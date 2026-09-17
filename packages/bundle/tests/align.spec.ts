import { describe, expect, it } from 'vitest'
import { alignAction, descriptorFromToolCall } from '../src/align.ts'
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

  it('allows reading mission.contract.json while denying writes to it', () => {
    const read = alignAction({
      action: 'read mission.contract.json',
      path: '.scratch/widget/mission.contract.json',
      toolName: 'read',
    }, { contract, sealed: true })
    expect(read.allow).toBe(true)
    const write = alignAction({
      action: 'write mission.contract.json',
      path: '.scratch/widget/mission.contract.json',
      toolName: 'write',
      supports: ['REQ-001'],
    }, { contract, sealed: true })
    expect(write.allow).toBe(false)
  })

  it('denies a write that targets an immutable section', () => {
    const verdict = alignAction({
      action: 'write docs/specs/widget.md',
      path: 'docs/specs/widget.md',
      toolName: 'write',
      section: 'Out of Scope',
      supports: ['REQ-001'],
    }, {
      contract,
      sealed: true,
      activeTicket: { title: 'Ticket 1', done: false, trackIds: [1] },
    })
    expect(verdict.allow).toBe(false)
    expect(verdict.violatesScope).toBe(true)
  })

  it('does not apply Alignment Gate to Conflict-resolution hunk bytes', () => {
    const verdict = alignAction({
      action: 'write src/greet.ts',
      path: 'src/greet.ts',
      toolName: 'write',
    }, {
      contract,
      sealed: true,
      activeTicket: { title: 'Ticket 1', done: false, trackIds: [1] },
      conflictFiles: ['src/greet.ts'],
    })
    expect(verdict.allow).toBe(true)
    expect(verdict.violatesScope).toBe(false)
  })

  it('does not map Conflict-resolution writes onto the active landing ticket', () => {
    const opts = {
      contract,
      sealed: true,
      activeTicket: { title: 'Ticket 2: WWII Weaponry', done: false, trackIds: [2] },
      conflictFiles: ['src/weapons/ballistics.ts'],
    }
    const unmapped = alignAction({
      action: 'write',
      toolName: 'write',
    }, opts)
    expect(unmapped.allow).toBe(true)
    expect(unmapped.reasons).toEqual([])

    const invented = alignAction({
      action: 'write src/weapons/ballistics.ts',
      path: 'src/weapons/ballistics.ts',
      toolName: 'write',
      supports: ['ACC-002', 'REQ-001', 'Track-2'],
    }, opts)
    expect(invented.allow).toBe(true)
    expect(invented.reasons).toEqual([])

    const viaTarget = descriptorFromToolCall('write', {
      target_file: './src/weapons/ballistics.ts',
      content: 'export {}\n',
    })
    expect(alignAction(viaTarget, opts).allow).toBe(true)
  })

  it('still refuses immutable contract writes during Conflict-resolution', () => {
    const verdict = alignAction({
      action: 'write mission.contract.json',
      path: '.scratch/widget/mission.contract.json',
      toolName: 'write',
    }, {
      contract,
      sealed: true,
      conflictFiles: ['src/weapons/ballistics.ts'],
    })
    expect(verdict.allow).toBe(false)
    expect(verdict.violatesScope).toBe(true)
  })

  it('allows writes citing acceptance criteria as supports', () => {
    const verdict = alignAction({
      action: 'write src/test.ts',
      path: 'src/test.ts',
      toolName: 'write',
      supports: ['ACC-001'],
    }, {
      contract,
      sealed: true,
      activeTicket: { title: 'Ticket 1', done: false, trackIds: [1] },
    })
    expect(verdict.allow).toBe(true)
    expect(verdict.supportsRequirement).toBe('ACC-001')
  })

  it('normalizes acceptance criteria and requirement numbers', () => {
    const accVerdict = alignAction({
      action: 'write src/test.ts',
      path: 'src/test.ts',
      toolName: 'write',
      supports: ['ACC-1'],
    }, {
      contract,
      sealed: true,
      activeTicket: { title: 'Ticket 1', done: false, trackIds: [1] },
    })
    expect(accVerdict.allow).toBe(true)
    expect(accVerdict.supportsRequirement).toBe('ACC-001')

    const reqVerdict = alignAction({
      action: 'write src/x.ts',
      path: 'src/x.ts',
      toolName: 'write',
      supports: ['REQ-1'],
    }, {
      contract,
      sealed: true,
      activeTicket: { title: 'Ticket 1', done: false, trackIds: [1] },
    })
    expect(reqVerdict.allow).toBe(true)
    expect(reqVerdict.supportsRequirement).toBe('REQ-001')
  })
