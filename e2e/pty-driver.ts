/**
 * Driving the real binary inside a real PTY.
 *
 * The surface only exists on a terminal: raw mode, a window size, frames
 * painted as synchronized updates. Reaching it means a pseudo-terminal and a
 * script of "wait for this text, then send these bytes" — which is what this
 * module provides, once, for every suite that needs it and for the showcase
 * capture that renders the same frames on the web.
 * @module codsh/e2e/pty-driver
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { makeHome, overlayText, resolveLaunch } from './harness.ts'
import { Terminal } from './vt.ts'

/** The window size the driver gives every run. */
export const PTY_ROWS = 40

/** Columns every run reports; wide enough that nothing wraps by accident. */
export const PTY_COLUMNS = 120

/** Ends one synchronized frame, which is where a capture may safely be cut. */
export const SYNC_END = '\u001B[?2026l'

/** The surface handing the terminal back; nothing after it is session screen. */
export const LEAVE_ALT = '\u001B[?1049l'

/**
 * One scripted step: wait for `marker`, then write `payload`.
 *
 * `delayMs` settles before the write — the only way to assert that nothing
 * appears, since silence has no marker to wait for.
 */
export type PtyStep = readonly [marker: string, payload: string, delayMs: number]

/** A capture plus where in it each scripted step fired. */
export interface Driven {
  output: string
  /** Byte offset of the capture when step N (1-based) wrote its payload. */
  offsets: number[]
}

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

node, launch_args_json, launch_env_json, cwd, timeout_seconds, script_json, win_rows, win_cols = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
script = [(m.encode(), p.encode(), int(d)) for m, p, d in json.loads(script_json)]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(launch_args_json)], env)
# A forked PTY has no window size, and a terminal reporting zero columns is
# not what any of this is about; give it the one the caller asked for.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(win_rows), int(win_cols), 0, 0))
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
        payload = resolve(payload, output)
        # A step may resize the window instead of typing: a re-layout is only
        # observable when the size the app reads actually changes under it.
        if payload.startswith(b"@WINSZ:"):
            new_rows, new_cols = payload[7:].split(b"x")
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(new_rows), int(new_cols), 0, 0))
        else:
            os.write(fd, payload)
        step += 1
        sys.stderr.write(f"step {step} at {len(output)}: matched {marker!r}, wrote {payload!r}\n")
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

/** What a run may choose, beyond the mode and the script. */
export interface DriveOptions {
  /** How long the whole script may take. */
  timeoutMs?: number
  /**
   * The workspace to run in, created if missing and left in place.
   *
   * A run makes its own throwaway directory by default. The showcase capture
   * chooses one instead: the surface prints the workspace it is in, and a path
   * under the temp root is what tells a reader they are looking at a fixture.
   */
  cwd?: string
  /** Window height to report; the suites' 40 unless a caller needs another. */
  rows?: number
  /** Window width to report. */
  columns?: number
}

/**
 * Boot the packed build in a PTY and run one marker-driven script against it.
 * @param mode - the mocked tool mode the fixture model answers in.
 * @param script - ordered steps, run in sequence.
 * @param options - timeout and workspace choices.
 * @returns the capture and the offsets its steps fired at.
 */
export async function drivePtySteps(
  mode: string,
  script: readonly PtyStep[],
  options: DriveOptions = {},
): Promise<Driven> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const rows = options.rows ?? PTY_ROWS
  const columns = options.columns ?? PTY_COLUMNS
  const chosen = options.cwd
  const cwd = chosen ?? await mkdtemp(join(tmpdir(), 'codsh-pty-'))
  if (chosen !== undefined) await mkdir(chosen, { recursive: true })
  const home = await makeHome()
  try {
    const overlay = join(cwd, 'mock.cordis.patch.yml')
    await writeFile(overlay, overlayText())
    const launch = resolveLaunch({ overlay, home, mode })
    const result = await execa('python3', [
      '-c', PTY_DRIVER,
      launch.command, JSON.stringify(launch.args), JSON.stringify(launch.env),
      cwd, String(timeoutMs / 1000), JSON.stringify(script), String(rows), String(columns),
    ], { stdin: 'ignore', timeout: timeoutMs + 10_000, reject: false, killSignal: 'SIGKILL', stripFinalNewline: false })
    if (result.exitCode !== 0) {
      throw new Error(`PTY driver exited ${String(result.exitCode)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    const offsets = [...result.stderr.matchAll(/step \d+ at (\d+):/gu)].map(match => Number(match[1]))
    return { output: result.stdout, offsets }
  }
  finally {
    // A chosen workspace belongs to its caller, who may want to look at it.
    if (chosen === undefined) await rm(cwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * Boot and run a script, keeping only what the terminal showed.
 * @param mode - the mocked tool mode.
 * @param script - ordered steps.
 * @param options - timeout and workspace choices.
 * @returns everything the PTY emitted.
 */
export async function drivePty(
  mode: string,
  script: readonly PtyStep[],
  options: DriveOptions = {},
): Promise<string> {
  return (await drivePtySteps(mode, script, options)).output
}

/** Everything painted while the session held the alternate screen. */
export function heldOutput(output: string): string {
  const handedBack = output.indexOf(LEAVE_ALT)
  return handedBack < 0 ? output : output.slice(0, handedBack)
}

/**
 * The screen as of the frame containing the byte offset `at`.
 *
 * Cut at the end of a frame, never inside one: a frame is one synchronized
 * update, and half of one is a torn screen no terminal would ever show.
 * @param held - output from while the session held the screen.
 * @param at - byte offset to stop at, or -1 for the whole capture.
 * @returns the terminal at that point.
 */
export function screenOf(held: string, at: number): Terminal {
  const frameEnd = at < 0 ? -1 : held.indexOf(SYNC_END, at)
  const terminal = new Terminal(PTY_ROWS, PTY_COLUMNS)
  terminal.feed(held.slice(0, frameEnd < 0 ? held.length : frameEnd + SYNC_END.length))
  return terminal
}

/** The screen as of the frame in which `marker` first appears. */
export function screenAt(output: string, marker: string): Terminal {
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
export function screenAtLast(output: string, marker: string): Terminal {
  const held = heldOutput(output)
  return screenOf(held, held.lastIndexOf(marker))
}

/** The screen at the LAST frame before the terminal is handed back. */
export function finalScreen(output: string): Terminal {
  const terminal = new Terminal(PTY_ROWS, PTY_COLUMNS)
  terminal.feed(heldOutput(output))
  return terminal
}
