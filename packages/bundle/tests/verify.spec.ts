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

  it('rejects bare ACC id without a successful exit code', () => {
    const contract = compileMissionContract(BASE, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const evidence = parseEvidenceFromSpec(`${BASE}
## Verification
- ACC-001
- ACC-002
`)
    const verdict = verifyAcceptance(contract, evidence)
    expect(verdict.satisfied).toBe(false)
    expect(verdict.missing).toEqual(['ACC-001', 'ACC-002'])
  })

  it('keeps completed tickets when some global ACC evidence is still missing', () => {
    const contract = compileMissionContract(BASE, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const markdown = `${BASE}
## Plan
- [x] Ticket 1
- [ ] Ticket 2

## Verification
1. \`pnpm test\` exits 0.
`
    const evidence = parseEvidenceFromSpec(markdown)
    const verdict = verifyAcceptance(contract, evidence)
    expect(verdict.satisfied).toBe(false)
    expect(verdict.missing).toContain('ACC-002')
    expect(reconcilePlanTicks(markdown, verdict, evidence)).toBeUndefined()
    expect(markdown).toContain('- [x] Ticket 1')
  })

  it('ignores Baseline results when judging Verification evidence', () => {
    const contract = compileMissionContract(BASE, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const baselinePassVerifyFail = `${BASE}
## Baseline
1. \`pnpm test\` exits 0.
2. \`pnpm run typecheck\` exits 0.

## Verification
1. \`pnpm test\` exit code 1.
2. \`pnpm run typecheck\` exit code 1.
`
    const bad = verifyAcceptance(contract, parseEvidenceFromSpec(baselinePassVerifyFail))
    expect(bad.satisfied).toBe(false)

    const baselineFailVerifyPass = `${BASE}
## Baseline
1. \`pnpm test\` exit code 1.
2. \`pnpm run typecheck\` exit code 1.

## Verification
1. \`pnpm test\` exits 0.
2. \`pnpm run typecheck\` exits 0.
`
    const ok = verifyAcceptance(contract, parseEvidenceFromSpec(baselineFailVerifyPass))
    expect(ok.satisfied).toBe(true)
  })
