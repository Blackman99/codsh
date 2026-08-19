/**
 * The behaviours that exist only on a terminal: Escape interrupting a turn, a
 * pasted block arriving as one message, Tab completing, and the live region
 * repainting as text streams.
 *
 * Neither can be exercised through a pipe — Escape needs raw mode, and a pipe's
 * lines are separate instructions by design — so these drive `dsh code` inside a
 * real PTY and write the actual bytes.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS, makeHome, overlayText, resolveLaunch } from './harness.ts'

/** The bare Escape byte, which is what a person pressing the key sends. */
const ESCAPE = '\u001B'

/** Enter, as a terminal in raw mode sends it. */
const ENTER = '\r'

/** Ctrl-U, which clears the line so a following command is not appended to it. */
const CLEAR = '\u0015'

/** Bracketed-paste markers, which the surface asks the terminal to send. */
const PASTE_START = '\u001B[200~'
const PASTE_END = '\u001B[201~'

/**
 * One scripted interaction: wait for `marker` in the output (empty to wait for
 * nothing), settle for `delayMs`, then type `payload`.
 */
type PtyStep = readonly [marker: string, payload: string, delayMs: number]

/**
 * Drive a PTY through an ordered script: wait for each marker, then write its
 * payload. Exits 124 when a marker never arrives, so a hang is a named failure
 * rather than a timeout with no explanation.
 */
const PTY_DRIVER = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
node, launch_args_json, launch_env_json, cwd, timeout_seconds, script_json = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
script = [(m.encode(), p.encode(), int(d)) for m, p, d in json.loads(script_json)]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(launch_args_json)], env)

# A forked PTY has no window size, and a terminal reporting zero columns is not
# what this test is about; give it the dimensions a real one would report.
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
    # Each marker is searched only in output produced after the previous step,
    # so a payload never fires twice on one banner and the order is enforced.
    while step < len(script):
        marker, payload, delay_ms = script[step]
        if marker:
            found = output.find(marker, consumed)
            if found < 0:
                break
            consumed = found + len(marker)
        # A settle delay is how a step asserts that NOTHING appears: there is no
        # marker to wait for when the expected outcome is silence.
        if delay_ms:
            time.sleep(delay_ms / 1000)
        if payload.startswith(b"@WINSZ:"):
            new_rows, new_cols = payload[7:].split(b"x")
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(new_rows), int(new_cols), 0, 0))
        else:
            os.write(fd, payload)
        step += 1
        sys.stderr.write(f"step {step}: matched {marker!r}, wrote {payload!r}\n")
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

/**
 * Boot `dsh code` in a PTY and run one marker-driven script against it.
 * @param mode - the mocked tool mode.
 * @param script - ordered steps, run in sequence.
 * @returns everything the PTY showed.
 */
