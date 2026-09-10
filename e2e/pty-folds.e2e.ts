/**
 * What streams and what folds: the live region repainting as text arrives,
 * thinking collapsing to a summary, tool cards settling, the todo list and
 * ship plan panels, workflow rounds, block rules, replayed folds, and the
 * fold `/compact` leaves behind.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { PTY_COLUMNS, PTY_ROWS, SYNC_END, drivePty, drivePtySteps, screenOf } from './pty-driver.ts'
import { ENTER, boxTops, screenAt, visible } from './pty-helpers.ts'
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

  it('never folds a call that is waiting on the person', async () => {
    // `bash` asks for a sandbox escalation, so this call reaches the keyboard
    // for approval. A question addressed to the person must never be hidden
    // behind a collapsed summary, so it stands on its own row with its alert
    // glyph instead of joining the merged group.
    const output = await drivePty('bash', [
      ['Welcome to codsh', `run it${ENTER}`, 300],
      ['Allow bash', ENTER, 600],
      ['CODE_CLI_CALL_OK', '\u000F', 600],
      ['', `/exit${ENTER}`, 600],
    ])

    const settled = screenAt(output, 'printf CODE_CLI_ROUND_TRIP', 'last').alternate
    // Its own row, not a group row: no merged label stands for this call.
    expect(settled.filter(row => row.includes('Ran 1 command'))).toHaveLength(0)
    expect(settled.some(row => row.includes('⚠ printf CODE_CLI_ROUND_TRIP'))).toBe(true)
    // The old per-card headline is gone either way.
    expect(settled.some(row => row.includes('● bash'))).toBe(false)
    // Ctrl+O opened it: the real command and its output are the body.
    expect(settled.some(row => row.trim() === '│   CODE_CLI_ROUND_TRIP')).toBe(true)
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
    expect(rows.map(visible)).toContain('›   create the note')
  }, E2E_TEST_TIMEOUT_MS)

  it('renders a tool call as one muted group row, with no panel and no amber', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 400],
    ])

    const rows = screenAt(output, 'CODE_CLI_CALL_OK').alternate
    const group = rows.filter(row => row.includes('Edited 1 file'))
    // One row stands for the call — not a padded card with a coloured headline.
    expect(group).toHaveLength(1)
    const [row = ''] = group
    // Muted means muted: no amber tool name, and no background panel behind it.
    expect(row).not.toContain('\u001B[38;5;172m')
    expect(row).not.toMatch(/\u001B\[48;[25];/)
    // The old per-card headline is gone.
    expect(rows.some(candidate => candidate.includes('● write'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('streams thinking as three live rows and collapses it to a summary', async () => {
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      ['CODE_CLI_ANSWER after thinking', `/exit${ENTER}`, 400],
    ])

    // While it streamed, the preview held several rows at once (compact's
    // budget is three), which is what makes the reasoning the main area.
    const mid = screenAt(output, 'settling on one').alternate
    const thought = mid.filter(row => row.includes('CODE_CLI_THINKING') || row.includes('weighing the options') || row.includes('checking the render path') || row.includes('comparing two shapes') || row.includes('settling on one'))
    expect(thought.length).toBeGreaterThanOrEqual(3)
    // ...but the settled screen keeps one summary line, not the pages.
    const rows = screenAt(output, 'CODE_CLI_ANSWER after thinking').alternate
    const summary = rows.findIndex(row => /✻\s+thought for [\d.]+s/u.test(row))
    expect(summary).toBeGreaterThanOrEqual(0)
    expect(rows.some(row => row.includes('weighing the options'))).toBe(false)
    expect(summary).toBeLessThan(rows.findIndex(row => row.includes('CODE_CLI_ANSWER')))
  }, E2E_TEST_TIMEOUT_MS)

  it('reads a long diff in the pager on click, leaving the group row collapsed', async () => {
    const clickCard = '\u001B[<0;6;{row:Edited 1 file}M\u001B[<0;6;{row:Edited 1 file}m'
    const output = await drivePty('tall', [
      ['Welcome to codsh', `create the tall note${ENTER}`, 300],
      // 45 diff lines, folded into one group row: a click opens the reader.
      ['Edited 1 file', clickCard, 500],
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

    // Esc returns, and the group row is where it was — reading is not expanding.
    const after = screenAt(output, 'Ask anything', 'last').alternate
    expect(after.some(row => row.includes('● Edited 1 file'))).toBe(true)
    expect(after.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('says how far through the plan a run is, not just which round', async () => {
    // The spec file is where progress lives: one checkbox per ticket, ticked
    // as each lands. The working line reports it as soon as the file exists.
    const output = await drivePty('spec', [
      ['Welcome to codsh', `write the plan${ENTER}`, 900],
      // The write renders as one merged group row (`Edited 1 file`); the file's
      // own title is inside the fold now, so the visible line is what to wait on.
      ['Edited 1 file', '', 900],
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
      if (probe.alternate.some(row => /E2E round \d.*ESC to interrupt/u.test(row))) namedARound = true
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

  it('toggles a collapsed group open with Ctrl-O, and keeps that choice on moving on', async () => {
    const output = await drivePty('tall', [
      ['Welcome to codsh', `create the tall note${ENTER}`, 300],
      // 45 diff lines, folded into one group row; Ctrl-O expands in place.
      ['Edited 1 file', '\u000F', 400],
      // ...Ctrl-O swaps the block for its full body, clipped tail included...
      ['CODE_CLI_TALL_44', `/status${ENTER}`, 400],
      // ...and the next submission preserves that explicit reading choice.
      ['permissions', `/exit${ENTER}`, 400],
    ])

    // Expanded: the tail line is on screen where the summary was.
    const expanded = screenAt(output, 'CODE_CLI_TALL_44').alternate
    expect(expanded.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(true)
    // Still expanded after moving on: the summary stays away and the tail remains.
    const after = screenAt(output, 'permissions').alternate
    expect(after.some(row => row.includes('Ctrl+O expands'))).toBe(false)
    expect(after.some(row => row.includes('CODE_CLI_TALL_44'))).toBe(true)
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

    const rows = screenAt(output, 'CODE_CLI_CALL_OK').alternate.map(visible)
    // The person's own words carry the heavy mark; the tool block the light
    // one — which is what tells two segments apart without a frame or a fill.
    expect(rows).toContain('›   create the note')
    expect(rows.some(row => row.includes('│ ') && row.includes('Edited 1 file'))).toBe(true)
    // What a person reads stays flush: the answer is not marked at all.
    expect(rows.some(row => row.startsWith('CODE_CLI_CALL_OK'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('replays history as folds, so a resumed long diff still opens', async () => {
    const output = await drivePty('tall', [
      ['Welcome to codsh', `create the tall note${ENTER}`, 300],
      // 45 diff lines, folded live into one group row...
      ['Edited 1 file', '\u000F', 400],
      // ...then explicitly expanded before session replacement.
      ['CODE_CLI_TALL_44', `/clear${ENTER}`, 400],
      ['new session session-', `/resume${ENTER}`, 400],
      ['Resume session', ENTER, 500],
      // ...and the replayed row still promises the key...
      ['resumed session-', '\u000F', 500],
      // ...which must actually deliver the body, or the promise was a lie and
      // the output would be unreachable for the rest of the session.
      ['CODE_CLI_TALL_44', `/exit${ENTER}`, 400],
    ])

    // Replayed, before the key: the log's own message above a group still
    // collapsed to its summary — history as the turn left it.
    const replayed = screenAt(output, 'resumed session-').alternate
    expect(replayed.map(visible)).toContain('›   create the tall note')
    expect(replayed.some(row => row.includes('● Edited 1 file'))).toBe(true)
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
