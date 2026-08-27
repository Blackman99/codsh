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
import { PTY_COLUMNS, PTY_ROWS, SYNC_END, drivePty, finalScreen, screenAt, screenAtLast } from './pty-driver.ts'
import { Terminal } from './vt.ts'

/** Submit what the box holds. */
const ENTER = '\r'

describe.skipIf(process.platform === 'win32')('the first five minutes', () => {
  it('welcomes with the lettermark at the TOP of the screen', async () => {
    const output = await drivePty('write', [
      // The box appearing is the settled first frame; the welcome precedes it.
      ['Ask anything', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'Ask anything').alternate
    const logoRow = rows.findIndex(row => row.includes('█') || row.includes('▀') || row.includes('▄'))
    expect(logoRow).toBeGreaterThanOrEqual(0)
    expect(logoRow).toBeLessThan(8)
    // The gap sits between the welcome and the chrome, not above the welcome.
    expect(rows.slice(-4).some(row => row.startsWith('╭'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('shows the welcome again after /clear', async () => {
    const output = await drivePty('write', [
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
    const output = await drivePty('write', [
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
    const output = await drivePty('tall', [
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
    const output = await drivePty('tall', [
      ['Welcome to codsh', `make it tall${ENTER}`, 300],
      ['lines (click or Ctrl+O expands)', `/exit${ENTER}`, 500],
    ])
    const rows = screenAt(output, 'Ctrl+O expands').alternate
    const body = rows.filter(row => row.includes('CODE_CLI_TALL_'))
    // A skimmable sliver, not a wall; the affordance names the key.
    expect(body.length).toBeLessThanOrEqual(24)
    expect(rows.some(row => row.includes('(click or Ctrl+O expands)'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('names the block the pointer rests on, and gives the row back', async () => {
    // A move with nothing held: button 35 is the motion bit over the no-button
    // code, which is what any-motion tracking sends.
    const moveTo = (line: string): string => `\u001B[<35;6;{row:${line}}M`
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      // Resting on the collapsed thought: the chrome says what it is and what
      // a click would do, before anything is clicked.
      ['thought for', moveTo('thought for'), 600],
      // Away from every block — the welcome banner — and the row is given back.
      ['click to expand', moveTo('Welcome to codsh'), 600],
      ['thought for', `/exit${ENTER}`, 400],
    ])
    const named = screenAtLast(output, 'click to expand').alternate
    expect(named.some(row => /thinking · \d+ lines · click to expand/u.test(row))).toBe(true)
    const released = finalScreen(output).alternate
    expect(released.some(row => row.includes('click to expand'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the block a click lands on, and folds it back from inside it', async () => {
    // Where a block sits depends on everything printed above it, so the click
    // aims at the line itself and the driver resolves the row it was painted
    // on. Press and release without moving: a drag would copy instead.
    const clickOn = (line: string): string => `\u001B[<0;6;{row:${line}}M\u001B[<0;6;{row:${line}}m`
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      // Thinking lands collapsed; a click on its summary opens that block.
      ['thought for', clickOn('thought for'), 600],
      // A click anywhere in the open block — not just its head line — folds it
      // back again.
      ['weighing the options carefully', clickOn('weighing the options carefully'), 600],
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
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 500],
    ])
    const screen = finalScreen(output)
    // Exactly one cost line per turn — per-step reports would print several.
    const costs = screen.alternate.filter(row => /^\s+\d+(?:\.\d+)?s( · .*tokens)?$/u.test(row))
    expect(costs).toHaveLength(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('renders model output faithfully: tables stay tables, emphasis eats its markers', async () => {
    const output = await drivePty('markdown', [
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
    const output = await drivePty('markdown', [
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

  it('searches prompt history on Ctrl+R', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', '\u0012', 400],
      ['bck-i-search', '\u001B', 300],
      ['Ask anything', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'bck-i-search').alternate
    expect(rows.some(row => row.includes('bck-i-search'))).toBe(true)
    expect(rows.some(row => row.includes('create the note'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('searches the transcript on Ctrl+F', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', '\u0006', 400],
      ['find:', 'CALL', 400],
      ['find: CALL', '\u001B', 300],
      ['Ask anything', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'find: CALL').alternate
    expect(rows.some(row => row.includes('find: CALL'))).toBe(true)
    expect(rows.some(row => row.includes('│ › CALL'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the shortcuts overlay on ? from an empty box', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', '?', 400],
      ['Ctrl+R history', '\u001B', 300],
      ['Ask anything', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'Ctrl+R history').alternate
    expect(rows.some(row => row.includes('Ctrl+R history'))).toBe(true)
    expect(rows.some(row => row.includes('Ctrl+F find'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('gives a queued line back on Escape', async () => {
    const output = await drivePty('slow', [
      ['Welcome to codsh', `take your time${ENTER}`, 300],
      ['$ sleep', `later work${ENTER}`, 400],
      ['queued: later work', '\u001B', 500],
      ['', '\u0015\u001B', 400],
      ['interrupted', `/exit${ENTER}`, 400],
    ])
    expect(screenAt(output, 'queued: later work').alternate.some(row => row.includes('queued: later work'))).toBe(true)
    const back = screenAtLast(output, 'later work').alternate
    expect(back.some(row => row.includes('later work'))).toBe(true)
    expect(back.some(row => row.includes('queued: later work'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('collapses thinking by default and expands it on Ctrl+O', async () => {
    const output = await drivePty('reasoning', [
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
