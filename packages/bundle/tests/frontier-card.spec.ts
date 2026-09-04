/** FrontierCard layout, focus, and key mapping for /ship grill questions. */

import { describe, expect, it } from 'vitest'
import { FrontierCard, recommendedIndex } from '../src/frontier-card.ts'
import { createTheme, displayWidth } from '../src/theme.ts'

const theme = createTheme(false, {})
const painted = createTheme(true, {})

const spec = {
  question: 'Which storage wins for the first slice?',
  options: [
    { label: 'SQLite file', recommended: true },
    { label: 'Postgres' },
    { label: 'In-memory' },
  ],
}

describe('recommendedIndex', () => {
  it('defaults to the first marked option, else the first row', () => {
    expect(recommendedIndex(spec.options)).toBe(0)
    expect(recommendedIndex([
      { label: 'A' },
      { label: 'B', recommended: true },
      { label: 'C' },
    ])).toBe(1)
    expect(recommendedIndex([{ label: 'only' }])).toBe(0)
  })
})

describe('FrontierCard', () => {
  it('defaults focus to the recommended option', () => {
    const later = new FrontierCard({
      question: 'Pick',
      options: [
        { label: 'Skip' },
        { label: 'Take this', recommended: true },
        { label: 'Other' },
      ],
    })
    expect(later.focused).toBe(1)
    expect(later.frame(theme, 56).focus).toBe(1)
    expect(later.frame(theme, 56).rows.join('\n')).toContain('[rec]')
    expect(later.frame(theme, 56).rows.join('\n')).toContain('Take this')
  })

  it('accepts the recommended option on y and Enter', () => {
    const card = new FrontierCard(spec)
    expect(card.handleKey({ kind: 'text', text: 'y' })).toEqual({ kind: 'accept', value: 'SQLite file' })
    expect(card.handleKey({ kind: 'enter' })).toEqual({ kind: 'accept', value: 'SQLite file' })
  })

  it('maps e to edit', () => {
    const card = new FrontierCard(spec)
    expect(card.handleKey({ kind: 'text', text: 'e' })).toEqual({ kind: 'edit' })
    expect(card.handleKey({ kind: 'text', text: 'E' })).toEqual({ kind: 'edit' })
  })

  it('moves with up/down and accepts the newly focused label', () => {
    const card = new FrontierCard(spec)
    expect(card.handleKey({ kind: 'down' })).toEqual({ kind: 'move' })
    expect(card.focused).toBe(1)
    expect(card.handleKey({ kind: 'enter' })).toEqual({ kind: 'accept', value: 'Postgres' })
    expect(card.handleKey({ kind: 'up' })).toEqual({ kind: 'move' })
    expect(card.focused).toBe(0)
    expect(card.handleKey({ kind: 'up' })).toEqual({ kind: 'move' })
    expect(card.focused).toBe(2)
  })

  it('dismisses on Esc and does not treat n as abort', () => {
    const card = new FrontierCard(spec)
    expect(card.handleKey({ kind: 'escape' })).toEqual({ kind: 'dismiss' })
    expect(card.handleKey({ kind: 'text', text: 'n' })).toBeUndefined()
    expect(card.handleKey({ kind: 'text', text: 'n' })).not.toEqual({ kind: 'dismiss' })
    expect(card.focused).toBe(0)
  })

  it('paints a short muted frame with the footer hint', () => {
    const card = new FrontierCard(spec)
    const frame = card.frame(theme, 56)
    expect(frame.rows.length).toBeLessThanOrEqual(8)
    const text = frame.rows.join('\n')
    expect(text).toContain('Which storage wins')
    expect(text).toContain('[rec]')
    expect(text).toContain('SQLite file')
    expect(text).toContain('Postgres')
    expect(text).toContain('[y] take · [e] edit · [↑↓] pick')
    expect(text).not.toMatch(/\[n\]/)
    expect(text).not.toContain('abort')
    expect(text).toContain('┌')
    expect(text).toContain('└')
  })

  it('truncates a long question to two lines', () => {
    const card = new FrontierCard({
      question: 'This question is long enough that it must wrap and then truncate rather than grow the card past two question lines of body copy that would hide the transcript',
      options: [{ label: 'Yes', recommended: true }, { label: 'No' }],
    })
    const frame = card.frame(theme, 40)
    expect(frame.rows.length).toBeLessThanOrEqual(8)
    expect(frame.rows.join('\n')).toContain('…')
  })

  it('scrolls options inside the card when they exceed the budget', () => {
    const card = new FrontierCard({
      question: 'Pick one',
      options: [
        { label: 'One', recommended: true },
        { label: 'Two' },
        { label: 'Three' },
        { label: 'Four' },
        { label: 'Five' },
        { label: 'Six' },
      ],
    })
    const first = card.frame(theme, 40)
    expect(first.rows.length).toBeLessThanOrEqual(8)
    expect(first.rows.join('\n')).toContain('One')
    expect(first.rows.join('\n')).not.toContain('Six')
    for (let step = 0; step < 5; step += 1) card.handleKey({ kind: 'down' })
    const last = card.frame(theme, 40)
    expect(last.rows.join('\n')).toContain('Six')
    expect(last.focus).toBe(5)
  })

  it('stays readable under NO_COLOR / plain theme', () => {
    const card = new FrontierCard(spec)
    const text = card.frame(theme, 56).rows.join('\n')
    expect(text).not.toMatch(/\u001B\[/)
    expect(text).toContain('[rec]')
    expect(text).toContain('[y] take · [e] edit · [↑↓] pick')
    expect(text).toContain('SQLite file')
    expect(text).toContain('Which storage wins')
  })

  it('marks recommended with ok and the focused row with accent when colored', () => {
    const card = new FrontierCard(spec)
    const text = card.frame(painted, 56).rows.join('\n')
    expect(text).toContain('\u001B[32m')
    expect(text).toContain('\u001B[36m')
    // Footer: y is ok (green), arrows are accent (cyan); no abort red.
    expect(text).toContain('\u001B[32m[y]')
    expect(text).toContain('\u001B[36m[↑↓]')
    expect(text).not.toContain('\u001B[31m')
  })

  it('keeps every row within the column budget', () => {
    const card = new FrontierCard({
      question: 'A very long frontier question that would overflow a narrow terminal if the frame did not truncate it',
      options: [
        { label: 'An option label that is also much too wide for ten columns', recommended: true },
        { label: 'Short' },
      ],
    })
    for (const columns of [1, 8, 10, 20, 40, 72]) {
      const frame = card.frame(theme, columns)
      expect(frame.rows.length).toBeLessThanOrEqual(8)
      for (const row of frame.rows) {
        expect(displayWidth(row)).toBeLessThanOrEqual(columns)
      }
    }
  })
})
