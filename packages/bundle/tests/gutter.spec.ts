/**
 * Transcript left gutter: one connecting `│`, coloured by block role.
 */

import { describe, expect, it } from 'vitest'
import { blockRules, gutter, runnerNotice } from '../src/gutter.ts'
import { createTheme } from '../src/theme.ts'

describe('gutter', () => {
  it('uses │ for every role, colouring the rail instead of changing the glyph', () => {
    const theme = createTheme(false, {})
    expect(gutter('user', theme)).toBe('│ ')
    expect(gutter('thinking', theme)).toBe('│ ')
    expect(gutter('tool', theme)).toBe('│ ')
    expect(gutter('error', theme)).toBe('│ ')
    expect(gutter('system', theme)).toBe('│ ')
    expect(gutter('answer', theme)).toBe('│ ')
  })

  it('colours the same │ by role on a TTY', () => {
    const theme = createTheme(true, {})
    expect(gutter('user', theme)).toBe(theme.accent('│ '))
    expect(gutter('thinking', theme)).toBe(theme.agent('│ '))
    expect(gutter('tool', theme)).toBe(theme.dim('│ '))
    expect(gutter('error', theme)).toBe(theme.err('│ '))
    expect(gutter('system', theme)).toBe(theme.muted('│ '))
    expect(gutter('answer', theme)).toBe(theme.muted('│ '))
    expect(blockRules(theme).answer).toBe(gutter('answer', theme))
  })
})

describe('runnerNotice', () => {
  it('draws the tool gutter beside a drift flash so the left rule does not break', () => {
    const theme = createTheme(false, {})
    expect(runnerNotice('Mission drift detected — review plan against sealed contract', theme)).toEqual({
      line: '  Mission drift detected — review plan against sealed contract',
      rule: '│ ',
    })
  })

  it('draws the same gutter beside an alignment denial', () => {
    const theme = createTheme(false, {})
    expect(runnerNotice('✗ write has no requirement mapping (supports)', theme)).toEqual({
      line: '  ✗ write has no requirement mapping (supports)',
      rule: '│ ',
    })
  })

  it('styles the notice dim and keeps the tool glyph under colour', () => {
    const theme = createTheme(true, {})
    const notice = runnerNotice('Mission drift detected', theme)
    expect(notice.line).toBe(theme.dim('  Mission drift detected'))
    expect(notice.rule).toBe(blockRules(theme).tool)
  })
})
