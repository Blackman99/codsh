/**
 * The experience checklist: what a person notices in the first five minutes,
 * asserted at the screen level before a person has to.
 *
 * Every entry here started life as a real complaint — a menu that hid its
 * tail, a wheel that scrolled backwards, a clock that reset per step, a
 * flickering hint row, a bare welcome, a wall of output. The suite exists so
 * the NEXT change to rendering or input fails here first.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { Terminal } from './vt.ts'

// The PTY plumbing lives in pty.e2e.ts; this suite re-declares the little it
// needs so the two files stay independently readable.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { makeHome, overlayText, resolveLaunch } from './harness.ts'

const PTY_ROWS = 40
const PTY_COLUMNS = 120
const SYNC_END = '\u001B[?2026l'
const LEAVE_ALT = '\u001B[?1049l'
const ENTER = '\r'

type PtyStep = readonly [marker: string, payload: string, delayMs: number]

const PTY_DRIVER = String.raw`
import errno, fcntl, json, os, pty, re, select, signal, struct, sys, termios, time

# A payload may aim at a line rather than a fixed row: {row:TEXT} becomes the
# terminal row TEXT was last painted on, which is the only way to click a
# transcript block whose position depends on how much came before it.
ROW_AT = re.compile(rb"\{row:([^}]*)\}")

def resolve(payload, output):
    def row_of(match):
        target = match.group(1)
        at = output.rfind(target)
        if at < 0:
            sys.stderr.write(f"no painted row holds {target!r}\n")
            sys.exit(125)
        moves = re.findall(rb"\x1b\[(\d+);1H", bytes(output[:at]))
        if not moves:
            sys.stderr.write(f"nothing positioned the row holding {target!r}\n")
            sys.exit(125)
        return moves[-1]
    return ROW_AT.sub(row_of, payload)

node, launch_args_json, launch_env_json, cwd, timeout_seconds, script_json = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
script = [(m.encode(), p.encode(), int(d)) for m, p, d in json.loads(script_json)]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(launch_args_json)], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
output = bytearray()
step = 0
consumed = 0
deadline = time.monotonic() + float(timeout_seconds)
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            output.extend(chunk)
    while step < len(script):
        marker, payload, delay_ms = script[step]
        if marker:
            found = output.find(marker, consumed)
            if found < 0:
                break
            consumed = found + len(marker)
        settle_until = time.monotonic() + delay_ms / 1000
        while time.monotonic() < settle_until:
            ready, _, _ = select.select([fd], [], [], 0.02)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if chunk:
                    output.extend(chunk)
        os.write(fd, resolve(payload, output))
        step += 1
        sys.stderr.write(f"step {step} at {len(output)}: matched {marker!r}\n")
    waited, candidate = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = candidate
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
if step != len(script):
    sys.stderr.write(f"completed {step}/{len(script)} PTY steps before timeout\n")
    sys.exit(124)
sys.exit(os.waitstatus_to_exitcode(status))
`

/** Run one scripted PTY scenario against the packed build. */
async function drive(mode: string, script: readonly PtyStep[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'codsh-exp-'))
  const home = await makeHome()
  try {
    const overlay = join(cwd, 'mock.cordis.patch.yml')
    await writeFile(overlay, overlayText())
    const launch = resolveLaunch({ overlay, home, mode })
    const timeoutMs = 30_000
    const result = await execa('python3', [
      '-c', PTY_DRIVER,
      launch.command, JSON.stringify(launch.args), JSON.stringify(launch.env),
      cwd, String(timeoutMs / 1000), JSON.stringify(script),
    ], { stdin: 'ignore', timeout: timeoutMs + 10_000, reject: false, killSignal: 'SIGKILL', stripFinalNewline: false })
    if (result.exitCode !== 0) {
      throw new Error(`experience driver exited ${String(result.exitCode)}.\nstderr:\n${result.stderr}`)
    }
    return result.stdout
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

/** Everything painted while the session held the alternate screen. */
function heldOutput(output: string): string {
  const handedBack = output.indexOf(LEAVE_ALT)
  return handedBack < 0 ? output : output.slice(0, handedBack)
}

/** The screen as of the frame containing the byte offset `at`. */
function screenOf(held: string, at: number): Terminal {
  const frameEnd = at < 0 ? -1 : held.indexOf(SYNC_END, at)
  const terminal = new Terminal(PTY_ROWS, PTY_COLUMNS)
  terminal.feed(held.slice(0, frameEnd < 0 ? held.length : frameEnd + SYNC_END.length))
  return terminal
}

/** The screen as of the frame in which `marker` first appears. */
function screenAt(output: string, marker: string): Terminal {
  const held = heldOutput(output)
  return screenOf(held, held.indexOf(marker))
}

/**
 * The screen as of the frame that painted `marker` LAST.
 *
 * What a line was replaced by is the question a toggle raises, and the first
 * paint of a line rarely answers it: a live preview, a summary, and a fold's
 * full form can all carry the same text at different moments.
 */
function screenAtLast(output: string, marker: string): Terminal {
  const held = heldOutput(output)
  return screenOf(held, held.lastIndexOf(marker))
}

/** The screen at the LAST frame before the terminal is handed back. */
function finalScreen(output: string): Terminal {
  const terminal = new Terminal(PTY_ROWS, PTY_COLUMNS)
  terminal.feed(heldOutput(output))
  return terminal
}

describe.skipIf(process.platform === 'win32')('the first five minutes', () => {
  it('welcomes with the lettermark at the TOP of the screen', async () => {
    const output = await drive('write', [
      // The box appearing is the settled first frame; the welcome precedes it.
      ['Ask anything', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'Ask anything').alternate
    const logoRow = rows.findIndex(row => row.includes('██████╗'))
    expect(logoRow).toBeGreaterThanOrEqual(0)
    expect(logoRow).toBeLessThan(8)
    // The gap sits between the welcome and the chrome, not above the welcome.
    expect(rows.slice(-4).some(row => row.startsWith('╭'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('shows the welcome again after /clear', async () => {
    const output = await drive('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/clear${ENTER}`, 400],
      ['new session', `/exit${ENTER}`, 500],
    ])
    const rows = screenAt(output, 'new session').alternate
    // The fresh session greets like the first one did, and the old turn is gone.
    expect(rows.some(row => row.includes('✻ Welcome to codsh'))).toBe(true)
    expect(rows.some(row => row.includes('Write note.txt'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps the selected completion visible however far the arrows go', async () => {
    // Tab far past the first page of commands; the marked row must follow.
    const output = await drive('write', [
      ['Welcome to codsh', '/', 300],
      ['/exit', '\t\t\t\t\t\t\t\t\t\t', 400],
      ['', `/exit${ENTER}`, 600],
    ])
    const frames = output.split(SYNC_END)
    // In every frame that shows a menu, the marked row is on screen.
    const probe = new Terminal(PTY_ROWS, PTY_COLUMNS)
    let markedSeen = 0
    for (const frame of frames) {
      probe.feed(frame + SYNC_END)
      const screen = probe.alternate.join('\n')
      if (screen.includes('❯ /')) markedSeen += 1
    }
    expect(markedSeen).toBeGreaterThan(5)
  }, E2E_TEST_TIMEOUT_MS)

  it('scrolls back with wheel-up, gently, and says how far', async () => {
    const wheelUp = '\u001B[<64;10;10M'.repeat(4)
    // A tall result, so the transcript genuinely overflows the viewport.
    const output = await drive('tall', [
      ['Welcome to codsh', `make it tall${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', wheelUp, 600],
      ['rows above', `/exit${ENTER}`, 500],
    ])
    const scrolled = screenAt(output, 'rows above')
    const text = scrolled.alternate.join('\n')
    // Four wheel events, one row each: gentle, and away from the tail it says so.
    expect(text).toMatch(/↑ \d+ rows above/u)
    const distance = Number(/↑ (\d+) rows above/u.exec(text)?.[1] ?? '0')
    expect(distance).toBeGreaterThan(0)
    expect(distance).toBeLessThanOrEqual(4)
  }, E2E_TEST_TIMEOUT_MS)

  it('collapses a long result and names the expand key', async () => {
    const output = await drive('tall', [
      ['Welcome to codsh', `make it tall${ENTER}`, 300],
      ['lines (click or Ctrl+O expands)', `/exit${ENTER}`, 500],
    ])
    const rows = screenAt(output, 'Ctrl+O expands').alternate
    const body = rows.filter(row => row.includes('CODE_CLI_TALL_'))
    // A skimmable sliver, not a wall; the affordance names the key.
    expect(body.length).toBeLessThanOrEqual(24)
    expect(rows.some(row => row.includes('(click or Ctrl+O expands)'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the block a click lands on, and folds it back from its head row', async () => {
    // Where a block sits depends on everything printed above it, so the click
    // aims at the line itself and the driver resolves the row it was painted
    // on. Press and release without moving: a drag would copy instead.
    const clickOn = (line: string): string => `\u001B[<0;6;{row:${line}}M\u001B[<0;6;{row:${line}}m`
    const output = await drive('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      // Thinking lands collapsed; a click on its summary opens that block.
      ['thought for', clickOn('thought for'), 600],
      // A click on the open block's head line folds it back again.
      ['weighing the options carefully', clickOn('✻ thought for'), 600],
      ['lines (click or Ctrl+O expands)', `/exit${ENTER}`, 400],
    ])
    const opened = screenAtLast(output, 'weighing the options carefully').alternate
    expect(opened.some(row => row.includes('CODE_CLI_THINKING about the request'))).toBe(true)
    // Folded back by the second click — before any submission could do it.
    const shut = screenAtLast(output, 'lines (click or Ctrl+O expands)').alternate
    expect(shut.some(row => /✻ thought for [\d.]+s · \+\d+ lines/u.test(row))).toBe(true)
    expect(shut.some(row => row.includes('weighing the options carefully'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('reports one continuous clock for the whole turn', async () => {
    const output = await drive('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 500],
    ])
    const screen = finalScreen(output)
    // Exactly one cost line per turn — per-step reports would print several.
    const costs = screen.alternate.filter(row => /^\s+\d+(?:\.\d+)?s( · .*tokens)?$/u.test(row))
    expect(costs).toHaveLength(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('renders model output faithfully: tables stay tables, emphasis eats its markers', async () => {
    const output = await drive('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/exit${ENTER}`, 600],
    ])
    const rows = screenAt(output, 'CODE_CLI_CALL_STREAM_DONE').alternate
    const text = rows.join('\n')
    // The wide Chinese table wrapped inside its cells — never raw pipe rows.
    expect(text).not.toContain('|---')
    expect(text).not.toContain('| 维度')
    expect(rows.some(row => row.includes('维度') && row.includes('内容'))).toBe(true)
    // The grid is framed and ruled: edges, a head rule, and every table row —
    // wrapped continuations included — carries the same rule count, so the
    // sheared-apart layout of the field report cannot re-form silently.
    expect(rows.some(row => row.startsWith('╭') && row.includes('┬'))).toBe(true)
    expect(rows.some(row => row.includes('┼'))).toBe(true)
    // Table rows carry three rules (two columns framed); the input box's
    // middle row has two and a blockquote one, so ≥3 isolates the table.
    const ruleCounts = new Set(rows.filter(row => row.split('│').length - 1 >= 3)
      .map(row => row.split('│').length - 1))
    expect(ruleCounts.size).toBeLessThanOrEqual(1)
    // Bold-wrapped code lost its backticks and its stars.
    expect(text).not.toContain('`screen.ts`')
    expect(text).not.toContain('**')
    expect(text).toContain('screen.ts')
  }, E2E_TEST_TIMEOUT_MS)

  it('folds a finished long answer on moving on, and reopens it on Ctrl+O', async () => {
    const output = await drive('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      // The whole answer stands while fresh; the next submission collapses it.
      ['CODE_CLI_CALL_STREAM_DONE', `/status${ENTER}`, 500],
      // Collapsed to its head lines: Ctrl+O brings the tail back.
      ['permissions', '\u000F', 400],
      ['CODE_CLI_CALL_STREAM_DONE', `/exit${ENTER}`, 400],
    ])
    // After /status the wall is gone: a head, a count, and no tail marker.
    const folded = screenAt(output, 'permissions').alternate
    expect(folded.some(row => row.includes('lines (click or Ctrl+O expands)'))).toBe(true)
    expect(folded.some(row => row.includes('CODE_CLI_CALL_STREAM_DONE'))).toBe(false)
    // Re-expanded: read the frame that painted the tail marker last.
    const probe = screenAtLast(output, 'CODE_CLI_CALL_STREAM_DONE')
    expect(probe.alternate.some(row => row.includes('CODE_CLI_CALL_STREAM_DONE'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('collapses thinking by default and expands it on Ctrl+O', async () => {
    const output = await drive('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      ['thought for', '\u000F', 500],
      ['weighing the options carefully', `/exit${ENTER}`, 400],
    ])
    // The toggle swaps the summary for the full thought in place: read the
    // frame that painted its final line last (the live preview carried the
    // same text earlier).
    const rows = screenAtLast(output, 'weighing the options carefully').alternate
    expect(rows.some(row => /✻ thought for [\d.]+s/u.test(row))).toBe(true)
    expect(rows.some(row => row.includes('weighing the options carefully'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)
})
