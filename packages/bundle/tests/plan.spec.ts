/** Reading a `/ship` spec's plan: how many tickets, and which one is now. */

import { describe, expect, it } from 'vitest'
import { parsePlan, parseShipStatus, parseSpecMetadata, planInFlight, planReport, planRow, planSummary } from '../src/plan.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})

const SPEC = `# Long diffs open in a pager

Status: landing

## Problem Statement

Reading a long diff scrolls it past.

## Plan

- [x] Give the reader a diff kind
- [x] Point \`/diff\` at it
- [ ] Open a long card in it
- [ ] Document the gesture

## Acceptance criteria

1. \`pnpm test\` passes
`

describe('planInFlight', () => {
  it('pins a plan while its tickets are being landed', () => {
    expect(planInFlight(SPEC, parsePlan(SPEC))).toBe(true)
    // Every ticket ticked but not yet shipped: the final run is still owed.
    const landed = SPEC.replaceAll('- [ ]', '- [x]')
    expect(planInFlight(landed, parsePlan(landed))).toBe(true)
  })

  it('gives the row back once the spec has shipped', () => {
    const shipped = SPEC.replace('Status: landing', 'Status: shipped').replaceAll('- [ ]', '- [x]')
    expect(planInFlight(shipped, parsePlan(shipped))).toBe(false)
  })

  it('has nothing to pin for a spec without a plan', () => {
    const bare = 'Status: landing\n\nNo plan yet.'
    expect(planInFlight(bare, parsePlan(bare))).toBe(false)
  })
})

describe('parsePlan', () => {
  it('reads the tickets and where the work is', () => {
    const plan = parsePlan(SPEC)
    expect(plan.tickets).toHaveLength(4)
    expect(plan.done).toBe(2)
    expect(plan.current?.title).toBe('Open a long card in it')
  })

  it('stops at the next heading, so other sections do not count', () => {
    // Acceptance criteria and out-of-scope lists carry boxes of their own;
    // counting them would report progress against work the plan never claimed.
    const plan = parsePlan(`${SPEC}\n## Out of scope\n\n- [ ] Rewriting the viewport\n`)
    expect(plan.tickets).toHaveLength(4)
  })

  it('takes a plan at any heading depth, and a star for a dash', () => {
    const plan = parsePlan('### plan\n\n* [X] one\n* [ ] two\n')
    expect(plan.tickets.map(t => t.title)).toEqual(['one', 'two'])
    expect(plan.done).toBe(1)
  })

  it('cleans up verbose ticket metadata from the title for clean terminal display', () => {
    const spec = `## Plan\n\n- [x] Ticket 1: Short Title (Blocked by: None) — Delivers foo (Verification: vitest)\n- [ ] Ticket 2: Another Title - Delivers bar (Blocked by: Ticket 1)\n- [ ] Ticket 3: Third Title (Verification Log: pass) — Delivers baz\n`
    const plan = parsePlan(spec)
    expect(plan.tickets[0]?.title).toBe('Ticket 1: Short Title')
    expect(plan.tickets[1]?.title).toBe('Ticket 2: Another Title')
    expect(plan.tickets[2]?.title).toBe('Ticket 3: Third Title')
  })

  it('reports nothing for a spec with no plan yet', () => {
    const plan = parsePlan('# Spec\n\nStatus: interviewing\n')
    expect(plan.tickets).toEqual([])
    expect(plan.current).toBeUndefined()
    expect(planRow(plan, theme, 80)).toBeUndefined()
  })

  it('has no current ticket once every one is ticked', () => {
    const plan = parsePlan('## Plan\n\n- [x] one\n- [x] two\n')
    expect(plan.current).toBeUndefined()
    expect(planRow(plan, theme, 80)).toBe('2/2 tickets')
  })
})

describe('parseShipStatus', () => {
  it('reads the Status phase from the spec', () => {
    expect(parseShipStatus(SPEC)).toBe('landing')
    expect(parseShipStatus('# Spec\n\nStatus: interviewing\n')).toBe('interviewing')
    expect(parseShipStatus('Status: shipped\n')).toBe('shipped')
  })

  it('ignores a file with no Status line', () => {
    expect(parseShipStatus('# Spec\n\n## Plan\n\n- [ ] one\n')).toBeUndefined()
  })
})

describe('parseSpecMetadata', () => {
  it('reads branch and base commit metadata from spec header', () => {
    const markdown = `# Feature\n\nStatus: planned\nBranch: ship/my-feature\nBase-Commit: abc1234\nOriginal-Branch: main\n\n## Plan\n`
    const meta = parseSpecMetadata(markdown)
    expect(meta.branch).toBe('ship/my-feature')
    expect(meta.baseCommit).toBe('abc1234')
    expect(meta.originalBranch).toBe('main')
  })

  it('returns empty object when metadata headers are absent', () => {
    const meta = parseSpecMetadata('# Feature\n\nStatus: interviewing\n')
    expect(meta.branch).toBeUndefined()
    expect(meta.baseCommit).toBeUndefined()
    expect(meta.originalBranch).toBeUndefined()
  })
})

describe('planRow', () => {
  it('says how far in, and on what', () => {
    expect(planRow(parsePlan(SPEC), theme, 80)).toBe('2/4 · Open a long card in it')
  })

  it('cuts the title rather than the count when the width runs out', () => {
    const row = planRow(parsePlan(SPEC), theme, 16) ?? ''
    expect(row.startsWith('2/4')).toBe(true)
    expect(row.length).toBeLessThanOrEqual(16)
  })
})

describe('the readout', () => {
  it('says how far in, and what is being landed, on one row', () => {
    const row = planSummary(parsePlan(SPEC), theme, 80, 'click or Ctrl+T opens the list') ?? ''
    expect(row).toContain('2/4')
    expect(row).toContain('Open a long card in it')
    expect(row).toContain('click or Ctrl+T opens the list')
  })

  it('says so when every ticket landed', () => {
    const row = planSummary(parsePlan('## Plan\n\n- [x] one\n'), theme, 80) ?? ''
    expect(row).toContain('every ticket landed')
  })

  it('reports nothing for a spec with no plan', () => {
    expect(planSummary(parsePlan('# Spec\n'), theme, 80)).toBeUndefined()
    expect(planReport(parsePlan('# Spec\n'), theme, 80)).toEqual([])
  })

  it('marks each ticket by where the work is', () => {
    const rows = planReport(parsePlan(SPEC), theme, 80)
    expect(rows[0]).toContain('2/4')
    // Landed, landed, the one in flight, and one waiting.
    expect(rows[1]).toContain('\u2714')
    expect(rows[2]).toContain('\u2714')
    expect(rows[3]).toContain('\u25B6')
    expect(rows[4]).toContain('\u25CB')
  })

  it('counts the tickets it could not fit', () => {
    const many = `## Plan\n\n${Array.from({ length: 9 }, (_, index) => `- [ ] ticket ${index}`).join('\n')}\n`
    const rows = planReport(parsePlan(many), theme, 80, 4)
    expect(rows).toHaveLength(6)
    expect(rows.at(-1)).toContain('+5 more')
  })
})
