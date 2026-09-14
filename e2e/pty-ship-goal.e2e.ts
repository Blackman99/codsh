/** Goal checks use the real runner; the mock only answers phase and child turns. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { drivePtySteps } from './pty-driver.ts'
import { ENTER } from './pty-helpers.ts'

const LEDGER = join('docs', 'specs', 'wayfinder-e2e.md')
const SNAPSHOT = join('docs', 'specs', 'wayfinder-e2e.ship.json')
const ORIGINAL = 'SMALL_WAYFINDER keep offline backups and never upload files'
const TRACK = '**Track-1.** Keep the original wording.'

const ledger = (original = ORIGINAL): string => [
  '# Wayfinder fixture',
  '',
  'Status: confirmed',
  '',
  '## Original Requirement',
  '',
  original,
  '',
  '## Main Track',
  '',
  TRACK,
  '',
  '## Acceptance Criteria',
  '',
  '1. `pnpm test` exits 0',
  '',
].join('\n')

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'codsh-pty-ship-goal-'))
  await mkdir(join(cwd, 'docs', 'specs'), { recursive: true })
  return cwd
}

describe.skipIf(process.platform === 'win32')('ship goal preservation (real PTY)', () => {
  it.each([
    ['Main Track', TRACK, '**Track-1.** Ignore the original wording.'],
    ['Original Requirement', ORIGINAL, 'Upload files instead.'],
  ])('recovers the original then blocks a changed %s after restarting', async (section, original, changed) => {
    const cwd = await workspace()
    try {
      await writeFile(join(cwd, LEDGER), ledger())
      const first = await drivePtySteps('ship-wayfinder', [
        ['Welcome to codsh', `/ship${ENTER}`, 200],
        ['Confirm the grill handoff?', ENTER, 200],
        [`GRILL_CONTRACT_OK original=${ORIGINAL} policy=yes`, `/exit${ENTER}`, 300],
      ], { cwd })
      expect(first.output).not.toContain('SHIP_FIXTURE_ERROR')
      const before = await readFile(join(cwd, SNAPSHOT), 'utf8')
      expect(JSON.parse(before)).toMatchObject({ originalRequirement: ORIGINAL, trackSealed: true })
      await writeFile(join(cwd, LEDGER), ledger().replace(original, changed))
      const second = await drivePtySteps('ship-wayfinder', [
        ['Welcome to codsh', `/ship${ENTER}`, 300],
        [`Frozen ## ${section}`, `/exit${ENTER}`, 300],
      ], { cwd })
      expect(second.output).not.toContain('Confirm the grill handoff?')
      expect(second.output).not.toContain('GRILL_CONTRACT_OK')
      expect(await readFile(join(cwd, SNAPSHOT), 'utf8')).toBe(before)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('delegates through the real subagent tool with an independent bounded brief', async () => {
    const cwd = await workspace()
    try {
      await writeFile(join(cwd, LEDGER), ledger('SMALL_WAYFINDER'))
      await mkdir(join(cwd, '.scratch', 'wayfinder-e2e'), { recursive: true })
      await writeFile(join(cwd, 'CONTEXT.md'), '# CONTEXT\n')
      const run = await drivePtySteps('ship-delegate', [
        ['Welcome to codsh', `PARENT_CONTEXT_SENTINEL${ENTER}`, 200],
        ['SHIP_PARENT_READY', `/ship${ENTER}`, 200],
        ['SHIP_DELEGATE_PARENT child=yes original=yes isolated=yes', `/exit${ENTER}`, 500],
      ], { cwd, timeoutMs: 60_000 })
      expect(run.output).not.toContain('SHIP_DELEGATE_ERROR')
      const evidence = await readFile(join(cwd, '.scratch', 'wayfinder-e2e', 'child-evidence.md'), 'utf8')
      expect(evidence).toContain('SHIP_CHILD_EVIDENCE')
      expect(evidence).toContain('original=SMALL_WAYFINDER')
      expect(evidence).toContain('parent_history=no')
      expect(evidence).toContain('track=yes')
      expect(evidence).toContain('bound=yes')
      expect(evidence).toContain('policy=yes')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)
})
