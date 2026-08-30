/**
 * The selection widget: one picker for approvals and questions, driven by
 * arrows, digits, shortcuts, and Space — because three slightly different
 * pickers is how the same bug ships three times.
 */

import { describe, expect, it } from 'vitest'
import { Selector } from '../src/selector.ts'
import { createTheme } from '../src/theme.ts'
import type { SelectSpec } from '../src/selector.ts'
import type { Key } from '../src/keys.ts'

const theme = createTheme(false, {})

const spec: SelectSpec = {
  title: 'Allow bash?',
  options: [
    { label: 'Yes, this time', shortcut: 'y' },
    { label: 'Yes, always', shortcut: 'a' },
    { label: 'No', shortcut: 'n' },
  ],
}

/** Shorthand for a bare key. */
const key = (kind: Key['kind']): Key => ({ kind } as Key)

/** Feed keys and return the settled outcome, or undefined while pending. */
function drive(selector: Selector, keys: Key[]) {
  for (const each of keys) {
    const step = selector.handle(each)
    if (step.kind === 'done') return step.outcome
  }
  return undefined
}

describe('single select', () => {
  it('accepts the marked option on Enter', () => {
    expect(drive(new Selector(spec), [key('enter')])).toEqual({ kind: 'chosen', indices: [0] })
  })

  it('moves the marker with the arrows and wraps', () => {
    expect(drive(new Selector(spec), [key('down'), key('enter')])).toEqual({ kind: 'chosen', indices: [1] })
    expect(drive(new Selector(spec), [key('up'), key('enter')])).toEqual({ kind: 'chosen', indices: [2] })
  })

  it('answers a digit outright', () => {
    expect(drive(new Selector(spec), [{ kind: 'text', text: '3' }])).toEqual({ kind: 'chosen', indices: [2] })
  })

  it('answers a shortcut key outright', () => {
    expect(drive(new Selector(spec), [{ kind: 'text', text: 'a' }])).toEqual({ kind: 'chosen', indices: [1] })
  })

  it('cancels on Escape', () => {
    expect(drive(new Selector(spec), [key('escape')])).toEqual({ kind: 'cancelled' })
  })

  it('ignores a key that means nothing here', () => {
    expect(drive(new Selector(spec), [{ kind: 'text', text: 'q' }, key('backspace')])).toBeUndefined()
  })
})

describe('multi select', () => {
  const multi: SelectSpec = { ...spec, multi: true }

  it('toggles with Space and confirms the checked set on Enter', () => {
    const outcome = drive(new Selector(multi), [
      { kind: 'text', text: ' ' },
      key('down'),
      key('down'),
      { kind: 'text', text: ' ' },
      key('enter'),
    ])
    expect(outcome).toEqual({ kind: 'chosen', indices: [0, 2] })
  })

  it('answers the marked option when nothing was checked', () => {
    // A plain Enter still answers; demanding a toggle first would read as a
    // broken Enter key.
    expect(drive(new Selector(multi), [key('down'), key('enter')])).toEqual({ kind: 'chosen', indices: [1] })
  })

  it('toggles by digit rather than settling', () => {
    const outcome = drive(new Selector(multi), [
      { kind: 'text', text: '1' },
      { kind: 'text', text: '3' },
      key('enter'),
    ])
    expect(outcome).toEqual({ kind: 'chosen', indices: [0, 2] })
  })
})

describe('the custom row', () => {
  const withCustom: SelectSpec = { ...spec, custom: '✎ Type your own answer' }

  it('reports custom when chosen', () => {
    expect(drive(new Selector(withCustom), [key('up'), key('enter')])).toEqual({ kind: 'custom' })
  })

  it('does not expose the custom row as an option preview', () => {
    const selector = new Selector(withCustom)
    selector.handle(key('up'))
    expect(selector.highlighted).toBeUndefined()
  })

  it('reaches it by digit too', () => {
    expect(drive(new Selector(withCustom), [{ kind: 'text', text: '4' }])).toEqual({ kind: 'custom' })
  })
})

describe('filterable', () => {
  const catalog: SelectSpec = {
    title: 'Switch model',
    filterable: true,
    options: [
      { label: 'deepseek/flash', detail: 'fast' },
      { label: 'deepseek/pro', detail: 'current' },
      { label: 'openai/gpt', detail: 'codex' },
    ],
  }

  it('filters by typed text and accepts the original index', () => {
    expect(drive(new Selector(catalog), [
      { kind: 'text', text: 'p' },
      { kind: 'text', text: 'r' },
      key('enter'),
    ])).toEqual({ kind: 'chosen', indices: [1] })
  })

  it('moves arrows inside the filtered set', () => {
    expect(drive(new Selector(catalog), [
      { kind: 'text', text: 'deepseek' },
      key('down'),
      key('enter'),
    ])).toEqual({ kind: 'chosen', indices: [1] })
  })

  it('exposes the marked original index to preview callers', () => {
    const selector = new Selector(catalog)
    expect(selector.highlighted).toBe(0)
    selector.handle({ kind: 'text', text: 'gpt' })
    expect(selector.highlighted).toBe(2)
    selector.handle({ kind: 'text', text: 'zzz' })
    expect(selector.highlighted).toBeUndefined()
  })

  it('edits the query with Backspace', () => {
    expect(drive(new Selector(catalog), [
      { kind: 'text', text: 'zzz' },
      key('backspace'),
      key('backspace'),
      key('backspace'),
      { kind: 'text', text: 'gpt' },
      key('enter'),
    ])).toEqual({ kind: 'chosen', indices: [2] })
  })

  it('leaves digits and shortcuts working when filtering is off', () => {
    expect(drive(new Selector(spec), [{ kind: 'text', text: 'n' }])).toEqual({ kind: 'chosen', indices: [2] })
    expect(drive(new Selector(spec), [{ kind: 'text', text: '2' }])).toEqual({ kind: 'chosen', indices: [1] })
  })
})

describe('the view', () => {
  it('shows the title, numbered options, shortcuts, and the marker', () => {
    const rows = new Selector(spec).view(theme, 60)
    expect(rows[0]).toBe('Allow bash?')
    expect(rows[1]).toContain('❯ 1. Yes, this time (y)')
    expect(rows[3]).toContain('  3. No (n)')
    expect(rows.at(-1)).toContain('Enter accepts')
  })

  it('marks checked options in multi select', () => {
    const selector = new Selector({ ...spec, multi: true })
    selector.handle({ kind: 'text', text: ' ' })
    const rows = selector.view(theme, 60)
    expect(rows[1]).toContain('◉')
    expect(rows[2]).toContain('○')
    expect(rows.at(-1)).toContain('Space toggles')
  })

  it('fits its rows to the terminal', () => {
    const wide: SelectSpec = {
      title: 'T',
      options: [{ label: 'x'.repeat(100), detail: 'y'.repeat(100) }],
    }
    for (const row of new Selector(wide).view(theme, 30)) {
      expect(row.length).toBeLessThanOrEqual(30)
    }
  })
})
