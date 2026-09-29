/**
 * Terminal styling degrades off a TTY and under NO_COLOR, and display metrics
 * count the columns a terminal actually advances.
 */

import { describe, expect, it } from 'vitest'
import { nearest256, nearestAnsi, params } from '../src/palette.ts'
import { backgroundIsLight, columnIndex, createTheme, displayWidth, graphemeAt, markSpan, oneRow, parseColor, truncate } from '../src/theme.ts'

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

  it('maps the locked semantic palette to the agreed SGR codes', () => {
    const theme = createTheme(true, {})
    expect(theme.muted('x')).toBe('\u001B[90mx\u001B[0m')
    expect(theme.accent('x')).toBe('\u001B[94mx\u001B[0m')
    expect(theme.agent('x')).toBe('\u001B[94mx\u001B[0m')
    expect(theme.tool('x')).toBe('\u001B[33mx\u001B[0m')
    expect(theme.ok('x')).toBe('\u001B[32mx\u001B[0m')
    expect(theme.warn('x')).toBe('\u001B[93mx\u001B[0m')
    expect(theme.err('x')).toBe('\u001B[31mx\u001B[0m')
  })

  it('paints the DeepSeek brand blue and its tint by the depth the terminal has', () => {
    const palette = createTheme(true, { TERM: 'xterm-256color' })
    expect(palette.accent('x')).toBe('\u001B[38;5;63mx\u001B[0m')
    expect(palette.user('x')).toBe('\u001B[38;5;63mx\u001B[0m')
    expect(palette.agent('x')).toBe('\u001B[38;5;105mx\u001B[0m')
    expect(palette.path('x')).toBe('\u001B[38;5;105mx\u001B[0m')
    expect(palette.heading('x')).toBe('\u001B[38;5;105mx\u001B[0m')
    expect(palette.link('x')).toBe('\u001B[38;5;105mx\u001B[0m')
    expect(palette.muted('x')).toBe('\u001B[90mx\u001B[0m')
    const truecolor = createTheme(true, { COLORTERM: 'truecolor' })
    expect(truecolor.accent('x')).toBe('\u001B[38;2;77;107;254mx\u001B[0m')
    expect(truecolor.agent('x')).toBe('\u001B[38;2;126;150;245mx\u001B[0m')
    expect(truecolor.dim('x')).toBe('\u001B[38;5;245mx\u001B[0m')
  })

  it('strips accent under NO_COLOR', () => {
    expect(createTheme(true, { NO_COLOR: '1' }).accent('x')).toBe('x')
  })

  it('formats strike with ANSI SGR 9 when colored', () => {
    const theme = createTheme(true, {})
    expect(theme.strike('strikethrough text')).toBe('\u001B[9mstrikethrough text\u001B[0m')
  })

  it('strips strike when uncolored or off-TTY', () => {
    const offTty = createTheme(false, {})
    expect(offTty.strike('strikethrough text')).toBe('strikethrough text')
    const noColor = createTheme(true, { NO_COLOR: '1' })
    expect(noColor.strike('strikethrough text')).toBe('strikethrough text')
  })

  it('renders grok background colors for different functional sections under truecolor', () => {
    const theme = createTheme(true, { COLORTERM: 'truecolor' })
    expect(theme.bgUser('prompt')).toBe('\u001B[48;2;21;26;48mprompt\u001B[0m')
    expect(theme.bgTool('exec')).toBe('\u001B[48;2;14;18;24mexec\u001B[0m')
    expect(theme.bgThinking('thought')).toBe('\u001B[48;2;26;29;46mthought\u001B[0m')
    expect(theme.bgError('failure')).toBe('\u001B[48;2;45;15;25mfailure\u001B[0m')
    expect(theme.bgCode('const x = 1')).toBe('\u001B[48;2;15;18;24mconst x = 1\u001B[0m')
    expect(theme.bgMeta('plan')).toBe('\u001B[48;2;18;20;26mplan\u001B[0m')
    expect(theme.diffAdd('+ line')).toBe('\u001B[48;2;10;38;30;38;2;80;200;140m+ line\u001B[0m')
    expect(theme.diffDel('- line')).toBe('\u001B[48;2;45;15;25;38;2;240;100;110m- line\u001B[0m')
  })

  it('renders grok background colors under 256-color palette', () => {
    const theme = createTheme(true, { TERM: 'xterm-256color' })
    expect(theme.bgUser('prompt')).toBe('\u001B[48;5;17mprompt\u001B[0m')
    expect(theme.bgTool('exec')).toBe('\u001B[48;5;235mexec\u001B[0m')
    expect(theme.bgThinking('thought')).toBe('\u001B[48;5;237mthought\u001B[0m')
    expect(theme.bgError('failure')).toBe('\u001B[48;5;52mfailure\u001B[0m')
    expect(theme.diffAdd('+ line')).toBe('\u001B[48;5;22;38;5;120m+ line\u001B[0m')
    expect(theme.diffDel('- line')).toBe('\u001B[48;5;52;38;5;203m- line\u001B[0m')
  })

  it('swaps grok background colors for light palette and back', () => {
    const theme = createTheme(true, { COLORTERM: 'truecolor' })
    theme.setLight(true)
    expect(theme.bgUser('prompt')).toBe('\u001B[48;2;238;241;251mprompt\u001B[0m')
    expect(theme.bgTool('exec')).toBe('\u001B[48;2;243;245;248mexec\u001B[0m')
    expect(theme.bgThinking('thought')).toBe('\u001B[48;2;243;245;253mthought\u001B[0m')
    expect(theme.bgError('failure')).toBe('\u001B[48;2;254;226;226mfailure\u001B[0m')
    expect(theme.diffAdd('+ line')).toBe('\u001B[48;2;236;253;245;38;2;22;101;52m+ line\u001B[0m')
    expect(theme.diffDel('- line')).toBe('\u001B[48;2;254;242;242;38;2;153;27;27m- line\u001B[0m')
    theme.setLight(false)
    expect(theme.bgUser('prompt')).toBe('\u001B[48;2;21;26;48mprompt\u001B[0m')
  })

  it('leaves grok backgrounds unstyled off-TTY or under NO_COLOR', () => {
    const offTty = createTheme(false, {})
    expect(offTty.bgUser('prompt')).toBe('prompt')
    expect(offTty.bgTool('exec')).toBe('exec')
    expect(offTty.diffAdd('+ line')).toBe('+ line')
    const noColor = createTheme(true, { NO_COLOR: '1' })
    expect(noColor.bgUser('prompt')).toBe('prompt')
    expect(noColor.diffDel('- line')).toBe('- line')
  })
})

