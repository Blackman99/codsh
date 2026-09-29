/**
 * First-run keeps the ASCII mark and short tips; returning is two content
 * lines; a resume paints nothing.
 */

import { describe, expect, it } from 'vitest'
import { bannerLines, resolveWelcomeKind, type BannerFacts } from '../src/banner.ts'
import { createTheme, displayWidth } from '../src/theme.ts'

const theme = createTheme(false, {})

const facts: BannerFacts = {
  model: 'deepseek-v4-flash',
  session: 'session-1',
  readsKeys: true,
  welcomeKind: 'first',
}

describe('resolveWelcomeKind', () => {
  it('skips the welcome for --resume / --continue', () => {
    expect(resolveWelcomeKind(true)).toBe('none')
    expect(resolveWelcomeKind(true, false)).toBe('none')
    expect(resolveWelcomeKind(true, true)).toBe('none')
  })

  it('greets fresh startups with first regardless of prior workspace sessions', () => {
    expect(resolveWelcomeKind(false)).toBe('first')
    expect(resolveWelcomeKind(false, true)).toBe('first')
    expect(resolveWelcomeKind(false, false)).toBe('first')
  })
})

describe('bannerLines', () => {
  it('greets a first session with the mark and short tips', () => {
    const lines = bannerLines(facts, theme, 100)
    expect(lines.some(line => line.includes('█'))).toBe(true)
    expect(lines.some(line => line.includes('▀') || line.includes('▄'))).toBe(true)
    expect(lines.some(line => line.includes('✻ Welcome to codsh'))).toBe(true)
    expect(lines.join('\n')).toContain('deepseek-v4-flash')
    expect(lines.join('\n')).toContain('/help · /status · Tab · ⇧Tab plan · Ctrl-C · /exit')
    expect(lines.join('\n')).not.toContain('for commands')
  })

  it('paints returning as exactly two content lines, with no ASCII', () => {
    const lines = bannerLines({ ...facts, welcomeKind: 'returning' }, theme, 100)
    const content = lines.filter(line => line !== '')
    expect(content).toHaveLength(2)
    expect(content[0]).toContain('✻ codsh · deepseek-v4-flash · /help')
    expect(content[1]).toBe('session session-1 · /status · ⇧Tab plan')
    expect(content[1]).toContain('/status')
    expect(lines.some(line => line.includes('█') || line.includes('▀') || line.includes('▄'))).toBe(false)
    expect(lines.join('\n')).not.toContain('Welcome to codsh')
  })

  it('skips the welcome entirely when kind is none', () => {
    expect(bannerLines({ ...facts, welcomeKind: 'none' }, theme, 100)).toEqual([])
  })

  it('keeps ✻ under NO_COLOR', () => {
    const plain = createTheme(true, { NO_COLOR: '1' })
    expect(bannerLines(facts, plain, 100).join('\n')).toContain('✻')
    expect(bannerLines({ ...facts, welcomeKind: 'returning' }, plain, 100).join('\n')).toContain('✻')
  })

  it('names Ctrl-C as the interrupt on a terminal and off one', () => {
    expect(bannerLines(facts, theme, 100).join('\n')).toContain('Ctrl-C')
    expect(bannerLines({ ...facts, readsKeys: false }, theme, 100).join('\n')).toContain('Ctrl-C')
    expect(bannerLines(facts, theme, 100).join('\n')).not.toContain('ESC')
  })

  it('never exceeds the terminal width', () => {
    for (const columns of [24, 40, 80, 100]) {
      for (const welcomeKind of ['first', 'returning'] as const) {
        const lines = bannerLines({ ...facts, welcomeKind }, theme, columns)
        for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('drops the ASCII when the terminal is too narrow, keeping the short tips', () => {
    const lines = bannerLines(facts, theme, 24)
    expect(lines.some(line => line.includes('█'))).toBe(false)
    expect(lines.some(line => line.includes('Welcome to codsh'))).toBe(true)
  })
})

describe('the mark, by theme and depth', () => {
  const logo = (theme: ReturnType<typeof createTheme>): string =>
    bannerLines(facts, theme, 100).filter(line => /[█▀▄]/u.test(line)).join('\n')

  it('inks the whale in the brand and its tint on a 256-colour terminal, with ✻ in the brand', () => {
    const theme = createTheme(true, { TERM: 'xterm-256color' })
    expect(logo(theme)).toContain('\u001B[38;5;105m')
    expect(logo(theme)).toContain('\u001B[38;5;63m')
    expect(logo(theme)).not.toContain('\u001B[38;2;')
    expect(bannerLines(facts, theme, 100).join('\n')).toContain('\u001B[38;5;63m✻')
  })

  it('keeps the hull visible on a light background', () => {
    const theme = createTheme(true, { TERM: 'xterm-256color' }, 'deepseek-light')
    expect(logo(theme)).toContain('\u001B[38;5;17m')
    expect(logo(theme)).not.toContain('\u001B[38;5;255m')
  })

  it('paints the terminal theme in ANSI colours only, and truecolor as the logo file does', () => {
    const terminal = createTheme(true, { COLORTERM: 'truecolor' }, 'terminal')
    expect(logo(terminal)).not.toContain('38;2;')
    expect(logo(terminal)).toContain('\u001B[36m')
    expect(logo(createTheme(true, { COLORTERM: 'truecolor' }))).toContain('\u001B[38;2;77;107;254m')
  })
})
