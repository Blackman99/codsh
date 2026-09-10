/**
 * The transcript gutter is where a speaker becomes a glyph and a role. Every
 * call site goes through it, so two rows for one speaker cannot drift apart.
 */

import { describe, expect, it } from 'vitest'
import { blockRules, gutter } from '../src/gutter.ts'
import { createTheme } from '../src/theme.ts'

describe('the transcript gutter', () => {
  it('resolves each speaker through the theme role, so a call site cannot drift', () => {
    const theme = createTheme(true, {})
    expect(gutter('user', theme)).toBe(theme.person('› '))
    expect(gutter('thinking', theme)).toBe(theme.reasoning('✻ '))
    expect(gutter('tool', theme)).toBe(theme.tool('│ '))
    expect(gutter('error', theme)).toBe(theme.error('│ '))
    expect(blockRules(theme).user).toBe(gutter('user', theme))
  })

  it('paints the person the same whether the transcript or the input asks', () => {
    const theme = createTheme(true, {})
    // The gutter is the transcript's call site; the input box still asks by
    // the old name, and the two must resolve to one painting.
    expect(theme.user('› ')).toBe(theme.person('› '))
    expect(theme.agent('✻ ')).toBe(theme.reasoning('✻ '))
  })

  it('keeps the person and reasoning marks, unstyled under NO_COLOR', () => {
    const plain = createTheme(true, { NO_COLOR: '1' })
    // The marks are what carries the speaker when the palette is gone.
    expect(gutter('user', plain)).toBe('› ')
    expect(gutter('thinking', plain)).toBe('✻ ')
    expect(gutter('tool', plain)).toBe('│ ')
    expect(gutter('error', plain)).toBe('│ ')
    expect(gutter('system', plain)).toBe('· ')
    expect(gutter('answer', plain)).toBe('')
    for (const role of ['user', 'thinking', 'tool', 'error', 'system'] as const) {
      expect(gutter(role, plain)).not.toContain('\u001B')
    }
  })
})
