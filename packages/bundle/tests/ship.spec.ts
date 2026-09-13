/**
 * The /ship canned prompt: its contract with expandTemplate and with the
 * tools the workflow depends on. Prose may change; these tokens may not.
 */

import { describe, expect, it } from 'vitest'
import { expandTemplate } from '../src/custom-commands.ts'
import { SHIP_PROMPT, shipPhaseKind, shipPromptFor } from '../src/ship.ts'

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
    expect(SHIP_PROMPT).toContain('Edit means revise the spec and ask again')
    expect(SHIP_PROMPT).toContain('Fold Edit answers back in and present again')
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

  it('follows the grill-me skill: recon first, batched frontier, recommended answers, exhaustion handshake', () => {
    expect(SHIP_PROMPT).toContain('Follow the grill-me skill as the contract, not a summary of it')
    expect(SHIP_PROMPT).toContain('Relentless Frontier Exploration')
    expect(SHIP_PROMPT).toContain('One Question Round per Turn')
    expect(SHIP_PROMPT).toContain('Autonomous Fact Extraction')
    expect(SHIP_PROMPT).toContain('Active Assumption Invalidation')
    expect(SHIP_PROMPT).toContain('No Premature Implementation')
    expect(SHIP_PROMPT).toContain('Strict Topological Dependency Ordering')
    expect(SHIP_PROMPT).toContain('Mandatory Concrete Recommendations')
    expect(SHIP_PROMPT).toContain('Verified Exhaustion Gate')
    expect(SHIP_PROMPT).toContain('ship · grill')
    expect(SHIP_PROMPT).toContain('never interrogate with one-off dribble')
    expect(SHIP_PROMPT).toContain('never ask the user what inspection can reveal')
  })

  it('follows the to-spec skill: exhaustive stories, public seams, tracker or scratch, no interrogation', () => {
    expect(SHIP_PROMPT).toContain('Pure Synthesis, Zero Interrogation')
    expect(SHIP_PROMPT).toContain('As an <actor>, I want a <feature>, so that <benefit>')
    expect(SHIP_PROMPT).toContain('Edge cases and failure states are covered as distinct stories')
    expect(SHIP_PROMPT).toContain('highest available integration seam')
    expect(SHIP_PROMPT).toContain('Out of Scope')
    expect(SHIP_PROMPT).toContain('ready-for-agent')
    expect(SHIP_PROMPT).toContain('.scratch/')
    expect(SHIP_PROMPT).toContain('/setup-engineering-workflows')
  })

  it('follows the to-tickets skill: vertical slices, DAG, per-ticket acceptance, no parent mutation', () => {
    expect(SHIP_PROMPT).toContain('Strict Vertical Tracer Slicing')
    expect(SHIP_PROMPT).toContain('Blocked by:')
    expect(SHIP_PROMPT).toContain('single fresh context window')
    expect(SHIP_PROMPT).toContain('expand–contract')
    expect(SHIP_PROMPT).toContain('.scratch/<kebab-case-slug>/issues/')
    expect(SHIP_PROMPT).toContain('atomic acceptance checklist')
    expect(SHIP_PROMPT).toContain('Never close, resolve, or corrupt parent tracker issues')
  })

  it('follows the tdd skill: one red test witnessed failing, then minimal green, then the suite', () => {
    expect(SHIP_PROMPT).toContain('Strict Red-First Execution')
    expect(SHIP_PROMPT).toContain('witness it fail for the right reason')
    expect(SHIP_PROMPT).toContain('Independent Expected Values')
    expect(SHIP_PROMPT).toContain('one test → minimal code → green')
    expect(SHIP_PROMPT).toContain('never recomputed mirror logic')
    expect(SHIP_PROMPT).toContain('full test suite')
  })

  it('enforces Phase 0 pre-flight dirty working tree check and feature branch isolation', () => {
    expect(SHIP_PROMPT).toContain('Phase 0 — pre-flight & branch isolation')
    expect(SHIP_PROMPT).toContain('ship · preflight')
    expect(SHIP_PROMPT).toContain('git status --porcelain')
    expect(SHIP_PROMPT).toContain('git checkout -b ship/')
    expect(SHIP_PROMPT).toContain('Branch: ship/')
    expect(SHIP_PROMPT).toContain('Base-Commit:')
  })

  it('enforces cascading re-verification and state degradation on resumption', () => {
    expect(SHIP_PROMPT).toContain('cascading re-verification')
    expect(SHIP_PROMPT).toContain('re-run the proof commands of every checked `[x]` ticket')
    expect(SHIP_PROMPT).toContain('degrade that ticket and all subsequent tickets to `[ ]`')
  })

  it('enforces anti-cheating TDD red-to-green proof logging and clean single commits', () => {
    expect(SHIP_PROMPT).toContain('TDD proof logging')
    expect(SHIP_PROMPT).toContain('non-zero exit code')
    expect(SHIP_PROMPT).toContain('exactly one clean commit per ticket')
  })

  it('enforces 3-strike circuit breaker and Ralph blocker escalation', () => {
    expect(SHIP_PROMPT).toContain('three repair attempts')
    expect(SHIP_PROMPT).toContain('circuit breaker')
    expect(SHIP_PROMPT).toContain('Blocker')
  })

  it('enforces dual-layer DoD with zero-new-failures against baseline and release ticket', () => {
    expect(SHIP_PROMPT).toContain('dual-layer DoD')
    expect(SHIP_PROMPT).toContain('zero new failures')
    expect(SHIP_PROMPT).toContain('Release & Documentation Compliance')
  })

  it('presents post-ship interactive delivery modal for branch merge options', () => {
    expect(SHIP_PROMPT).toContain('ship · deliver')
    expect(SHIP_PROMPT).toContain('Merge back')
    expect(SHIP_PROMPT).toContain('Keep branch for PR')
  })

  it('injects grill, to-spec, to-tickets, and tdd as separate turns', () => {
    const grill = shipPromptFor(undefined)
    expect(grill).toContain('Follow the grill-me skill as the contract, not a summary of it')
    expect(grill).toContain('This turn is pre-flight and grill only')
    expect(grill).toContain('Status: interviewing')
    expect(grill).toContain('ship · preflight')
    expect(grill).not.toContain('Pure Synthesis, Zero Interrogation')
    expect(grill).not.toContain('ship · gate 1/2')
    expect(grill).not.toContain('Strict Vertical Tracer Slicing')
    expect(grill).not.toContain('Strict Red-First Execution')

    const spec = shipPromptFor('interviewing')
    expect(spec).toContain('Pure Synthesis, Zero Interrogation')
    expect(spec).toContain('ship · gate 1/2')
    expect(spec).toContain('This turn is to-spec (gate 1) only')
    expect(spec).not.toContain('Relentless Frontier Exploration')
    expect(spec).not.toContain('Strict Vertical Tracer Slicing')
    expect(spec).not.toContain('Strict Red-First Execution')

    const tickets = shipPromptFor('confirmed')
    expect(tickets).toContain('Strict Vertical Tracer Slicing')
    expect(tickets).toContain('This turn is tickets and baseline (gate 2) only')
    expect(tickets).not.toContain('Relentless Frontier Exploration')
    expect(tickets).not.toContain('Pure Synthesis, Zero Interrogation')
    expect(tickets).not.toContain('Strict Red-First Execution')

    const land = shipPromptFor('planned')
    expect(land).toContain('Strict Red-First Execution')
    expect(land).toContain('dual-layer DoD')
    expect(land).not.toContain('Relentless Frontier Exploration')
    expect(land).not.toContain('Pure Synthesis, Zero Interrogation')
    expect(land).not.toContain('Strict Vertical Tracer Slicing')
    expect(shipPromptFor('landing')).toBe(land)

    expect(shipPhaseKind(undefined)).toBe('grill')
    expect(shipPhaseKind('interviewing')).toBe('spec')
    expect(shipPhaseKind('confirmed')).toBe('tickets')
    expect(shipPhaseKind('planned')).toBe('land')
    expect(shipPhaseKind('landing')).toBe('land')
    expect(shipPhaseKind('shipped')).toBe('done')
  })

  it('passes Goal-Id into grill so the spec header records the session compass (Track: 5)', () => {
    expect(SHIP_PROMPT).toContain('$GOAL_ID')
    const grill = shipPromptFor(undefined, { goalId: 'goal-abc123' })
    expect(grill).toContain('goal-abc123')
    expect(grill).toContain('Goal-Id:')
    expect(grill).not.toContain('$GOAL_ID')
    expect(grill).not.toContain('Pure Synthesis, Zero Interrogation')
  })

  it('prepends the compact Main Track on later phases without substituting the phase contract (Track: 2)', () => {
    const track = [
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.** No harness fork.',
    ].join('\n')
    const spec = shipPromptFor('interviewing', { track })
    expect(spec.startsWith(track)).toBe(true)
    expect(spec).toContain('Pure Synthesis, Zero Interrogation')
    expect(spec).not.toContain('Relentless Frontier Exploration')

    const tickets = shipPromptFor('confirmed', { track })
    expect(tickets.startsWith(track)).toBe(true)
    expect(tickets).toContain('Strict Vertical Tracer Slicing')
    expect(tickets).not.toContain('Pure Synthesis, Zero Interrogation')

    const land = shipPromptFor('planned', { track })
    expect(land.startsWith(track)).toBe(true)
    expect(land).toContain('Strict Red-First Execution')
    expect(land).not.toContain('Strict Vertical Tracer Slicing')

    const done = shipPromptFor('shipped', { track })
    expect(done.startsWith(track)).toBe(true)
    expect(done).toContain('dual-layer DoD')

    const grill = shipPromptFor(undefined, { track })
    expect(grill).not.toContain(track)
    expect(grill).toContain('Follow the grill-me skill as the contract, not a summary of it')
  })

  it('forbids goal tools in every phase so the model cannot fight the runner (Track: 7)', () => {
    const phases = [
      shipPromptFor(undefined),
      shipPromptFor('interviewing'),
      shipPromptFor('confirmed'),
      shipPromptFor('planned'),
      shipPromptFor('landing'),
      shipPromptFor('shipped'),
    ]
    for (const prompt of phases) {
      expect(prompt).toContain('create_goal')
      expect(prompt).toContain('update_goal')
      expect(prompt).toContain('get_goal')
      expect(prompt).toMatch(/must not call|do not call|forbid/i)
    }
    expect(SHIP_PROMPT).toContain('create_goal')
    expect(SHIP_PROMPT).toContain('update_goal')
    expect(SHIP_PROMPT).toContain('get_goal')
  })

  it('freezes Main Track after Confirm so a contradiction is a blocker not a silent rewrite (Track: 3)', () => {
    const afterConfirm = [
      shipPromptFor(undefined),
      shipPromptFor('interviewing'),
      shipPromptFor('confirmed'),
      shipPromptFor('planned'),
      shipPromptFor('landing'),
      shipPromptFor('shipped'),
    ]
    for (const prompt of afterConfirm) {
      expect(prompt).toContain('## Main Track')
      expect(prompt).toMatch(/do not rewrite|must not rewrite/i)
      expect(prompt).toMatch(/contradiction is a blocker/i)
      expect(prompt).not.toContain('When a decision changes mid-flight, update the spec file first so the file on disk stays the truth.')
    }
    expect(SHIP_PROMPT).toContain('## Main Track')
    expect(SHIP_PROMPT).toMatch(/contradiction is a blocker/i)
    expect(SHIP_PROMPT).not.toContain('When a decision changes mid-flight, update the spec file first so the file on disk stays the truth.')
    expect(SHIP_PROMPT).toMatch(/progress \(Status, checkboxes, proof logs\) remains writable/i)
  })

  it('requires Track: on plan lines and a Track-N cite on the first red test or commit (Track: 4)', () => {
    const land = shipPromptFor('planned')
    expect(land).toContain('Track:')
    expect(land).toMatch(/first red test/)
    expect(land).toMatch(/ticket commit/)
    expect(land).toMatch(/Track-N/)
    expect(SHIP_PROMPT).toContain('Track:')
    expect(SHIP_PROMPT).toMatch(/first red test/)
  })

  it('puts the sealed Main Track plus the spec path into the Ralph objective (Track: 4)', () => {
    const track = '## Main Track\n\n**Idea.** Bind /goal into /ship.'
    const land = shipPromptFor('landing', { track })
    expect(land).toContain('ralph')
    expect(land).toContain(track)
    expect(land).toMatch(/objective/)
    expect(land).toMatch(/sealed track/)
    expect(land).toMatch(/spec (file )?path/)
    expect(SHIP_PROMPT).toMatch(/sealed track/)
  })
  it('names the sealed Mission Contract as immutable control-plane memory', () => {
    expect(SHIP_PROMPT).toMatch(/Mission Contract/)
    expect(SHIP_PROMPT).toMatch(/mission\.contract\.json/)
    for (const status of ['confirmed', 'planned', 'landing', 'shipped'] as const) {
      expect(shipPromptFor(status)).toMatch(/Mission Contract/)
    }
  })

  it('tells land to implement only the Active Ticket pack', () => {
    expect(shipPromptFor('planned')).toMatch(/Active Ticket/)
    expect(SHIP_PROMPT).toMatch(/Active Ticket/)
  })

})
