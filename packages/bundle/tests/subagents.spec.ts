/**
 * The subagents roster and its chrome: entries fed by events, the readout
 * row under the box, the panel a person picks a child from, the report
 * `/subagents` prints, and the title a Child view carries.
 */

import { describe, expect, it } from 'vitest'
import type { Key } from '../src/keys.ts'
import {
  SUBAGENTS_KEY,
  SubagentRoster,
  SubagentsPanel,
  outcomeStatus,
  subagentLine,
  subagentTitle,
  subagentsReport,
  subagentsRow,
  tally,
} from '../src/subagents.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})

/** A roster with two children: one still running, one done. */
function twoChildren(): SubagentRoster {
  const roster = new SubagentRoster()
  roster.start('child-1', 'Investigate CONTEXT.md', 1_000)
  roster.start('child-2', 'Write the evidence', 2_000)
  roster.call('child-1', 'bash: sleep 2')
  roster.call('child-1', 'read: CONTEXT.md')
  roster.call('child-2', 'write: evidence.md')
  roster.settle('child-2', 'done', 9_500)
  return roster
}

describe('SubagentRoster', () => {
  it('keeps children in start order with what they did', () => {
    const roster = twoChildren()
    expect(roster.entries().map(entry => entry.id)).toEqual(['child-1', 'child-2'])
    expect(roster.entry('child-1')).toEqual({
      id: 'child-1', label: 'Investigate CONTEXT.md', startedAt: 1_000, status: 'running', endedAt: undefined, calls: 2, latest: 'read: CONTEXT.md',
    })
    expect(roster.entry('child-2')?.status).toBe('done')
    expect(roster.entry('child-2')?.endedAt).toBe(9_500)
    expect(roster.size).toBe(2)
  })

  it('maps a turn-end reason or a stop reason onto a status, and never marks an unfinished child done', () => {
    expect(outcomeStatus('completed')).toBe('done')
    expect(outcomeStatus('error')).toBe('failed')
    // The parent is told these failed — the runtime reports a blocked
    // turn as a refusal — and the row says the same.
    expect(outcomeStatus('max-tokens')).toBe('failed')
    expect(outcomeStatus('refusal')).toBe('failed')
    expect(outcomeStatus('blocked')).toBe('failed')
    expect(outcomeStatus('aborted')).toBe('stopped')
    expect(outcomeStatus('interrupted')).toBe('stopped')
  })

  it('takes the name its own log gives it, and ignores an empty one', () => {
    const roster = twoChildren()
    roster.relabel('child-1', '  Investigate the retry path  ')
    expect(roster.entry('child-1')?.label).toBe('Investigate the retry path')
    roster.relabel('child-1', '   ')
    expect(roster.entry('child-1')?.label).toBe('Investigate the retry path')
    roster.relabel('stranger', 'x')
    expect(roster.has('stranger')).toBe(false)
  })

  it('puts a continuable child back to running on another start, keeping its clock', () => {
    const roster = twoChildren()
    roster.start('child-2', 'ignored', 20_000)
    expect(roster.entry('child-2')).toMatchObject({ label: 'Write the evidence', startedAt: 2_000, status: 'running', endedAt: undefined })
    roster.settle('child-2', 'running', 21_000)
    expect(roster.entry('child-2')?.endedAt).toBeUndefined()
  })

  it('ignores a call or an end for a child it never saw start', () => {
    const roster = new SubagentRoster()
    roster.call('stranger', 'bash: ls')
    roster.settle('stranger', 'done', 5)
    expect(roster.entries()).toEqual([])
    expect(roster.has('stranger')).toBe(false)
  })

  it('keeps the latest call when a later one has no name', () => {
    const roster = new SubagentRoster()
    roster.start('c', 'x', 0)
    roster.call('c', 'bash: ls')
    roster.call('c', undefined)
    expect(roster.entry('c')).toMatchObject({ calls: 2, latest: 'bash: ls' })
  })

  it('forgets everything on clear', () => {
    const roster = twoChildren()
    roster.clear()
    expect(roster.size).toBe(0)
  })

  it('counts each status once', () => {
    const roster = twoChildren()
    roster.start('child-3', 'x', 3_000)
    roster.settle('child-3', 'failed', 4_000)
    roster.start('child-4', 'y', 3_000)
    roster.settle('child-4', 'stopped', 4_000)
    expect(tally(roster.entries())).toEqual({ total: 4, running: 1, done: 1, failed: 1, stopped: 1 })
  })
})

