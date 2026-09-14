/** One ticket per turn through the runner, independent of model compliance. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ShipRun } from '../src/ship-run.ts'
import { landingPlan } from '../src/ship-landing.ts'

const roots: string[] = []
const original = 'Deliver offline exports.'
const spec = (checks: boolean[], status = 'landing', track = 'Track-1: Offline only.'): string => [
  `Status: ${status}`, '', '## Original Requirement', '', original,
  '', '## Main Track', '', track, '', '## Acceptance Criteria', '', 'Run pnpm test; exit 0.',
  '', '## Plan', '', ...checks.map((done, i) => `- [${done ? 'x' : ' '}] Ticket ${i + 1}: Capability ${i + 1} (Blocked by: ${i === 0 ? 'none' : i}) (Track: 1)`), '',
].join('\n')
function fixture(checks = [false, false, false, false]) {
  const cwd = mkdtempSync(join(tmpdir(), 'ship-landing-'))
  roots.push(cwd)
  mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
  const path = join(cwd, 'docs', 'specs', 'exports.md')
  writeFileSync(path, spec(checks))
  const messages: string[] = []
  const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} }, { flash: text => { messages.push(text) } })
  return { path, ship, messages }
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('ship landing coordinator', () => {
  it('dispatches four tickets separately then independently verifies, without a Ralph loop', async () => {
    const checks = [false, false, false, false]
    const { ship, path, messages } = fixture(checks)
    const prompts: string[] = []
    await ship.run('', async prompt => {
      prompts.push(prompt)
      const index = checks.findIndex(done => !done)
      if (index >= 0) {
        expect(prompt).toContain(`Active Ticket: Ticket ${index + 1}:`)
        expect(prompt).not.toContain('Phase 5 — done means verified')
        expect(prompt).toContain('Do not call ralph from /ship')
        checks[index] = true
        writeFileSync(path, spec(checks))
      } else {
        expect(prompt).toContain('Phase 5 — done means verified')
        expect(prompt).not.toContain('Phase 4 — automatic landing')
        writeFileSync(path, spec(checks, 'shipped'))
      }
    })
    expect(prompts).toHaveLength(5)
    expect(messages.join('\n')).not.toMatch(/Stopped|stopped/)
  })

  it('checks the sealed goal after the first ticket before dispatching the second', async () => {
    const { ship, path, messages } = fixture([false, false])
    const prompts: string[] = []
    await ship.run('', async prompt => {
      prompts.push(prompt)
      writeFileSync(path, spec([true, false], 'landing', 'Track-1: Upload everything.'))
    })
    expect(prompts).toHaveLength(1)
    expect(messages.join('\n')).toContain('Frozen ## Main Track')
  })

  it('stops after two no-progress turns', async () => {
    const { ship, messages } = fixture()
    const prompts: string[] = []
    await ship.run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toHaveLength(2)
    expect(messages.join('\n')).toContain('two consecutive turns without ticket progress')
  })

  it('stops on a recorded blocker without retrying', async () => {
    const { ship, path } = fixture()
    const prompts: string[] = []
    await ship.run('', async prompt => {
      prompts.push(prompt)
      writeFileSync(path, `${spec([false, false, false, false])}\n## Blocker\n\nNeed a user decision.\n`)
    })
    expect(prompts).toHaveLength(1)
  })

  it('refuses multiple completed tickets and premature delivery in one turn', async () => {
    for (const status of ['landing', 'shipped']) {
      const { ship, path, messages } = fixture([false, false])
      const prompts: string[] = []
      await ship.run('', async prompt => {
        prompts.push(prompt)
        writeFileSync(path, spec([true, true], status))
      })
      expect(prompts).toHaveLength(1)
      expect(messages.join('\n')).toContain('other than its Active Ticket')
    }
  })

  it('reselects a ticket invalidated during final verification and verifies again', async () => {
    const { ship, path } = fixture([true])
    let turns = 0
    await ship.run('', async prompt => {
      turns += 1
      if (turns === 1) {
        expect(prompt).toContain('Phase 5 — done means verified')
        writeFileSync(path, spec([false]))
      } else if (turns === 2) {
        expect(prompt).toContain('Active Ticket: Ticket 1:')
        writeFileSync(path, spec([true]))
      } else writeFileSync(path, spec([true], 'shipped'))
    })
    expect(turns).toBe(3)
  })

  it('bounds alternating checkbox progress and degradation', async () => {
    const { ship, path, messages } = fixture([false])
    let turns = 0
    await ship.run('', async () => { turns += 1; writeFileSync(path, spec([turns % 2 === 1])) })
    expect(turns).toBe(4)
    expect(messages.join('\n')).toContain('landing turn budget')
  })

  it('keeps dependencies and Track metadata while choosing an unblocked ticket', () => {
    const plan = landingPlan('## Plan\n\n- [ ] Ticket 2: downstream (Blocked by: 1) (Track: 2)\n- [ ] Ticket 1: upstream (Blocked by: none) (Track: 1)\n')
    expect(plan.active?.id).toBe('1')
    expect(plan.tickets[0]?.blockers).toEqual(['1'])
    expect(plan.active?.contract).toContain('(Track: 1)')
    expect(landingPlan('## Plan\n\n- [ ] Ticket 1: broken (Blocked by: 2)\n').error).toContain('Unknown')
  })
})
