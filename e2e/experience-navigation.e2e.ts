/**
 * The experience checklist: what a person notices in the first five minutes,
 * asserted at the screen level before a person has to.
 *
 * Every entry started life as a real complaint — a menu that hid its tail, a
 * wheel that scrolled backwards, a clock that reset per step, a flickering
 * hint row, a bare welcome, a wall of output. The checklist is split by topic
 * because Vitest parallelises by file: the run takes as long as its largest
 * file. This file: the timeline rail, turn jumps,
 * folds, hover feedback, and the turn clock.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { PTY_COLUMNS, drivePty, drivePtySteps, finalScreen, screenOf, screenAt, screenAtLast } from './pty-driver.ts'
import { ENTER } from './pty-helpers.ts'
import { Terminal } from './vt.ts'

describe.skipIf(process.platform === 'win32')('the first five minutes: timeline, folds, hover', () => {
  it('previews and clicks the timeline rail, then clears the preview on mouse-out', async () => {
    const moveRail = '\u001B[<35;120;2M'
    const clickRail = '\u001B[<0;120;2M\u001B[<0;120;2m'
    const clickDown = '\u001B[<0;120;5M\u001B[<0;120;5m'
    const moveAway = '\u001B[<35;10;6M'
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', `third sticky prompt${ENTER}`, 500],
      ['STICKY_SECOND_DONE', moveRail, 300],
      ['first sticky prompt', clickRail, 300],
      ['first sticky prompt', clickDown, 300],
      ['second sticky prompt', moveAway, 300],
      ['', `/exit${ENTER}`, 400],
    ], { rows: 12 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const preview = screenOf(captured(run.offsets[4]), -1, 12).alternate.join('\n')
    const clicked = screenOf(captured(run.offsets[5]), -1, 12).alternate
    const arrowed = screenOf(captured(run.offsets[6]), -1, 12).alternate
    const cleared = screenOf(captured(run.offsets[7]), -1, 12).alternate.join('\n')
    const occurrences = (text: string): number => text.split('first sticky prompt').length - 1
    expect(occurrences(preview)).toBe(1)
    expect(occurrences(clicked.join('\n'))).toBe(2)
    expect(clicked[1]?.at(-1)).toBe('●')
    expect(arrowed[2]?.at(-1)).toBe('●')
    expect(occurrences(cleared)).toBe(0)
  }, E2E_TEST_TIMEOUT_MS)

  it('jumps between real user turns with shifted horizontal arrows', async () => {
    const shiftLeft = '\u001B[1;2D'
    const shiftRight = '\u001B[1;2C'
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', shiftLeft, 500],
      ['', shiftRight, 400],
      ['', `/exit${ENTER}`, 400],
    ], { rows: 12 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const previous = screenOf(captured(run.offsets[3]), -1, 12).alternate
    const next = screenOf(captured(run.offsets[4]), -1, 12).alternate
    expect(previous.join('\n')).toContain('first sticky prompt')
    expect(next.join('\n')).toContain('second sticky prompt')
  }, E2E_TEST_TIMEOUT_MS)

  it('previews /jump choices, restores after resize, and keeps the committed turn', async () => {
    const wheelUp = '\u001B[<64;10;5M'.repeat(8)
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', wheelUp, 300],
      ['rows above', `/jump${ENTER}`, 300],
      ['Jump to turn', '\u001B[B', 300],
      ['', '@WINSZ:12x20', 400],
      ['Jump to turn', '\u001B', 500],
      ['', `/jump${ENTER}`, 300],
      ['Jump to turn', '\u001B[B', 300],
      ['', ENTER, 500],
      ['', `/exit${ENTER}`, 400],
    ], { rows: 12 })

    const bytes = Buffer.from(run.output)
    const captured = (offset: number | undefined): string => bytes.subarray(0, offset).toString()
    const preview = screenOf(captured(run.offsets[5]), -1, 12).alternate
    const resizeAt = run.offsets[5] ?? 0
    const restoredTerminal = new Terminal(12, PTY_COLUMNS)
    restoredTerminal.feed(bytes.subarray(0, resizeAt).toString())
    restoredTerminal.resize(12, 20)
    restoredTerminal.feed(bytes.subarray(resizeAt, run.offsets[7] ?? bytes.length).toString())
    const restored = restoredTerminal.alternate
    const committedTerminal = new Terminal(12, PTY_COLUMNS)
    committedTerminal.feed(bytes.subarray(0, resizeAt).toString())
    committedTerminal.resize(12, 20)
    committedTerminal.feed(bytes.subarray(resizeAt, run.offsets[10] ?? bytes.length).toString())
    const committed = committedTerminal.alternate
    expect(preview.join('\n')).toContain('first sticky prompt')
    expect(restored.join('\n')).toContain('second sticky')
    expect(committed.join('\n')).toContain('first sticky')
  }, E2E_TEST_TIMEOUT_MS)

  it('collapses a long result and names what each gesture does', async () => {
    const output = await drivePty('tall', [
      ['Welcome to codsh', `make it tall${ENTER}`, 300],
      // Diff cards default to one ToolCard line; hunks live in the fold.
      ['+45 -0', `/exit${ENTER}`, 500],
    ])
    const rows = screenAt(output, '+45 -0').alternate
    const body = rows.filter(row => row.includes('CODE_CLI_TALL_'))
    // A skimmable one-liner, not a wall. Click / Ctrl+O still open the body;
    // those gestures are covered in the pty suite.
    expect(body.length).toBe(0)
    expect(rows.some(row => row.includes('● Write note.txt +45 -0 ✔'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('names the block the pointer rests on, and gives the row back', async () => {
    // A move with nothing held: button 35 is the motion bit over the no-button
    // code, which is what any-motion tracking sends.
    const moveTo = (line: string): string => `\u001B[<35;6;{row:${line}}M`
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      // Resting on the open thought: the chrome says what it is, how much it
      // holds, and what a click would do, before anything is clicked.
      ['CODE_CLI_ANSWER after thinking', moveTo('thought for'), 600],
      // Away from every block — the welcome banner — and the row is given back.
      ['click to fold', moveTo('Welcome to codsh'), 600],
      ['thought for', `/exit${ENTER}`, 400],
    ])
    const named = screenAtLast(output, 'click to fold').alternate
    // Two lines of deliberation: the count the readout names is the count
    // the block withholds when folded, never the pads and the clock with it.
    expect(named.some(row => /thinking · 2 lines · click to fold/u.test(row))).toBe(true)
    const released = finalScreen(output).alternate
    expect(released.some(row => row.includes('click to fold'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('names a one-row card under the pointer with the count its row carries', async () => {
    const moveTo = (line: string): string => `\u001B[<35;6;{row:${line}}M`
    const output = await drivePty('bash', [
      ['Welcome to codsh', `run it${ENTER}`, 300],
      ['Allow bash', ENTER, 600],
      ['CODE_CLI_CALL_OK', moveTo('printf CODE_CLI_ROUND_TRIP'), 600],
      ['click to expand', `/exit${ENTER}`, 400],
    ])
    const named = screenAtLast(output, 'click to expand').alternate
    expect(named.some(row => /printf CODE_CLI_ROUND_TRIP · 2 lines · click to expand/u.test(row))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('clears the hover readout when the window loses focus, and the status row never moved', async () => {
    const moveTo = (line: string): string => `\u001B[<35;6;{row:${line}}M`
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      ['CODE_CLI_ANSWER after thinking', moveTo('thought for'), 600],
      // Focus out is a pointer-left: the readout clears and the legend row it
      // borrowed comes back. The status row was always the row below it.
      ['click to fold', '\u001B[O', 600],
      ['? shortcuts', `/exit${ENTER}`, 400],
    ])
    const named = screenAtLast(output, 'click to fold').alternate
    expect(named.some(row => /thinking · 2 lines · click to fold/u.test(row))).toBe(true)
    const released = screenAtLast(output, '? shortcuts').alternate
    expect(released.some(row => row.includes('click to fold'))).toBe(false)
    // The status row is not what the hover borrowed, so it stayed throughout.
    expect(released.some(row => row.includes('cli-mock'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('folds the open block a click lands on, and opens it again from its clock', async () => {
    // Where a block sits depends on everything printed above it, so the click
    // aims at the line itself and the driver resolves the row it was painted
    // on. Press and release without moving: a drag would copy instead.
    const clickOn = (line: string): string => `\u001B[<0;6;{row:${line}}M\u001B[<0;6;{row:${line}}m`
    const run = await drivePtySteps('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      // The thought lands open; a click anywhere inside it — not only its
      // clock — folds it to that one row.
      ['CODE_CLI_ANSWER after thinking', clickOn('weighing the options carefully'), 600],
      // A click on the clock opens it again.
      ['', clickOn('thought for'), 600],
      ['', `/exit${ENTER}`, 600],
    ])
    // offsets[k] is the moment step k+1 wrote: the screen after step k settled.
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const shut = screenOf(captured(run.offsets[2]), -1).alternate
    const opened = screenOf(captured(run.offsets[3]), -1).alternate
    expect(shut.some(row => /✻\s+thought for [\d.]+s/u.test(row))).toBe(true)
    expect(shut.some(row => row.includes('weighing the options carefully'))).toBe(false)
    expect(opened.some(row => row.includes('CODE_CLI_THINKING about the request'))).toBe(true)
    expect(opened.some(row => row.includes('weighing the options carefully'))).toBe(true)
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

  it('leaves a finished answer whole, with no fold and no hover chrome', async () => {
    // A move with nothing held: button 35 is the motion bit over the no-button
    // code, which is what any-motion tracking sends. Press and release without
    // moving: a drag would copy instead. Aim at the tail marker — it is on
    // screen once the stream ends, and it belongs to the answer.
    const moveTo = (line: string): string => `\u001B[<35;6;{row:${line}}M`
    const clickOn = (line: string): string => `\u001B[<0;6;{row:${line}}M\u001B[<0;6;{row:${line}}m`
    const tail = 'CODE_CLI_CALL_STREAM_DONE'
    const run = await drivePtySteps('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      // Resting on the fresh answer must not name it as a fold.
      [tail, moveTo(tail), 600],
      // Empty markers: the tail is already in the capture, and a no-op hover
      // does not reprint it. Delay, then click, then move on.
      ['', clickOn(tail), 600],
      ['', `/status${ENTER}`, 500],
      ['permissions', `/exit${ENTER}`, 400],
    ])
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    // After the pointer has rested on the answer: the chrome still names the
    // model, not a fold, and the tail marker is still on screen.
    const hovered = screenOf(captured(run.offsets[2]), -1).alternate
    expect(hovered.some(row => /answer · \d+ lines · click to (?:fold|expand)/u.test(row))).toBe(false)
    expect(hovered.some(row => row.includes(tail))).toBe(true)
    const clicked = screenOf(captured(run.offsets[3]), -1).alternate
    expect(clicked.some(row => row.includes(tail))).toBe(true)
    expect(clicked.some(row => row.includes('lines (click or Ctrl+O expands)'))).toBe(false)
    const after = screenAt(run.output, 'permissions').alternate
    expect(after.some(row => row.includes(tail))).toBe(true)
    expect(after.some(row => row.includes('lines (click or Ctrl+O expands)'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps a block the person opened by hand open across the next real turn', async () => {
    // A fresh thought is open on its own account and folds when the next
    // turn comes; folding it and opening it again makes that form the
    // person's, which the next turn leaves alone. The next turn anchors its
    // own prompt at the top, so the earlier block is read by scrolling back.
    const wheelUp = '\u001B[<64;10;5M'
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `first question${ENTER}`, 300],
      ['CODE_CLI_ANSWER', '\u000F', 400],
      ['', '\u000F', 400],
      ['weighing the options carefully', `second question${ENTER}`, 300],
      // The turn's own tag: the first answer's repaints carry the same words.
      ['(turn 2)', wheelUp.repeat(12), 400],
      ['\u2191 12 rows above', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, '\u2191 12 rows above').alternate
    // Both thoughts are open: the first by hand, the second because it is live.
    expect(rows.filter(row => row.includes('weighing the options carefully'))).toHaveLength(2)
    expect(rows.some(row => row.includes('second question'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('shows thinking open by default and folds it on Ctrl+O', async () => {
    const run = await drivePtySteps('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      ['CODE_CLI_ANSWER after thinking', '\u000F', 500],
      ['', `/exit${ENTER}`, 600],
    ])
    // offsets[k] is the moment step k+1 wrote: the screen after step k settled.
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const open = screenOf(captured(run.offsets[1]), -1).alternate
    const folded = screenOf(captured(run.offsets[2]), -1).alternate
    // Settled: the whole thought under its clock, nothing to press for.
    expect(open.some(row => /✻\s+thought for [\d.]+s/u.test(row))).toBe(true)
    expect(open.some(row => row.includes('weighing the options carefully'))).toBe(true)
    // The only fold on screen is open, so Ctrl+O folds it to its clock.
    expect(folded.some(row => /✻\s+thought for [\d.]+s/u.test(row))).toBe(true)
    expect(folded.some(row => row.includes('weighing the options carefully'))).toBe(false)
  }, E2E_TEST_TIMEOUT_MS)
})
