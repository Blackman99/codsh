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
    expect(resolveWelcomeKind(true, false)).toBe('none')
    expect(resolveWelcomeKind(true, true)).toBe('none')
  })

  it('is returning when the workspace already has a session', () => {
    expect(resolveWelcomeKind(false, true)).toBe('returning')
  })

  it('is first when this workspace is new', () => {
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
    expect(lines.join('\n')).toContain('/help · Tab · ⇧Tab plan · ESC · /exit')
    expect(lines.join('\n')).not.toContain('for commands')
  })

  it('paints returning as exactly two content lines, with no ASCII', () => {
    const lines = bannerLines({ ...facts, welcomeKind: 'returning' }, theme, 100)
    const content = lines.filter(line => line !== '')
    expect(content).toHaveLength(2)
    expect(content[0]).toContain('✻ codsh · deepseek-v4-flash · /help')
    expect(content[1]).toBe('  session session-1 · Tab · ⇧Tab plan')
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

  it('names ESC on a terminal and Ctrl-C off one', () => {
    expect(bannerLines(facts, theme, 100).join('\n')).toContain('ESC')
    expect(bannerLines({ ...facts, readsKeys: false }, theme, 100).join('\n')).toContain('Ctrl-C')
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
