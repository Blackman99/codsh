/**
 * The experience checklist: what a person notices in the first five minutes,
 * asserted at the screen level before a person has to.
 *
 * Every entry started life as a real complaint — a menu that hid its tail, a
 * wheel that scrolled backwards, a clock that reset per step, a flickering
 * hint row, a bare welcome, a wall of output. The checklist is split by topic
 * because Vitest parallelises by file: the run takes as long as its largest
 * file. This file: the completion menu, history and
 * transcript search, the shortcuts overlay, queued lines, and the key legend.
 */

import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { PTY_COLUMNS, PTY_ROWS, SYNC_END, drivePty, drivePtySteps, screenOf, screenAt, screenAtLast } from './pty-driver.ts'
import { ENTER } from './pty-helpers.ts'
import { Terminal } from './vt.ts'

describe.skipIf(process.platform === 'win32')('the first five minutes: menus, search, legend', () => {
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
