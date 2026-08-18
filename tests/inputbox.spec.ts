/**
 * Input box layout: a frame that closes on itself at any width, long lines that
 * wrap instead of hiding, a window that follows the cursor, and a menu under it.
 */

import { describe, expect, it } from 'vitest'
import { inputBox } from '../src/inputbox.ts'
import { createTheme, displayWidth } from '../src/theme.ts'
import type { EditorView } from '../src/editor.ts'

const theme = createTheme(false, {})

/** A view with sensible defaults. */
function view(over: Partial<EditorView> = {}): EditorView {
  return { lines: [''], row: 0, column: 0, candidates: [], selected: 0, token: '', ...over }
}

describe('the frame', () => {
  it('frames one line, all rows the same width', () => {
    const { rows } = inputBox(view({ lines: ['hello'], column: 5 }), theme, 40)
    expect(rows[0]).toMatch(/^╭─+╮$/)
    expect(rows[2]).toMatch(/^╰─+╯$/)
    expect(rows[1]).toContain('› hello')
    // A box whose rows disagree on width is a broken box.
    const widths = new Set(rows.slice(0, 3).map(displayWidth))
    expect(widths.size).toBe(1)
  })

  it('gives every buffer line its own row, marking only the first', () => {
    const { rows } = inputBox(view({ lines: ['one', 'two'], row: 1, column: 3 }), theme, 40)
    expect(rows[1]).toContain('› one')
    // Continuations align under the marker so the block reads as one prompt.
    expect(rows[2]).toContain('  two')
    expect(rows[2]).not.toContain('›')
  })

  it('closes the frame around a wide character', () => {
    const { rows } = inputBox(view({ lines: ['终端'], column: 2 }), theme, 30)
    const widths = new Set(rows.slice(0, 3).map(displayWidth))
    expect(widths.size).toBe(1)
  })

  it('shows a placeholder inside an empty box', () => {
    const { rows } = inputBox(view(), theme, 60, { placeholder: 'Ask anything · / commands' })
    expect(rows[1]).toContain('Ask anything')
    // Placeholder text is furniture, gone the moment anything is typed.
    const typed = inputBox(view({ lines: ['x'], column: 1 }), theme, 60, { placeholder: 'Ask anything' })
    expect(typed.rows[1]).not.toContain('Ask anything')
  })

  it('takes an accent for the frame, which is how a mode announces itself', () => {
    const loud = (text: string): string => `<${text}>`
    const { rows } = inputBox(view(), theme, 40, { accent: loud })
    expect(rows[0]?.startsWith('<')).toBe(true)
  })
})

describe('wrapping', () => {
  it('wraps a long line instead of hiding it', () => {
    // 30 columns leaves 24 for text: 40 characters must occupy two rows.
    const text = 'x'.repeat(40)
    const { rows } = inputBox(view({ lines: [text], column: 40 }), theme, 30)
    const body = rows.slice(1, -1).map(row => row.replaceAll(/[│› ]/gu, ''))
    expect(body.join('')).toBe(text)
    expect(body.length).toBe(2)
  })

  it('never splits a wide character across the wrap', () => {
    const text = '终'.repeat(15)
    const { rows } = inputBox(view({ lines: [text], column: 15 }), theme, 30)
    const body = rows.slice(1, -1).map(row => row.replaceAll(/[│› ]/gu, ''))
    expect(body.join('')).toBe(text)
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(30)
  })

  it('puts the cursor on the wrapped row it is editing', () => {
    const text = 'x'.repeat(40)
    const layout = inputBox(view({ lines: [text], column: 40 }), theme, 30)
    // The second segment, one row below the frame's top.
    expect(layout.cursorRow).toBe(2)
    expect(layout.cursorColumn).toBe(4 + 16)
  })

  it('windows around the cursor once the box outgrows its budget', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`)
    const layout = inputBox(view({ lines, row: 9, column: 6 }), theme, 40)
    const body = layout.rows.filter(row => row.includes('line '))
    expect(body.length).toBe(6)
    // The cursor's line is visible; the earliest lines are the ones clipped.
    expect(body.at(-1)).toContain('line 9')
    expect(layout.rows.join('\n')).not.toContain('line 0')
    // A clipped edge says so instead of looking complete.
    expect(body[0]).toContain('…')
  })

  it('keeps the cursor visible when it moves back into the clipped part', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`)
    const layout = inputBox(view({ lines, row: 0, column: 0 }), theme, 40)
    expect(layout.rows.join('\n')).toContain('line 0')
    expect(layout.cursorRow).toBe(1)
  })
})

