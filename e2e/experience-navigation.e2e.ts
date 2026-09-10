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
      ['Edited 1 file', `/exit${ENTER}`, 500],
    ])
    const rows = screenAt(output, '+45 -0').alternate
    const body = rows.filter(row => row.includes('CODE_CLI_TALL_'))
    // A skimmable one-liner, not a wall. Click / Ctrl+O still open the body;
    // those gestures are covered in the pty suite.
    expect(body.length).toBe(0)
    expect(rows.some(row => row.includes('● Edited 1 file'))).toBe(true)
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

  it('clears the hover readout when the window loses focus, and the status row never moved', async () => {
    const moveTo = (line: string): string => `\u001B[<35;6;{row:${line}}M`
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `think it over${ENTER}`, 300],
      ['thought for', moveTo('thought for'), 600],
      // Focus out is a pointer-left: the readout clears and the legend row it
      // borrowed comes back. The status row was always the row below it.
      ['click to expand', '\u001B[O', 600],
      ['? shortcuts', `/exit${ENTER}`, 400],
    ])
    const named = screenAtLast(output, 'click to expand').alternate
    expect(named.some(row => /thinking · \d+ lines · click to expand/u.test(row))).toBe(true)
    const released = screenAtLast(output, '? shortcuts').alternate
    expect(released.some(row => row.includes('click to expand'))).toBe(false)
    // The status row is not what the hover borrowed, so it stayed throughout.
    expect(released.some(row => row.includes('cli-mock'))).toBe(true)
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
      // Folded summary is `thought for Xs` with no leftover hint line; delay
      // then leave so the last frame is the shut card.
      ['', `/exit${ENTER}`, 600],
    ])
    const opened = screenAtLast(output, 'weighing the options carefully').alternate
    expect(opened.some(row => row.includes('CODE_CLI_THINKING about the request'))).toBe(true)
    // Folded back by the second click — before any submission could do it.
    const shut = finalScreen(output).alternate
    expect(shut.some(row => /✻\s+thought for [\d.]+s/u.test(row))).toBe(true)
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

  it('keeps a manually expanded block open across the next real turn', async () => {
    // The next turn anchors its own prompt at the top, so the block that was
    // opened by hand is read by scrolling back to it.
    const wheelUp = '\u001B[<64;10;5M'
    const output = await drivePty('reasoning', [
      ['Welcome to codsh', `first question${ENTER}`, 300],
      ['CODE_CLI_ANSWER', '\u000F', 300],
      ['weighing the options carefully', `second question${ENTER}`, 300],
      ['CODE_CLI_ANSWER', wheelUp.repeat(12), 400],
      ['\u2191 12 rows above', `/exit${ENTER}`, 400],
    ])
    const rows = screenAt(output, '\u2191 12 rows above').alternate
    expect(rows.filter(row => row.includes('weighing the options carefully'))).toHaveLength(1)
    expect(rows.some(row => row.includes('second question'))).toBe(true)
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
    expect(rows.some(row => /✻\s+thought for [\d.]+s/u.test(row))).toBe(true)
    expect(rows.some(row => row.includes('weighing the options carefully'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)
})
