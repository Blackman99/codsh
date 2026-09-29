/**
 * `/theme` names: forgiving the way Grok CLI's are, with `CODSH_THEME` picking
 * one for a launch and a saved choice for the rest.
 */

import { describe, expect, it } from 'vitest'
import { createTheme } from '../src/theme.ts'
import { THEME_CHOICES, choiceList, parseThemeSetting, startupThemeSetting, themeReport } from '../src/theme-setting.ts'

describe('parseThemeSetting', () => {
  it('reads every name, any case, padded', () => {
    for (const choice of THEME_CHOICES) expect(parseThemeSetting(choice.name)).toBe(choice.name)
    expect(parseThemeSetting(' DeepSeek-Light ')).toBe('deepseek-light')
    expect(parseThemeSetting('AUTO')).toBe('auto')
  })

  it('answers to the aliases a person would type', () => {
    expect(parseThemeSetting('system')).toBe('auto')
    expect(parseThemeSetting('default')).toBe('auto')
    expect(parseThemeSetting('DARK')).toBe('deepseek')
    expect(parseThemeSetting('ds')).toBe('deepseek')
    expect(parseThemeSetting(' Light ')).toBe('deepseek-light')
    expect(parseThemeSetting('native')).toBe('terminal')
    expect(parseThemeSetting('ansi')).toBe('terminal')
  })

  it('names nothing for anything else', () => {
    expect(parseThemeSetting('')).toBeUndefined()
    expect(parseThemeSetting('tokyonight')).toBeUndefined()
    expect(parseThemeSetting('groknight')).toBeUndefined()
  })

  it('lists the four choices in picker order', () => {
    expect(THEME_CHOICES.map(choice => choice.name)).toEqual(['auto', 'deepseek', 'deepseek-light', 'terminal'])
    expect(choiceList()).toBe('auto, deepseek, deepseek-light, terminal')
  })
})

describe('startupThemeSetting', () => {
  it('starts on auto with nothing saved or set', () => {
    expect(startupThemeSetting({}, undefined)).toEqual({ setting: 'auto', fromEnv: false })
  })

  it('takes the saved choice, and ignores a saved value that names none', () => {
    expect(startupThemeSetting({}, 'terminal')).toEqual({ setting: 'terminal', fromEnv: false })
    expect(startupThemeSetting({}, 'light')).toEqual({ setting: 'deepseek-light', fromEnv: false })
    expect(startupThemeSetting({}, 'nope').setting).toBe('auto')
    expect(startupThemeSetting({}, 42).setting).toBe('auto')
  })

  it('lets CODSH_THEME win over the saved choice', () => {
    expect(startupThemeSetting({ CODSH_THEME: 'Light' }, 'terminal')).toEqual({ setting: 'deepseek-light', fromEnv: true })
    expect(startupThemeSetting({ CODSH_THEME: '  ' }, 'terminal')).toEqual({ setting: 'terminal', fromEnv: false })
  })

  it('warns about a CODSH_THEME that names nothing, and falls back to the saved choice', () => {
    const start = startupThemeSetting({ CODSH_THEME: 'solarized' }, 'deepseek')
    expect(start.setting).toBe('deepseek')
    expect(start.fromEnv).toBe(false)
    expect(start.warning).toBe('CODSH_THEME="solarized" names no theme — auto, deepseek, deepseek-light, terminal')
  })
})

describe('themeReport', () => {
  it('names the palette auto resolved to, and a named theme alone', () => {
    const theme = createTheme(true, { TERM: 'xterm-256color' })
    expect(themeReport(theme)).toBe('theme · auto → deepseek')
    theme.setLight(true)
    expect(themeReport(theme)).toBe('theme · auto → deepseek-light')
    theme.setTheme('terminal')
    expect(themeReport(theme)).toBe('theme · terminal')
  })

  it('says colour is off when nothing is painted', () => {
    expect(themeReport(createTheme(true, { NO_COLOR: '1' }))).toBe('theme · auto · colour is off (NO_COLOR or not a terminal)')
  })
})
