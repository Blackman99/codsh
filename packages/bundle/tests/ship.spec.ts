/**
 * The /ship canned prompt: its contract with expandTemplate and with the
 * tools the workflow depends on. Prose may change; these tokens may not.
 */

import { describe, expect, it } from 'vitest'
import { expandTemplate } from '../src/custom-commands.ts'
import { SHIP_PROMPT } from '../src/ship.ts'

describe('SHIP_PROMPT', () => {
  it('substitutes the typed idea exactly once', () => {
    expect(SHIP_PROMPT.split('$ARGUMENTS')).toHaveLength(2)
    const expanded = expandTemplate(SHIP_PROMPT, 'build a widget')
    expect(expanded).toContain('build a widget')
    expect(expanded).not.toContain('$ARGUMENTS')
  })

  it('handles an empty idea by asking for it, never erroring', () => {
    const expanded = expandTemplate(SHIP_PROMPT, '')
    expect(expanded).toContain('empty')
    expect(expanded).toContain('ask_user_question')
  })

  it('names the tools the workflow is built on', () => {
    expect(SHIP_PROMPT).toContain('ask_user_question')
    expect(SHIP_PROMPT).toContain('todo_write')
    expect(SHIP_PROMPT).toContain('ralph')
  })

  it('carries both approval gates and the verification rule', () => {
    expect(SHIP_PROMPT).toContain('gate 1')
    expect(SHIP_PROMPT).toContain('gate 2')
    expect(SHIP_PROMPT).toContain('Never report a result you did not run')
  })
})
