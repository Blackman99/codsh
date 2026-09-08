/**
 * The queue's own surface: the collapsed readout a person reads at a glance,
 * and the panel they open to act on what is waiting. Both are read mid-run,
 * so the counts, the previews, and what each key does are the contract.
 */

import { describe, expect, it } from 'vitest'
import { QueuePanel, queueRow, steerRefusal, steeringRow } from '../src/queue-panel.ts'
import { createTheme, displayWidth } from '../src/theme.ts'
import type { QueueItem, QueueItemKind } from '../src/queue.ts'

const theme = createTheme(false, {})

/** A queued item, images beside the point here. */
const item = (id: number, text: string, kind: QueueItemKind = 'prompt'): QueueItem => ({ id, kind, text, images: [] })

describe('queueRow', () => {
  it('names the one queued line and the key', () => {
    expect(queueRow([item(1, 'later work')], theme, 80)).toBe('  ↳ queued: later work · Ctrl+Q')
  })

  it('counts several and previews each first line', () => {
    const items = [item(1, 'fix the test'), item(2, '!pnpm test', 'bang'), item(3, '/compact', 'command')]
    expect(queueRow(items, theme, 80)).toBe('  ↳ 3 queued: fix the test · !pnpm test · /compact · Ctrl+Q')
  })

  it('shows only the first line of a multi-line item', () => {
    const items = [item(1, 'first line\nsecond line'), item(2, 'another')]
    const row = queueRow(items, theme, 80) ?? ''
    expect(row).toContain('first line')
    expect(row).not.toContain('second line')
  })

  it('cuts the preview before dropping the key', () => {
    const row = queueRow([item(1, 'a rather long thought about the failing test')], theme, 24) ?? ''
    expect(row).toContain('Ctrl+Q')
    expect(row).toContain('…')
    expect(displayWidth(row)).toBeLessThanOrEqual(24)
  })

  it('drops the key only when even a short preview would not fit', () => {
    const row = queueRow([item(1, 'a rather long thought about the failing test')], theme, 10) ?? ''
    expect(row).not.toContain('Ctrl+Q')
    expect(displayWidth(row)).toBeLessThanOrEqual(10)
  })

  it('is cut to its columns, never wrapped', () => {
    const row = queueRow([item(1, 'x'.repeat(100))], theme, 30) ?? ''
    expect(displayWidth(row)).toBeLessThanOrEqual(30)
  })

  it('has nothing to report for an empty queue', () => {
    expect(queueRow([], theme, 80)).toBeUndefined()
  })
})

describe('steeringRow', () => {
  it('names the steer in flight', () => {
    expect(steeringRow('rename the helper function', theme, 80)).toBe('  ↳ steering: rename the helper function')
  })
})

describe('QueuePanel view', () => {
  it('shows the header count, numbered rows, the marker, and the footer', () => {
    const panel = new QueuePanel()
    const items = [
      item(1, 'fix the failing test in prompt.spec'),
      item(2, '!pnpm test', 'bang'),
      item(3, 'explain the diff\nwith more context\nand detail'),
    ]
    panel.setHovered({ kind: 'item', index: 2 })
    expect(panel.view(items, theme, 80, true)).toEqual([
      '  queue 3 · Ctrl+Q closes',
      '  ❯ 1. fix the failing test in prompt.spec',
      '    2. !pnpm test',
      '  · 3. explain the diff ⏎ +2 lines',
      '    [enter] edit · [d] delete · [s] steer · [⇧↑↓] move · [esc] back',
    ])
  })

  it('offers [s] steer only while a turn runs', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a')]
    expect(panel.view(items, theme, 80, true).at(-1)).toContain('[s] steer')
    expect(panel.view(items, theme, 80, false).at(-1)).not.toContain('[s] steer')
  })

  it('windows a long queue and counts the rest, then flips after End', () => {
    const panel = new QueuePanel()
    const items = Array.from({ length: 12 }, (_, index) => item(index + 1, `item ${index + 1}`))
    const rows = panel.view(items, theme, 80, true).join('\n')
    expect(rows).toContain('↓ 4 more')
    // The footer's `[⇧↑↓] move` legend carries an up arrow of its own — only a
    // "more above" row would put one before it.
    expect(rows).not.toMatch(/↑ \d+ more/)
    panel.handle({ kind: 'end' }, items, true)
    expect(panel.view(items, theme, 80, true).join('\n')).toContain('↑ 4 more')
  })

  it('fits its rows to the terminal', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'x'.repeat(200))]
    for (const row of panel.view(items, theme, 30, true)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(30)
    }
  })

  it('shows a multi-line item as its first line and a line count', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'first\nsecond\nthird\nfourth')]
    const rows = panel.view(items, theme, 80, true)
    expect(rows[1]).toContain('first')
    expect(rows[1]).not.toContain('second')
    expect(rows[1]).toContain('⏎ +3 lines')
  })

  it('returns nothing for an empty queue', () => {
    const panel = new QueuePanel()
    expect(panel.view([], theme, 80, true)).toEqual([])
  })
})

