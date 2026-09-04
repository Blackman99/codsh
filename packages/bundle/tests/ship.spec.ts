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

  it('instructs gate headers so the TUI can open GateModal', () => {
    expect(SHIP_PROMPT).toContain('ship · gate 1/2')
    expect(SHIP_PROMPT).toContain('ship · gate 2/2')
    expect(SHIP_PROMPT).toContain('detail')
  })

  it('makes the spec file the durable memory: status, resume, plan on disk', () => {
    // A bare /ship offers to pick up unfinished work before asking for an idea.
    expect(SHIP_PROMPT).toContain('Status line is not `shipped`')
    expect(SHIP_PROMPT).toContain('resume')
    // The phase ledger the resume reads.
    expect(SHIP_PROMPT).toContain('`Status:` line (interviewing, confirmed, planned, landing, shipped)')
    // The approved tickets are written into the spec, not left in the conversation.
    expect(SHIP_PROMPT).toContain('`## Plan` section with one checkbox per ticket')
    expect(SHIP_PROMPT).toContain('re-read it before starting each ticket')
  })

  it('grounds green in a recorded baseline and per-ticket commits', () => {
    // Proof commands run once BEFORE code, so a red baseline surfaces at the gate.
    expect(SHIP_PROMPT).toContain('recording the baseline in the spec')
    expect(SHIP_PROMPT).toContain('working tree is clean')
    expect(SHIP_PROMPT).toContain('commit after each ticket turns green')
  })

  it('makes verification mechanical, and re-runs it after a Ralph loop', () => {
    // Every criterion carries its own command; the final phase runs exactly those.
    expect(SHIP_PROMPT).toContain('names the exact command that proves it')
    expect(SHIP_PROMPT).toContain('run every proof command again yourself')
    // The loop is bounded and stops on stall instead of spinning to the cap.
    expect(SHIP_PROMPT).toContain('three rounds per ticket')
    expect(SHIP_PROMPT).toContain('two consecutive rounds that tick nothing')
  })

  it('treats pasted images as requirements material', () => {
    expect(SHIP_PROMPT).toContain('[Image #N]')
    expect(SHIP_PROMPT).toContain('<pasted-image>')
  })

  it('grills as a design-tree frontier, then synthesizes spec and tickets without another interview', () => {
    expect(SHIP_PROMPT).toContain('design tree')
    expect(SHIP_PROMPT).toContain('whole frontier into a single ask_user_question call')
    expect(SHIP_PROMPT).toContain('recommended answer as the first option')
    expect(SHIP_PROMPT).toContain('Do not interview further')
    expect(SHIP_PROMPT).toContain('Problem Statement')
    expect(SHIP_PROMPT).toContain('Testing Decisions')
    expect(SHIP_PROMPT).toContain('tracer-bullet tickets')
    expect(SHIP_PROMPT).toContain('red before green')
  })
})
