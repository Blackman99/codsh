/**
 * The todo readout: what the pinned row says about work in flight, and what
 * the full list says about the rest. Both are read by a person mid-run, so the
 * counts and the item they name are the contract.
 */

import { describe, expect, it } from 'vitest'
import { createTheme, displayWidth } from '../src/theme.ts'
import { todoReport, todoRow } from '../src/todos.ts'
import type { TodoList } from '../src/todos.ts'

const theme = createTheme(false, {})

/** Build a list from `status:content` shorthand. */
const list = (...items: string[]): TodoList => items.map((item) => {
  const [status = '', ...rest] = item.split(':')
  return { status: status as 'pending' | 'in_progress' | 'completed', content: rest.join(':') }
})

describe('todoRow', () => {
  it('names the item in progress and the progress around it', () => {
    const row = todoRow(list('completed:read the code', 'in_progress:write the fix', 'pending:run the tests'), theme, 80)
    expect(row).toBe('todos 1/3 · ▶ write the fix')
  })

  it('names the next pending item with the same play mark, not a next: prefix', () => {
    // A list between items still answers "what now": the next pending one.
    const row = todoRow(list('completed:read the code', 'pending:write the fix'), theme, 80)
    expect(row).toBe('todos 1/2 · ▶ write the fix')
  })

  it('reports a finished list rather than vanishing', () => {
    // `2/2` is the confirmation the work landed; dropping the row here would
    // read as the list never having existed.
    expect(todoRow(list('completed:one', 'completed:two'), theme, 80)).toBe('todos 2/2 · all done ✔')
  })

  it('has nothing to report before the first write', () => {
    expect(todoRow([], theme, 80)).toBeUndefined()
  })

  it('appends the hint it is given', () => {
    const row = todoRow(list('in_progress:ship it'), theme, 80, 'Ctrl+T')
    expect(row).toBe('todos 0/1 · ▶ ship it · Ctrl+T')
  })

  it('keeps the hint on a finished list when the row has room', () => {
    expect(todoRow(list('completed:one', 'completed:two'), theme, 80, 'Ctrl+T'))
      .toBe('todos 2/2 · all done ✔ · Ctrl+T')
  })

  it('drops the hint on a finished list before cutting all done', () => {
    expect(todoRow(list('completed:one', 'completed:two'), theme, 24, 'Ctrl+T'))
      .toBe('todos 2/2 · all done ✔')
  })

  it('is cut to the columns it was given, never wrapped', () => {
    const row = todoRow(list('in_progress:a task with a very long name indeed'), theme, 24)
    expect(displayWidth(row ?? '')).toBeLessThanOrEqual(24)
    expect(row).toContain('…')
  })

  it('truncates the title before dropping the Ctrl+T hint', () => {
    const row = todoRow(
      list('in_progress:rewrite the authentication middleware and cover every path'),
      theme,
      80,
      'Ctrl+T',
    )
    expect(row).toContain('Ctrl+T')
    expect(row).toContain('…')
    expect(displayWidth(row ?? '')).toBeLessThanOrEqual(80)
  })

  it('drops the hint only when even a short title would not leave room', () => {
    const row = todoRow(list('in_progress:ship it'), theme, 22, 'Ctrl+T')
    expect(row).toBe('todos 0/1 · ▶ ship it')
    expect(row).not.toContain('Ctrl+T')
  })

  it('keeps glyphs when colour is off', () => {
    const plain = createTheme(true, { NO_COLOR: '1' })
    const row = todoRow(list('in_progress:write the fix'), plain, 80, 'Ctrl+T')
    expect(row).toBe('todos 0/1 · ▶ write the fix · Ctrl+T')
  })

  it('keeps the collapsed play mark off accent and pending', () => {
    const coloured = createTheme(true, {})
    const row = todoRow(list('in_progress:write the fix'), coloured, 80) ?? ''
    expect(row).toContain('\u001B[1m▶')
    expect(row).not.toContain('\u001B[93m▶')
    expect(row).not.toContain('\u001B[36m▶')
  })
})

describe('todoReport', () => {
  it('heads the list with progress and the states that have items', () => {
    const lines = todoReport(list('completed:read the code', 'in_progress:write the fix', 'pending:run the tests'), theme, 80)
    expect(lines).toEqual([
      'todos 1/3 · 1 in progress · 1 open',
      '  ✔ read the code',
      '  ▶ write the fix',
      '  ○ run the tests',
    ])
  })

  it('drops a state with nothing in it rather than reporting a zero', () => {
    const [header] = todoReport(list('completed:one', 'completed:two'), theme, 80)
    expect(header).toBe('todos 2/2')
  })

  it('counts the items a capped surface cannot show', () => {
    const lines = todoReport(list('pending:one', 'pending:two', 'pending:three'), theme, 80, { limit: 1 })
    expect(lines).toEqual(['todos 0/3 · 3 open', '  ○ one', '  … +2 more'])
  })

  it('carries a hint on the header without the state breakdown', () => {
    const [header] = todoReport(list('pending:one'), theme, 80, { hint: 'Ctrl+T closes' })
    expect(header).toBe('todos 0/1 · Ctrl+T closes')
  })

  it('has nothing to print before the first write', () => {
    expect(todoReport([], theme, 80)).toEqual([])
  })

  it('styles each state distinctly once the theme has colour', () => {
    const coloured = createTheme(true, {})
    const [, done = '', active = '', open = ''] = todoReport(
      list('completed:one', 'in_progress:two', 'pending:three'),
      coloured,
      80,
    )
    // Three states, three renderings: a glance must separate them without
    // reading the words.
    expect(new Set([done.replace('one', ''), active.replace('two', ''), open.replace('three', '')]).size).toBe(3)
    expect(active).toContain('\u001B[93m▶')
  })
})