describe('the theme catalog', () => {
  const env256 = { TERM: 'xterm-256color' }

  it('keeps the navy band and the thinking fill by override, not by the nearest index', () => {
    // The gray ramp is nearer to the navy than any cube colour, and would lose its hue.
    expect(nearest256(21, 26, 48)).toBe(234)
    expect(createTheme(true, env256).sgr('bg_light')).toBe('\u001B[48;5;17m')
    // The nearest to the thinking fill is 235, the tool fill's index.
    expect(nearest256(26, 29, 46)).toBe(235)
    expect(createTheme(true, env256).sgr('bg_thinking')).toBe('\u001B[48;5;237m')
  })

  it('quantizes the brand to the palette index and the ANSI colour closest to it', () => {
    expect(nearest256(77, 107, 254)).toBe(63)
    expect(nearestAnsi(77, 107, 254)).toBe('94')
    expect(params({ rgb: [77, 107, 254] }, 'fg', '256')).toBe('38;5;63')
    expect(params({ rgb: [77, 107, 254] }, 'bg', '16')).toBe('104')
    expect(params({ x256: 236 }, 'bg', '16')).toBe('48;5;236')
    expect(params(undefined, 'fg', 'truecolor')).toBe('')
  })

  it('follows the background under auto and ignores it for a theme chosen by name', () => {
    const auto = createTheme(true, env256)
    expect(auto.setting).toBe('auto')
    expect(auto.resolved).toBe('deepseek')
    expect(auto.setLight(true)).toBe(true)
    expect(auto.resolved).toBe('deepseek-light')
    expect(auto.setLight(true)).toBe(false)
    expect(auto.agent('x')).toBe('\u001B[38;5;62mx\u001B[0m')
    expect(auto.accent('x')).toBe('\u001B[38;5;63mx\u001B[0m')

    const dark = createTheme(true, env256, 'deepseek')
    expect(dark.setLight(true)).toBe(false)
    expect(dark.resolved).toBe('deepseek')
    expect(dark.dim('x')).toBe('\u001B[38;5;245mx\u001B[0m')
  })

  it('switches in place, so roles already handed out paint the new palette', () => {
    const theme = createTheme(true, env256)
    const { accent, bgUser } = theme
    const { keyword } = theme.syntax
    expect(theme.setTheme('deepseek-light')).toBe(true)
    expect(theme.setting).toBe('deepseek-light')
    expect(bgUser('x')).toBe('\u001B[48;5;189mx\u001B[0m')
    expect(theme.setTheme('terminal')).toBe(true)
    expect(accent('x')).toBe('\u001B[34mx\u001B[0m')
    expect(keyword('x')).toBe('\u001B[35mx\u001B[0m')
    // Naming the palette already painting changes nothing that needs repainting.
    expect(createTheme(true, env256).setTheme('deepseek')).toBe(false)
  })

  it('paints the terminal theme in the sixteen ANSI colours at every depth, with no surfaces', () => {
    for (const env of [{}, env256, { COLORTERM: 'truecolor' }]) {
      const theme = createTheme(true, env, 'terminal')
      expect(theme.bands).toBe(false)
      expect(theme.cursor).toBeUndefined()
      expect(theme.accent('x')).toBe('\u001B[34mx\u001B[0m')
      expect(theme.agent('x')).toBe('\u001B[36mx\u001B[0m')
      expect(theme.dim('x')).toBe('\u001B[90mx\u001B[0m')
      expect(theme.muted('x')).toBe('\u001B[90mx\u001B[0m')
      expect(theme.bgUser('x')).toBe('\u001B[1mx\u001B[0m')
      expect(theme.bgTool('x')).toBe('x')
      expect(theme.bgThinking('x')).toBe('x')
      expect(theme.bgError('x')).toBe('x')
      expect(theme.bgCode('x')).toBe('x')
      expect(theme.diffAdd('+ x')).toBe('\u001B[32m+ x\u001B[0m')
      expect(theme.diffDel('- x')).toBe('\u001B[31m- x\u001B[0m')
      expect(theme.sgr('bg_hover')).toBe('')
      expect(theme.color('#ff8800')?.('x')).toBe('\u001B[33mx\u001B[0m')
    }
  })

  it('colours the cursor with the brand in both DeepSeek themes, at every depth', () => {
    for (const env of [{}, env256, { COLORTERM: 'truecolor' }]) {
      expect(createTheme(true, env).cursor).toBe('#4d6bfe')
      expect(createTheme(true, env, 'deepseek-light').cursor).toBe('#4d6bfe')
    }
    expect(createTheme(true, {}).bands).toBe(true)
  })

  it('paints nothing and switches nothing under NO_COLOR or off a TTY', () => {
    for (const theme of [createTheme(true, { NO_COLOR: '1' }, 'deepseek'), createTheme(false, {})]) {
      expect(theme.setTheme('terminal')).toBe(false)
      expect(theme.setLight(true)).toBe(false)
      expect(theme.resolved).toBeUndefined()
      expect(theme.cursor).toBeUndefined()
      expect(theme.bands).toBe(false)
      expect(theme.sgr('accent')).toBe('')
      expect(theme.sgr('bg_hover')).toBe('')
      expect(theme.heading('x')).toBe('x')
      expect(theme.link('x')).toBe('x')
    }
  })
})

