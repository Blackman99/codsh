import { describe, expect, it } from 'vitest'
import { compileMissionContract } from '../src/mission.ts'
import { parseEvidenceFromSpec, reconcilePlanTicks, verifyAcceptance } from '../src/verify.ts'

const BASE = `
## Main Track
**Idea.** Ship a widget.
**Track-1.** Keep tests green.
## Acceptance Criteria
1. \`pnpm test\` exits 0.
2. \`pnpm run typecheck\` exits 0.
`

describe('verifyAcceptance', () => {
  it('requires evidence for every acceptance criterion', () => {
    const contract = compileMissionContract(BASE, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const empty = verifyAcceptance(contract, [])
    expect(empty.satisfied).toBe(false)
    expect(empty.missing).toEqual(['ACC-001', 'ACC-002'])

    const markdown = `${BASE}
## Verification
1. \`pnpm test\` exits 0.
2. \`pnpm run typecheck\` exit code 0.
`
    const evidence = parseEvidenceFromSpec(markdown)
    const ok = verifyAcceptance(contract, evidence)
    expect(ok.satisfied).toBe(true)
    expect(ok.matched).toEqual(['ACC-001', 'ACC-002'])
  })

  it('reconciles premature plan ticks when evidence is incomplete', () => {
    const contract = compileMissionContract(BASE, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const verdict = verifyAcceptance(contract, [])
    const markdown = `${BASE}
## Plan
- [x] Ticket 1
- [x] Ticket 2
`
    const next = reconcilePlanTicks(markdown, verdict)
    expect(next).toBeDefined()
    expect(next).toContain('- [ ] Ticket 1')
    expect(next).toContain('- [ ] Ticket 2')
  })
})
