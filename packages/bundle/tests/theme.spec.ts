/**
 * Terminal styling degrades off a TTY and under NO_COLOR, and display metrics
 * count the columns a terminal actually advances.
 */

import { describe, expect, it } from 'vitest'
import { backgroundIsLight, createTheme, displayWidth, oneRow, truncate } from '../src/theme.ts'

describe('createTheme', () => {
  it('emits sequences on a colour-capable terminal', () => {
    const theme = createTheme(true, {})
    expect(theme.colored).toBe(true)
    expect(theme.error('no')).toBe('\u001B[31mno\u001B[0m')
  })

  it('emits nothing off a TTY, so a redirected transcript stays greppable', () => {
    const theme = createTheme(false, {})
    expect(theme.colored).toBe(false)
    expect(theme.error('no')).toBe('no')
  })

  it.each([{ NO_COLOR: '1' }, { NO_COLOR: '' }])('honours NO_COLOR set to any value (%o)', (env) => {
    expect(createTheme(true, env).colored).toBe(false)
  })
})

describe('displayWidth', () => {
  it('counts one column per ASCII character', () => {
    expect(displayWidth('abc')).toBe(3)
  })

  it('counts two columns per East Asian wide character', () => {
    expect(displayWidth('终端')).toBe(4)
    expect(displayWidth('a终b')).toBe(4)
  })

  it('ignores styling sequences', () => {
    expect(displayWidth('\u001B[31mabc\u001B[0m')).toBe(3)
  })

  it('counts a combining mark as part of the cell it attaches to', () => {
    expect(displayWidth('é')).toBe(1)
  })

  it('measures the empty string as zero', () => {
    expect(displayWidth('')).toBe(0)
  })
})

describe('truncate', () => {
  it('returns a string that already fits', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })

  it('marks the cut with an ellipsis', () => {
    expect(truncate('abcdefgh', 4)).toBe('abc…')
  })

  it('never splits a wide character across the budget', () => {
    // Three wide characters are six columns; a five-column budget keeps one
    // pair plus the ellipsis rather than half a cell.
    expect(truncate('终端机', 5)).toBe('终端…')
  })

  it('keeps styling and closes it before the ellipsis on a cut', () => {
    // Styling must survive a fit untouched and a cut without leaking onto the
    // next row — stripping it is how every menu lost its colour.
    expect(truncate('\u001B[31mabcdefgh\u001B[0m', 4)).toBe('\u001B[31mabc\u001B[0m…')
    const styled = '\u001B[1m/plan\u001B[0m \u001B[2mdetail\u001B[0m'
    expect(truncate(styled, 60)).toBe(styled)
  })

  it('upgrades secondary text to a palette gray on a 256-colour terminal', () => {
    // The `dim` attribute renders at full brightness on several terminals, and
    // a hierarchy nobody can see is no hierarchy.
    expect(createTheme(true, { TERM: 'xterm-256color' }).dim('x')).toBe('\u001B[38;5;245mx\u001B[0m')
  })

  it('swaps the secondary-text shade for a light background, and back', () => {
    const theme = createTheme(true, { TERM: 'xterm-256color' })
    theme.setLight(true)
    expect(theme.dim('x')).toBe('\u001B[38;5;242mx\u001B[0m')
    theme.setLight(false)
    expect(theme.dim('x')).toBe('\u001B[38;5;245mx\u001B[0m')
  })

  it('reads lightness out of an OSC color answer', () => {
    expect(backgroundIsLight('rgb:ffff/ffff/ffff')).toBe(true)
    expect(backgroundIsLight('rgb:1e1e/1e1e/2e2e')).toBe(false)
    expect(backgroundIsLight('rgb:ff/ff/ff')).toBe(true)
    expect(backgroundIsLight('rgb:0/0/0')).toBe(false)
    // Yellow is light, blue is dark: the channels are weighted, not averaged.
    expect(backgroundIsLight('rgb:ffff/ffff/0000')).toBe(true)
    expect(backgroundIsLight('rgb:0000/0000/ffff')).toBe(false)
    expect(backgroundIsLight('not-a-color')).toBeUndefined()
    expect(createTheme(true, {}).dim('x')).toBe('\u001B[2mx\u001B[0m')
  })

  it('yields the empty string for a budget with no room for the marker', () => {
    expect(truncate('abcdef', 1)).toBe('')
  })
})

describe('emoji and symbol widths, per string-width', () => {
  it('sizes emoji-presentation symbols at two columns', () => {
    // ⚡ mis-sized at one column sheared a real table's fourth column.
    expect(displayWidth('⚡')).toBe(2)
    expect(displayWidth('工作中显示 ⚡ 前缀')).toBe(18)
  })
})

describe('a row that must stay one row', () => {
  it('turns every control character into the column it was measured as', () => {
    expect(oneRow('one\ntwo')).toBe('one two')
    expect(oneRow('tab\there')).toBe('tab here')
    expect(oneRow('carriage\rreturn')).toBe('carriage return')
    // The escape SGR is built from is the one C0 character a row needs.
    expect(oneRow('\u001B[1mbold\u001B[0m')).toBe('\u001B[1mbold\u001B[0m')
  })

  it('keeps the newline for a caller that breaks rows on it', () => {
    expect(oneRow('one\ntwo\tthree', true)).toBe('one\ntwo three')
  })

  it('measures a cut on the flattened string, so no cut keeps a newline', () => {
    // Left alone, a newline scores no columns: the string measures as a fit,
    // is returned untouched, and the row it is painted into loses its frame.
    const multi = "import re\np='spec.md'\ns=open(p).read()"
    expect(truncate(multi, 200)).not.toContain('\n')
    expect(truncate(multi, 20)).not.toContain('\n')
    expect(displayWidth(truncate(multi, 20))).toBeLessThanOrEqual(20)
  })
})