async function drivePty(mode: string, script: readonly PtyStep[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'codsh-pty-'))
  const home = await makeHome()
  try {
    const overlay = join(cwd, 'mock.cordis.patch.yml')
    await writeFile(overlay, overlayText())
    const launch = resolveLaunch({ overlay, home, mode })
    const timeoutMs = 25_000
    const result = await execa('python3', [
      '-c',
      PTY_DRIVER,
      launch.command,
      JSON.stringify(launch.args),
      JSON.stringify(launch.env),
      cwd,
      String(timeoutMs / 1000),
      JSON.stringify(script),
    ], {
      stdin: 'ignore',
      timeout: timeoutMs + 10_000,
      reject: false,
      killSignal: 'SIGKILL',
      stripFinalNewline: false,
    })
    if (result.exitCode !== 0) {
      throw new Error(`PTY driver exited ${String(result.exitCode)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    return result.stdout
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32')('dsh code Escape (real PTY)', () => {
  it('offers Escape as the interrupt on a terminal', async () => {
    const output = await drivePty('write', [
      ['/help for commands', '/exit\n', 0],
    ])

    // The banner names whichever interrupt this surface can actually offer.
    expect(output).toContain('ESC interrupts')
    expect(output).not.toContain('Ctrl-C interrupts')
  }, E2E_TEST_TIMEOUT_MS)

  it('cancels a running turn and returns to the prompt', async () => {
    const output = await drivePty('slow', [
      // Start a turn whose tool occupies it.
      ['/help for commands', 'take your time\n', 0],
      // The command is running; press Escape alone.
      ['$ sleep', ESCAPE, 0],
      // The turn is cancelled, so the prompt comes back and accepts more.
      //
      // `/exit` is the assertion that Escape released the reader's decoder: a
      // still-suspended decoder consumes the leading slash as the byte that
      // would have identified an arrow key, leaving `exit` — an ordinary prompt
      // that starts another turn instead of leaving, which times out here.
      ['interrupted', '/exit\n', 300],
    ])

    expect(output).toContain('$ sleep')
    expect(output).toContain('interrupted')
    // The mocked model answers only after a tool result; a cancelled call
    // produces none, so its closing message must never appear.
    expect(output).not.toContain('CODE_CLI_CALL_OK')
    // Leaving normally after the interrupt proves the session survived it.
    expect(output).toMatch(/session session-/)
  }, E2E_TEST_TIMEOUT_MS)

  it('takes a pasted block into the buffer whole, and waits', async () => {
    const paste = `${PASTE_START}first line of one prompt\nsecond line of it${PASTE_END}`
    const output = await drivePty('write', [
      // What a terminal actually sends for a paste: the block wrapped in markers.
      // Without them a multi-line write is indistinguishable from fast typing
      // with Enters, and guessing is how a paste turns into several turns.
      ['/help for commands', paste, 0],
      // The paste did not submit: the person still decides when to send it.
      ['second line of it', ENTER, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 300],
    ])

    // One turn, so one tool call. Line-by-line submission would have run two.
    expect(output.split('Write note.txt').length - 1).toBe(1)
    // Both lines reached the model as one prompt.
    expect(output).toContain('first line of one prompt')
    expect(output).toContain('second line of it')
  }, E2E_TEST_TIMEOUT_MS)

  it('completes an @ mention on Tab', async () => {
    // The unit suite covers the completer; only a terminal proves the reader was
    // actually given one, since Tab is inert without it.
    const output = await drivePty('write', [
      // `mock.cordis.patch.yml` is the overlay this harness writes into the cwd.
      ['/help for commands', '@mo\t', 0],
      ['mock.cordis.patch.yml', '\n', 300],
      ['CODE_CLI_CALL_OK', '/exit\n', 300],
    ])

    expect(output).toContain('@mock.cordis.patch.yml')
  }, E2E_TEST_TIMEOUT_MS)

  it('repaints the live region as text streams in', async () => {
    const output = await drivePty('markdown', [
      ['/help for commands', 'explain\n', 0],
      ['CODE_CLI_CALL_STREAM_DONE', '/exit\n', 300],
    ])

    // Each delta redraws the line being typed, which is the token-level display;
    // off a terminal there is no region to repaint and none of this appears.
    const repaints = output.split('\u001B[K').length - 1
    expect(repaints).toBeGreaterThan(10)
    // The finished lines still land exactly once.
    expect(output.split('CODE_CLI_HEADING').length - 1).toBe(1)
    // The box stays up while the answer streams — type-ahead must be visible —
    // and the cursor shows only inside it. A shown cursor directly after a bare
    // carriage return would be parked at column 0 of the region's last row,
    // which is the status bar: the collision this assertion pins down.
    const streaming = output.slice(output.indexOf('CODE_CLI_HEADING'), output.indexOf('CODE_CLI_CALL_STREAM_DONE'))
    expect(streaming).toContain('╭')
    expect(streaming).not.toContain('\r\u001B[?25h')
    expect(output).not.toContain('\r\u001B[?25h')
  }, E2E_TEST_TIMEOUT_MS)

  it('draws a framed input box that closes on itself', async () => {
    const output = await drivePty('write', [
      ['/help for commands', 'typed text', 0],
      ['typed text', `${CLEAR}/exit${ENTER}`, 300],
    ])

    // A real frame around the real text. Row widths are pinned by the layout's
    // own suite: a terminal's bytes interleave redraws, so measuring them here
    // would test the capture rather than the box.
    // The window-title OSC is `ESC ]`-introduced, so the CSI strip misses it.
    const rows = output.split('\n').map(row =>
      row.replaceAll(/\u001B\][^\u0007]*\u0007/gu, '').replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '').replaceAll('\r', ''))
    expect(rows.some(row => row.startsWith('╭─'))).toBe(true)
    expect(rows.some(row => row.startsWith('╰─'))).toBe(true)
    // The text sits inside the frame, not beside it.
    expect(rows.some(row => row.includes('│ › typed text') && row.endsWith('│'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the completion menu as a command is typed', async () => {
    const output = await drivePty('write', [
      // No Tab: the menu has to appear from the typing itself.
      ['/help for commands', '/p', 0],
      ['Enter or leave plan mode', `${CLEAR}/exit${ENTER}`, 300],
    ])

    // Both matches, each with what it does, and one of them marked. The typed
    // fragment keeps the accent colour inside each candidate.
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('/plan')
    expect(plain).toContain('/permission')
    expect(plain).toContain('Enter or leave plan mode')
    expect(plain).toContain('❯')
    expect(output).toContain('\u001B[36m/p\u001B[0m')
  }, E2E_TEST_TIMEOUT_MS)

  it('adds a line with Alt-Enter and submits the block with Enter', async () => {
    const output = await drivePty('write', [
      ['/help for commands', `first${ESCAPE}${ENTER}second`, 0],
      ['second', ENTER, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 300],
    ])

    // One turn from two lines: the break did not submit.
    expect(output.split('Write note.txt').length - 1).toBe(1)
    // The transcript's echo keeps the block's shape: marker on the first
    // line, the continuation as its own border-free line below. (The capture
    // interleaves region repaints between the two, so only order is stable.)
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    const lines = plain.split(/[\r\n]+/u).map(line => line.trim())
    const echo = lines.indexOf('› first')
    expect(echo).toBeGreaterThanOrEqual(0)
    // Inside the box the text always sits between │ borders; bare `second`
    // can only be the echoed continuation.
    expect(lines.indexOf('second', echo)).toBeGreaterThan(echo)
  }, E2E_TEST_TIMEOUT_MS)

  it('recalls the previous submission with the up arrow', async () => {
    const output = await drivePty('write', [
      ['/help for commands', `remembered text${ENTER}`, 0],
      ['CODE_CLI_CALL_OK', `${ESCAPE}[A`, 400],
      ['remembered text', `${CLEAR}/exit${ENTER}`, 400],
    ])

    // The recalled text is back inside the box. It appears only once: sent as a
    // single write, the typing itself never produced an intermediate frame.
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('› remembered text')
  }, E2E_TEST_TIMEOUT_MS)

  it('puts an approval to the arrow keys and accepts on Enter', async () => {
    const output = await drivePty('bash', [
      ['/help for commands', `run it${ENTER}`, 300],
      // The selector replaced the input box; Enter takes the marked default.
      ['Allow bash?', ENTER, 400],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    // Styling survives rendering now, so the codes are stripped before matching.
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('❯ 1. Yes, this time (y)')
    expect(plain).toContain('2. Yes, every bash call this session (a)')
    expect(plain).toContain('CODE_CLI_ROUND_TRIP')
  }, E2E_TEST_TIMEOUT_MS)

  it('denies an approval through its shortcut key', async () => {
    const output = await drivePty('bash', [
      ['/help for commands', `run it${ENTER}`, 300],
      ['Allow bash?', 'n', 400],
      ['CODE_CLI_CALL_DENIED', `/exit${ENTER}`, 400],
    ])

    expect(output).toContain('CODE_CLI_CALL_DENIED')
    expect(output).not.toContain('CODE_CLI_CALL_OK')
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps the status row live in the region', async () => {
    const output = await drivePty('write', [
      ['/help for commands', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    // The always-current facts live at the bottom, not spammed into the
    // transcript: model, composition, permissions, spend, and place. Each
    // segment carries its own styling, stripped here before matching.
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toMatch(/cli-mock · code-cli · workspace-write · \d+k? tokens/)
    // Submitting clears the box, so the transcript's own render is the only
    // copy of the message that survives. The box always paints the text
    // between │ borders; a border-free `› message` line proves the render.
    // The PTY separates lines with bare carriage returns as often as \r\n.
    expect(plain.split(/[\r\n]+/u).some(line => line.trim() === '› create the note')).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('toggles plan mode with Shift-Tab, both ways', async () => {
    const output = await drivePty('write', [
      ['/help for commands', `${ESCAPE}[Z`, 400],
      // The registry's bare /plan only ever enters; the second press must still
      // leave, or the key reads as broken.
      ['▲ plan mode', `${ESCAPE}[Z`, 500],
      ['▼ plan mode off', `/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('▲ plan mode')
    expect(plain).toContain('▼ plan mode off')
    // The box frame carries the mode while it holds.
    expect(output).toContain('\u001B[33m╭')
  }, E2E_TEST_TIMEOUT_MS)

  it('completes a command argument and runs it', async () => {
    const output = await drivePty('write', [
      ['/help for commands', `${ESCAPE}[Z`, 400],
      // Typing the space after /plan opens the argument menu by itself.
      ['▲ plan mode', '/plan ', 500],
      ['leave plan mode', `\t${ENTER}`, 400],
      ['▼ plan mode off', `${CLEAR}/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('leave plan mode')
    expect(plain).toContain('▼ plan mode off')
  }, E2E_TEST_TIMEOUT_MS)

  it('switches the model through the /model selector, all the way to the request', async () => {
    const output = await drivePty('write', [
      // Bare /model IS the request to pick one: the selector opens.
      ['/help for commands', `/model${ENTER}`, 400],
      ['Switch model', `${ESCAPE}[B${ENTER}`, 500],
      // The pick is confirmed, and the next turn must be SERVED by it: the
      // mock names the model that answered, which is the only proof a switch
      // reached the request rather than only the display.
      ['model cli-mock/cli-mock-pro', `run it${ENTER}`, 400],
      ['via cli-mock-pro', `/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('❯ 1. cli-mock/cli-mock')
    expect(plain).toContain('· current')
    expect(plain).toContain('model cli-mock/cli-mock-pro')
    expect(plain).toContain('via cli-mock-pro')
    // The status row reads the live selection.
    expect(plain).toContain('cli-mock-pro · code-cli')
  }, E2E_TEST_TIMEOUT_MS)

  it('ignores Escape at an idle prompt', async () => {
    const output = await drivePty('write', [
      // Press Escape with nothing running.
      ['/help for commands', ESCAPE, 0],
      // Nothing should have happened, so there is no marker to wait for: settle,
      // then prove the surface is still reading by giving it real work.
      ['', 'create the note\n', 1000],
      ['CODE_CLI_CALL_OK', '/exit\n', 300],
    ])

    // Cancelling an idle agent is a no-op, so the surface stays quiet about it.
    expect(output).not.toContain('interrupted')
    expect(output).toContain('CODE_CLI_CALL_OK')
    expect(output).toMatch(/session session-/)
  }, E2E_TEST_TIMEOUT_MS)

  it('streams thinking dim before the answer', async () => {
    const output = await drivePty('reasoning', [
      ['/help for commands', `think it over${ENTER}`, 300],
      ['CODE_CLI_ANSWER after thinking', `/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('✻ thinking')
    expect(plain).toContain('CODE_CLI_THINKING about the request')
    expect(plain.indexOf('✻ thinking')).toBeLessThan(plain.indexOf('CODE_CLI_ANSWER'))
  }, E2E_TEST_TIMEOUT_MS)

  it('recalls the previous message with a double Escape', async () => {
    const output = await drivePty('write', [
      ['/help for commands', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', ESCAPE, 400],
      // The first Escape at a quiet, empty prompt arms recall and says so.
      ['ESC again to edit', ESCAPE, 200],
      // The recalled text is back in the box, editable — not submitted.
      ['create the note', `${CLEAR}/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('ESC again to edit your previous message')
    // The run never re-submitted it: exactly one write happened.
    expect(output.split('Write note.txt').length - 1).toBe(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('expands the last clipped output with Ctrl-O', async () => {
    const output = await drivePty('tall', [
      ['/help for commands', `create the tall note${ENTER}`, 300],
      // 45 added lines, capped at 40: the card says what it hid...
      ['more lines', '\u000F', 400],
      // ...and Ctrl-O prints the full body, clipped tail included.
      ['CODE_CLI_TALL_44', `/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('full output')
    expect(plain).toContain('CODE_CLI_TALL_44')
  }, E2E_TEST_TIMEOUT_MS)

  it('clears to a fresh session, then resumes the old one through the selector', async () => {
    const output = await drivePty('echo', [
      ['/help for commands', `remember DELTA_ONE${ENTER}`, 300],
      ['remembered=yes', `/clear${ENTER}`, 400],
      ['new session session-', `/resume${ENTER}`, 400],
      // The retired session is the one on offer; Enter takes it.
      ['Resume session', ENTER, 400],
      ['resumed session-', `/exit${ENTER}`, 500],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    // Resuming replays the retired session's transcript, echo included.
    expect(plain.split(/[\r\n]+/u).filter(line => line.trim() === '› remember DELTA_ONE').length).toBeGreaterThanOrEqual(2)
    // The window title tracks the surface on a real terminal.
    expect(output).toContain('\u001B]2;dsh code —')
  }, E2E_TEST_TIMEOUT_MS)

  it('runs a ! line in the shell without spending a turn', async () => {
    const output = await drivePty('echo', [
      ['/help for commands', `!echo BANG_PTY_7${ENTER}`, 300],
      ['BANG_PTY_7', `did it run${ENTER}`, 300],
      ['bang=yes', `/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('› !echo BANG_PTY_7')
    expect(plain).toContain('bang=yes')
  }, E2E_TEST_TIMEOUT_MS)

  it('recovers from a terminal resize with an absolute erase and a bottom re-anchor', async () => {
    const output = await drivePty('write', [
      ['/help for commands', '', 0],
      // The startup anchor follows the banner; consuming it makes the later
      // match unambiguously the post-resize re-anchor.
      ['\u001B[9999;1H', '@WINSZ:40x80', 400],
      // The resize recovery: clear from an absolute row, then a fresh draw
      // anchored to the bottom — relative erase math is void after a rewrap.
      ['\u001B[0J', '', 0],
      ['\u001B[9999;1H', `still alive${ENTER}`, 300],
      // The surface keeps working at the new size.
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    // The absolute-row erase is the recovery's signature; relative erases
    // never carry an explicit row.
    expect(output).toMatch(/\u001B\[\d+;1H\u001B\[0J/u)
    expect(output).toContain('CODE_CLI_CALL_OK')
  }, E2E_TEST_TIMEOUT_MS)
})
