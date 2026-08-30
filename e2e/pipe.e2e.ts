/**
 * The terminal surface end to end: the real `dsh code` command over the real
 * `code` profile and its `code-cli` preset, with a keyless mock adapter
 * standing in for the model.
 *
 * This is the only place the whole loop is exercised together — preset mount,
 * tool call, keyboard approval, presenter-driven card, and the closing
 * message. The unit suites cover each piece; none of them prove they compose.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS, makeHome, overlayText, resolveLaunch } from './harness.ts'

/**
 * What the mocked model does: `write` needs no approval, `bash` escalates and so
 * asks for one, and `markdown` answers in prose instead of calling anything.
 */
type MockTool = 'write' | 'bash' | 'markdown' | 'reasoning' | 'echo' | 'todo'

/** One completed run of the terminal surface. */
interface Run {
  stdout: string
  exitCode: number | undefined
  /** Contents of the file the mocked write creates, or undefined when it never ran. */
  written: string | undefined
}

/** How many times `needle` occurs in `text`. */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1

/**
 * Boot `dsh code` in an isolated workspace, feed it `input`, and collect what
 * the terminal showed.
 * @param options - the mocked tool, arguments after `code`, and everything typed.
 * @returns the run's output, exit code, and written file.
 */
async function runCodeCli(options: {
  tool: MockTool
  args?: readonly string[]
  input: string
  /** Extra workspace preparation, e.g. a custom command file. */
  setup?: (cwd: string) => Promise<void>
}): Promise<Run> {
  const cwd = await mkdtemp(join(tmpdir(), 'codsh-e2e-'))
  const home = await makeHome()
  try {
    const overlay = join(cwd, 'mock.cordis.patch.yml')
    await writeFile(overlay, overlayText())
    await options.setup?.(cwd)
    const launch = resolveLaunch({ overlay, args: options.args, home, mode: options.tool })
    const result = await execa(launch.command, launch.args, {
      cwd,
      env: launch.env,
      extendEnv: false,
      input: options.input,
      reject: false,
      stripFinalNewline: false,
      timeout: 90_000,
    })
    return {
      stdout: result.stdout,
      exitCode: result.exitCode,
      written: await readFile(join(cwd, 'note.txt'), 'utf8').catch(() => undefined),
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

describe('dsh code (real profile, keyless model)', () => {
  it('mounts the preset and renders a write through the diff card', async () => {
    const run = await runCodeCli({ tool: 'write', args: ['-p', 'create the note'], input: '' })

    // The composed surface names the preset the roster resolved.
    expect(run.stdout).toContain('code-cli')
    // The absolute path the tool reports is shortened against the workspace and
    // shown once: the pending card names the file, and the result adds only its
    // body. (The banner still prints the workspace itself, one line above.)
    const card = run.stdout.split('\n').filter(line => line.includes('note.txt'))
    expect(card).toEqual(['● Write note.txt'])
    // Print mode serves scripts: the task text came from the caller's own
    // command line, so it is not echoed back into the output.
    expect(run.stdout).not.toContain('› create the note')
    // The write tool's own diff presenter drives the body.
    expect(run.stdout).toContain('+ CODE_CLI_ROUND_TRIP')
    expect(run.stdout).toContain('CODE_CLI_CALL_OK')
    expect(run.written).toBe('CODE_CLI_ROUND_TRIP\n')
    expect(run.exitCode).toBe(0)
  }, E2E_TEST_TIMEOUT_MS)

  it('asks before a command the workspace-write preset does not cover', async () => {
    const run = await runCodeCli({ tool: 'bash', args: ['-p', 'run the command'], input: 'y\n' })

    expect(run.stdout).toContain('allow bash')
    expect(run.stdout).toContain('CODE_CLI_ROUND_TRIP')
    expect(run.stdout).toContain('CODE_CLI_CALL_OK')
    expect(run.exitCode).toBe(0)
  }, E2E_TEST_TIMEOUT_MS)

  it('denies the command when the answer is no, and the model is told', async () => {
    const run = await runCodeCli({ tool: 'bash', args: ['-p', 'run the command'], input: 'n\n' })

    expect(run.stdout).toContain('denied bash')
    expect(run.stdout).toContain('CODE_CLI_CALL_DENIED')
    expect(run.exitCode).toBe(0)
  }, E2E_TEST_TIMEOUT_MS)

  it('holds a conversation, then leaves on /exit', async () => {
    const run = await runCodeCli({ tool: 'write', input: 'create the note\n/exit\n' })

    expect(run.stdout).toContain('CODE_CLI_CALL_OK')
    // The person's own message is in the transcript: a pipe has no terminal
    // echo, so without this render it would appear nowhere at all.
    expect(run.stdout).toContain('› create the note')
    expect(run.written).toBe('CODE_CLI_ROUND_TRIP\n')
    // Leaving prints the session id, which is what `--resume` takes.
    expect(run.stdout).toMatch(/session session-/)
    expect(run.exitCode).toBe(0)
  }, E2E_TEST_TIMEOUT_MS)

  it('dispatches a real registry command, not only the ones it handles itself', async () => {
    // `/help` and `/exit` are this surface's own, so they proved nothing about
    // the registry: the parser anchors on the leading slash, and a dispatch that
    // stripped it answered "unknown command" for every registered command.
    const run = await runCodeCli({ tool: 'write', input: '/status\n/plan\n/exit\n' })

    // Commands echo above their result — they never reach the session log, so
    // nothing else would show what was run.
    expect(run.stdout).toContain('› /status')
    // `/status` is registered by this surface and reports through the registry.
    expect(run.stdout).toContain('permissions  workspace-write')
    // `/plan` belongs to the composed preset, so it proves the whole chain.
    expect(run.stdout).toContain('plan mode')
    expect(run.stdout).not.toContain('unknown command')
    expect(run.exitCode).toBe(0)
  }, E2E_TEST_TIMEOUT_MS)

  it('shows the composition, location, and spend with the prompt', async () => {
    const run = await runCodeCli({ tool: 'write', input: 'create the note\n/exit\n' })

    // The banner frames what answered; the status line carries it per prompt.
    expect(run.stdout).toContain('dsh code · cli-mock · code-cli')
    expect(run.stdout).toMatch(/cli-mock · code-cli · workspace-write/)
    // A turn reports what it cost, which is the figure a person acts on.
    expect(run.stdout).toMatch(/\d+\.\ds · \d+ tokens/)
  }, E2E_TEST_TIMEOUT_MS)

  it('renders a Markdown answer without mangling its prose', async () => {
    const run = await runCodeCli({ tool: 'markdown', input: 'explain\n/exit\n' })

    // Block constructs are rendered rather than printed as source.
    expect(run.stdout).toContain('CODE_CLI_HEADING')
    expect(run.stdout).toContain('• screen.ts: the viewport module')
    expect(run.stdout).toContain('│ a quoted line')
    expect(run.stdout).not.toContain('```')
    // Bold wrapping a code span consumes both sets of markers.
    expect(run.stdout).not.toContain('`screen.ts`')
    // The wide Chinese table wraps inside its cells instead of printing raw.
    expect(run.stdout).not.toContain('|---')
    expect(run.stdout).toContain('维度')
    // Emphasis is applied by unwrapping, so the markers must be gone...
    expect(run.stdout).not.toContain('**bold**')
    // ...and everything that only LOOKS like syntax must survive byte-for-byte.
    expect(run.stdout).toContain('some_helper_name must survive intact')
    expect(run.stdout).toContain('inline_code')
    expect(run.stdout).toContain('(https://x.dev)')
    // Streamed delta by delta AND assembled into a message: printing both would
    // show the answer twice.
    expect(countOf(run.stdout, 'CODE_CLI_HEADING')).toBe(1)
    expect(countOf(run.stdout, 'const answer = "text"')).toBe(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('refuses /copy without a TTY and emits no clipboard sequence', async () => {
    const run = await runCodeCli({ tool: 'markdown', input: 'explain\n/copy 1\n/exit\n' })

    expect(run.stdout).toContain('/copy requires an interactive terminal')
    expect(run.stdout).not.toContain('\u001B]52;c;')
  }, E2E_TEST_TIMEOUT_MS)

  it('refuses /view without adding full-screen UI to a pipe', async () => {
    const run = await runCodeCli({ tool: 'markdown', input: 'explain\n/view 1\n/exit\n' })

    expect(run.stdout).toContain('/view requires an interactive terminal')
    expect(run.stdout).not.toContain('Esc closes')
  }, E2E_TEST_TIMEOUT_MS)

  it('stops asking for the rest of the session once the answer is "always"', async () => {
    const run = await runCodeCli({ tool: 'bash', input: 'run it\na\nrun it again\n/exit\n' })

    expect(run.stdout).toContain('allowing every bash call')
    // Both turns called bash; only the first was put to the keyboard.
    expect(countOf(run.stdout, 'allow bash')).toBe(1)
    expect(countOf(run.stdout, 'CODE_CLI_CALL_OK')).toBe(2)
    expect(run.exitCode).toBe(0)
  }, E2E_TEST_TIMEOUT_MS)

  it('streams the model thinking dim, then the answer, without double-printing either', async () => {
    const run = await runCodeCli({ tool: 'reasoning', input: 'think it over\n/exit\n' })

    // Collapsed by default: the transcript keeps a one-line summary, never the
    // pages of deliberation, and the summary lands before the answer.
    expect(run.stdout).toMatch(/✻ thought for [\d.]+s · \+\d+ lines/u)
    expect(run.stdout).not.toContain('weighing the options carefully')
    expect(run.stdout.indexOf('✻ thought for')).toBeLessThan(run.stdout.indexOf('CODE_CLI_ANSWER'))
    expect(countOf(run.stdout, 'CODE_CLI_ANSWER after thinking')).toBe(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('runs a ! line locally and the next request sees its outcome', async () => {
    const run = await runCodeCli({ tool: 'echo', input: '!echo BANG_OUTPUT_42\n/exit\n' })

    expect(run.stdout).toContain('$ echo BANG_OUTPUT_42')
    expect(run.stdout).toContain('BANG_OUTPUT_42')
    expect(run.stdout).toContain('bang=yes')
    expect(countOf(run.stdout, 'CODE_CLI_CTX')).toBe(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('starts a fresh session on /clear, and the old context stays behind', async () => {
    const run = await runCodeCli({ tool: 'echo', input: 'remember DELTA_ONE\n/clear\nwhat do you know\n/exit\n' })

    expect(run.stdout).toContain('remembered=yes')
    expect(run.stdout).toContain('new session session-')
    // The post-/clear request no longer carries the first conversation.
    expect(run.stdout).toContain('remembered=no')
    expect(run.stdout.indexOf('remembered=yes')).toBeLessThan(run.stdout.indexOf('remembered=no'))
  }, E2E_TEST_TIMEOUT_MS)

  it('lists resumable sessions on a pipe, where the selector cannot open', async () => {
    const run = await runCodeCli({ tool: 'echo', input: 'remember DELTA_ONE\n/clear\n/resume\n/exit\n' })

    // The pre-/clear session lists with its age; the pipe gets rows, not a widget.
    expect(run.stdout).toContain('just now')
    expect(countOf(run.stdout, 'session-')).toBeGreaterThanOrEqual(2)
  }, E2E_TEST_TIMEOUT_MS)

  it('loads a custom command file and runs it as a canned prompt', async () => {
    const run = await runCodeCli({
      tool: 'echo',
      input: '/hello world\n/exit\n',
      setup: async (cwd) => {
        await mkdir(join(cwd, '.dsh', 'commands'), { recursive: true })
        await writeFile(
          join(cwd, '.dsh', 'commands', 'hello.md'),
          '---\ndescription: greet the arguments\n---\nSay CODE_CLI_CUSTOM_MARKER to $ARGUMENTS',
        )
      },
    })

    // The command echoes as typed; the request carries the expanded template.
    expect(run.stdout).toContain('› /hello world')
    expect(run.stdout).toContain('marker=yes')
    expect(run.stdout).not.toContain('unknown command')
  }, E2E_TEST_TIMEOUT_MS)

  it('prints the todo list on /todos, read back from the session projection', async () => {
    const run = await runCodeCli({ tool: 'todo', input: 'plan the work\n/todos\n/exit\n' })

    // Twice: once as the card the write produced, once as `/todos` reading the
    // projection back — which is what keeps the list answerable off a TTY,
    // where there is no chrome to pin it to.
    const header = 'todos 1/3 · 1 in progress · 1 open'
    expect(run.stdout.split(header)).toHaveLength(3)
    expect(run.stdout).toContain('▶ write the fix')
    expect(run.stdout).not.toContain('unknown command')
  }, E2E_TEST_TIMEOUT_MS)

  it('runs /ship as a built-in canned prompt carrying the typed idea', async () => {
    const run = await runCodeCli({ tool: 'echo', input: '/ship add a SHIP_E2E_IDEA command\n/exit\n' })

    // The command echoes as typed; the request carries the expanded workflow
    // with the idea substituted and the tool names the phases hang on.
    expect(run.stdout).toContain('› /ship add a SHIP_E2E_IDEA command')
    expect(run.stdout).toContain('ship=yes')
    expect(run.stdout).not.toContain('unknown command')
  }, E2E_TEST_TIMEOUT_MS)
})
