/**
 * The terminal protocols and the session's lifecycle: Escape interrupting a
 * turn, the kitty keyboard protocol, focus and background reports, resize,
 * the replayable trace, `/clear` and `/resume`, desktop notifications, and
 * rewinding to an earlier turn.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { LEAVE_ALT, PTY_COLUMNS, PTY_ROWS, SYNC_END, drivePty, drivePtySteps, finalScreen } from './pty-driver.ts'
import { ENTER, ESCAPE, screenAt, visible } from './pty-helpers.ts'
import { Terminal } from './vt.ts'

describe.skipIf(process.platform === 'win32')('protocols and the session (real PTY)', () => {
  it('offers Escape as the interrupt on a terminal', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', '/exit\n', 0],
    ])

    // The banner names whichever interrupt this surface can actually offer.
    expect(output).toContain('⇧Tab plan · ESC')
    expect(output).not.toContain('Ctrl-C interrupts')
  }, E2E_TEST_TIMEOUT_MS)

  it('cancels a running turn and returns to the prompt', async () => {
    const output = await drivePty('slow', [
      // Start a turn whose tool occupies it.
      ['Welcome to codsh', 'take your time\n', 0],
      // The command is running; press Escape alone. The wait is on the approval
      // prompt rather than on `$ sleep`: a pending call is now one merged row
      // (`Running 1 command`) and the command text lives behind the fold, so the
      // literal `$ sleep` no longer reaches the output at all.
      ['Running 1 command', ESCAPE, 0],
      // The turn is cancelled, so the prompt comes back and accepts more.
      //
      // `/exit` is the assertion that Escape released the reader's decoder: a
      // still-suspended decoder consumes the leading slash as the byte that
      // would have identified an arrow key, leaving `exit` — an ordinary prompt
      // that starts another turn instead of leaving, which times out here.
      ['interrupted', '/exit\n', 300],
    ])

    expect(output).toContain('Running 1 command')
    expect(output).toContain('interrupted')
    // The mocked model answers only after a tool result; a cancelled call
    // produces none, so its closing message must never appear.
    expect(output).not.toContain('CODE_CLI_CALL_OK')
    // Leaving normally after the interrupt proves the session survived it.
    expect(output).toMatch(/session session-/)
  }, E2E_TEST_TIMEOUT_MS)

  it('records a replayable trace of what it drew, when asked to', async () => {
    // A corrupted frame is a disagreement between what the surface emitted and
    // what the terminal did with it, and the emitted half is unrecoverable
    // afterwards. CODSH_TRACE keeps it.
    const dir = await mkdtemp('/tmp/codsh-trace-')
    const path = join(dir, 'trace')
    try {
      const output = await drivePty('write', [
        ['Welcome to codsh', `note the work${ENTER}`, 600],
        ['Edited 1 file', `/exit${ENTER}`, 500],
      ], { columns: 60, rows: 16, env: { CODSH_TRACE: path } })

      const trace = await readFile(path, 'utf8')
      // It leads with the geometry the bytes were painted for; replaying them
      // without it would be replaying at the wrong size.
      expect(trace).toMatch(/\u001B_codsh;start 60x16 /u)
      // And the bytes themselves reproduce the screen the run ended on.
      const fromTrace = screenAt(trace, 'Edited 1 file', 'last').alternate
      const fromRun = screenAt(output, 'Edited 1 file', 'last').alternate
      expect(fromTrace).toEqual(fromRun)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('speaks the kitty keyboard protocol: pushed on entry, Shift+Enter breaks the line', async () => {
    const output = await drivePty('write', [
      // A kitty-capable terminal sends Shift+Enter as CSI 13;2u.
      ['Welcome to codsh', `first${ESCAPE}[13;2usecond`, 300],
      // Both halves in the box; Enter submits them as ONE message.
      ['second', ENTER, 400],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    // The flag is pushed inside the session and popped before it ends.
    const held = output.slice(0, output.indexOf('\u001B[?1049l'))
    expect(held.indexOf('\u001B[?1049h')).toBeLessThan(held.indexOf('\u001B[>1u'))
    expect(held).toContain('\u001B[<u')
    // The report broke the line: both halves stacked in the box...
    const typing = screenAt(output, 'second').alternate
    const boxRow = typing.findIndex(row => row.includes('› first'))
    expect(boxRow).toBeGreaterThanOrEqual(0)
    expect(typing[boxRow + 1] ?? '').toContain('second')
    // ...and the transcript echoes the one two-line message.
    const done = screenAt(output, 'CODE_CLI_CALL_OK').alternate
    const echo = done.findIndex(row => visible(row).startsWith('›   first'))
    expect(echo).toBeGreaterThanOrEqual(0)
    expect(done[echo + 1] ?? '').toContain('second')
  }, E2E_TEST_TIMEOUT_MS)

  it('speaks Ctrl+Enter as steer under the kitty protocol', async () => {
    const output = await drivePty('steer', [
      ['Welcome to codsh', `take your time${ENTER}`, 300],
      // CSI 13;5u is Ctrl+Enter: the line goes into the running turn. The wait
      // is on the approval prompt because a pending call is now one merged row
      // and its command text lives behind the fold.
      ['Running 1 command', `CODE_CLI_STEER_MARK now${ESCAPE}[13;5u`, 300],
      ['re:steering:[^\\r\\n]{0,40}CODE_CLI_STEER_MARK', '', 0],
      ['seen=yes', `/exit${ENTER}`, 400],
    ])
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('steering: CODE_CLI_STEER_MARK now')
    const final = finalScreen(output).alternate
    // One reply and one turn-cost line: the steer joined the running turn.
    expect(final.filter(row => row.includes('CODE_CLI_STEER seen='))).toHaveLength(1)
    expect(final.filter(row => /^\s+\d+(?:\.\d+)?s · /u.test(row))).toHaveLength(1)
    expect(final.some(row => row.includes('seen=yes'))).toBe(true)
    expect(final.some(row => /›\s+CODE_CLI_STEER_MARK now/u.test(row))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('reads focus and background reports: no bell while focused, light palette adopted', async () => {
    const output = await drivePty('bash', [
      // The terminal reports focus, then answers the background question with
      // white — the decoder must consume both, never type them.
      ['Welcome to codsh', `${ESCAPE}[I${ESCAPE}]11;rgb:ffff/ffff/ffff\u0007run the command${ENTER}`, 300],
      ['Running 1 command', 'n', 400],
      ['CODE_CLI_CALL_DENIED', `/exit${ENTER}`, 400],
    ])

    const held = output.slice(0, output.indexOf('\u001B[?1049l'))
    // Every BEL in the run terminates an OSC: the approval rang no bell,
    // because the person was already looking at the terminal.
    const bels = (held.match(/\u0007/gu) ?? []).length
    const oscs = (held.match(/\u001B\]/gu) ?? []).length
    expect(bels).toBe(oscs)
    // Nor did it notify: focused, the person is already here.
    expect(held).not.toContain('\u001B]9;')
    // The light answer swapped the secondary-text shade for later frames.
    expect(held).toContain('\u001B[38;5;242m')
    // And nothing of the reports leaked into visible text.
    const plain = held.replaceAll(/\u001B(?:\[[0-9;?<>:]*[A-Za-z]|\][^\u0007]*\u0007)/gu, '')
    expect(plain).not.toContain('rgb:')
  }, E2E_TEST_TIMEOUT_MS)

  it('clears to a fresh session, then resumes the old one through the selector', async () => {
    const output = await drivePty('echo', [
      ['Welcome to codsh', `remember DELTA_ONE${ENTER}`, 300],
      ['remembered=yes', `/clear${ENTER}`, 400],
      ['new session session-', `/resume${ENTER}`, 400],
      // The retired session is the one on offer; Enter takes it.
      ['Resume session', ENTER, 400],
      ['resumed session-', `/exit${ENTER}`, 500],
    ])

    const rows = screenAt(output, 'resumed session-', 'last').alternate.map(visible)
    // Switching sessions clears the retired viewport, then replays the resumed
    // log: exactly one echo, and none of the interim session's chatter.
    expect(rows.filter(row => row === '›   remember DELTA_ONE')).toHaveLength(1)
    expect(rows.some(row => row.includes('new session session-'))).toBe(false)
    // The window title tracks the surface on a real terminal.
    expect(output).toContain('\u001B]2;dsh code —')
  }, E2E_TEST_TIMEOUT_MS)

  it('re-lays-out the whole viewport after a terminal resize', async () => {
    const narrow = 80
    const { output, offsets } = await drivePtySteps('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      // Shrink the window mid-session: every row has to be laid out again, and
      // a viewport repaint has no old frame to leave behind.
      ['CODE_CLI_CALL_OK', `@WINSZ:${PTY_ROWS}x${narrow}`, 600],
      ['', `still here${ENTER}`, 500],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    // Replayed the way the terminal lived it: wide frames at the wide size,
    // then the emulator resizes exactly where the window did, then the rest.
    const held = output.slice(0, output.indexOf(LEAVE_ALT))
    const resizeAt = offsets[1] ?? 0
    // The settled frame is the last whole one before `/exit` reaches the box:
    // the turn is over by then, while counting frames from the tool marker
    // judges the layout on whichever repaint happened to be in flight.
    const typed = held.lastIndexOf('/exit')
    const settled = held.lastIndexOf(SYNC_END, typed < 0 ? held.length : typed)
    const terminal = new Terminal(PTY_ROWS, PTY_COLUMNS)
    terminal.feed(held.slice(0, resizeAt))
    terminal.resize(PTY_ROWS, narrow)
    terminal.feed(held.slice(resizeAt, settled < 0 ? held.length : settled + SYNC_END.length))
    const rows = terminal.alternate
    const foot = rows.slice(-5)
    expect(foot.filter(row => row.trimStart().startsWith('╭─') && row.length > narrow / 2)).toHaveLength(1)
    expect(rows.findLastIndex(row => row.trimStart().startsWith('╰─') && row.length > narrow / 2)).toBeGreaterThanOrEqual(PTY_ROWS - 4)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(narrow)
    // The session kept working at the new size.
    expect(held.includes('still here')).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)
})

describe.skipIf(process.platform === 'win32')('desktop notifications (real PTY)', () => {
  it('notifies through the terminal while the window is unfocused, naming what waits', async () => {
    const output = await drivePty('bash', [
      // The window reports focus out, then a turn asks for approval.
      ['Welcome to codsh', `${ESCAPE}[Orun it${ENTER}`, 300],
      ['Running 1 command', 'n', 400],
      ['CODE_CLI_CALL_DENIED', `/exit${ENTER}`, 400],
    ])
    const notices = [...output.matchAll(/\u001B\]9;([^\u0007]*)\u0007/gu)].map(match => match[1])
    expect(notices).toEqual(['waiting for approval: bash: printf CODE_CLI_ROUND_TRIP'])
  }, E2E_TEST_TIMEOUT_MS)
})

describe.skipIf(process.platform === 'win32')('rewind (real PTY)', () => {
  it('forks the conversation from before a chosen turn and continues there', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `first request${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `second request${ENTER}`, 400],
      ['CODE_CLI_CALL_OK', `third request${ENTER}`, 400],
      // The picker opens newest first; Enter takes back the last turn.
      ['CODE_CLI_CALL_OK', `/rewind${ENTER}`, 400],
      ['Rewind to before turn', ENTER, 400],
      // The fork is a live session: a new prompt runs on it. Its write may be
      // refused — the new agent never read the file the discarded turn wrote —
      // so the turn ending is the assertion, not the tool's outcome.
      ['rewound to before turn 3', `fourth request${ENTER}`, 600],
      ['CODE_CLI_CALL_', `/exit${ENTER}`, 400],
    ], { timeoutMs: 60_000 })
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    const rewound = screenAt(output, 'rewound to before turn 3').alternate
    // The report wraps at 120 columns, so it is read off the screen with its
    // padding squeezed out: two session ids, and not the same one twice.
    const said = /nowon(session-[\w-]+)·(session-[\w-]+)staysin\/resume/u.exec(rewound.join('').replaceAll(/\s+/gu, ''))
    expect(said).not.toBeNull()
    expect(said?.[1]).not.toBe(said?.[2])
    // The replayed fork carries the first two turns and not the third.
    expect(rewound.some(row => row.includes('›   first request'))).toBe(true)
    expect(rewound.some(row => row.includes('›   second request'))).toBe(true)
    expect(rewound.some(row => row.includes('›   third request'))).toBe(false)
    expect(plain).toContain('› fourth request')
  }, E2E_TEST_TIMEOUT_MS)
})
