/**
 * The behaviours that exist only on a terminal: Escape interrupting a turn, a
 * pasted block arriving as one message, Tab completing, and the live region
 * repainting as text streams.
 *
 * Neither can be exercised through a pipe — Escape needs raw mode, and a pipe's
 * lines are separate instructions by design — so these drive `dsh code` inside a
 * real PTY and write the actual bytes.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { PTY_COLUMNS, PTY_ROWS, SYNC_END, drivePty, drivePtySteps } from './pty-driver.ts'
import { Terminal, render } from './vt.ts'

/** The surface handing the terminal back; nothing after it is session screen. */
const LEAVE_ALT = '\u001B[?1049l'

/**
 * The screen as it stood when `marker` was last emitted.
 *
 * The surface owns its screen, so its output is frames rather than lines:
 * replaying them through a terminal is what turns a capture back into what a
 * person saw at that moment.
 * @param output - everything the PTY emitted.
 * @param marker - text to stop at; the whole capture when absent.
 * @returns the terminal at that point.
 */
function screenAt(output: string, marker: string, occurrence: 'first' | 'last' = 'first'): Terminal {
  // Only what the session showed while it held the screen: the frames after it
  // hands the terminal back have already torn the chrome down.
  const handedBack = output.indexOf(LEAVE_ALT)
  const held = handedBack < 0 ? output : output.slice(0, handedBack)
  // First occurrence by default: teardown reflows the viewport and re-emits
  // transcript bytes, so the LAST copy of a transcript marker is usually the
  // chrome-less exit frame. `last` is for markers that only chrome paints.
  const at = occurrence === 'first' ? held.indexOf(marker) : held.lastIndexOf(marker)
  if (at < 0) return render(held, PTY_ROWS, PTY_COLUMNS)
  // Cut at the end of the frame the marker appeared in, never inside it: a
  // frame is one synchronized update, and half of one is a torn screen no
  // terminal would ever show.
  const frameEnd = held.indexOf(SYNC_END, at)
  return render(held.slice(0, frameEnd < 0 ? held.length : frameEnd + SYNC_END.length), PTY_ROWS, PTY_COLUMNS)
}

/**
 * Rows that start the INPUT box's frame.
 *
 * The banner is boxed too, so width is what tells them apart: the input box
 * spans the terminal, the banner is as wide as its own text.
 */
const boxTops = (terminal: Terminal): number[] =>
  terminal.alternate.flatMap((row, index) => row.trimStart().startsWith('╭─') && row.length > PTY_COLUMNS / 2 ? [index] : [])

