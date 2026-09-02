/** Reading a `/ship` spec's plan: how many tickets, and which one is now. */

import { describe, expect, it } from 'vitest'
import { parsePlan, planReport, planRow, planSummary } from '../src/plan.ts'
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
    const row = planSummary(parsePlan(SPEC), theme, 80, 'Ctrl+T opens the list') ?? ''
    expect(row).toContain('2/4')
    expect(row).toContain('Open a long card in it')
    expect(row).toContain('Ctrl+T opens the list')
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
