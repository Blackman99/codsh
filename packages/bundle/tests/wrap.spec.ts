/**
 * Wrapping styled text: the alternate screen makes us do the terminal's job,
 * and a break that cuts an escape sequence or drops a colour is visible.
 */

import { describe, expect, it } from 'vitest'
import { displayWidth } from '../src/theme.ts'
import { wrapAll, wrapStyled } from '../src/wrap.ts'

/** Strip styling, for content assertions. */
const plain = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/gu, '')

describe('wrapStyled', () => {
  it('leaves a line that fits untouched', () => {
    expect(wrapStyled('hello', 10)).toEqual(['hello'])
  })

  it('yields one empty row for an empty line, which is a paragraph break', () => {
    expect(wrapStyled('', 10)).toEqual([''])
  })

  it('breaks on display width, losing no characters', () => {
    const rows = wrapStyled('x'.repeat(25), 10)
    expect(rows).toHaveLength(3)
    expect(rows.join('')).toBe('x'.repeat(25))
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(10)
  })

  it('never splits a wide character across the edge', () => {
    // Nine columns cannot hold the fifth wide character's second half.
    const rows = wrapStyled('终'.repeat(5), 9)
    expect(rows.map(plain).join('')).toBe('终'.repeat(5))
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(9)
  })

  it('carries the active style onto the continuation row and closes each row', () => {
    const rows = wrapStyled(`\u001B[31m${'a'.repeat(15)}\u001B[0m`, 10)
    expect(rows).toHaveLength(2)
    // Each row opens the colour and closes it, so no row bleeds into the next.
    expect(rows[0]).toBe(`\u001B[31m${'a'.repeat(10)}\u001B[0m`)
    expect(rows[1]?.startsWith('\u001B[31m')).toBe(true)
    expect(rows[1]?.endsWith('\u001B[0m')).toBe(true)
    expect(plain(rows.join(''))).toBe('a'.repeat(15))
  })

  it('drops carried styles at a reset', () => {
    const rows = wrapStyled(`\u001B[31mred\u001B[0m${'b'.repeat(12)}`, 5)
    // The reset closed the colour before the break, so continuations are plain.
    expect(rows.at(-1)).not.toContain('\u001B[31m')
  })

  it('keeps a hyperlink escape without counting it as width', () => {
    const link = '\u001B]8;;https://x.dev\u0007link\u001B]8;;\u0007'
    expect(wrapStyled(link, 10)).toEqual([link])
  })

  it('returns the line unchanged when the width is nonsense', () => {
    expect(wrapStyled('abc', 0)).toEqual(['abc'])
  })
})

describe('wrapAll', () => {
  it('keeps line order and counts physical rows', () => {
    expect(wrapAll(['ab', 'cdefgh', ''], 3)).toEqual(['ab', 'cde', 'fgh', ''])
  })
})

describe('a line that carries its own newlines', () => {
  it('becomes one row per line, not one row with a cursor movement in it', () => {
    expect(wrapStyled('one\ntwo\nthree', 40)).toEqual(['one', 'two', 'three'])
  })

  it('carries the styles open at the break into the next row', () => {
    const rows = wrapStyled('\u001B[1mbold\nstill bold', 40)
    expect(rows[0]).toBe('\u001B[1mbold\u001B[0m')
    expect(rows[1]).toBe('\u001B[1mstill bold\u001B[0m')
  })

  it('spends a column on every other control character', () => {
    expect(wrapStyled('a\tb', 40)).toEqual(['a b'])
  })
})
