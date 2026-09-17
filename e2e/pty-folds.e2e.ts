/**
 * What streams and what folds: the live region repainting as text arrives,
 * thinking streaming as a ticking `thinking…` head that lands folded under its clock,
 * tool cards settling to one row each with the body behind the fold, the
 * todo list and ship plan panels, workflow rounds, block rules, replayed
 * folds, and the fold `/compact` leaves behind.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { PTY_COLUMNS, PTY_ROWS, SYNC_END, drivePty, drivePtySteps, finalScreen, screenOf } from './pty-driver.ts'
import { CTRL_C, ENTER, boxTops, screenAt, visible } from './pty-helpers.ts'
import { Terminal } from './vt.ts'

describe.skipIf(process.platform === 'win32')('streaming, cards and folds (real PTY)', () => {
  it('repaints the live region as text streams in', async () => {
    const output = await drivePty('markdown', [
      ['Welcome to codsh', 'explain\n', 0],
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

  it('settles a call into one card, not a finished copy under its pending one', async () => {
    // A result short enough to need no fold took the path that dropped the
    // pending card it was finishing, so every such call printed twice.
    const output = await drivePty('bash', [
      ['Welcome to codsh', `run it${ENTER}`, 300],
      ['Allow bash', ENTER, 600],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 600],
    ])

    const settled = finalScreen(output).alternate
    expect(settled.filter(row => row.includes('printf CODE_CLI_ROUND_TRIP'))).toHaveLength(1)
    expect(settled.some(row => row.includes('● bash'))).toBe(false)
    // The finished card is one row: the command, how much it printed, the
    // tick. What the call printed stays behind that row.
    expect(settled.some(row => /● printf CODE_CLI_ROUND_TRIP · 2 lines ✔/u.test(row))).toBe(true)
    expect(settled.some(row => /^\s*│\s+CODE_CLI_ROUND_TRIP$/u.test(row.trimEnd()))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps a terminal card to one row, and opens what it printed on a click', async () => {
    // Press and release without moving: a drag would copy instead. The row
    // is resolved from the last paint of the command, which is the finished
    // card once the result has taken the pending row's place.
    const clickOn = (line: string): string => `\u001B[<0;6;{row:${line}}M\u001B[<0;6;{row:${line}}m`
    const run = await drivePtySteps('bash', [
      ['Welcome to codsh', `run it${ENTER}`, 300],
      ['Allow bash', ENTER, 600],
      ['CODE_CLI_CALL_OK', clickOn('printf CODE_CLI_ROUND_TRIP'), 600],
      ['', clickOn('printf CODE_CLI_ROUND_TRIP'), 600],
      ['', `/exit${ENTER}`, 400],
    ])
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const body = (rows: readonly string[]): boolean => rows.some(row => /^\s*│\s+CODE_CLI_ROUND_TRIP$/u.test(row.trimEnd()))
    const settled = screenOf(captured(run.offsets[2]), -1).alternate
    const opened = screenOf(captured(run.offsets[3]), -1).alternate
    const shut = screenOf(captured(run.offsets[4]), -1).alternate
    // Settled: the row says how much it withholds — the call's description
    // and the one line it printed — and withholds it.
    expect(settled.some(row => /● printf CODE_CLI_ROUND_TRIP · 2 lines ✔/u.test(row))).toBe(true)
    expect(body(settled)).toBe(false)
    // A click opens the output under the same row...
    expect(opened.some(row => /● printf CODE_CLI_ROUND_TRIP · 2 lines ✔/u.test(row))).toBe(true)
    expect(body(opened)).toBe(true)
    // ...and a click inside folds it back.
    expect(body(shut)).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps a failed call to one row, and opens what it printed on Ctrl+O', async () => {
    const output = await drivePty('fail', [
      ['Welcome to codsh', `break it${ENTER}`, 300],
      ['Allow bash', ENTER, 600],
      // The row names the exit status and the count; the line stays behind.
      // Parenthesised, the status is only ever on the finished row: the bare
      // words are in the command itself, which the pending row and the
      // approval question both show first.
      ['(exit 3)', '\u000F', 600],
      ['CODE_CLI_FAIL_PRINTED', `/exit${ENTER}`, 400],
    ])
    const settled = screenAt(output, '(exit 3)').alternate
    const row = settled.find(row => row.includes('(exit 3)')) ?? ''
    // dsh's bash tool reports a non-zero exit rather than erroring it — the
    // model decides how to react — but the row still fails: ✗, not a green pass.
    expect(row).toMatch(/● sh -c .*\(exit 3\) · 2 lines ✗/u)
    expect(settled.some(row => row.includes('CODE_CLI_FAIL_PRINTED'))).toBe(false)
    const expanded = screenAt(output, 'CODE_CLI_FAIL_PRINTED').alternate
    expect(expanded.some(row => /^\s*│\s+CODE_CLI_FAIL_PRINTED$/u.test(row.trimEnd()))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps the status row live in the region', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    const rows = screenAt(output, 'CODE_CLI_CALL_OK').alternate
    // The always-current facts occupy the screen's last row, not the
    // transcript: model, composition, permissions, spend, and place.
    expect(rows.at(-1)).toMatch(/cli-mock/)
    // Submitting clears the box, so the transcript's own render is the only
    // copy of the message that survives — a row outside the box's borders.
    expect(rows.map(visible)).toContain('│   create the note')
  }, E2E_TEST_TIMEOUT_MS)

  it('streams thinking as a head, then lands it folded under its clock', async () => {
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      ['CODE_CLI_ANSWER after thinking', `/exit${ENTER}`, 400],
    ])

    // The panel opened with a head before the first line landed, and the
    // head ticked — a Braille frame rode with `thinking…`, and the working
    // line named it. SGR sits between glyphs, so strip it before matching.
    const plain = output.replaceAll(/\x1B\[[0-9;]*[A-Za-z]/gu, '')
    expect(plain).toContain('thinking…')
    expect(plain).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] thinking…/u)
    expect(plain).toMatch(/thinking [\d.]+s/u)
    // ...and the settled screen keeps the clock, the deliberation behind it.
    const rows = screenAt(output, 'CODE_CLI_ANSWER after thinking').alternate
    const clock = rows.findIndex(row => /│\s+thought for [\d.]+s/u.test(row))
    const answer = rows.findIndex(row => row.includes('CODE_CLI_ANSWER'))
    expect(clock).toBeGreaterThanOrEqual(0)
    expect(answer).toBeGreaterThan(clock)
    expect(rows.some(row => row.includes('CODE_CLI_THINKING about the request'))).toBe(false)
    expect(rows.some(row => row.includes('weighing the options carefully'))).toBe(false)
    expect(rows.some(row => row.includes('thinking…'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('folds an untouched thought to its clock when the conversation moves on', async () => {
    // The next turn anchors its own prompt at the top, so the earlier turn
    // is read by scrolling back to it.
    const wheelUp = '\u001B[<64;10;5M'
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `first question${ENTER}`, 300],
      ['CODE_CLI_ANSWER after thinking', `second question${ENTER}`, 400],
      // The turn's own tag: the first answer's repaints carry the same words.
      ['(turn 2)', wheelUp.repeat(12), 400],
      ['\u2191 12 rows above', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, '\u2191 12 rows above').alternate
    // Two clocks; both thoughts stay folded unless opened by hand.
    const clocks = rows.flatMap((row, index) => /│\s+thought for [\d.]+s/u.test(row) ? [index] : [])
    expect(clocks).toHaveLength(2)
    expect(rows.some(row => row.includes('weighing the options carefully'))).toBe(false)
    expect(rows.some(row => row.includes('second question'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it.each([60, 120])('keeps folded thoughts and the tool between them to one row at %i columns', async columns => {
    const wheelUp = '\u001B[<64;10;5M'
    const run = await drivePtySteps('reason-write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_REASONED_ANSWER', '', 600],
      ['', `and again${ENTER}`, 300],
      // The turn's own tag: the first answer's repaints carry the same words.
      ['(turn 2)', wheelUp.repeat(16), 600],
      ['\u2191 16 rows above', `/exit${ENTER}`, 400],
    ], { columns })
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const settled = screenOf(captured(run.offsets[2]), -1, PTY_ROWS, columns).alternate
    const at = (needle: string): number => settled.findIndex(row => row.includes(needle))
    // One turn, in order: a thought clock, the write as one row, a second
    // thought clock, the answer — both thoughts folded, the card's diff behind
    // its row.
    const firstClock = settled.findIndex(row => /│\s+thought for/u.test(row))
    const secondClock = settled.findIndex((row, index) => index > firstClock && /│\s+thought for/u.test(row))
    expect(firstClock).toBeGreaterThanOrEqual(0)
    expect(at('● Write note.txt +1 -0 ✔')).toBe(firstClock + 1)
    expect(secondClock).toBe(at('● Write note.txt +1 -0 ✔') + 1)
    // The answer keeps its ordinary paragraph separator, outside the fold.
    expect(settled[secondClock + 1]?.replace(/[│\s]/gu, '')).toBe('')
    expect(at('CODE_CLI_REASONED_ANSWER')).toBe(secondClock + 2)
    expect(settled.some(row => row.includes('planning the write step'))).toBe(false)
    expect(settled.some(row => row.includes('checking what the write did'))).toBe(false)
    expect(settled.some(row => row.includes('+ CODE_CLI_ROUND_TRIP'))).toBe(false)

    // Moving on leaves both turns' thoughts folded; the card stays as it was.
    const later = screenOf(run.output, run.output.indexOf('\u2191 16 rows above'), PTY_ROWS, columns).alternate
    expect(later.filter(row => /│\s+thought for/u.test(row))).toHaveLength(4)
    expect(later.some(row => row.includes('planning the write step'))).toBe(false)
    expect(later.some(row => row.includes('checking what the write did'))).toBe(false)
    expect(later.filter(row => row.includes('● Write note.txt'))).toHaveLength(2)
  }, E2E_TEST_TIMEOUT_MS)

  it('reads a long diff card in the pager on click, leaving the card collapsed', async () => {
    const clickCard = '\u001B[<0;6;{row:Write note.txt}M\u001B[<0;6;{row:Write note.txt}m'
    const output = await drivePty('tall', [
      ['Welcome to codsh', `create the tall note${ENTER}`, 300],
      // 45 diff lines, collapsed to one ToolCard line: a click opens the reader.
      ['+45 -0', clickCard, 500],
      // ...and the click opens it over the conversation, not into it.
      ['Esc closes', '\u001B', 400],
      ['Ask anything', `/exit${ENTER}`, 400],
    ])

    const reading = screenAt(output, 'Esc closes').alternate
    expect(reading[0]).toContain('Changes')
    // Raw unified text, coloured by the reader: a create runs against /dev/null.
    expect(reading.join('\n')).toContain('+++ b/note.txt')
    expect(reading.join('\n')).toContain('CODE_CLI_TALL_0')
    // The box is gone while the reader holds the screen.
    expect(reading.join('\n')).not.toContain('Ask anything')

    // Esc returns, and the card is where it was — reading is not expanding.
    const after = screenAt(output, 'Ask anything', 'last').alternate
    expect(after.some(row => row.includes('● Write note.txt +45 -0 ✔'))).toBe(true)
    expect(after.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('says how far through the plan a run is, not just which round', async () => {
    // The spec file is where progress lives: one checkbox per ticket, ticked
    // as each lands. The working line reports it as soon as the file exists.
    const output = await drivePty('spec', [
      ['Welcome to codsh', `write the plan${ENTER}`, 900],
      // Spec body is folded; the one-liner is what lands on screen.
      ['Write plan.md', '', 900],
      ['', `/exit${ENTER}`, 500],
    ], { columns: 100, rows: 16 })

    const working = output.split(SYNC_END)
      .flatMap(frame => frame.split('\n'))
      .filter(line => line.includes('working') && line.includes('1/3'))
    // One ticket of three is ticked, and the line names the one in flight.
    expect(working.length).toBeGreaterThan(0)
    expect(working.join('\n')).toContain('SHIP_TICKET_TWO')
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the ship plan in the panel, ticket by ticket', async () => {
    // The spec on disk is the plan; the panel is where the whole of it reads.
    const run = await drivePtySteps('spec', [
      ['Welcome to codsh', `write the plan${ENTER}`, 900],
      // The closed readout teases it; Ctrl+T opens the list.
      ['Ctrl+T opens the list', '\u0014', 700],
      ['SHIP_TICKET_THREE', '', 300],
      ['', `/exit${ENTER}`, 500],
    ], { columns: 100, rows: 24 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const closed = screenOf(captured(run.offsets[1]), -1, 24).alternate.join('\n')
    const open = screenOf(captured(run.offsets[2]), -1, 24).alternate.join('\n')

    // The card that wrote the spec is also on screen with the same words in
    // it, so the panel is told apart by its marks, which a diff never has.
    // Closed: one row, the count and what is being landed, and no marks.
    expect(closed).toContain('plan 1/3')
    expect(closed).not.toContain('\u25B6')
    // Open: the ticket in flight is marked, and the ones around it are too.
    expect(open).toMatch(/\u25B6 SHIP_TICKET_TWO/u)
    expect(open).toMatch(/\u2714 SHIP_TICKET_ONE/u)
    expect(open).toMatch(/\u25CB SHIP_TICKET_THREE/u)
  }, E2E_TEST_TIMEOUT_MS)

  it('opens the ship plan on a click, the way a fold does', async () => {
    const clickOn = (line: string): string => `\u001B[<0;6;{row:${line}}M\u001B[<0;6;{row:${line}}m`
    const run = await drivePtySteps('spec', [
      ['Welcome to codsh', `write the plan${ENTER}`, 900],
      ['Ctrl+T opens the list', clickOn('Ctrl+T opens the list'), 700],
      ['Ctrl+T closes', clickOn('Ctrl+T closes'), 500],
      ['Ctrl+T opens the list', `/exit${ENTER}`, 400],
    ], { columns: 100, rows: 24 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const opened = screenOf(captured(run.offsets[2]), -1, 24).alternate.join('\n')
    const shut = screenOf(captured(run.offsets[3]), -1, 24).alternate.join('\n')
    expect(opened).toMatch(/\u25B6 SHIP_TICKET_TWO/u)
    expect(opened).toMatch(/\u25CB SHIP_TICKET_THREE/u)
    expect(shut).toContain('Ctrl+T opens the list')
    expect(shut).not.toMatch(/\u25CB SHIP_TICKET_THREE/u)
  }, E2E_TEST_TIMEOUT_MS)

  it('shows a workflow round by round, in the transcript and the working line', async () => {
    // The real engine, driven by the mock: a script that runs two rounds, each
    // child answering as text. Until now this rendering had no terminal test
    // at all, because nothing could make a workflow run.
    const run = await drivePtySteps('workflow', [
      ['Welcome to codsh', `run the rounds${ENTER}`, 400],
      ['completed', '', 400],
      ['', `/exit${ENTER}`, 500],
    ], { rows: 24 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const settled = screenOf(captured(run.offsets[1]), -1, 24).alternate.join('\n')

    // The round in flight is in the working line, not the transcript: an
    // append-only transcript cannot unprint a line when the round ends. Every
    // frame is searched rather than one moment sampled: the label is also in
    // the script the tool call carries, so only a decoded working line proves
    // it, and only the frames while a round runs have one.
    const probe = new Terminal(20, PTY_COLUMNS)
    let namedARound = false
    let sawActivity = false
    for (const frame of run.output.split(SYNC_END)) {
      probe.feed(frame + SYNC_END)
      // The verb is the tool's own name once a call is in flight, so the
      // working line is recognised by what only it carries.
      if (probe.alternate.some(row => /E2E round \d.*Ctrl-C to interrupt/u.test(row))) namedARound = true
      // The child's one write reached the working line while the round ran:
      // the round reads as work, not as a hang.
      if (probe.alternate.some(row => /E2E round \d · 1 call · write/u.test(row))) sawActivity = true
    }
    expect(namedARound).toBe(true)
    expect(sawActivity).toBe(true)
    // Each settled round is one line — saying what it did — and the run
    // closes with its reason.
    expect(settled).toContain('e2e-rounds')
    expect(settled).toMatch(/\u2713 E2E round 1 · 1 call · \d/u)
    expect(settled).toMatch(/\u2713 E2E round 2 · 1 call · \d/u)
    expect(settled).toContain('completed')
    // And no door is offered, because a workflow's children live in a worker
    // thread and no click could ever open one.
    expect(settled).not.toContain('click to enter')
  }, E2E_TEST_TIMEOUT_MS)

  it('toggles a collapsed output open with Ctrl-O, and keeps that choice on moving on', async () => {
    // The next turn anchors its own prompt at the top, so the block that was
    // opened by hand is read by scrolling back to it.
    const wheelUp = '\u001B[<64;10;5M'
    const output = await drivePty('tall', [
      ['Welcome to codsh', `create the tall note${ENTER}`, 300],
      // 45 diff lines, collapsed to one line; Ctrl-O expands in place.
      ['+45 -0', '\u000F', 400],
      // ...Ctrl-O swaps the block for its full body, clipped tail included...
      ['CODE_CLI_TALL_44', `and again${ENTER}`, 400],
      // ...and the next turn preserves that explicit reading choice.
      ['CODE_CLI_CALL_OK', wheelUp.repeat(12), 400],
      ['\u2191 12 rows above', `/exit${ENTER}`, 400],
    ])

    // Expanded: the tail line is on screen where the summary was.
    const expanded = screenAt(output, 'CODE_CLI_TALL_44').alternate
    expect(expanded.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(true)
    // Still expanded after moving on: the tail remains above the next prompt.
    const after = screenAt(output, '\u2191 12 rows above').alternate
    expect(after.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(true)
    expect(after.some(row => row.includes('and again'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('leaves a thought folded for an empty Enter and a chrome command', async () => {
    // Only a turn spent moves the conversation on. A nudge on Enter and a
    // command that only works the chrome are not turns, and must not open
    // a thought that landed folded.
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      ['CODE_CLI_ANSWER after thinking', ENTER, 400],
      ['', `/status${ENTER}`, 400],
      // A `!` line runs in the shell and spends no turn either: its card
      // lands under the clock and folds nothing.
      ['permissions', `!echo THOUGHT_BANG_MARK${ENTER}`, 400],
      ['re:\\$ echo THOUGHT_BANG_MARK', '', 600],
      ['', `/exit${ENTER}`, 400],
    ])
    const after = screenAt(output, 'permissions').alternate
    expect(after.some(row => /│\s+thought for [\d.]+s/u.test(row))).toBe(true)
    expect(after.some(row => row.includes('weighing the options carefully'))).toBe(false)
    const banged = finalScreen(output).alternate
    expect(banged.some(row => row.includes('$ echo THOUGHT_BANG_MARK'))).toBe(true)
    expect(banged.some(row => row.includes('weighing the options carefully'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('lands an interrupted thought as a folded clock, with what streamed so far behind it', async () => {
    // Ctrl-C cuts the thought off mid-stream: the clock takes the head's
    // place, the deliberation stays behind the fold, and nothing of the
    // head remains.
    const output = await drivePty('reasoning-slow', [
      ['Welcome to codsh', `think slowly${ENTER}`, 300],
      // The deliberation stays off the transcript; the head is what is on
      // screen when the interrupt has to land.
      ['thinking…', CTRL_C, 400],
      ['interrupted', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, 'interrupted').alternate
    expect(rows.some(row => /│\s+thought for [\d.]+s/u.test(row))).toBe(true)
    expect(rows.some(row => row.includes('thinking…'))).toBe(false)
    expect(rows.some(row => row.includes('CODE_CLI_SLOW_THINK_3'))).toBe(false)
    expect(rows.some(row => row.includes('CODE_CLI_SLOW_THINK_11'))).toBe(false)
    expect(rows.some(row => row.includes('CODE_CLI_SLOW_ANSWER'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('replays a thought as a fold, collapsed, that Ctrl+O opens', async () => {
    // History is read back through: a resumed session shows each thought as
    // its clock, capable of opening, never the pages it streamed as.
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      ['CODE_CLI_ANSWER after thinking', `/clear${ENTER}`, 400],
      ['new session session-', `/resume${ENTER}`, 400],
      ['Resume session', ENTER, 500],
      ['resumed session-', '\u000F', 500],
      ['weighing the options carefully', `/exit${ENTER}`, 400],
    ])
    const replayed = screenAt(output, 'resumed session-').alternate
    expect(replayed.some(row => /│\s+thought/u.test(row))).toBe(true)
    expect(replayed.some(row => row.includes('weighing the options carefully'))).toBe(false)
    const expanded = screenAt(output, 'weighing the options carefully', 'last').alternate
    expect(expanded.some(row => row.includes('weighing the options carefully'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('pins the todo list in the chrome and opens it on Ctrl-T', async () => {
    // One-line chrome is `todos 1/3 · ▶ write the fix · Ctrl+T`. Colour splits
    // that across SGR, so the wait is the same line as a raw-stream regex.
    const collapsed = 're:todos[\\s\\S]{0,120}?write the fix[\\s\\S]{0,40}?Ctrl\\+T'
    const output = await drivePty('todo', [
      ['Welcome to codsh', `plan the work${ENTER}`, 300],
      [collapsed, '\u0014', 400],
      ['Ctrl+T closes', '\u0014', 400],
      [collapsed, `/exit${ENTER}`, 400],
    ])

    // Pinned: the item in flight sits directly over the status row, so the list
    // is still answerable long after its card scrolled away.
    const pinned = screenAt(output, 'write the fix').alternate
    expect(pinned.at(-1)).toMatch(/cli-mock/)
    const readout = pinned.findIndex(row => /todos 1\/3 · ▶ write the fix · Ctrl\+T/.test(row))
    expect(readout).toBeGreaterThanOrEqual(0)
    expect(pinned[readout]).toMatch(/todos 1\/3 · ▶ write the fix · Ctrl\+T/)
    // Collapsed chrome is one row: the transcript card may still list items,
    // but the readout itself is not a multi-line checklist.
    expect(pinned[readout]?.includes('read the code')).toBe(false)
    // In the chrome, not the transcript: only the rows about right now sit
    // under it — the working indicator, when one is ticking, and the status row.
    expect(pinned.length - readout).toBeLessThanOrEqual(3)

    // Opened: every item, under the header that says how to close it.
    const opened = screenAt(output, 'Ctrl+T closes').alternate
    const head = opened.findIndex(row => row.includes('Ctrl+T closes'))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(opened[head]).toMatch(/todos 1\/3 · Ctrl\+T closes/)
    expect(opened.slice(head + 1, head + 4).map(row => row.trim())).toEqual([
      '✔ read the code',
      '▶ write the fix',
      '○ run the tests',
    ])

    // Closed again: the chrome is back to one row. The card in the transcript
    // still lists the items, so the header's own key text is what separates an
    // open readout from a scrolled-back write.
    const closed = screenAt(output, ' · Ctrl+T', 'last').alternate
    expect(closed.some(row => /todos 1\/3 · ▶ write the fix · Ctrl\+T/.test(row))).toBe(true)
    expect(closed.some(row => row.includes('Ctrl+T closes'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('rules each block down its left edge, by what the block is', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    const painted = screenAt(output, 'CODE_CLI_CALL_OK', 'last').alternate
    const rows = painted.map(visible)
    // One connecting │ on every block; colour — not a different glyph —
    // says what the row is. Last paint is the flushed transcript; the first
    // CODE_CLI_CALL_OK is the live line under the box, which has no rail.
    expect(rows).toContain('│   create the note')
    expect(rows.some(row => row.includes('│ ') && row.includes('note.txt'))).toBe(true)
    expect(painted.some(row => /│/.test(row) && row.includes('CODE_CLI_CALL_OK'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('replays history as folds, so a resumed long output still opens', async () => {
    const output = await drivePty('tall', [
      ['Welcome to codsh', `create the tall note${ENTER}`, 300],
      // 45 diff lines, collapsed live to one ToolCard line...
      ['+45 -0', '\u000F', 400],
      // ...then explicitly expanded before session replacement.
      ['CODE_CLI_TALL_44', `/clear${ENTER}`, 400],
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
    expect(replayed.map(visible)).toContain('│   create the tall note')
    expect(replayed.some(row => row.includes('● Write note.txt +45 -0 ✔'))).toBe(true)
    expect(replayed.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(false)

    // After the key: the body the log carried, on screen from a fold that only
    // exists because replay rebuilt it.
    const expanded = screenAt(output, 'CODE_CLI_TALL_44', 'last').alternate
    expect(expanded.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)
})

describe.skipIf(process.platform === 'win32')('compaction feedback (real PTY)', () => {
  it('leaves a fold after /compact that names what was summarized, and opens on Ctrl+O', async () => {
    const output = await drivePty('markdown', [
      ['Welcome to codsh', `first question${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `second question${ENTER}`, 600],
      ['CODE_CLI_CALL_STREAM_DONE', `/compact${ENTER}`, 600],
      ['into a summary', '\u000F', 600],
      ['', `/exit${ENTER}`, 800],
    ], { timeoutMs: 60_000 })
    const plain = output.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    expect(plain).toMatch(/✂ compacted \d+ history items \(~\d+ tokens\) into a summary · cli-mock/u)
    expect(plain).toContain('lines of summary (click or Ctrl+O expands)')
    // dsh's own report still prints: the fold adds the summary, not a second count.
    expect(plain).toMatch(/Compacted \d+ history items/u)
  }, E2E_TEST_TIMEOUT_MS)
})
