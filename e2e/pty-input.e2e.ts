/**
 * Typing on a real terminal: a pasted block arriving as one message, Tab
 * completing, Alt-Enter breaking a line, history recall, the box wrapping
 * and holding its frame, `!` lines going to the shell, and undo.
 *
 * None of it can be exercised through a pipe — raw mode is the point — so
 * these drive `dsh code` inside a real PTY and write the actual bytes. The
 * PTY suites are split by topic because Vitest parallelises by file: the
 * run takes as long as its largest file.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { LEAVE_ALT, PTY_COLUMNS, PTY_ROWS, SYNC_END, drivePty, drivePtySteps, finalScreen, screenOf } from './pty-driver.ts'
import { CLEAR, ENTER, ESCAPE, PASTE_END, PASTE_START, boxTops, screenAt, visible } from './pty-helpers.ts'
import { Terminal } from './vt.ts'

describe.skipIf(process.platform === 'win32')('typing and keys (real PTY)', () => {
  it('takes a pasted block into the buffer whole, and waits', async () => {
    const paste = `${PASTE_START}first line of one prompt\nsecond line of it${PASTE_END}`
    const output = await drivePty('write', [
      // What a terminal actually sends for a paste: the block wrapped in markers.
      // Without them a multi-line write is indistinguishable from fast typing
      // with Enters, and guessing is how a paste turns into several turns.
      ['Welcome to codsh', paste, 0],
      // The paste did not submit: the person still decides when to send it.
      ['second line of it', ENTER, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 300],
    ])

    // Both lines sat in the box together, unsent, before Enter.
    const held = screenAt(output, 'second line of it').text
    expect(held).toContain('first line of one prompt')
    expect(held).toContain('second line of it')
    // One turn, so one tool card. Line-by-line submission would have run two.
    const done = screenAt(output, 'CODE_CLI_CALL_OK').alternate
    expect(done.filter(row => row.includes('Write note.txt'))).toHaveLength(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('completes an @ mention on Tab', async () => {
    // The unit suite covers the completer; only a terminal proves the reader was
    // actually given one, since Tab is inert without it.
    const output = await drivePty('write', [
      // `mock.cordis.patch.yml` is the overlay this harness writes into the cwd.
      ['Welcome to codsh', '@mo\t', 0],
      ['mock.cordis.patch.yml', '\n', 300],
      ['CODE_CLI_CALL_OK', '/exit\n', 300],
    ])

    expect(output).toContain('@mock.cordis.patch.yml')
  }, E2E_TEST_TIMEOUT_MS)

  it('draws a framed input box that closes on itself', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', 'typed text', 0],
      ['typed text', `${CLEAR}/exit${ENTER}`, 300],
    ])

    // A real frame around the real text, exactly one of it, pinned at the
    // bottom of the session's own screen.
    const screen = screenAt(output, 'typed text')
    const rows = screen.alternate
    expect(boxTops(screen)).toHaveLength(1)
    // The typed text sits inside the frame, which closes on itself.
    expect(rows.some(row => row.includes('│ › typed text') && row.endsWith('│'))).toBe(true)
    // The frame's last row is within the chrome at the screen's foot.
    const bottom = rows.findLastIndex(row => row.trimStart().startsWith('╰─') && row.length > PTY_COLUMNS / 2)
    expect(bottom).toBeGreaterThanOrEqual(PTY_ROWS - 4)
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the completion menu as a command is typed', async () => {
    const output = await drivePty('write', [
      // No Tab: the menu has to appear from the typing itself.
      ['Welcome to codsh', '/p', 0],
      ['Enter or leave plan mode', `${CLEAR}/exit${ENTER}`, 300],
    ])

    // Both matches, each with what it does, and one of them marked. The typed
    // fragment keeps the accent colour inside each candidate.
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('/plan')
    expect(plain).toContain('/permission')
    expect(plain).toContain('Enter or leave plan mode')
    expect(plain).toContain('❯')
    expect(output).toContain('\u001B[4m/p\u001B[24m')
  }, E2E_TEST_TIMEOUT_MS)

  it('adds a line with Alt-Enter and submits the block with Enter', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `first${ESCAPE}${ENTER}second`, 0],
      ['second', ENTER, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 300],
    ])

    const screen = screenAt(output, 'CODE_CLI_CALL_OK')
    // One turn from two lines: the break did not submit.
    expect(screen.alternate.filter(row => row.includes('Write note.txt'))).toHaveLength(1)
    // The echo keeps the block's shape: the marker on the first row, the
    // continuation aligned under it, both outside the box's borders.
    const rows = screen.alternate.map(visible)
    const echo = rows.indexOf('›   first')
    expect(echo).toBeGreaterThanOrEqual(0)
    expect(rows[echo + 1]).toBe('›   second')
  }, E2E_TEST_TIMEOUT_MS)

  it('recalls the previous submission with the up arrow', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `remembered text${ENTER}`, 0],
      ['CODE_CLI_CALL_OK', `${ESCAPE}[A`, 400],
      ['remembered text', `${CLEAR}/exit${ENTER}`, 400],
    ])

    // The recalled text is back inside the box. It appears only once: sent as a
    // single write, the typing itself never produced an intermediate frame.
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('› remembered text')
  }, E2E_TEST_TIMEOUT_MS)

  it('completes a command argument and runs it', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `${ESCAPE}[Z`, 400],
      // Typing the space after /plan opens the argument menu by itself.
      ['▲ plan mode', '/plan ', 500],
      ['leave plan mode', `\t${ENTER}`, 400],
      ['▼ plan mode off', `${CLEAR}/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('leave plan mode')
    expect(plain).toContain('▼ plan mode off')
  }, E2E_TEST_TIMEOUT_MS)

  it('ignores Escape at an idle prompt', async () => {
    const output = await drivePty('write', [
      // Press Escape with nothing running.
      ['Welcome to codsh', ESCAPE, 0],
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

  it('recalls the previous message with a double Escape', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', ESCAPE, 400],
      // The first Escape at a quiet, empty prompt arms recall and says so.
      ['ESC again to edit', ESCAPE, 200],
      // The recalled text is back in the box, editable — not submitted.
      ['create the note', `${CLEAR}/exit${ENTER}`, 400],
    ])

    // The armed hint appeared on screen, and the recalled text is back in the
    // box rather than submitted: still exactly one tool card.
    expect(screenAt(output, 'ESC again to edit').text).toContain('ESC again to edit your previous message')
    // The recall puts the text back INSIDE the box. Chrome-height changes make
    // the transcript re-emit its rows, so no byte marker is unambiguous here;
    // replaying frame by frame and watching the screen is.
    const held = output.slice(0, output.indexOf(LEAVE_ALT))
    const probe = new Terminal(PTY_ROWS, PTY_COLUMNS)
    let from = 0
    let recalled: string[] | undefined
    for (;;) {
      const end = held.indexOf(SYNC_END, from)
      if (end < 0) break
      probe.feed(held.slice(from, end + SYNC_END.length))
      from = end + SYNC_END.length
      if (probe.alternate.some(row => row.includes('│ › create the note'))) {
        // Keep the LAST such frame: the first is the original typing, before
        // the tool card existed; the last is the recall.
        recalled = [...probe.alternate]
      }
    }
    expect(recalled).toBeDefined()
    // Recalled for editing, not re-submitted: still exactly one tool card.
    expect(recalled?.filter(row => row.includes('Write note.txt'))).toHaveLength(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('moves up a wrapped line instead of recalling the last prompt', async () => {
    // A narrow window, so one typed line is more than one row on screen.
    const long = 'const alpha = beta.gamma(delta, epsilon, zeta, eta, theta)'
    const run = await drivePtySteps('write', [
      ['Welcome to codsh', `remembered prompt${ENTER}`, 500],
      // Type the long line — 40 columns makes it several rows — then Up from
      // its last row.
      ['Write note.txt', long, 400],
      [long.slice(-12), '\u001B[A', 500],
      // Submitting empties the box, so the command after it is a command.
      ['', ENTER, 700],
      ['Write note.txt', `/exit${ENTER}`, 500],
    ], { columns: 40 })

    // The frame after Up settled.
    const after = screenOf(
      Buffer.from(run.output).subarray(0, run.offsets[3]).toString(), -1,
    ).alternate.join('\n')
    // The line is still in the box: Up moved inside it. Recalling history
    // would have replaced the buffer, and this line was never submitted, so
    // it would be nowhere on screen at all.
    expect(after).toContain('const alpha')
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps the box intact while lines wider than the terminal stream in', async () => {
    // The reported corruption: streamed text sitting on the box's top border.
    // Narrow window, lines far wider than it, deltas that ignore line ends —
    // the box repaints many times inside one line.
    const output = await drivePty('wide', [
      ['Welcome to codsh', `stream something wide${ENTER}`, 2_500],
      ['WIDEDONE', `/exit${ENTER}`, 500],
    ], { columns: 60, rows: 16 })

    // Every frame, not just the last: the corruption is transient by nature.
    const probe = new Terminal(16, 60)
    const offenders: string[] = []
    for (const frame of output.split(SYNC_END)) {
      probe.feed(frame + SYNC_END)
      const border = probe.alternate.find(row => row.includes('╭'))
      if (border === undefined) continue
      // A top border is border and space; a letter on it is bled content.
      if (/[A-Za-z]/u.test(border)) offenders.push(border.trim())
    }
    expect(offenders.slice(0, 3)).toEqual([])
  }, E2E_TEST_TIMEOUT_MS)

  it('runs a queued ! line in its turn, between the prompts around it', async () => {
    // The steer mock ends a turn on its own after three seconds, so the queue
    // drains without an Escape per turn.
    // Markers match in order, so the script itself proves the sequence: the
    // first reply, then the shell card, then the shell's own follow-up reply,
    // then the prompt's. The screens at each step pin what was — and was not
    // — there yet.
    const run = await drivePtySteps('steer', [
      ['Welcome to codsh', `go${ENTER}`, 300],
      ['$ sleep', `!echo QUEUED_BANG${ENTER}after QUEUED_PROMPT${ENTER}`, 300],
      ['seen=', '', 0],
      ['$ echo QUEUED_BANG', '', 0],
      ['seen=', '', 0],
      ['seen=', `/exit${ENTER}`, 400],
    ])
    const at = (step: number): string[] => screenOf(run.output.slice(0, run.offsets[step - 1]), -1).alternate
    const promptRow = /›\s+after QUEUED_PROMPT/u
    // When the shell card had just appeared, the prompt typed after it had
    // not started its turn; by the end it had.
    expect(at(4).some(row => row.includes('$ echo QUEUED_BANG'))).toBe(true)
    expect(at(4).some(row => promptRow.test(row))).toBe(false)
    const final = finalScreen(run.output).alternate
    expect(final.some(row => promptRow.test(row))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('runs a ! line in the shell and the agent sees the output', async () => {
    const output = await drivePty('echo', [
      ['Welcome to codsh', `!echo BANG_PTY_7${ENTER}`, 300],
      ['bang=yes', `/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('$ echo BANG_PTY_7')
    expect(plain).toContain('BANG_PTY_7')
    expect(plain).toContain('bang=yes')
  }, E2E_TEST_TIMEOUT_MS)
})

describe.skipIf(process.platform === 'win32')('undo and redo (real PTY)', () => {
  it('takes typing back on Ctrl+Z and returns it on Ctrl+Shift+Z', async () => {
    // Ctrl+Z is the raw byte 0x1A; redo has no legacy byte, so it is the
    // kitty report for Ctrl+Shift+Z — the protocol this surface pushes.
    const undo = '\u001A'
    const redo = '\u001B[122;6u'
    const run = await drivePtySteps('write', [
      ['Welcome to codsh', 'hello', 0],
      ['hello', `${PASTE_START} pasted words${PASTE_END}`, 300],
      ['pasted words', undo, 300],
      ['', redo, 400],
      ['', `${CLEAR}/exit${ENTER}`, 400],
    ])

    // The screen as each step was written: the settle before it let the
    // previous key's frame land.
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const screenBefore = (step: number): string => screenOf(captured(run.offsets[step]), -1).alternate.join('\n')
    const pasted = screenBefore(2)
    const undone = screenBefore(3)
    const redone = screenBefore(4)
    expect(pasted).toContain('› hello pasted words')
    // The paste came off as one step; the typed word is still there.
    expect(undone).toMatch(/› hello\s+│/u)
    expect(undone).not.toContain('pasted words')
    expect(redone).toContain('› hello pasted words')
  }, E2E_TEST_TIMEOUT_MS)
})
