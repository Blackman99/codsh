/** Landing wave: parallel worktrees, Ready-set drain, no parent turn-budget. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ShipRun, type ShipChildHandle, type ShipGit } from '../src/ship-run.ts'
import {
  landingPlan,
  landingWavePrepend,
  readySet,
  type LandingTicket,
  type LandingWaveView,
} from '../src/ship-landing.ts'

const roots: string[] = []
const original = 'Deliver offline exports.'
const spec = (
  checks: boolean[],
  status = 'landing',
  track = 'Track-1: Offline only.',
  blockers?: Array<string | undefined>,
): string => [
  `Status: ${status}`, 'Branch: ship/exports', '', '## Original Requirement', '', original,
  '', '## Main Track', '', track, '', '## Acceptance Criteria', '', 'Run pnpm test; exit 0.',
  '', '## Plan', '', ...checks.map((done, i) => {
    const blocked = blockers?.[i] ?? (i === 0 ? 'none' : String(i))
    return `- [${done ? 'x' : ' '}] Ticket ${i + 1}: Capability ${i + 1} (Blocked by: ${blocked}) (Track: 1)`
  }), '',
].join('\n')

function writeIssue(cwd: string, n: number, title: string, extra = ''): void {
  const dir = join(cwd, '.scratch', 'exports', 'issues')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${String(n).padStart(2, '0')}-${title.toLowerCase().replace(/\s+/gu, '-')}.md`), `Ticket ${String(n)}: ${title}\n${extra}`)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>(next => { resolve = next })
  return { promise, resolve }
}

function waveChildren() {
  const created: Array<{ graphKey: string; cwd?: string; prompt: string }> = []
  const pending = new Map<string, { resolve: () => void; handle: ShipChildHandle }>()
  return {
    created,
    pending,
    finish(graphKey: string) { pending.get(graphKey)?.resolve() },
    async create(request: { graphKey: string; label: string; prompt: string; cwd?: string }): Promise<ShipChildHandle> {
      const wait = deferred()
      created.push({
        graphKey: request.graphKey,
        prompt: request.prompt,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      })
      const handle: ShipChildHandle = {
        id: `child-${String(created.length)}`,
        graphKey: request.graphKey,
        label: request.label,
        done: wait.promise,
        async dispose() {},
      }
      pending.set(request.graphKey, { resolve: wait.resolve, handle })
      return handle
    },
  }
}

async function waitUntil(predicate: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
}

function recordingGit(): ShipGit & { log: string[] } {
  const log: string[] = []
  const git: ShipGit & { log: string[] } = Object.assign(
    async (args: readonly string[], cwd: string) => {
      log.push(`${args.join(' ')} @ ${cwd}`)
      if (args[0] === 'config' && args[1] === 'user.name') return { code: 0, output: 'Ada Lovelace\n' }
      if (args[0] === 'config' && args[1] === 'user.email') return { code: 0, output: 'ada@example.com\n' }
      if (args[0] === 'worktree' && args[1] === 'add') {
        const dest = args[args.length - 1]
        if (dest !== undefined && dest !== '') mkdirSync(dest, { recursive: true })
      }
      return { code: 0, output: '' }
    },
    { log },
  )
  return git
}

function fixture(
  checks = [false, false, false, false],
  opts: {
    blockers?: Array<string | undefined>
    prove?: (ticket: { id: string }) => Promise<'green' | 'red'>
    children?: ReturnType<typeof waveChildren>
    git?: ShipGit & { log: string[] }
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), 'ship-landing-'))
  roots.push(cwd)
  mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
  const path = join(cwd, 'docs', 'specs', 'exports.md')
  writeFileSync(path, spec(checks, 'landing', 'Track-1: Offline only.', opts.blockers))
  for (const [index, done] of checks.entries()) {
    if (!done) writeIssue(cwd, index + 1, `Capability ${index + 1}`)
  }
  const messages: string[] = []
  const children = opts.children ?? waveChildren()
  const git = opts.git ?? recordingGit()
  const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} }, {
    flash: text => { messages.push(text) },
    childCreate: children,
    git,
    ...(opts.prove === undefined ? {} : { prove: opts.prove }),
  })
  return { path, cwd, ship, messages, children, git }
}

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

const ticket = (id: string, blockers: string[] = []): LandingTicket => ({
  id,
  contract: `Ticket ${id}: Capability ${id} (Blocked by: ${blockers[0] ?? 'none'}) (Track: 1)`,
  done: false,
  blockers,
})

describe('Ready-set', () => {
  it('orders finished 已认领 work by lowest landing:N and ignores a live earlier-N', () => {
    const t1 = ticket('1')
    const t2 = ticket('2')
    const t3 = ticket('3')
    const view: LandingWaveView = {
      tickets: [t1, t2, t3],
      claimed: new Set(['1', '2', '3']),
      inFlight: new Set(['1']),
      finished: new Set(['3', '2']),
      worktrees: new Set(['1', '2', '3']),
    }
    expect(readySet(view).map(row => row.id)).toEqual(['2', '3'])
  })

  it('does not treat a keep-commit that stayed [ ] as 已关闭 for dependents', () => {
    const t1 = ticket('1')
    const t2 = ticket('2', ['1'])
    const view: LandingWaveView = {
      tickets: [t1, t2],
      claimed: new Set(['1', '2']),
      inFlight: new Set(),
      finished: new Set(['2']),
      worktrees: new Set(['2']),
    }
    expect(readySet(view).map(row => row.id)).toEqual([])
  })

  it('prepends in-flight / Ready-set, not one Active Ticket', () => {
    const t1 = ticket('1')
    const t3 = ticket('3')
    const text = landingWavePrepend({
      tickets: [t1, t3],
      claimed: new Set(['1', '3']),
      inFlight: new Set(['1']),
      finished: new Set(['3']),
      worktrees: new Set(['1', '3']),
    })
    expect(text).toContain('In-flight:')
    expect(text).toContain('Ready-set:')
    expect(text).toContain('Ticket 1:')
    expect(text).toContain('Ticket 3:')
    expect(text).not.toMatch(/Active Ticket/i)
  })
})

describe('ship landing coordinator', () => {
  it('dispatches two independent tickets in parallel worktrees in one run()', async () => {
    const { ship, cwd, children, git } = fixture([false, false], {
      blockers: ['none', 'none'],
    })
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.length === 2)
    expect(children.created).toHaveLength(2)
    expect(children.created.map(row => row.graphKey).sort()).toEqual(['landing:1', 'landing:2'])
    expect(children.created.every(row => row.cwd?.includes(`${join('.scratch', 'exports', 'worktrees')}`))).toBe(true)
    expect(git.log.some(entry => entry.includes('worktree add -B wt/exports/landing-1'))).toBe(true)
    expect(git.log.some(entry => entry.includes('worktree add -B wt/exports/landing-2'))).toBe(true)
    expect(readFileSync(join(cwd, '.scratch', 'exports', 'worktrees', '.gitignore'), 'utf8')).toContain('*')
    ship.abort()
    await running
  })

  it('merges a finished independent later-N while an earlier-N is still running', async () => {
    const { ship, path, cwd, children, git } = fixture([false, false], {
      blockers: ['none', 'none'],
    })
    const running = ship.run('', async prompt => {
      if (prompt.includes('Phase 5 — done means verified')) {
        writeFileSync(path, spec([true, true], 'shipped', 'Track-1: Offline only.', ['none', 'none']))
      }
    })
    await waitUntil(() => children.created.length === 2)
    expect(children.created.map(row => row.graphKey).sort()).toEqual(['landing:1', 'landing:2'])
    children.finish('landing:2')
    await waitUntil(() => git.log.some(entry => entry.includes('merge --no-ff') && /Ticket 2/.test(entry)))
    const land2 = git.log.findIndex(entry => entry.includes('merge --no-ff') && /Ticket 2/.test(entry))
    const land1 = git.log.findIndex(entry => entry.includes('merge --no-ff') && /Ticket 1/.test(entry))
    expect(land2).toBeGreaterThan(-1)
    expect(land1 === -1 || land2 < land1).toBe(true)
    expect(git.log.some(entry => /Ticket 2: Capability 2/.test(entry) && entry.includes('Ada Lovelace'))).toBe(true)
    expect(existsSync(join(cwd, '.scratch', 'exports', 'worktrees', 'landing-2'))).toBe(false)
    children.finish('landing:1')
    await running
    expect(readFileSync(path, 'utf8')).toMatch(/- \[x\] Ticket 2:/u)
  })

  it('ticks now on green proof and keeps dependents blocked after a red keep-commit', async () => {
    const prove = async (ticket: { id: string }): Promise<'green' | 'red'> => (ticket.id === '1' ? 'red' : 'green')
    const { ship, path, cwd, children, git } = fixture([false, false], {
      blockers: ['none', '1'],
      prove,
    })
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.length === 1)
    expect(children.created.map(row => row.graphKey)).toEqual(['landing:1'])
    children.finish('landing:1')
    await running
    expect(git.log.some(entry => entry.includes('merge --no-ff') && /Ticket 1/.test(entry))).toBe(true)
    expect(readFileSync(path, 'utf8')).toMatch(/- \[ \] Ticket 1:/u)
    expect(readFileSync(path, 'utf8')).toMatch(/- \[ \] Ticket 2:/u)
    expect(readFileSync(join(cwd, '.scratch', 'exports', 'issues', '01-capability-1.md'), 'utf8')).toMatch(/^Proof:\s*red\b/mu)
    expect(children.created.map(row => row.graphKey)).toEqual(['landing:1'])
    expect(existsSync(join(cwd, '.scratch', 'exports', 'worktrees', 'landing-1'))).toBe(false)
  })

  it('does not inject a third parent turn from a landing turn-budget or two-no-progress stop', async () => {
    const { ship, messages, children } = fixture([false, false], { blockers: ['none', 'none'] })
    const prompts: string[] = []
    const running = ship.run('', async prompt => { prompts.push(prompt) })
    await waitUntil(() => children.created.length === 2)
    expect(children.created).toHaveLength(2)
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(prompts).toHaveLength(0)
    expect(messages.join('\n')).not.toContain('two consecutive turns without ticket progress')
    expect(messages.join('\n')).not.toContain('landing turn budget')
    ship.abort()
    await running
    expect(prompts).toHaveLength(0)
  })

  it('stops on a recorded blocker without a parent retry', async () => {
    const { path, cwd } = fixture()
    writeFileSync(path, `${spec([false, false, false, false])}\n## Blocker\n\nNeed a user decision.\n`)
    const messages: string[] = []
    const prompts: string[] = []
    const children = waveChildren()
    const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} }, {
      flash: text => { messages.push(text) },
      childCreate: children,
      git: recordingGit(),
    })
    await ship.run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toHaveLength(0)
    expect(messages.join('\n')).toMatch(/Blocker/)
  })

  it('checks the sealed goal after a Ready-set merge before further dispatch', async () => {
    const { ship, path, messages, children } = fixture([false, false], { blockers: ['none', '1'] })
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.length === 1)
    writeFileSync(path, spec([false, false], 'landing', 'Track-1: Upload everything.', ['none', '1']))
    children.finish('landing:1')
    await running
    expect(messages.join('\n')).toContain('Frozen ## Main Track')
    expect(children.created.map(row => row.graphKey)).toEqual(['landing:1'])
  })

  it('uses the unblocked ticket for Mission Contract action mapping without an Active Ticket parent turn', async () => {
    const { ship, path, children } = fixture([false, false], {
      blockers: ['none', '1'],
    })
    const base = spec([false, false], 'landing', 'Track-1: Offline only.\nTrack-2: Local format.', ['none', '1'])
    const first = '- [ ] Ticket 1: Capability 1 (Blocked by: none) (Track: 1)'
    const second = '- [ ] Ticket 2: Capability 2 (Blocked by: 1) (Track: 1)'
    writeFileSync(path, base.replace(`${first}\n${second}`, `${second.replace('(Track: 1)', '(Track: 2)')}\n${first}`))
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.length === 1)
    expect(children.created.map(row => row.graphKey)).toEqual(['landing:1'])
    expect(ship.alignTool('write', { file_path: 'src/export.ts' }).supportsRequirement).toBe('REQ-001')
    expect(ship.alignTool('write', { file_path: 'src/export.ts', supports: ['REQ-002'] }).allow).toBe(false)
    expect(ship.alignTool('write', { file_path: path, content: base.replace(original, 'Upload files.') }).allow).toBe(false)
    ship.abort()
    await running
  })

  it('requires acceptance evidence in the independent final verification turn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-landing-'))
    roots.push(cwd)
    mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
    const path = join(cwd, 'docs', 'specs', 'exports.md')
    const ledger = (done: boolean, status = 'landing', proof = false) => spec([done], status)
      .replace('Run pnpm test; exit 0.', '1. `pnpm test` exits 0.')
      + (proof ? '\n## Verification\n\n- ACC-001: `pnpm test` exit 0\n' : '')
    writeFileSync(path, ledger(true))
    const messages: string[] = []
    const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} }, {
      flash: text => { messages.push(text) },
    })
    const prompts: string[] = []
    await ship.run('', async prompt => {
      prompts.push(prompt)
      expect(prompt).toContain('This turn is final verification only')
      expect(prompt).not.toMatch(/Active Ticket:/)
      expect(ship.alignTool('write', { file_path: path, content: ledger(true, 'shipped') }).allow).toBe(false)
      writeFileSync(path, ledger(true, 'shipped'))
    })
    expect(prompts).toHaveLength(1)
    expect(ship.verifyVerdict?.satisfied).toBe(false)
    expect(messages.join('\n')).toContain('Delivery blocked')
    await ship.run('', async prompt => {
      if (prompt.includes('This turn is final verification only')) writeFileSync(path, ledger(true, 'shipped', true))
      else writeFileSync(path, ledger(true))
    })
    expect(ship.verifyVerdict?.satisfied).toBe(true)
  })

  it('keeps dependencies and Track metadata while choosing an unblocked ticket', () => {
    const plan = landingPlan('## Plan\n\n- [ ] Ticket 2: downstream (Blocked by: 1) (Track: 2)\n- [ ] Ticket 1: upstream (Blocked by: none) (Track: 1)\n')
    expect(plan.active?.id).toBe('1')
    expect(plan.tickets[0]?.blockers).toEqual(['1'])
    expect(plan.active?.contract).toContain('(Track: 1)')
    expect(landingPlan('## Plan\n\n- [ ] Ticket 1: broken (Blocked by: 2)\n').error).toContain('Unknown')
  })
})