describe('the cursor', () => {
  it('sits after the text it follows', () => {
    const { cursorRow, cursorColumn } = inputBox(view({ lines: ['abc'], column: 3 }), theme, 40)
    // Row 0 is the frame's top, so the first buffer line is row 1.
    expect(cursorRow).toBe(1)
    // Border, space, marker, space, then three characters.
    expect(cursorColumn).toBe(7)
  })

  it('counts a wide character as two columns', () => {
    const { cursorColumn } = inputBox(view({ lines: ['终'], column: 1 }), theme, 40)
    expect(cursorColumn).toBe(6)
  })

  it('follows the line being edited', () => {
    const { cursorRow } = inputBox(view({ lines: ['a', 'b', 'c'], row: 2, column: 1 }), theme, 40)
    expect(cursorRow).toBe(3)
  })
})

describe('visual hierarchy', () => {
  const colour = createTheme(true, { TERM: 'xterm-256color' })
  const gray = '\u001B[38;5;245m'

  it('sets the placeholder behind the typed text, not beside it', () => {
    const empty = inputBox(view(), colour, 60, { placeholder: 'Ask anything' })
    // Placeholder is secondary gray; typed text carries no styling at all —
    // that difference IS the contrast the box hinges on.
    expect(empty.rows[1]).toContain(`${gray}Ask anything`)
    const typed = inputBox(view({ lines: ['hello'], column: 5 }), colour, 60)
    expect(typed.rows[1]).toContain(' hello')
    expect(typed.rows[1]).not.toContain(`${gray}hello`)
  })

  it('keeps the menu detail gray and the matched prefix accented', () => {
    const { rows } = inputBox(view({
      lines: ['/pl'],
      column: 3,
      token: '/pl',
      candidates: [{ value: '/plan', detail: 'enter plan mode' }],
    }), colour, 60)
    const menu = rows.at(-1) ?? ''
    // The typed fragment keeps the accent colour inside the candidate...
    expect(menu).toContain('\u001B[36m/pl\u001B[0m')
    // ...and the description sits in the secondary gray, never full-strength.
    expect(menu).toContain(`${gray}  enter plan mode`)
  })

  it('pads menu labels by display width, so wide names still align', () => {
    const { rows } = inputBox(view({
      lines: ['@'],
      column: 1,
      token: '@',
      candidates: [{ value: '@终端.ts', detail: 'a' }, { value: '@aaaaaa.ts', detail: 'b' }],
    }), theme, 60)
    const menu = rows.slice(-2)
    // The details are single letters at the end: aligned labels put them at the
    // same display column, which code-unit padding gets wrong for wide names.
    const detailColumn = (row: string): number => displayWidth(row.slice(0, -1))
    expect(detailColumn(menu[0] ?? '')).toBe(detailColumn(menu[1] ?? ''))
  })
})

describe('the menu', () => {
  it('lists candidates under the box and marks the selected one', () => {
    const { rows } = inputBox(view({
      lines: ['/p'],
      column: 2,
      candidates: [{ value: '/plan', detail: 'enter plan mode' }, { value: '/permission', detail: 'switch preset' }],
      selected: 1,
    }), theme, 60)
    const menu = rows.slice(3)
    expect(menu[0]).toContain('/plan')
    expect(menu[0]).toContain('enter plan mode')
    expect(menu[1]).toContain('❯')
    expect(menu[1]).toContain('/permission')
  })

  it('caps a long menu and says how much it hid', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ value: `/c${index}`, detail: '' }))
    const { rows } = inputBox(view({ lines: ['/c'], column: 2, candidates: many }), theme, 60)
    expect(rows.at(-1)).toContain('4 more')
  })

  it('shows the hint instead of a menu when there is nothing to offer', () => {
    const { rows } = inputBox(view(), theme, 60, { hint: 'ESC interrupts' })
    expect(rows.at(-1)).toContain('ESC interrupts')
  })

  it('prefers the menu over the hint', () => {
    const { rows } = inputBox(
      view({ lines: ['/p'], column: 2, candidates: [{ value: '/plan', detail: '' }] }),
      theme, 60, { hint: 'ESC interrupts' })
    expect(rows.join('\n')).not.toContain('ESC interrupts')
  })
})