describe('QueuePanel keys', () => {
  it('moves the mark with the arrows and wraps', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')]
    expect(panel.handle({ kind: 'up' }, items, false)).toEqual({ kind: 'pending' })
    expect(panel.mark).toBe(2)
    panel.handle({ kind: 'down' }, items, false)
    panel.handle({ kind: 'down' }, items, false)
    expect(panel.mark).toBe(1)
  })

  it('moves down on Tab', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b')]
    panel.handle({ kind: 'tab' }, items, false)
    expect(panel.mark).toBe(1)
  })

  it('jumps to the first and last row with Home and End', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')]
    panel.handle({ kind: 'end' }, items, false)
    expect(panel.mark).toBe(2)
    panel.handle({ kind: 'home' }, items, false)
    expect(panel.mark).toBe(0)
  })

  it('jumps by digit without acting', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')]
    expect(panel.handle({ kind: 'text', text: '3' }, items, false)).toEqual({ kind: 'pending' })
    expect(panel.mark).toBe(2)
  })

  it('edits on Enter and on e', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b')]
    expect(panel.handle({ kind: 'enter' }, items, false)).toEqual({ kind: 'edit', id: 1 })
    panel.handle({ kind: 'down' }, items, false)
    expect(panel.handle({ kind: 'text', text: 'e' }, items, false)).toEqual({ kind: 'edit', id: 2 })
  })

  it('removes on d and on Delete, not on Backspace', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b')]
    expect(panel.handle({ kind: 'backspace' }, items, false)).toEqual({ kind: 'pending' })
    expect(panel.handle({ kind: 'delete' }, items, false)).toEqual({ kind: 'remove', id: 1 })
    expect(panel.handle({ kind: 'text', text: 'd' }, items, false)).toEqual({ kind: 'remove', id: 1 })
  })

  it('moves the marked item with Shift+Up/Down and keeps the mark on it', () => {
    const panel = new QueuePanel()
    let items = [item(1, 'a'), item(2, 'b'), item(3, 'c')]
    panel.handle({ kind: 'down' }, items, false)
    expect(panel.mark).toBe(1)
    expect(panel.handle({ kind: 'scroll', lines: -1 }, items, false)).toEqual({ kind: 'move', id: 2, delta: -1 })
    expect(panel.mark).toBe(0)
    // The owner applies the move to the real queue; the panel only tracks
    // where the item it moved now sits, so the next call sees it reordered.
    items = [items[1]!, items[0]!, items[2]!]
    expect(panel.handle({ kind: 'scroll', lines: 1 }, items, false)).toEqual({ kind: 'move', id: 2, delta: 1 })
    expect(panel.mark).toBe(1)
  })

  it('refuses to move the marked item past either end', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b')]
    expect(panel.handle({ kind: 'scroll', lines: -1 }, items, false)).toEqual({ kind: 'pending' })
    panel.handle({ kind: 'end' }, items, false)
    expect(panel.handle({ kind: 'scroll', lines: 1 }, items, false)).toEqual({ kind: 'pending' })
  })

  it('steers a prompt on s while a turn runs, refuses a ! line, and refuses when nothing runs', () => {
    const panel = new QueuePanel()
    const prompt = item(1, 'ask a question')
    const bang = item(2, '!pnpm test', 'bang')
    expect(panel.handle({ kind: 'text', text: 's' }, [prompt], true)).toEqual({ kind: 'steer', id: 1 })
    expect(panel.handle({ kind: 'text', text: 's' }, [bang], true)).toEqual({ kind: 'pending' })
    expect(steerRefusal(bang, true)).toBe('only a message can steer — ! and / lines run in their turn')
    expect(panel.handle({ kind: 'text', text: 's' }, [prompt], false)).toEqual({ kind: 'pending' })
    expect(steerRefusal(prompt, false)).toBe('nothing is running — it stays queued')
    expect(steerRefusal(prompt, true)).toBeUndefined()
    expect(steerRefusal(undefined, true)).toBeUndefined()
  })

  it('closes on Escape and on toggle-queue', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a')]
    expect(panel.handle({ kind: 'escape' }, items, false)).toEqual({ kind: 'close' })
    expect(panel.handle({ kind: 'toggle-queue' }, items, false)).toEqual({ kind: 'close' })
  })

  it('swallows a letter it has no verb for', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a')]
    expect(panel.handle({ kind: 'text', text: 'x' }, items, false)).toEqual({ kind: 'pending' })
  })

  it('clamps the mark when items drain under it', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')]
    panel.handle({ kind: 'end' }, items, false)
    expect(panel.mark).toBe(2)
    const drained = [item(1, 'a')]
    expect(panel.handle({ kind: 'up' }, drained, false)).toEqual({ kind: 'pending' })
    expect(panel.mark).toBe(0)
  })

  it('comes back to the mark on any key after the wheel moved the window', () => {
    const panel = new QueuePanel()
    const items = Array.from({ length: 12 }, (_, index) => item(index + 1, `item ${index + 1}`))
    panel.scrollBy(4, items)
    const scrolled = panel.view(items, theme, 80, true)
    // `endsWith`, not `includes`: item 1's row is the only one ending in
    // "item 1" — item 11 and item 12 end in "item 11" / "item 12" instead.
    expect(scrolled.some(row => row.endsWith('item 1'))).toBe(false)
    panel.handle({ kind: 'down' }, items, true)
    const restored = panel.view(items, theme, 80, true)
    expect(restored.some(row => row.endsWith('item 1'))).toBe(true)
  })
})

