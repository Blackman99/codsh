import { describe, expect, it } from 'vitest'
import { detectDrift } from '../src/drift.ts'
import { compileMissionContract } from '../src/mission.ts'
import { parsePlan } from '../src/plan.ts'

const SPEC = `
## Main Track
**Idea.** Ship a widget.
**Track-1.** Keep OpenAI endpoint.
**Track-2.** Keep Anthropic endpoint.
**Out of Scope.**
- cloud computer
## Acceptance Criteria
1. \`pnpm test\` exits 0.
## Plan
- [ ] Ticket 1: OpenAI (Track: 1)
- [ ] Ticket 2: Mystery work
`

describe('detectDrift', () => {
  it('flags missing Track mapping and uncovered requirements', () => {
    const contract = compileMissionContract(SPEC, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const plan = parsePlan(SPEC)
    const report = detectDrift({ contract, plan })
    expect(report.driftScore).toBeGreaterThanOrEqual(0.4)
    expect(report.suspected.some(s => s.includes('Mystery'))).toBe(true)
    expect(report.suspected.some(s => s.includes('REQ-002'))).toBe(true)
  })

  it('scores low when plan covers requirements', () => {
    const markdown = SPEC.replace('- [ ] Ticket 2: Mystery work', '- [ ] Ticket 2: Anthropic (Track: 2)')
    const contract = compileMissionContract(markdown, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const report = detectDrift({ contract, plan: parsePlan(markdown) })
    expect(report.driftScore).toBeLessThan(0.4)
  })
})
