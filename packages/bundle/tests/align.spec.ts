import { describe, expect, it } from 'vitest'
import { alignAction } from '../src/align.ts'
import { compileMissionContract } from '../src/mission.ts'

const SPEC = `
## Main Track
**Idea.** Ship a widget.
**Track-1.** Keep OpenAI endpoint.
**Out of Scope.**
- cloud computer
## Acceptance Criteria
1. \`pnpm test\` exits 0.
`

const contract = compileMissionContract(SPEC, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })

describe('alignAction', () => {
  it('allows a mapped write for the active ticket', () => {
    const verdict = alignAction({
      action: 'modify src/openai.ts',
      path: 'src/openai.ts',
      supports: ['REQ-001'],
      task: 'Ticket 1',
    }, {
      contract,
      sealed: true,
      activeTicket: { title: 'Ticket 1', done: false, trackIds: [1] },
    })
    expect(verdict.allow).toBe(true)
    expect(verdict.supportsRequirement).toBe('REQ-001')
  })

  it('denies writes to mission.contract.json', () => {
    const verdict = alignAction({
      action: 'modify mission.contract.json',
      path: '.scratch/widget/mission.contract.json',
      supports: ['REQ-001'],
    }, { contract, sealed: true })
    expect(verdict.allow).toBe(false)
    expect(verdict.violatesScope).toBe(true)
  })

  it('denies land writes with no requirement mapping', () => {
    const verdict = alignAction({
      action: 'modify src/x.ts',
      path: 'src/x.ts',
    }, {
      contract,
      sealed: true,
      activeTicket: { title: 'Ticket 1', done: false, trackIds: [1] },
    })
    expect(verdict.allow).toBe(false)
  })

  it('denies unknown requirement ids', () => {
    const verdict = alignAction({
      action: 'modify src/x.ts',
      path: 'src/x.ts',
      supports: ['REQ-999'],
    }, { contract, sealed: true })
    expect(verdict.allow).toBe(false)
  })
})

  it('allows a read tool with a path without supports on land', () => {
    const verdict = alignAction({
      action: 'read src/openai.ts',
      path: 'src/openai.ts',
      toolName: 'read',
    }, {
      contract,
      sealed: true,
      activeTicket: { title: 'Ticket 1', done: false, trackIds: [1] },
    })
    expect(verdict.allow).toBe(true)
  })