describe('the subagents readout', () => {
  it('counts the children by state and names the key', () => {
    expect(subagentsRow(twoChildren().entries(), theme, 80)).toBe('  subagents 2 · 1 running · 1 done · Ctrl+G')
  })

  it('names only the states that have children', () => {
    const roster = new SubagentRoster()
    roster.start('a', 'x', 0)
    roster.start('b', 'y', 0)
    expect(subagentsRow(roster.entries(), theme, 80)).toBe('  subagents 2 · 2 running · Ctrl+G')
    roster.settle('a', 'failed', 1)
    roster.settle('b', 'stopped', 1)
    expect(subagentsRow(roster.entries(), theme, 80)).toBe('  subagents 2 · 1 failed · 1 stopped · Ctrl+G')
  })

  it('cuts the counts before dropping the key', () => {
    const row = subagentsRow(twoChildren().entries(), theme, 30) ?? ''
    expect(row.endsWith(` · ${SUBAGENTS_KEY}`)).toBe(true)
    expect(row.length).toBeLessThanOrEqual(30)
  })

  it('has nothing to say before any child started', () => {
    expect(subagentsRow([], theme, 80)).toBeUndefined()
  })
})

describe('a child in one line', () => {
  it('names the mark, the label, the clock, the calls, and the latest call', () => {
    const [running, done] = twoChildren().entries()
    expect(subagentLine(running!, theme, 13_000)).toBe('▶ Investigate CONTEXT.md · 12s · 2 calls · read: CONTEXT.md')
    // A finished child's clock stopped when it ended, and says so.
    expect(subagentLine(done!, theme, 99_000)).toBe('✔ Write the evidence · 7.5s · 1 call · write: evidence.md')
  })

  it('leaves out figures a child has not earned', () => {
    const roster = new SubagentRoster()
    roster.start('c', 'Fresh', 0)
    expect(subagentLine(roster.entry('c')!, theme, 500)).toBe('▶ Fresh · 0.5s')
  })

  it('marks a failed and a stopped child', () => {
    const roster = new SubagentRoster()
    roster.start('a', 'x', 0)
    roster.settle('a', 'failed', 1_000)
    roster.start('b', 'y', 0)
    roster.settle('b', 'stopped', 1_000)
    expect(subagentLine(roster.entry('a')!, theme, 5)).toBe('✗ x · 1.0s')
    expect(subagentLine(roster.entry('b')!, theme, 5)).toBe('■ y · 1.0s')
  })
})

describe('the /subagents report', () => {
  it('prints the panel header without its key, and one numbered row per child', () => {
    expect(subagentsReport(twoChildren().entries(), theme, 120, 13_000)).toEqual([
      'subagents 2 · 1 running · 1 done',
      '  1. ▶ Investigate CONTEXT.md · 12s · 2 calls · read: CONTEXT.md',
      '  2. ✔ Write the evidence · 7.5s · 1 call · write: evidence.md',
    ])
  })

  it('fits its rows to the terminal and prints nothing for no children', () => {
    for (const row of subagentsReport(twoChildren().entries(), theme, 24, 13_000)) expect(row.length).toBeLessThanOrEqual(24)
    expect(subagentsReport([], theme, 80, 0)).toEqual([])
  })
})