describe('a colour an answer names', () => {
  it('reads names, hex, and rgb() the way a browser would', () => {
    expect(parseColor('green')).toEqual({ ansi: '32' })
    expect(parseColor(' Gray ')).toEqual({ ansi: '90' })
    expect(parseColor('orange')).toEqual({ rgb: [255, 165, 0] })
    expect(parseColor('#f80')).toEqual({ rgb: [255, 136, 0] })
    expect(parseColor('#FF8800')).toEqual({ rgb: [255, 136, 0] })
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ rgb: [1, 2, 3] })
    expect(parseColor('rgba(1,2,3,0.5)')).toEqual({ rgb: [1, 2, 3] })
    expect(parseColor('nosuchcolour')).toBeUndefined()
    expect(parseColor('#12')).toBeUndefined()
  })

  it('paints an ANSI name with the terminal\'s palette and a point by the depth it has', () => {
    const basic = createTheme(true, {})
    const palette = createTheme(true, { TERM: 'xterm-256color' })
    const truecolor = createTheme(true, { COLORTERM: 'truecolor' })
    for (const theme of [basic, palette, truecolor]) expect(theme.color('green')?.('x')).toBe('\u001B[32mx\u001B[0m')
    expect(truecolor.color('#ff8800')?.('x')).toBe('\u001B[38;2;255;136;0mx\u001B[0m')
    expect(palette.color('#ff8800')?.('x')).toBe('\u001B[38;5;208mx\u001B[0m')
    expect(palette.color('#808080')?.('x')).toBe('\u001B[38;5;244mx\u001B[0m')
    expect(basic.color('#ff8800')?.('x')).toBe('\u001B[33mx\u001B[0m')
    expect(basic.color('nosuchcolour')).toBeUndefined()
  })

  it('knows a colour but paints nothing off a TTY', () => {
    const plain = createTheme(false, {})
    expect(plain.color('green')?.('x')).toBe('x')
    expect(plain.color('nosuchcolour')).toBeUndefined()
    expect(plain.italic('x')).toBe('x')
    expect(plain.underline('x')).toBe('x')
  })

  it('has italic and underline roles for the tags that ask for them', () => {
    const theme = createTheme(true, {})
    expect(theme.italic('x')).toBe('\u001B[3mx\u001B[0m')
    expect(theme.underline('x')).toBe('\u001B[4mx\u001B[0m')
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

  it('never splits a grapheme cluster, and charges it the columns it paints', () => {
    // A selector emoji is two columns, so the cut falls after one letter.
    expect(truncate('🎙️abc', 4)).toBe('🎙️a…')
    expect(truncate('1️⃣ keycap', 5)).toBe('1️⃣ k…')
    // A joined family stays whole or goes whole — never `👨‍👩‍…`.
    expect(truncate('👨‍👩‍👧xyz', 3)).toBe('👨‍👩‍👧…')
    expect(truncate('👨‍👩‍👧xyz', 2)).toBe('…')
    for (const [text, budget] of [['🎙️abc', 4], ['1️⃣ keycap', 5], ['👨‍👩‍👧xyz', 3]] as const) {
      expect(displayWidth(truncate(text, budget))).toBeLessThanOrEqual(budget)
    }
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

  it('upgrades warning and tool styling to an amber shade on a 256-colour terminal', () => {
    const theme = createTheme(true, { TERM: 'xterm-256color' })
    expect(theme.warn('x')).toBe('\u001B[38;5;172mx\u001B[0m')
    expect(theme.tool('x')).toBe('\u001B[38;5;172mx\u001B[0m')
  })

  it('swaps the amber shade for a light background, and back', () => {
    const theme = createTheme(true, { TERM: 'xterm-256color' })
    theme.setLight(true)
    expect(theme.warn('x')).toBe('\u001B[38;5;130mx\u001B[0m')
    expect(theme.tool('x')).toBe('\u001B[38;5;130mx\u001B[0m')
    theme.setLight(false)
    expect(theme.warn('x')).toBe('\u001B[38;5;172mx\u001B[0m')
    expect(theme.tool('x')).toBe('\u001B[38;5;172mx\u001B[0m')
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

  it('measures a cluster whole: selector emoji, keycap, and joined family are two columns', () => {
    // 🎙️ is U+1F399 plus U+FE0F: one column for the base plus none for the
    // selector is what a code-point scan summed; the terminal paints two.
    expect(displayWidth('🎙️')).toBe(2)
    expect(displayWidth('1️⃣')).toBe(2)
    expect(displayWidth('👨‍👩‍👧')).toBe(2)
    expect(displayWidth('👍🏽')).toBe(2)
  })
})

describe('graphemeAt', () => {
  it('steps plain text one character at a time', () => {
    const cluster = graphemeAt('ab')
    expect(cluster(0)).toBe('a')
    expect(cluster(1)).toBe('b')
  })

  it('keeps a selector, a keycap, joiners, a skin tone, and a combining mark with their base', () => {
    for (const whole of ['🎙️', '1️⃣', '👨‍👩‍👧', '👍🏽', 'e\u0301']) {
      expect(graphemeAt(`${whole}x`)(0)).toBe(whole)
    }
  })

  it('leaves an escape sequence to the caller: ESC never joins a cluster', () => {
    const text = '\u001B[31m🎙️'
    const cluster = graphemeAt(text)
    expect(cluster(0)).toBe('\u001B')
    expect(cluster(5)).toBe('🎙️')
  })

  it('answers from inside a cluster with the rest of it, never with text already read', () => {
    // The mark clusters with the `m` that closed the escape; a caller that
    // consumed the escape must not get the `m` back.
    expect(graphemeAt('\u001B[31m\u0301x')(5)).toBe('\u0301')
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

describe('columnIndex', () => {
  it('skips styling and snaps past a wide character', () => {
    expect(columnIndex('hello', 3)).toBe(3)
    expect(columnIndex('\u001B[90mhello\u001B[0m', 0)).toBe('\u001B[90m'.length)
    expect(columnIndex('\u001B[90mhello\u001B[0m', 3)).toBe('\u001B[90m'.length + 3)
    expect(columnIndex('终端', 2)).toBe('终'.length)
    expect(columnIndex('hello', 80)).toBe(5)
  })
})

describe('markSpan', () => {
  it('inverts a display-column span and re-arms after a reset', () => {
    expect(markSpan('hello world', 0, 5)).toBe('\u001B[7mhello\u001B[27m world')
    expect(markSpan('hello world', 5, 5)).toBe('hello world')
    const styled = '\u001B[90mhello\u001B[0m world'
    const marked = markSpan(styled, 0, 5)
    expect(marked).toContain('\u001B[7m')
    expect(marked).toContain('\u001B[27m')
    expect(marked.replaceAll(/\u001B\[[0-9;]*m/gu, '')).toBe('hello world')
  })
})