describe('QueuePanel pointer', () => {
  it('maps its rows to what sits on them', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')]
    expect(panel.targetAt(0, items)).toEqual({ kind: 'header' })
    expect(panel.targetAt(1, items)).toEqual({ kind: 'item', index: 0 })
    expect(panel.targetAt(3, items)).toEqual({ kind: 'item', index: 2 })
    expect(panel.targetAt(4, items)).toEqual({ kind: 'footer' })
    expect(panel.targetAt(5, items)).toBeUndefined()
  })

  it('accounts for the "more above" row once the window is scrolled', () => {
    const panel = new QueuePanel()
    const items = Array.from({ length: 12 }, (_, index) => item(index + 1, `item ${index + 1}`))
    panel.handle({ kind: 'end' }, items, true)
    expect(panel.targetAt(1, items)).toBeUndefined()
    expect(panel.targetAt(2, items)).toEqual({ kind: 'item', index: 4 })
    expect(panel.targetAt(9, items)).toEqual({ kind: 'item', index: 11 })
    expect(panel.targetAt(10, items)).toEqual({ kind: 'footer' })
  })

  it('marks the row under the pointer with · and leaves the mark where it was', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')]
    panel.setHovered({ kind: 'item', index: 2 })
    const rows = panel.view(items, theme, 80, true)
    expect(rows[1]).toContain('❯')
    expect(rows[3]).toContain('·')
    expect(rows[1]).not.toContain('·')
    expect(panel.mark).toBe(0)
  })

  it('edits the item a click lands on and moves the mark there', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a'), item(2, 'b'), item(3, 'c')]
    expect(panel.click({ kind: 'item', index: 2 }, items)).toEqual({ kind: 'edit', id: 3 })
    expect(panel.mark).toBe(2)
  })

  it('closes on a header click and on a footer click', () => {
    const panel = new QueuePanel()
    const items = [item(1, 'a')]
    expect(panel.click({ kind: 'header' }, items)).toEqual({ kind: 'close' })
    expect(panel.click({ kind: 'footer' }, items)).toEqual({ kind: 'close' })
  })
})
