/** /ship wayfinder handoff through the real command, tools, ledger, and terminal. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { drivePtySteps, screenOf, type Driven } from './pty-driver.ts'
import { ENTER, ESCAPE } from './pty-helpers.ts'

function beforeStep(run: Driven, index: number, columns = 120): string[] {
  const offset = run.offsets[index]
  if (offset === undefined) throw new Error(`Missing PTY step ${index + 1}`)
  return screenOf(Buffer.from(run.output).subarray(0, offset).toString(), -1, 40, columns).alternate
}

describe.skipIf(process.platform === 'win32')('ship wayfinder (real PTY)', () => {
  it.each([60, 120])('enters wayfinder before grill at %i columns', async columns => {
    const run = await drivePtySteps('ship-wayfinder', [
      ['Welcome to codsh', `/ship SMALL_WAYFINDER${ENTER}`, 200],
      ['Is the route clear?', ENTER, 300],
      ['Confirm the grill handoff?', ENTER, 400],
      ['GRILL_CONTRACT_OK', '', 0],
      ['Confirm the grill handoff?', ESCAPE, 0],
      ['', `/exit${ENTER}`, 500],
    ], { columns })
    expect(beforeStep(run, 1, columns).join('\n')).toContain('ship · wayfinder')
    expect(beforeStep(run, 2, columns).join('\n')).toContain('ship · grill')
    expect(run.output.indexOf('Is the route clear?')).toBeLessThan(run.output.indexOf('Confirm the grill handoff?'))
    expect(run.output).not.toContain('SHIP_FIXTURE_ERROR')
    for (const row of beforeStep(run, 4, columns)) expect(row.length).toBeLessThanOrEqual(columns)
  }, E2E_TEST_TIMEOUT_MS)

  it('stops with an unresolved map and resumes wayfinder on bare /ship', async () => {
    const run = await drivePtySteps('ship-wayfinder', [
      ['Welcome to codsh', `/ship PENDING_WAYFINDER${ENTER}`, 200],
      ['Is the route clear?', ENTER, 300],
      ['', ESCAPE, 800],
      ['WAYFINDER_WAITING', `/ship${ENTER}`, 400],
      ['WAYFINDER_RESUMED', ESCAPE, 400],
      ['', `/exit${ENTER}`, 300],
    ])
    expect(beforeStep(run, 3).at(-1)).toContain('ship · wayfinder')
    expect(run.output).not.toContain('Confirm the grill handoff?')
  }, E2E_TEST_TIMEOUT_MS)

  it.each([['Stop', `${ESCAPE}[B${ENTER}`], ['Escape', ESCAPE]])('leaves grill untouched after %s', async (_label, answer) => {
    const run = await drivePtySteps('ship-wayfinder', [
      ['Welcome to codsh', `/ship SMALL_WAYFINDER${ENTER}`, 200],
      ['Is the route clear?', answer, 300],
      ['', ESCAPE, 600],
      ['', `/exit${ENTER}`, 300],
    ])
    expect(run.output).not.toContain('Confirm the grill handoff?')
    expect(run.output).not.toContain('WAYFINDER_READY')
  }, E2E_TEST_TIMEOUT_MS)

  it('persists SMALL_WAYFINDER verbatim and shows original plus subagent policy on grill', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'codsh-pty-ship-'))
    try {
      const run = await drivePtySteps('ship-wayfinder', [
        ['Welcome to codsh', `/ship SMALL_WAYFINDER${ENTER}`, 200],
        ['Is the route clear?', ENTER, 300],
        ['Confirm the grill handoff?', ENTER, 400],
        ['GRILL_CONTRACT_OK original=SMALL_WAYFINDER policy=yes', '', 0],
        ['Confirm the grill handoff?', ESCAPE, 0],
        ['', `/exit${ENTER}`, 700],
      ], { cwd })
      expect(run.output).toContain('original=SMALL_WAYFINDER')
      expect(run.output).toContain('policy=yes')
      expect(run.output).not.toContain('original=missing')
      const ledger = await readFile(join(cwd, 'docs', 'specs', 'wayfinder-e2e.md'), 'utf8')
      expect(ledger).toContain('## Original Requirement')
      expect(ledger).toContain('SMALL_WAYFINDER')
      expect(ledger).not.toContain('Small route confirmed; no map needed.\n\nStatus:')
      expect(ledger.match(/SMALL_WAYFINDER/g)?.length).toBeGreaterThanOrEqual(1)
      const answers = JSON.parse(await readFile(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.answers.json'), 'utf8'))
      expect(answers.answers).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'wayfinder', question: 'Is the route clear?', answer: expect.stringContaining('Continue') }),
        expect.objectContaining({ phase: 'grill', question: 'Confirm the grill handoff?', answer: expect.any(String) }),
      ]))
      const graph = JSON.parse(await readFile(join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.graph.json'), 'utf8'))
      expect(graph.originalRequirement).toBe('SMALL_WAYFINDER')
      expect(graph.answers).toEqual(expect.arrayContaining(answers.answers))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('persists PENDING_WAYFINDER verbatim and recovers it on bare /ship', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'codsh-pty-ship-'))
    try {
      const run = await drivePtySteps('ship-wayfinder', [
        ['Welcome to codsh', `/ship PENDING_WAYFINDER${ENTER}`, 200],
        ['Is the route clear?', ENTER, 300],
        ['', ESCAPE, 800],
        ['WAYFINDER_WAITING original=PENDING_WAYFINDER policy=yes', `/ship${ENTER}`, 400],
        ['WAYFINDER_RESUMED original=PENDING_WAYFINDER policy=yes', ESCAPE, 400],
        ['', `/exit${ENTER}`, 300],
      ], { cwd })
      expect(run.output).toContain('WAYFINDER_WAITING original=PENDING_WAYFINDER policy=yes')
      expect(run.output).toContain('WAYFINDER_RESUMED original=PENDING_WAYFINDER policy=yes')
      expect(run.output).not.toContain('Confirm the grill handoff?')
      const ledger = await readFile(join(cwd, 'docs', 'specs', 'wayfinder-e2e.md'), 'utf8')
      expect(ledger).toContain('## Original Requirement\n\nPENDING_WAYFINDER')
      expect(ledger).toContain('Status: wayfinding')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)
})