/** A painted row without the viewport gutter, for assertions on the content. */
const visible = (row: string): string => row.replace(/^ {2}/u, '').trimEnd()

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
/**
 * Drive a PTY through an ordered script: wait for each marker, then write its
 * payload. Exits 124 when a marker never arrives, so a hang is a named failure
 * rather than a timeout with no explanation.
 */

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

    // Each delta repaints the row being typed, which is the token-level display.
    const repaints = output.split('\u001B[K').length - 1
    expect(repaints).toBeGreaterThan(10)
    // Mid-stream: the answer is on screen once, the box is still up — type-ahead
    // must stay visible — and the cursor is inside the box, not parked on the
    // status row, which is the collision this pins down.
    const mid = screenAt(output, 'CODE_CLI_HEADING')
    expect(mid.alternate.filter(row => row.includes('CODE_CLI_HEADING'))).toHaveLength(1)
    const tops = boxTops(mid)
    expect(tops).toHaveLength(1)
    expect(mid.cursorRow).toBeGreaterThan(tops[0] ?? 0)
    expect(mid.cursorRow).toBeLessThan(PTY_ROWS - 1)
  }, E2E_TEST_TIMEOUT_MS)

  it('draws a framed input box that closes on itself', async () => {
    const output = await drivePty('write', [
      ['/help for commands', 'typed text', 0],
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
    expect(output).toContain('\u001B[4m/p\u001B[24m')
  }, E2E_TEST_TIMEOUT_MS)

  it('adds a line with Alt-Enter and submits the block with Enter', async () => {
    const output = await drivePty('write', [
      ['/help for commands', `first${ESCAPE}${ENTER}second`, 0],
      ['second', ENTER, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 300],
    ])

    const screen = screenAt(output, 'CODE_CLI_CALL_OK')
    // One turn from two lines: the break did not submit.
    expect(screen.alternate.filter(row => row.includes('Write note.txt'))).toHaveLength(1)
    // The echo keeps the block's shape: the marker on the first row, the
    // continuation aligned under it, both outside the box's borders.
    const rows = screen.alternate.map(visible)
    const echo = rows.indexOf('┃ › first')
    expect(echo).toBeGreaterThanOrEqual(0)
    expect(rows[echo + 1]).toBe('┃   second')
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

    const rows = screenAt(output, 'CODE_CLI_CALL_OK').alternate
    // The always-current facts occupy the screen's last row, not the
    // transcript: model, composition, permissions, spend, and place.
    expect(rows.at(-1)).toMatch(/cli-mock · code-cli · workspace-write · \d+k? tokens/)
    // Submitting clears the box, so the transcript's own render is the only
    // copy of the message that survives — a row outside the box's borders.
    expect(rows.map(visible)).toContain('┃ › create the note')
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

  it('streams thinking as a live line and collapses it to a summary', async () => {
    const output = await drivePty('reasoning', [
      ['/help for commands', `think it over${ENTER}`, 300],
      ['CODE_CLI_ANSWER after thinking', `/exit${ENTER}`, 400],
    ])

    // The thought was visible while it streamed...
    expect(output).toContain('CODE_CLI_THINKING')
    // ...but the settled screen keeps one summary line, not the pages.
    const rows = screenAt(output, 'CODE_CLI_ANSWER after thinking').alternate
    const summary = rows.findIndex(row => /✻ thought for [\d.]+s · \+\d+ lines \(click or Ctrl\+O expands\)/u.test(row))
    expect(summary).toBeGreaterThanOrEqual(0)
    expect(rows.some(row => row.includes('weighing the options'))).toBe(false)
    expect(summary).toBeLessThan(rows.findIndex(row => row.includes('CODE_CLI_ANSWER')))
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

  it('toggles a collapsed output open with Ctrl-O, and folds it on moving on', async () => {
    const output = await drivePty('tall', [
      ['/help for commands', `create the tall note${ENTER}`, 300],
      // 45 diff lines, collapsed: the card names the expand key...
      ['Ctrl+O expands', '\u000F', 400],
      // ...Ctrl-O swaps the block for its full body, clipped tail included...
      ['CODE_CLI_TALL_44', `/status${ENTER}`, 400],
      // ...and the next submission folds it back, like clicking elsewhere.
      ['permissions', `/exit${ENTER}`, 400],
    ])

    // Expanded: the tail line is on screen where the summary was.
    const expanded = screenAt(output, 'CODE_CLI_TALL_44').alternate
    expect(expanded.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(true)
    // Collapsed again after moving on: summary back, tail gone.
    const after = screenAt(output, 'permissions').alternate
    expect(after.some(row => row.includes('Ctrl+O expands'))).toBe(true)
    expect(after.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('pins the todo list in the chrome and opens it on Ctrl-T', async () => {
    const output = await drivePty('todo', [
      ['/help for commands', `plan the work${ENTER}`, 300],
      // The readout names its own key, the way a fold names Ctrl-O...
      ['Ctrl+T opens the list', '\u0014', 400],
      // ...opens to every item...
      ['Ctrl+T closes', '\u0014', 400],
      // ...and closes back to the one line.
      ['Ctrl+T opens the list', `/exit${ENTER}`, 400],
    ])

    // Pinned: the item in flight sits directly over the status row, so the list
    // is still answerable long after its card scrolled away.
    const pinned = screenAt(output, 'Ctrl+T opens the list').alternate
    expect(pinned.at(-1)).toMatch(/cli-mock · code-cli/)
    const readout = pinned.findIndex(row => row.includes('Ctrl+T opens the list'))
    expect(pinned[readout]).toContain('▶ write the fix')
    expect(pinned[readout]).toContain('1/3')
    // In the chrome, not the transcript: only the rows about right now sit
    // under it — the working indicator, when one is ticking, and the status row.
    expect(pinned.length - readout).toBeLessThanOrEqual(3)

    // Opened: every item, under the header that says how to close it.
    const opened = screenAt(output, 'Ctrl+T closes').alternate
    const head = opened.findIndex(row => row.includes('Ctrl+T closes'))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(opened.slice(head + 1, head + 4).map(row => row.trim())).toEqual([
      '✔ read the code',
      '▶ write the fix',
      '○ run the tests',
    ])

    // Closed again: the chrome is back to one row. The card in the transcript
    // still lists the items, so the header's own key text is what separates an
    // open readout from a scrolled-back write.
    const closed = screenAt(output, 'Ctrl+T opens the list', 'last').alternate
    expect(closed.some(row => row.includes('Ctrl+T closes'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('speaks the kitty keyboard protocol: pushed on entry, Shift+Enter breaks the line', async () => {
    const output = await drivePty('write', [
      // A kitty-capable terminal sends Shift+Enter as CSI 13;2u.
      ['/help for commands', `first${ESCAPE}[13;2usecond`, 300],
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
    const echo = done.findIndex(row => visible(row).startsWith('┃ › first'))
    expect(echo).toBeGreaterThanOrEqual(0)
    expect(done[echo + 1] ?? '').toContain('second')
  }, E2E_TEST_TIMEOUT_MS)

  it('reads focus and background reports: no bell while focused, light palette adopted', async () => {
    const output = await drivePty('bash', [
      // The terminal reports focus, then answers the background question with
      // white — the decoder must consume both, never type them.
      ['/help for commands', `${ESCAPE}[I${ESCAPE}]11;rgb:ffff/ffff/ffff\u0007run the command${ENTER}`, 300],
      ['Allow bash?', 'n', 400],
      ['CODE_CLI_CALL_DENIED', `/exit${ENTER}`, 400],
    ])

    const held = output.slice(0, output.indexOf('\u001B[?1049l'))
    // Every BEL in the run terminates an OSC: the approval rang no bell,
    // because the person was already looking at the terminal.
    const bels = (held.match(/\u0007/gu) ?? []).length
    const oscs = (held.match(/\u001B\]/gu) ?? []).length
    expect(bels).toBe(oscs)
    // The light answer swapped the secondary-text shade for later frames.
    expect(held).toContain('\u001B[38;5;242m')
    // And nothing of the reports leaked into visible text.
    const plain = held.replaceAll(/\u001B(?:\[[0-9;?<>:]*[A-Za-z]|\][^\u0007]*\u0007)/gu, '')
    expect(plain).not.toContain('rgb:')
  }, E2E_TEST_TIMEOUT_MS)

  it('selects with the mouse and copies on release', async () => {
    const output = await drivePty('write', [
      ['/help for commands', `create the note${ENTER}`, 300],
      // Press at the top, drag down over the banner, release: the gesture IS
      // the copy — no keystroke follows it.
      ['CODE_CLI_CALL_OK', `${ESCAPE}[<0;1;1M${ESCAPE}[<32;60;6M${ESCAPE}[<32;120;12M${ESCAPE}[<0;120;12m`, 400],
      ['copied', `/exit${ENTER}`, 500],
    ])

    // The drag painted a reverse-video span.
    expect(output).toContain('\u001B[7m')
    // Release wrote the clipboard through OSC 52, with the banner text in it.
    const osc = /\u001B\]52;c;([A-Za-z0-9+/=]+)\u0007/.exec(output)
    expect(osc).not.toBeNull()
    const copied = Buffer.from(osc?.[1] ?? '', 'base64').toString('utf8')
    expect(copied).toContain('Welcome to codsh')
    // Plain text: the styling on screen stayed out of the clipboard.
    expect(copied).not.toContain('\u001B')
    // And the toast said so.
    const frame = screenAt(output, 'copied', 'last')
    expect(frame.alternate.some(row => /✓ copied \d+ lines/u.test(row))).toBe(true)
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

    const rows = screenAt(output, 'resumed session-', 'last').alternate.map(visible)
    // Switching sessions clears the retired viewport, then replays the resumed
    // log: exactly one echo, and none of the interim session's chatter.
    expect(rows.filter(row => row === '┃ › remember DELTA_ONE')).toHaveLength(1)
    expect(rows.some(row => row.includes('new session session-'))).toBe(false)
    // The window title tracks the surface on a real terminal.
    expect(output).toContain('\u001B]2;dsh code —')
  }, E2E_TEST_TIMEOUT_MS)

  it('rules each block down its left edge, by what the block is', async () => {
    const output = await drivePty('write', [
      ['/help for commands', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    const rows = screenAt(output, 'CODE_CLI_CALL_OK').alternate.map(visible)
    // The person's own words carry the heavy mark; the tool block the light
    // one — which is what tells two segments apart without a frame or a fill.
    expect(rows).toContain('┃ › create the note')
    expect(rows.some(row => row.includes('│ ') && row.includes('note.txt'))).toBe(true)
    // What a person reads stays flush: the answer is not marked at all.
    expect(rows.some(row => row.startsWith('CODE_CLI_CALL_OK'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('replays history as folds, so a resumed long output still opens', async () => {
    const output = await drivePty('tall', [
      ['/help for commands', `create the tall note${ENTER}`, 300],
      // 45 diff lines, collapsed live...
      ['Ctrl+O expands', `/clear${ENTER}`, 400],
      ['new session session-', `/resume${ENTER}`, 400],
      ['Resume session', ENTER, 500],
      // ...and the replayed card still promises the key...
      ['resumed session-', '\u000F', 500],
      // ...which must actually deliver the body, or the promise was a lie and
      // the output would be unreachable for the rest of the session.
      ['CODE_CLI_TALL_44', `/exit${ENTER}`, 400],
    ])

    // Replayed, before the key: the log's own message above a card still
    // collapsed to its summary — history as the turn left it.
    const replayed = screenAt(output, 'resumed session-').alternate
    expect(replayed.map(visible)).toContain('┃ › create the tall note')
    expect(replayed.some(row => row.includes('Ctrl+O expands'))).toBe(true)
    expect(replayed.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(false)

    // After the key: the body the log carried, on screen from a fold that only
    // exists because replay rebuilt it.
    const expanded = screenAt(output, 'CODE_CLI_TALL_44', 'last').alternate
    expect(expanded.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('runs a ! line in the shell and the agent sees the output', async () => {
    const output = await drivePty('echo', [
      ['/help for commands', `!echo BANG_PTY_7${ENTER}`, 300],
      ['bang=yes', `/exit${ENTER}`, 400],
    ])

    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toContain('$ echo BANG_PTY_7')
    expect(plain).toContain('BANG_PTY_7')
    expect(plain).toContain('bang=yes')
  }, E2E_TEST_TIMEOUT_MS)

  it('re-lays-out the whole viewport after a terminal resize', async () => {
    const narrow = 80
    const { output, offsets } = await drivePtySteps('write', [
      ['/help for commands', `create the note${ENTER}`, 300],
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
    // The settled frame after the post-resize turn completes — a mid-typing
    // frame can catch the chrome one row from where the next frame puts it.
    const at = held.indexOf('CODE_CLI_CALL_OK', resizeAt)
    const frameEnd = held.indexOf(SYNC_END, held.indexOf(SYNC_END, at) + 1)
    const terminal = new Terminal(PTY_ROWS, PTY_COLUMNS)
    terminal.feed(held.slice(0, resizeAt))
    terminal.resize(PTY_ROWS, narrow)
    terminal.feed(held.slice(resizeAt, frameEnd < 0 ? held.length : frameEnd + SYNC_END.length))
    const rows = terminal.alternate
    const foot = rows.slice(-4)
    expect(foot.filter(row => row.trimStart().startsWith('╭─') && row.length > narrow / 2)).toHaveLength(1)
    expect(rows.findLastIndex(row => row.trimStart().startsWith('╰─') && row.length > narrow / 2)).toBeGreaterThanOrEqual(PTY_ROWS - 4)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(narrow)
    // The session kept working at the new size.
    expect(held.includes('still here')).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)
})
