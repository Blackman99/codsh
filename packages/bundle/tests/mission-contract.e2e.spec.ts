/**
 * Mission Contract control plane — PR #101 composition e2e.
 *
 * Unit suites pin parsers (mission / align / drift / verify). ship-run.spec
 * pins seal + Active Ticket inject. This file is the designed e2e for the
 * control plane: one sealed run on a real temp workspace must refuse
 * immutable writes, flag drifted plans, and clear premature ticks without
 * acceptance evidence.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ShipRun } from '../src/ship-run.ts'
import { parseMissionContract } from '../src/mission.ts'
import { detectDrift } from '../src/drift.ts'
import { parseEvidenceFromSpec, verifyAcceptance } from '../src/verify.ts'
import { parsePlan } from '../src/plan.ts'

const chrome = { setPlan: () => {}, setChip: () => {} }

const writeSpec = (cwd: string, markdown: string): string => {
  const dir = join(cwd, 'docs', 'specs')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'widget.md')
  writeFileSync(path, markdown)
  return path
}

const SEALED = [
  'Status: interviewing',
  'Branch: ship/widget',
  '',
  '## Main Track',
  '',
  '**Idea.** Bind /goal into /ship.',
  '**Track-1.** Hybrid compass.',
  '**Track-2.** Compact payload.',
  '**Out of Scope.**',
  '- cloud computer',
  '',
  '## Acceptance Criteria',
  '',
  '1. `pnpm test` exits 0.',
  '2. `pnpm run typecheck` exits 0.',
  '',
  '## Plan',
  '',
  '- [ ] Ticket 1: Spec schema (Track: 1)',
  '- [ ] Ticket 2: Prompt contracts (Track: 2)',
].join('\n')

describe('Mission Contract control plane e2e', () => {
  it('seals the contract, restores Main Track, and lands only the Active Ticket', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-e2e-'))
    const path = writeSpec(cwd, SEALED)
    const prompts: string[] = []
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })

    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) {
        writeFileSync(path, SEALED.replace('Status: interviewing', 'Status: confirmed'))
      } else if (prompts.length === 2) {
        writeFileSync(path, [
          'Status: planned',
          'Branch: ship/widget',
          '',
          '## Main Track',
          '',
          '**Idea.** silently rewritten design.',
          '',
          '## Acceptance Criteria',
          '',
          '1. `pnpm test` exits 0.',
          '2. `pnpm run typecheck` exits 0.',
          '',
          '## Plan',
          '',
          '- [ ] Ticket 1: Spec schema (Track: 1)',
          '- [ ] Ticket 2: Prompt contracts (Track: 2)',
        ].join('\n'))
      }
    })

    expect(ship.missionContractFile).toBeDefined()
    expect(existsSync(ship.missionContractFile!)).toBe(true)
    const contract = parseMissionContract(readFileSync(ship.missionContractFile!, 'utf8'))
    expect(contract.objective).toBe('Bind /goal into /ship.')
    expect(contract.requirements.map(r => r.id)).toEqual(['REQ-001', 'REQ-002'])
    expect(contract.excluded[0]?.text).toMatch(/cloud computer/i)
    expect(contract.acceptance).toHaveLength(2)

    expect(prompts.length).toBeGreaterThanOrEqual(3)
    expect(prompts[1]).toContain('## Mission Contract')
    expect(prompts[1]).toContain('REQ-001')
    expect(prompts[2]).toContain('## Active Ticket')
    expect(prompts[2]).toContain('Ticket 1: Spec schema')
    expect(prompts[2]).toContain('REQ-001')
    expect(prompts[2]).not.toContain('Ticket 2: Prompt contracts')

    const onDisk = readFileSync(path, 'utf8')
    expect(onDisk).toContain('**Idea.** Bind /goal into /ship.')
    expect(onDisk).not.toContain('silently rewritten design')
    expect(flashes.some(f => /Mission Contract/i.test(f))).toBe(true)
  })

  it('Alignment Gate denies immutable contract and unmapped writes after seal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-e2e-'))
    const path = writeSpec(cwd, SEALED)
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })

    await ship.run('build a widget', async (prompt) => {
      if (!prompt) return
      writeFileSync(path, SEALED.replace('Status: interviewing', 'Status: confirmed'))
    })

    expect(ship.missionContract).toBeDefined()
    expect(ship.missionContractFile).toBeDefined()

    const denyContract = ship.align({
      action: 'modify mission.contract.json',
      path: ship.missionContractFile!,
      supports: ['REQ-001'],
    })
    expect(denyContract.allow).toBe(false)
    expect(denyContract.violatesScope).toBe(true)

    const denyUnmapped = ship.align({
      action: 'modify src/x.ts',
      path: 'src/x.ts',
    })
    expect(denyUnmapped.allow).toBe(false)

    // Write-path guard flashes when noteWritten sees an immutable path.
    ship.noteWritten([ship.missionContractFile!])
    expect(flashes.some(f => /Alignment Gate/i.test(f))).toBe(true)

    const allowMapped = ship.align({
      action: 'modify src/openai.ts',
      path: 'src/openai.ts',
      supports: ['REQ-001'],
      task: 'Ticket 1: Spec schema',
    })
    expect(allowMapped.allow).toBe(true)
  })

  it('Drift Detector flags plans that leave sealed requirements uncovered', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-e2e-'))
    const path = writeSpec(cwd, SEALED)
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    const prompts: string[] = []

    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) {
        writeFileSync(path, SEALED.replace('Status: interviewing', 'Status: confirmed'))
      } else {
        writeFileSync(path, [
          'Status: planned',
          'Branch: ship/widget',
          '',
          '## Main Track',
          '',
          '**Idea.** Bind /goal into /ship.',
          '**Track-1.** Hybrid compass.',
          '**Track-2.** Compact payload.',
          '**Out of Scope.**',
          '- cloud computer',
          '',
          '## Acceptance Criteria',
          '',
          '1. `pnpm test` exits 0.',
          '2. `pnpm run typecheck` exits 0.',
          '',
          '## Plan',
          '',
          '- [ ] Ticket 1: Spec schema (Track: 1)',
          '- [ ] Ticket 2: Mystery rewrite with no track',
        ].join('\n'))
        ship.noteWritten([path])
      }
    })

    expect(ship.missionContract).toBeDefined()
    const report = ship.driftReport ?? detectDrift({
      contract: ship.missionContract!,
      plan: parsePlan(readFileSync(path, 'utf8')),
    })
    expect(report.driftScore).toBeGreaterThanOrEqual(0.4)
    expect(report.suspected.some(s => /Mystery|REQ-002|no Track|Track/i.test(s))).toBe(true)
    expect(flashes.some(f => /Mission drift/i.test(f))).toBe(true)
  })

  it('Verifier blocks completion without evidence and clears premature plan ticks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-e2e-'))
    const early = [
      'Status: interviewing',
      'Branch: ship/widget',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.**',
      '- cloud computer',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
      '2. `pnpm run typecheck` exits 0.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Spec schema (Track: 1)',
      '- [ ] Ticket 2: Prompt contracts (Track: 1)',
    ].join('\n')
    const path = writeSpec(cwd, early)
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    const prompts: string[] = []

    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) {
        writeFileSync(path, early.replace('Status: interviewing', 'Status: confirmed'))
      } else {
        writeFileSync(path, early
          .replace('Status: interviewing', 'Status: planned')
          .replace('- [ ] Ticket 1', '- [x] Ticket 1')
          .replace('- [ ] Ticket 2', '- [x] Ticket 2'))
        ship.noteWritten([path])
      }
    })

    expect(ship.missionContract).toBeDefined()
    const evidence = parseEvidenceFromSpec(readFileSync(path, 'utf8'))
    const verdict = ship.verifyVerdict ?? verifyAcceptance(ship.missionContract!, evidence)
    expect(verdict.satisfied).toBe(false)
    expect(verdict.missing.length).toBeGreaterThan(0)

    const onDisk = readFileSync(path, 'utf8')
    expect(onDisk).toMatch(/- \[ \] Ticket 1/)
    expect(onDisk).toMatch(/- \[ \] Ticket 2/)
    expect(flashes.some(f => /Verifier|evidence/i.test(f))).toBe(true)
  })
})
