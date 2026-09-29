/**
 * Wrapping styled text: the alternate screen makes us do the terminal's job,
 * and a break that cuts an escape sequence or drops a colour is visible.
 */

import { describe, expect, it } from 'vitest'
import { displayWidth } from '../src/theme.ts'
import { hangOf, wrapAll, wrapStyled } from '../src/wrap.ts'

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
    expect(rows).toEqual(['终'.repeat(4), '终'])
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(9)
  })

  it('charges a selector emoji or a keycap the two columns the terminal paints', () => {
    // Counted by code point, 🎙️ was one column and the row came out a column
    // too wide — the table rule after it drifted right on every such row.
    for (const emoji of ['🎙️', '1️⃣']) {
      const rows = wrapStyled(`${emoji}${'x'.repeat(11)}`, 12)
      expect(rows).toEqual([`${emoji}${'x'.repeat(10)}`, 'x'])
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(12)
    }
  })

  it('keeps a joined emoji on one row, whole', () => {
    // Summed by code point the family was six columns and broke between its
    // joiners; it is one two-column cluster. The space is the break, and a
    // word wider than the row is cut where the row ends.
    const rows = wrapStyled('👨‍👩‍👧 family', 4)
    expect(rows).toEqual(['👨‍👩‍👧', 'fami', 'ly'])
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(4)
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

describe('breaking between words', () => {
  it('breaks at a space, which neither row keeps', () => {
    expect(wrapStyled('the ship logic lives here', 12)).toEqual(['the ship', 'logic lives', 'here'])
  })

  it('moves a word that would straddle the edge down whole', () => {
    // A mid-word cut read `sh` / `ip` in a pasted answer.
    expect(wrapStyled('files 只有 bin 和 README.md，ship 逻辑', 20)).toEqual(['files 只有 bin 和', 'README.md，ship 逻辑'])
  })

  it('breaks between CJK characters, but never before closing punctuation', () => {
    expect(wrapStyled('一二三四五。六七', 10)).toEqual(['一二三四', '五。六七'])
    expect(wrapStyled('一二三（四五）', 8)).toEqual(['一二三', '（四五）'])
  })

  it('breaks a path after a slash', () => {
    expect(wrapStyled('packages/cli/extensions/ship/', 16)).toEqual(['packages/cli/', 'extensions/ship/'])
  })

  it('cuts a word wider than a whole row where the row ends', () => {
    expect(wrapStyled('a abcdefghijkl', 6)).toEqual(['a', 'abcdef', 'ghijkl'])
  })

  it('takes a run of spaces at the edge as the break', () => {
    expect(wrapStyled('abcde    fgh', 5)).toEqual(['abcde', 'fgh'])
  })

  it('keeps the styles open where it broke, as a cut anywhere does', () => {
    const rows = wrapStyled('\u001B[1mbold words here\u001B[0m', 10)
    expect(rows).toEqual(['\u001B[1mbold words\u001B[0m', '\u001B[1mhere\u001B[0m'])
  })
})

describe('a hanging continuation', () => {
  it('indents every row after the first by the hang', () => {
    expect(wrapStyled('• one two three four', 10, 2)).toEqual(['• one two', '  three', '  four'])
  })

  it('opens the hang inside the carried styles, so a fill runs under it', () => {
    const rows = wrapStyled('\u001B[48;5;235m  code that runs long\u001B[0m', 12, 2)
    expect(rows[1]).toBe('\u001B[48;5;235m  runs long\u001B[0m')
  })

  it('drops a hang that would leave too little row beside it', () => {
    // Two of four columns would be indent: no row after the first is.
    expect(wrapStyled('• abcdef', 4, 2)).toEqual(['•', 'abcd', 'ef'])
  })

  it('reads a line\'s hang from its indent and its list marker', () => {
    expect(hangOf('\u001B[2m•\u001B[0m text', 40)).toBe(2)
    expect(hangOf('  • nested', 40)).toBe(4)
    expect(hangOf('12. numbered', 40)).toBe(4)
    expect(hangOf('  indented prose', 40)).toBe(2)
    expect(hangOf('prose', 40)).toBe(0)
    expect(hangOf('•no space', 40)).toBe(0)
    expect(hangOf('      deep', 10)).toBe(0)
  })
})

describe('a very long line', () => {
  it('wraps in time proportional to its length, losing nothing', () => {
    // One tool result held a 49,616-character HTML line; wrapping it took four
    // seconds when every character re-sliced the remainder, and the buffer is
    // wrapped again at every resize and fold toggle. Linear now: milliseconds.
    const line = `\u001B[2m  ${'<div class="x">'.repeat(4000)}\u001B[0m`
    const started = performance.now()
    const rows = wrapStyled(line, 100)
    const elapsed = performance.now() - started
    // Only the spaces the breaks took are gone.
    expect(rows.map(plain).join('').replaceAll(' ', '')).toBe(plain(line).replaceAll(' ', ''))
    expect(rows.length).toBeGreaterThanOrEqual(Math.ceil(displayWidth(plain(line)) / 100))
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(100)
    // Every row opens the dim style and closes it.
    for (const row of rows) {
      expect(row.startsWith('\u001B[2m')).toBe(true)
      expect(row.endsWith('\u001B[0m')).toBe(true)
    }
    // Two orders of magnitude under the quadratic cost, so a slow machine
    // cannot turn this into a flake.
    expect(elapsed).toBeLessThan(1000)
  })

  it('wraps wide and styled text identically at any length', () => {
    // Wide characters, links, resets, and a mid-line newline, repeated until
    // the line is long enough that a quadratic scan would show.
    const unit = '中文\u001B[31mred\u001B[0m \u001B]8;;http://x\u0007l\u001B]8;;\u0007 a\nb '
    const rows = wrapStyled(unit.repeat(1500), 40)
    const text = plain(unit.repeat(1500)).replaceAll(/\u001B\][^\u0007]*\u0007/gu, '')
    const bare = (value: string): string => value.replaceAll(/[\n ]/gu, '')
    expect(bare(rows.map(row => plain(row).replaceAll(/\u001B\][^\u0007]*\u0007/gu, '')).join(''))).toBe(bare(text))
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(40)
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
