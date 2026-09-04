/**
 * The experience checklist: what a person notices in the first five minutes,
 * asserted at the screen level before a person has to.
 *
 * Every entry here started life as a real complaint — a menu that hid its
 * tail, a wheel that scrolled backwards, a clock that reset per step, a
 * flickering hint row, a bare welcome, a wall of output. The suite exists so
 * the NEXT change to rendering or input fails here first.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS, fakeRegistry } from './harness.ts'
import {
  PTY_COLUMNS,
  PTY_ROWS,
  SYNC_END,
  drivePty,
  drivePtySteps,
  finalScreen,
  screenOf,
  screenAt,
  screenAtLast,
} from './pty-driver.ts'
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
    // The chrome is the box plus its two rows — the key legend and the status —
    // so the box's top border is the fifth row up from the foot.
    expect(rows.slice(-5).some(row => row.trimStart().startsWith('╭'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('shows the welcome again after /clear', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', `create the note${ENTER}`, 300],
      ['CODE_CLI_CALL_OK', `/clear${ENTER}`, 400],
      ['new session', `/exit${ENTER}`, 500],
    ])
    const rows = screenAt(output, 'new session').alternate
    // Same workspace: /clear is a returning welcome (2 lines), not first-run ASCII.
    expect(rows.some(row => row.includes('✻ codsh'))).toBe(true)
    expect(rows.some(row => row.includes('⇧Tab plan'))).toBe(true)
    expect(rows.some(row => row.includes('Welcome to codsh'))).toBe(false)
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

  it('moves the command menu with an arrow reported under a lock key', async () => {
    // What a kitty-protocol terminal sends for Down with Caps Lock on: the
    // lock rides in the modifier field (64, encoded 65). Matched against a
    // fixed table of chords it hit nothing, lost its introducer, and the rest
    // was typed — the box filled with `/[1;65B` instead of the menu moving.
    const lockedDown = '\u001B[1;65B'
    // Waiting happens on the raw stream, where the marker is wrapped in SGR
    // and `❯ /` never appears contiguously; the menu's own entries do.
    const run = await drivePtySteps('write', [
      ['Welcome to codsh', '/', 400],
      ['/exit', lockedDown, 500],
      // Escape closes the menu but leaves the typed `/`; backspace clears it
      // so the command that follows is not `//exit`.
      ['', `\u001B\u007F/exit${ENTER}`, 600],
    ])
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const markedAt = (index: number): string => screenOf(captured(run.offsets[index]), -1)
      .alternate.find(row => row.includes('❯ ')) ?? ''

    // offsets[0] is the moment `/` was written, before the menu painted; the
    // menu is on screen at offsets[1], and the arrow has landed by offsets[2].
    const opened = markedAt(1)
    const moved = markedAt(2)
    // The menu opens on its first entry, and the arrow moves off it.
    expect(opened).not.toBe('')
    expect(moved).not.toBe('')
    expect(moved).not.toBe(opened)
    // Nothing of the report reached the box, at any point in the run.
    expect(run.output).not.toContain('[1;65B')
    expect(screenOf(captured(run.offsets[2]), -1).alternate.join('\n')).not.toContain('1;65')
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

  it('keeps the owning prompt above each turn while scrolling across the boundary', async () => {
    const rows = 12
    const wheelUp = '\u001B[<64;10;5M'
    const wheelDown = '\u001B[<65;10;5M'
    const output = await drivePty('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', wheelUp.repeat(36), 500],
      ['↑ 36 rows above', wheelUp.repeat(12), 300],
      ['↑ 48 rows above', wheelDown.repeat(48), 300],
      ['STICKY_SECOND_DONE', `/exit${ENTER}`, 300],
    ], { rows })
    const tail = screenAt(output, '51 tokens', rows).alternate
    const browsing = screenAt(output, '↑ 36 rows above', rows).alternate
    const crossed = screenAt(output, '↑ 48 rows above', rows).alternate
    const returned = screenAtLast(output, 'STICKY_SECOND_DONE', rows).alternate

    expect(tail[0]).toContain('second sticky prompt')
    expect(tail[0]?.at(-1)).toBe('↑')
    expect(tail[1]?.at(-1)).toBe('·')
    expect(tail[2]?.at(-1)).toBe('●')
    expect(browsing[0]).toContain('second sticky prompt')
    expect(crossed[0]).toContain('first sticky prompt')
    expect(crossed[0]?.at(-1)).toBe('↑')
    expect(crossed[1]?.at(-1)).toBe('●')
    expect(crossed[2]?.at(-1)).toBe('·')
    expect(crossed.join('\n')).toContain('↑ 48 rows above')
    expect(returned[0]).toContain('second sticky prompt')
    expect(crossed.slice(-2)).toEqual(tail.slice(-2))
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps both explicit user lines in the sticky header', async () => {
    const shiftEnter = '\u001B[13;2u'
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `你好${shiftEnter}介绍下你自己${ENTER}`, 300],
      ['STICKY_FIRST_44', `/exit${ENTER}`, 500],
    ], { rows: 12 })

    const settled = screenOf(Buffer.from(run.output).subarray(0, run.offsets[1]).toString(), -1, 12).alternate
    expect(settled[0]).toContain('你好')
    expect(settled[1]).toContain('介绍下你自己')
  }, E2E_TEST_TIMEOUT_MS)

  it('anchors a submitted prompt while streamed reply rows fill beneath it', async () => {
    const run = await drivePtySteps('anchor', [
      ['Welcome to codsh', `anchor this prompt${ENTER}`, 100],
      ['ANCHOR_REPLY_1', '', 0],
      ['ANCHOR_REPLY_3', '', 0],
      ['ANCHOR_REPLY_8', '', 0],
      ['ANCHOR_REPLY_12', `/exit${ENTER}`, 300],
    ], { rows: 12 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const first = screenOf(captured(run.offsets[1]), -1, 12).alternate
    const filling = screenOf(captured(run.offsets[2]), -1, 12).alternate
    const sticky = screenOf(captured(run.offsets[3]), -1, 12).alternate
    expect(first[0]).toContain('anchor this prompt')
    expect(first.join('\n')).toContain('ANCHOR_REPLY_1')
    expect(filling[0]).toContain('anchor this prompt')
    expect(filling.join('\n')).toContain('ANCHOR_REPLY_3')
    expect(sticky[0]).toContain('anchor this prompt')
    expect(sticky.filter(row => row.includes('anchor this prompt'))).toHaveLength(1)
    expect(first.findIndex(row => row.includes('Ask anything'))).toBe(filling.findIndex(row => row.includes('Ask anything')))
    expect(first.at(-1)).toBe(filling.at(-1))
  }, E2E_TEST_TIMEOUT_MS)

  it('gives a canned command the top of the viewport, like a typed prompt', async () => {
    const run = await drivePtySteps('anchor', [
      ['Welcome to codsh', `/ship let long diffs open in a pager${ENTER}`, 200],
      ['ANCHOR_REPLY_1', '', 0],
      ['ANCHOR_REPLY_8', '', 0],
      ['ANCHOR_REPLY_12', `/exit${ENTER}`, 300],
    ], { rows: 12 })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const first = screenOf(captured(run.offsets[1]), -1, 12).alternate
    const filling = screenOf(captured(run.offsets[2]), -1, 12).alternate

    // The echo takes the place a submitted message takes, and the reply fills
    // the space under it rather than pushing it up the screen.
    expect(first[0]).toContain('/ship let long diffs open in a pager')
    expect(first.join('\n')).toContain('ANCHOR_REPLY_1')
    expect(filling[0]).toContain('/ship let long diffs open in a pager')
    expect(filling.join('\n')).toContain('ANCHOR_REPLY_8')
    expect(first.findIndex(row => row.includes('Ask anything'))).toBe(filling.findIndex(row => row.includes('Ask anything')))
    // One copy: the anchored prompt and its sticky header are the same row.
    expect(filling.filter(row => row.includes('/ship let long diffs'))).toHaveLength(1)
    // The template the command expands into is still not the transcript's
    // business — the echo is its whole presence, however it is placed.
    expect(run.output).not.toContain('tracer-bullet')
    expect(run.output).not.toContain('Phase 1')
  }, E2E_TEST_TIMEOUT_MS)

  it('leaves a command that only works the chrome where it was written', async () => {
    // The other half of the rule: `/status` answers nothing, so taking the top
    // would clear the screen to make room for a reply that never comes.
    const run = await drivePtySteps('anchor', [
      ['Welcome to codsh', `/status${ENTER}`, 500],
      ['', `/exit${ENTER}`, 300],
    ], { rows: 24 })
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const shown = screenOf(captured(run.offsets[1]), -1, 24).alternate

    const echo = shown.findIndex(row => row.includes('› /status'))
    expect(echo).toBeGreaterThan(0)
    // What was on screen before it is still above it. On a 24-row terminal the
    // taller chrome scrolls the lettermark off, so the welcome's help line —
    // still on screen — is the witness that the command took no viewport.
    expect(shown.slice(0, echo).join('\n')).toContain('/help · Tab')
  }, E2E_TEST_TIMEOUT_MS)

  it('gives the anchored prompt back when the reader wheels home again', async () => {
    const wheelUp = '\u001B[<64;10;5M'
    const wheelDown = '\u001B[<65;10;5M'
    const run = await drivePtySteps('anchor', [
      ['Welcome to codsh', `anchor this prompt${ENTER}`, 100],
      ['ANCHOR_REPLY_12', wheelUp.repeat(3), 400],
      ['\u2191 3 rows above', wheelDown.repeat(3), 400],
      ['', `/exit${ENTER}`, 300],
    ])

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const anchored = screenOf(captured(run.offsets[1]), -1).alternate
    const browsing = screenOf(captured(run.offsets[2]), -1).alternate
    const returned = screenOf(captured(run.offsets[3]), -1).alternate
    expect(anchored[0]).toContain('anchor this prompt')
    // Reading back steps the prompt down by the rows asked for, and the way
    // back to the tail is the same frame it left — not one that lost the gap.
    expect(browsing[0]).not.toContain('anchor this prompt')
    expect(browsing[3]).toContain('anchor this prompt')
    expect(browsing.join('\n')).toContain('3 rows above')
    expect(returned[0]).toContain('anchor this prompt')
    expect(returned.slice(0, 14)).toEqual(anchored.slice(0, 14))
  }, E2E_TEST_TIMEOUT_MS)

  it('says how far back it is, at the foot of the screen, and clicks home', async () => {
    const rows = 12
    const wheelUp = '\u001B[<64;10;5M'
    // Press and release on the notice itself, wherever the frame painted it.
    const clickNotice = '\u001B[<0;6;{row:rows above}M\u001B[<0;6;{row:rows above}m'
    const run = await drivePtySteps('sticky', [
      ['Welcome to codsh', `first sticky prompt${ENTER}`, 300],
      ['STICKY_FIRST_44', `second sticky prompt${ENTER}`, 500],
      ['51 tokens', wheelUp.repeat(6), 400],
      ['rows above', clickNotice, 400],
      ['', `/exit${ENTER}`, 300],
    ], { rows })

    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const browsing = screenOf(captured(run.offsets[3]), -1, rows).alternate
    const returned = screenOf(captured(run.offsets[4]), -1, rows).alternate
    const noticeAt = browsing.findIndex(row => row.includes('rows above'))
    const boxAt = browsing.findIndex(row => row.trimStart().startsWith('╭'))
    // Under what is being read, not over it: the last transcript row, right
    // above the box — and it names the click that ends the scroll.
    expect(noticeAt).toBe(boxAt - 1)
    expect(browsing[noticeAt]).toContain('click or PgDn')
    expect(returned.join('\n')).not.toContain('rows above')
    expect(returned.join('\n')).toContain('STICKY_SECOND_DONE')
  }, E2E_TEST_TIMEOUT_MS)

  it('says a newer codsh is out, once, under the welcome', async () => {
    const registry = await fakeRegistry('99.0.0')
    try {
      const output = await drivePty('write', [
        ['Welcome to codsh', '', 900],
        ['', `/exit${ENTER}`, 400],
      ], { env: { CODSH_UPDATE_CHECK: 'on', CODSH_UPDATE_REGISTRY: registry.base } })
      const rows = screenAt(output, 'is available').alternate

      // One dim line under the greeting, naming the command that acts on it —
      // it never grows the chrome and never installs anything by itself.
      expect(rows.filter(row => row.includes('codsh 99.0.0 is available'))).toHaveLength(1)
      expect(rows.join('\n')).toContain('/update installs it')
      expect(output).not.toContain('npm install -g')
    } finally {
      await registry.close()
    }
  }, E2E_TEST_TIMEOUT_MS)

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
    expect(shut.some(row => /✻ thought for [\d.]+s/u.test(row))).toBe(true)
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
    expect(rows.some(row => row.includes('╭') && row.includes('┬'))).toBe(true)
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

  it('copies raw answers and fence-free code by stable content address', async () => {
    const markdown = [
      '# CODE_CLI_HEADING',
      '',
      'Prose with **bold**, *em*, `inline_code`, and a [link](https://x.dev).',
      'An identifier like some_helper_name must survive intact.',
      '',
      '- **`screen.ts`**: the viewport module',
      '- second bullet',
      '- third bullet keeps the answer long',
      '- fourth bullet keeps the answer long',
      '- fifth bullet keeps the answer long',
      '- sixth bullet keeps the answer long',
      '- seventh bullet keeps the answer long',
      '- eighth bullet: past the fold threshold at any test width',
      '',
      '| 维度 | 内容 |',
      '|---|---|',
      `| 一句话 | ${'一个很长的中文单元格内容,用来强制表格在任何终端宽度下都必须在单元格内部换行。'.repeat(3)} |`,
      '| 命令 | `codsh` | | |',
      '',
      '> a quoted line',
      '',
      '```ts',
      'const answer = "text" // a comment',
      '```',
      '',
      'CODE_CLI_CALL_STREAM_DONE',
    ].join('\n')
    const output = await drivePty('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/copy 1:1${ENTER}`, 300],
      ['copied code 1:1', `/copy${ENTER}`, 300],
      ['Copy content', ENTER, 300],
      ['copied answer 1', `/copy${ENTER}`, 300],
      ['Copy content', '\u001B', 300],
      ['nothing copied', `/exit${ENTER}`, 400],
    ])
    const copied = [...output.matchAll(/\u001B\]52;c;([^\u0007]*)\u0007/gu)]
      .map(match => Buffer.from(match[1] ?? '', 'base64').toString('utf8'))
    expect(copied).toEqual(['const answer = "text" // a comment', markdown])
  }, E2E_TEST_TIMEOUT_MS)

  it('does not write the clipboard when copying is disabled', async () => {
    const output = await drivePty('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/copy 1${ENTER}`, 300],
      ['clipboard is disabled or unavailable', `/exit${ENTER}`, 400],
    ], { env: { CODSH_CLIPBOARD: 'off' } })
    expect(output).not.toContain('\u001B]52;c;')
  }, E2E_TEST_TIMEOUT_MS)

  it('views answers and code full-screen, then restores the exact prior viewport', async () => {
    const run = await drivePtySteps('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/view${ENTER}`, 300],
      ['View content', ENTER, 300],
      ['Esc closes', '\u001B[6~', 300],
      ['Esc closes', '\u001B', 300],
      ['Ask anything', `/view 1:1${ENTER}`, 300],
      ['Esc closes', '\u001B', 300],
      ['Ask anything', `/view 9:9${ENTER}`, 300],
      ['was not found', '', 1_700],
      ['', `/exit${ENTER}`, 400],
    ], { rows: 12 })
    const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
    const at = (index: number): string[] => screenOf(captured(run.offsets[index]), -1, 12).alternate
    const before = at(1)
    const answer = at(3)
    const paged = at(4)
    const afterAnswer = at(5)
    const code = at(6)
    const afterCode = at(7)
    const afterFailure = at(9)

    expect(answer[0]).toContain('Answer 1')
    expect(answer.at(-1)).toContain('Esc closes')
    expect(answer.join('\n')).not.toContain('Ask anything')
    expect(paged).not.toEqual(answer)
    expect(afterAnswer).toEqual(before)
    expect(code[0]).toContain('Code 1:1')
    expect(code.join('\n')).toContain('const answer = "text" // a comment')
    expect(code.join('\n')).not.toContain('```')
    expect(afterCode).toEqual(before)
    expect(afterFailure).toEqual(before)
  }, E2E_TEST_TIMEOUT_MS)

  it('copies the diff the reader is showing, which /copy cannot address', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'codsh-copy-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
    }
    try {
      await writeFile(join(repo, 'tracked.ts'), 'const before = 1\n')
      git('init', '-q')
      git('add', '-A')
      git('-c', 'user.email=e2e@codsh', '-c', 'user.name=e2e', 'commit', '-qm', 'base')
      await writeFile(join(repo, 'tracked.ts'), 'const after = 2\n')

      const output = await drivePty('markdown', [
        ['Welcome to codsh', `/diff${ENTER}`, 500],
        // `c` inside the reader; the clipboard write is the OSC 52 the
        // terminal receives, which is the only proof available here.
        ['c copies', 'c', 400],
        ['copied', '\u001B', 300],
        ['Ask anything', `/exit${ENTER}`, 400],
      ], { cwd: repo, rows: 14 })

      // OSC 52 carries the payload base64-encoded.
      const written = /\u001B\]52;c;([A-Za-z0-9+/=]+)\u0007/u.exec(output)?.[1] ?? ''
      expect(written).not.toBe('')
      const text = Buffer.from(written, 'base64').toString()
      expect(text).toContain('-const before = 1')
      expect(text).toContain('+const after = 2')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('reads /diff in the pager instead of scrolling it past', async () => {
    // A real repository with a real uncommitted change: `/diff` shells out to
    // git, so a fixture that only looks like one would prove nothing.
    const repo = await mkdtemp(join(tmpdir(), 'codsh-diff-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
    }
    try {
      await writeFile(join(repo, 'tracked.ts'), Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n'))
      git('init', '-q')
      git('-c', 'user.email=e2e@codsh', '-c', 'user.name=e2e', 'commit', '-qam', 'base', '--allow-empty')
      git('add', '-A')
      git('-c', 'user.email=e2e@codsh', '-c', 'user.name=e2e', 'commit', '-qm', 'tracked')
      await writeFile(join(repo, 'tracked.ts'), Array.from({ length: 40 }, (_, index) => `const CHANGED${index + 1} = ${index + 1}`).join('\n'))

      const run = await drivePtySteps('markdown', [
        ['Welcome to codsh', `/diff${ENTER}`, 500],
        ['Esc closes', '\u001B[6~', 300],
        ['Esc closes', '\u001B[F', 300],
        ['Esc closes', '\u001B', 300],
        ['Ask anything', `/exit${ENTER}`, 400],
      ], { rows: 12, cwd: repo })
      const captured = (offset: number | undefined): string => Buffer.from(run.output).subarray(0, offset).toString()
      const at = (index: number): string[] => screenOf(captured(run.offsets[index]), -1, 12).alternate
      const before = at(0)
      const opened = at(1)
      const paged = at(2)
      const ended = at(3)
      const restored = at(4)

      expect(opened[0]).toContain('Uncommitted changes')
      expect(opened.at(-1)).toContain('Esc closes')
      expect(opened.join('\n')).toContain('tracked.ts')
      // The first screen is the removals; 87 diff lines do not fit 12 rows.
      expect(opened.join('\n')).toContain('-const line1 = 1')
      expect(opened.join('\n')).not.toContain('CHANGED')
      // The box is gone while the reader holds the screen.
      expect(opened.join('\n')).not.toContain('Ask anything')
      // Paging moves, and the far end carries the additions — which is the
      // whole point of not writing all 87 lines into the transcript.
      expect(paged).not.toEqual(opened)
      expect(ended.join('\n')).toContain('CHANGED')
      // Esc gives the conversation back — and the diff it just read stayed in
      // the reader: the transcript carries the command's own echo and nothing
      // else, which is the difference from writing 87 lines into it.
      expect(restored.join('\n')).toContain('Ask anything')
      expect(restored.join('\n')).not.toContain('CHANGED')
      expect(restored.join('\n')).not.toContain('@@ -1,40')
      expect(restored.join('\n')).not.toContain('Esc closes')
      expect(before.join('\n')).not.toContain('CHANGED')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('reports a failed /view in chrome without adding it to the transcript', async () => {
    const run = await drivePtySteps('write', [
      ['Welcome to codsh', `/view 1${ENTER}`, 300],
      ['no viewable assistant answers', '', 1_700],
      ['', `/exit${ENTER}`, 400],
    ])
    const settled = screenOf(Buffer.from(run.output).subarray(0, run.offsets[2]).toString(), -1).alternate
    expect(settled.join('\n')).not.toContain('/view 1')
    expect(run.output).not.toContain('Esc closes')
  }, E2E_TEST_TIMEOUT_MS)

  it('reflows a full-screen viewer across terminal resize before restoring', async () => {
    const run = await drivePtySteps('markdown', [
      ['Welcome to codsh', `explain${ENTER}`, 300],
      ['CODE_CLI_CALL_STREAM_DONE', `/view 1${ENTER}`, 300],
      ['Esc closes', '@WINSZ:9x50', 400],
      ['Esc closes', '\u001B', 300],
      ['Ask anything', `/exit${ENTER}`, 400],
    ], { rows: 12 })
    const resizeAt = run.offsets[2] ?? 0
    const bytes = Buffer.from(run.output)
    const afterResize = run.offsets[3] ?? bytes.length
    const terminal = new Terminal(12, PTY_COLUMNS)
    terminal.feed(bytes.subarray(0, resizeAt).toString())
    terminal.resize(9, 50)
    terminal.feed(bytes.subarray(resizeAt, afterResize).toString())
    expect(terminal.alternate).toHaveLength(9)
    expect(terminal.alternate[0]).toContain('Answer 1')
    expect(terminal.alternate.at(-1)).toContain('Esc closes')
    expect(terminal.alternate.join('\n')).not.toContain('Ask anything')
    for (const row of terminal.alternate) expect(row.length).toBeLessThanOrEqual(50)

    const restored = new Terminal(12, PTY_COLUMNS)
    restored.feed(bytes.subarray(0, resizeAt).toString())
    restored.resize(9, 50)
    restored.feed(bytes.subarray(resizeAt, run.offsets[4] ?? bytes.length).toString())
    expect(restored.alternate.join('\n')).toContain('Ask anything')
    expect(restored.alternate.join('\n')).not.toContain('Answer 1')
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
      ['', `/exit${ENTER}`, 400],
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

describe.skipIf(process.platform === 'win32')('the key legend (real PTY)', () => {
  it('keeps the key legend under the box while typing', async () => {
    const output = await drivePty('write', [
      ['Welcome to codsh', 'legend typing test', 400],
      ['legend typing test', ENTER, 400],
      ['CODE_CLI_CALL_OK', `/exit${ENTER}`, 300],
    ])
    const empty = screenAt(output, '? shortcuts').alternate
    expect(empty.some(row => row.includes('? shortcuts'))).toBe(true)
    // The placeholder left with the first character; the legend did not.
    const typing = screenAt(output, 'legend typing test').alternate
    expect(typing.some(row => row.includes('› legend typing test'))).toBe(true)
    expect(typing.some(row => row.includes('Ask anything'))).toBe(false)
    expect(typing.some(row => row.includes('? shortcuts'))).toBe(true)
    // Same chrome in both frames: the legend row is where it was, so the box is too.
    const legendRow = (rows: string[]): number => rows.findIndex(row => row.includes('? shortcuts'))
    expect(legendRow(typing)).toBe(legendRow(empty))
  }, E2E_TEST_TIMEOUT_MS)
})
