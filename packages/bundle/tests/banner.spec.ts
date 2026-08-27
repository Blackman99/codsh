/**
 * The opening banner frames its headline to the content and gives the frame up
 * rather than wrapping it when the terminal is too narrow.
 */

import { describe, expect, it } from 'vitest'
import { bannerLines, type BannerFacts } from '../src/banner.ts'
import { createTheme } from '../src/theme.ts'
import { displayWidth } from '../src/theme.ts'

const theme = createTheme(false, {})

const facts: BannerFacts = {
  model: 'deepseek-v4-flash',
  preset: 'code-cli',
  cwd: '/repo',
  branch: 'main',
  session: 'session-1',
  readsKeys: true,
  resumed: false,
}

describe('bannerLines', () => {
  it('greets a terminal with the mark, composition beneath it', () => {
    const lines = bannerLines(facts, theme, 100)
    expect(lines.some(line => line.includes('█'))).toBe(true)
    expect(lines.some(line => line.includes('▀') || line.includes('▄'))).toBe(true)
    expect(lines.some(line => line.includes('✻ Welcome to codsh'))).toBe(true)
    expect(lines.join('\n')).toContain('deepseek-v4-flash · code-cli')
  })

  it('skips the greeting for a resumed session, whose transcript matters more', () => {
    const lines = bannerLines({ ...facts, resumed: true }, theme, 100)
    expect(lines.some(line => line.includes('█'))).toBe(false)
  })

  it('frames the headline in a box off a terminal, which gets no lettermark', () => {
    const [top, middle, bottom] = bannerLines({ ...facts, readsKeys: false }, theme, 100)
    expect(top).toMatch(/^╭─+╮$/)
    expect(bottom).toMatch(/^╰─+╯$/)
    expect(middle).toContain('dsh code · deepseek-v4-flash · code-cli')
    // A box whose rows disagree on width is a broken box.
    expect(displayWidth(middle ?? '')).toBe(displayWidth(top ?? ''))
  })

  it('reports where the session is and how to resume it', () => {
    const text = bannerLines(facts, theme, 100).join('\n')
    expect(text).toContain('/repo (main)')
    expect(text).toContain('session session-1')
  })

  it('names Escape as the interrupt where keys can be read', () => {
    expect(bannerLines(facts, theme, 100).join('\n')).toContain('ESC interrupts')
  })

  it('names Ctrl-C where they cannot', () => {
    expect(bannerLines({ ...facts, readsKeys: false }, theme, 100).join('\n')).toContain('Ctrl-C interrupts')
  })

  it('says so when the transcript above it was replayed', () => {
    expect(bannerLines({ ...facts, resumed: true }, theme, 100).join('\n')).toContain('(resumed)')
  })

  it('gives up the frame rather than wrapping it in a narrow terminal', () => {
    const lines = bannerLines(facts, theme, 24)
    expect(lines[0]).not.toContain('╭')
    // Nothing may exceed the terminal, or the layout wraps into noise.
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(24)
  })

  it('drops the composition segment when no roster resolved one', () => {
    const lines = bannerLines({ ...facts, preset: undefined, readsKeys: false }, theme, 100)
    expect(lines[1]).toContain('dsh code · deepseek-v4-flash')
    expect(lines[1]).not.toContain('code-cli')
  })
})