describe('the title a Child view carries', () => {
  it('names the subagent, its clock, its work, and the way back', () => {
    const [running] = twoChildren().entries()
    expect(subagentTitle(running!, theme, 13_000, 120)).toBe('subagent ▶ Investigate CONTEXT.md · 12s · 2 calls · read: CONTEXT.md · Esc returns to the parent')
  })

  it('cuts the label and the figures before the way back, on a narrow terminal', () => {
    const [running] = twoChildren().entries()
    const row = subagentTitle(running!, theme, 13_000, 60)
    expect(row.endsWith(' · Esc returns to the parent')).toBe(true)
    expect(row.length).toBeLessThanOrEqual(60)
    expect(row.startsWith('subagent ▶ Investigate')).toBe(true)
  })

  it('caps a long latest call the way the working line does', () => {
    const roster = new SubagentRoster()
    roster.start('c', 'Run the suite', 0)
    roster.call('c', 'bash: pnpm exec vitest run packages/bundle/tests/transcript.spec.ts --reporter=dot')
    const row = subagentTitle(roster.entry('c')!, theme, 1_000, 200)
    expect(row).toContain(' · 1 call · bash: pnpm exec vitest run pack…')
    expect(row.endsWith(' · Esc returns to the parent')).toBe(true)
  })
})

describe('with colour on', () => {
  const colored = createTheme(true, {})
  const ESC = String.fromCharCode(27)
  const spans = (text: string): string[] => text.split(ESC).filter(part => part !== '')

  it('keeps the readout one span, so a PTY wait can match it as raw bytes', () => {
    const row = subagentsRow(twoChildren().entries(), colored, 80) ?? ''
    // One opening and one closing SGR around the whole row.
    expect(spans(row)).toHaveLength(2)
    expect(row).toContain('subagents 2 · 1 running · 1 done · Ctrl+G')
  })

  it('keeps a row\'s figures in one span, and the header\'s key with its counts', () => {
    const [running] = twoChildren().entries()
    expect(subagentLine(running!, colored, 13_000)).toContain(' · 12s · 2 calls · read: CONTEXT.md')
    const panel = new SubagentsPanel()
    panel.reset()
    expect(panel.view(twoChildren().entries(), colored, 120, 13_000)[0]).toContain(' 2 · 1 running · 1 done · Ctrl+G closes')
    const title = subagentTitle(running!, colored, 13_000, 120)
    expect(title).toContain(' · Esc returns to the parent')
  })
})

