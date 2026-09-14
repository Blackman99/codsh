/** Ticket turns and the final verification turn through the real terminal runner. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { drivePtySteps } from './pty-driver.ts'
import { ENTER } from './pty-helpers.ts'

const ledger = (drift = false) => [
  'Status: landing', '', '## Original Requirement', '', 'Keep offline exports.',
  '', '## Main Track', '', 'Track-1: Keep offline exports.',
  '', '## Acceptance Criteria', '', 'pnpm test exits 0.',
  '', '## Plan', '', ...[1, 2, 3, 4].map(i => `- [ ] Ticket ${i}: Export ${i} (Blocked by: ${i === 1 ? 'none' : i - 1}) (Track: 1)`),
  '', '## Notes', '', drift ? 'DRIFT_AFTER_FIRST' : 'Fixture: no real implementation is claimed.', '',
].join('\n')

describe.skipIf(process.platform === 'win32')('ship per-ticket landing (real PTY)', () => {
  it.each([60, 120])('coordinates four turns then verifies at %i columns', async columns => {
    const cwd = await mkdtemp(join(tmpdir(), 'ship-landing-pty-'))
    try {
      const dir = join(cwd, 'docs', 'specs')
      await mkdir(dir, { recursive: true })
      const path = join(dir, 'landing-e2e.md')
      await writeFile(path, ledger())
      const run = await drivePtySteps('ship-landing', [
        ['Welcome to codsh', `/ship${ENTER}`, 200],
        ['SHIP_VERIFICATION_DONE', `/exit${ENTER}`, 400],
      ], { cwd, columns })
      let previous = -1
      for (let i = 1; i <= 4; i += 1) {
        const position = run.output.indexOf(`SHIP_TICKET_${i}_DONE`)
        expect(position).toBeGreaterThan(previous)
        previous = position
      }
      expect(run.output.indexOf('SHIP_VERIFICATION_DONE')).toBeGreaterThan(previous)
      expect(run.output).not.toContain('SHIP_LANDING_ERROR')
      expect(await readFile(path, 'utf8')).toContain('Status: shipped')
      expect(run.output).not.toContain('Ralph round')
    } finally { await rm(cwd, { recursive: true, force: true }) }
  }, E2E_TEST_TIMEOUT_MS)

  it('blocks drift between tickets before a second model turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ship-drift-pty-'))
    try {
      const dir = join(cwd, 'docs', 'specs')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'landing-e2e.md'), ledger(true))
      const run = await drivePtySteps('ship-landing', [
        ['Welcome to codsh', `/ship${ENTER}`, 200],
        ['Frozen ## Main Track', `/exit${ENTER}`, 300],
      ], { cwd })
      expect(run.output).toContain('SHIP_TICKET_1_DONE')
      expect(run.output).not.toContain('SHIP_TICKET_2_DONE')
      expect(run.output).not.toContain('SHIP_VERIFICATION_DONE')
    } finally { await rm(cwd, { recursive: true, force: true }) }
  }, E2E_TEST_TIMEOUT_MS)
})
