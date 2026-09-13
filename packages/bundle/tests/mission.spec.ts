/**
 * Mission Contract compile / serialize / drift helpers.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compileMissionContract,
  mainTrackDrifted,
  missionContractPath,
  missionContractSummary,
  parseMissionContract,
  serializeMissionContract,
  slugFromSpec,
  writeMissionContract,
} from '../src/mission.ts'

const SPEC = `
Status: confirmed
Branch: ship/widget
Goal-Id: goal-1

## Requirement

Build a widget with a sealed compass.

## Main Track

**Idea.** Bind /goal into /ship.

**Track-1.** Hybrid compass: spec is durable memory.

**Track-2.** Compact payload: idea + Track-N + Out of Scope.

**Out of Scope.**
- Forking the harness goal service.
- A TTY GoalBar.

## Acceptance Criteria

1. \`pnpm exec vitest run packages/bundle/tests/mission.spec.ts\` exits 0.
2. \`pnpm run typecheck\` exits 0 with zero new failures.
`

describe('mission contract', () => {
  it('compiles REQ/NEG/ACC ids from Main Track and acceptance', () => {
    const contract = compileMissionContract(SPEC, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    expect(contract.version).toBe(1)
    expect(contract.id).toBe('widget')
    expect(contract.objective).toBe('Bind /goal into /ship.')
    expect(contract.requirements).toEqual([
      { id: 'REQ-001', text: 'Hybrid compass: spec is durable memory.', track: [1] },
      { id: 'REQ-002', text: 'Compact payload: idea + Track-N + Out of Scope.', track: [2] },
    ])
    expect(contract.excluded).toEqual([
      { id: 'NEG-001', text: 'Forking the harness goal service.' },
      { id: 'NEG-002', text: 'A TTY GoalBar.' },
    ])
    expect(contract.acceptance[0]).toMatchObject({
      id: 'ACC-001',
      command: 'pnpm exec vitest run packages/bundle/tests/mission.spec.ts',
      expect: 'exits 0',
    })
    expect(contract.authority.user_requirements).toBe('immutable')
    expect(contract.mainTrackMarkdown).toContain('**Track-1.**')
  })

  it('round-trips through serialize/parse', () => {
    const contract = compileMissionContract(SPEC, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const again = parseMissionContract(serializeMissionContract(contract))
    expect(again).toEqual(contract)
  })

  it('writes mission.contract.json under .scratch/<slug>/', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-'))
    const contract = compileMissionContract(SPEC, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const path = writeMissionContract(cwd, 'widget', contract)
    expect(path).toBe(missionContractPath(cwd, 'widget'))
    expect(parseMissionContract(readFileSync(path, 'utf8'))).toEqual(contract)
  })

  it('summarizes REQ/NEG for phase prepend', () => {
    const contract = compileMissionContract(SPEC, { id: 'widget', sealedAt: '2026-09-13T00:00:00.000Z' })
    const summary = missionContractSummary(contract, '/tmp/mission.contract.json')
    expect(summary).toContain('## Mission Contract')
    expect(summary).toContain('REQ-001')
    expect(summary).toContain('NEG-001')
    expect(summary).toContain('immutable')
    expect(summary).toContain('/tmp/mission.contract.json')
  })

  it('detects Main Track rewrite against the sealed body', () => {
    const contract = compileMissionContract(SPEC, { id: 'widget' })
    expect(mainTrackDrifted(contract.mainTrackMarkdown, SPEC)).toBe(false)
    expect(mainTrackDrifted(contract.mainTrackMarkdown, 'Status: planned\n\n## Main Track\n\n**Idea.** silently rewritten.\n')).toBe(true)
  })

  it('derives slug from Branch: ship/<slug> or basename', () => {
    expect(slugFromSpec('Branch: ship/widget\n')).toBe('widget')
    expect(slugFromSpec('Status: confirmed\n', '/repo/docs/specs/my-feature.md')).toBe('my-feature')
  })
})