describe('SubagentsPanel', () => {
  const key = (kind: Key['kind']): Key => ({ kind } as Key)
  const text = (value: string): Key => ({ kind: 'text', text: value })

  it('shows the header counts, numbered rows, the marker, and the footer', () => {
    const panel = new SubagentsPanel()
    panel.reset()
    expect(panel.view(twoChildren().entries(), theme, 120, 13_000)).toEqual([
      '  subagents 2 · 1 running · 1 done · Ctrl+G closes',
      '  ❯ 1. ▶ Investigate CONTEXT.md · 12s · 2 calls · read: CONTEXT.md',
      '    2. ✔ Write the evidence · 7.5s · 1 call · write: evidence.md',
      '    [enter] view · [esc] back',
    ])
  })

  it('cuts the header counts before its key, and says which child is on screen', () => {
    const panel = new SubagentsPanel()
    panel.reset()
    const narrow = panel.view(twoChildren().entries(), theme, 36, 13_000)
    expect(narrow[0]?.endsWith(' · Ctrl+G closes')).toBe(true)
    expect(narrow[0]?.length).toBeLessThanOrEqual(36)
    const viewing = panel.view(twoChildren().entries(), theme, 120, 13_000, 'child-2')
    expect(viewing[2]).toBe('    2. ✔ Write the evidence · 7.5s · 1 call · write: evidence.md · viewing')
    expect(viewing[1]).not.toContain('viewing')
  })

  it('moves the mark with the arrows, Tab, Home, End, and digits, and wraps', () => {
    const panel = new SubagentsPanel()
    const entries = twoChildren().entries()
    panel.reset()
    expect(panel.handle(key('down'), entries)).toEqual({ kind: 'pending' })
    expect(panel.mark).toBe(1)
    panel.handle(key('down'), entries)
    expect(panel.mark).toBe(0)
    panel.handle(key('up'), entries)
    expect(panel.mark).toBe(1)
    panel.handle(key('home'), entries)
    expect(panel.mark).toBe(0)
    panel.handle(key('end'), entries)
    expect(panel.mark).toBe(1)
    panel.handle(text('1'), entries)
    expect(panel.mark).toBe(0)
    panel.handle(key('tab'), entries)
    expect(panel.mark).toBe(1)
  })

  it('enters the marked child on Enter, and closes on Escape or the key', () => {
    const panel = new SubagentsPanel()
    const entries = twoChildren().entries()
    panel.reset()
    panel.handle(key('down'), entries)
    expect(panel.handle(key('enter'), entries)).toEqual({ kind: 'enter', id: 'child-2' })
    expect(panel.handle(key('escape'), entries)).toEqual({ kind: 'close' })
    expect(panel.handle(key('toggle-subagents'), entries)).toEqual({ kind: 'close' })
  })

  it('enters on a click on a row, and closes on the header or the footer', () => {
    const panel = new SubagentsPanel()
    const entries = twoChildren().entries()
    panel.reset()
    expect(panel.targetAt(0, entries)).toEqual({ kind: 'header' })
    expect(panel.targetAt(2, entries)).toEqual({ kind: 'item', index: 1 })
    expect(panel.targetAt(3, entries)).toEqual({ kind: 'footer' })
    expect(panel.click({ kind: 'item', index: 1 }, entries)).toEqual({ kind: 'enter', id: 'child-2' })
    expect(panel.mark).toBe(1)
    expect(panel.click({ kind: 'header' }, entries)).toEqual({ kind: 'close' })
    expect(panel.click({ kind: 'footer' }, entries)).toEqual({ kind: 'close' })
  })

  it('marks the row under the pointer with · and leaves the mark where it was', () => {
    const panel = new SubagentsPanel()
    const entries = twoChildren().entries()
    panel.reset()
    panel.setHovered({ kind: 'item', index: 1 })
    const rows = panel.view(entries, theme, 120, 13_000)
    expect(rows[1]?.startsWith('  ❯ 1.')).toBe(true)
    expect(rows[2]?.startsWith('  · 2.')).toBe(true)
  })

  it('windows a long roster and counts the rest, then comes back to the mark on a key', () => {
    const roster = new SubagentRoster()
    for (let index = 0; index < 12; index += 1) roster.start(`c${String(index)}`, `child ${String(index)}`, 0)
    const entries = roster.entries()
    const panel = new SubagentsPanel()
    panel.reset()
    const top = panel.view(entries, theme, 120, 1)
    expect(top.at(-2)).toBe('  ↓ 4 more')
    panel.scrollBy(4, entries)
    const scrolled = panel.view(entries, theme, 120, 1)
    expect(scrolled[1]).toBe('  ↑ 4 more')
    expect(panel.targetAt(2, entries)).toEqual({ kind: 'item', index: 4 })
    panel.handle(key('down'), entries)
    // The window sprang back to the top: no rows above, the mark on the second.
    const sprung = panel.view(entries, theme, 120, 1)
    expect(sprung[1]).toBe('    1. ▶ child 0 · 0.0s')
    expect(sprung[2]).toBe('  ❯ 2. ▶ child 1 · 0.0s')
    expect(sprung.at(-2)).toBe('  ↓ 4 more')
  })

  it('clamps the mark when the roster is shorter than it was', () => {
    const panel = new SubagentsPanel()
    panel.reset()
    panel.handle(key('end'), twoChildren().entries())
    const one = new SubagentRoster()
    one.start('only', 'x', 0)
    expect(panel.handle(key('enter'), one.entries())).toEqual({ kind: 'enter', id: 'only' })
  })

  it('renders nothing for no children', () => {
    expect(new SubagentsPanel().view([], theme, 80, 0)).toEqual([])
  })
})
