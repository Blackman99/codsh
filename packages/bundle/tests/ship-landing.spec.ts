/** Landing wave: parallel worktrees, Ready-set drain, no parent turn-budget. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ShipRun, type ShipChildHandle, type ShipGit } from '../src/ship-run.ts'
import {
  cascadeClosedDependents,
  dispatchedDependents,
  landingPlan,
  landingWavePrepend,
  proofSweepCommitMessage,
  readySet,
  sweepBlockerBody,
  sweepProofTargets,
  writeBlockerSection,
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

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve = (): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<void>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function waveChildren() {
  const created: Array<{ id: string; graphKey: string; cwd?: string; prompt: string; role?: 'conflict' | 'repair' }> = []
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; handle: ShipChildHandle }>()
  return {
    created,
    pending,
    finish(graphKey: string) { pending.get(graphKey)?.resolve() },
    fail(graphKey: string, error = new Error('timeout')) { pending.get(graphKey)?.reject(error) },
    async create(request: {
      graphKey: string
      label: string
      prompt: string
      cwd?: string
      role?: 'conflict' | 'repair'
    }): Promise<ShipChildHandle> {
      const wait = deferred()
      const id = `child-${String(created.length + 1)}`
      created.push({
        id,
        graphKey: request.graphKey,
        prompt: request.prompt,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.role === undefined ? {} : { role: request.role }),
      })
      const handle: ShipChildHandle = {
        id,
        graphKey: request.graphKey,
        label: request.label,
        ...(request.role === undefined ? {} : { role: request.role }),
        done: wait.promise,
        async dispose() {},
      }
      pending.set(request.graphKey, { resolve: wait.resolve, reject: wait.reject, handle })
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
    prove?: (ticket: { id: string; contract: string; kind: 'sweep' | 'land' }) => Promise<'green' | 'red'>
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
    writeIssue(
      cwd,
      index + 1,
      `Capability ${index + 1}`,
      done ? 'Claim: claimed\nProof: green\n' : '',
    )
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

describe('proof sweep helpers', () => {
  it('sweeps currently-已关闭 plus already-landed 已认领 whose blockers are 已关闭', () => {
    const t1 = { ...ticket('1'), done: true }
    const t2 = ticket('2', ['1'])
    const t3 = ticket('3')
    const t4 = ticket('4')
    const view: LandingWaveView = {
      tickets: [t1, t2, t3, t4],
      claimed: new Set(['1', '2', '3', '4']),
      inFlight: new Set(['3']),
      finished: new Set(['2']),
      worktrees: new Set(['2', '3']),
    }
    expect(sweepProofTargets(view).map(row => row.id)).toEqual(['1', '4'])
  })

  it('unticks already-closed DAG dependents of a failed sibling, not every later-N', () => {
    const t1 = { ...ticket('1'), done: true }
    const t2 = { ...ticket('2', ['1']), done: true }
    const t3 = { ...ticket('3'), done: true }
    expect(cascadeClosedDependents([t1, t2, t3], new Set(['1']))).toEqual(['2'])
    expect(dispatchedDependents([t1, t2, t3], new Set(['1']), new Set(['2', '3']))).toEqual(['2'])
  })

  it('writes one ledger commit that lists every ticket that failed this sweep', () => {
    const t1 = ticket('1')
    const t2 = { ...ticket('2'), done: true }
    const body = sweepBlockerBody([t2, t1])
    expect(body).toContain('Ticket 1:')
    expect(body).toContain('Ticket 2:')
    expect(proofSweepCommitMessage(t1, [t2])).toContain('ship: tick Ticket 1')
    expect(proofSweepCommitMessage(undefined, [t1, t2])).toBe(`ship: proof sweep\n\n${body}`)
    const next = writeBlockerSection('Status: landing\n\n## Plan\n\n- [x] Ticket 1: a\n', body)
    expect(next).toMatch(/^## Blocker$/m)
    expect(next).toContain('Ticket 1:')
    expect(writeBlockerSection(next, undefined)).not.toMatch(/^## Blocker$/m)
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
    expect(ship.inFlight).toBe(true)
    expect(ship.liveChildren).toHaveLength(2)
    ship.abort()
    await running
  })

  it('dispatches sibling dependents of one closed ticket together even when later-N restates the chain', async () => {
    const { ship, children, git } = fixture([true, false, false, false], {
      blockers: ['none', '1', '1, 2', '1, 2, 3'],
    })
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.length === 3)
    expect(children.created.map(row => row.graphKey).sort()).toEqual([
      'landing:2',
      'landing:3',
      'landing:4',
    ])
    expect(git.log.some(entry => entry.includes('worktree add -B wt/exports/landing-2'))).toBe(true)
    expect(git.log.some(entry => entry.includes('worktree add -B wt/exports/landing-3'))).toBe(true)
    expect(git.log.some(entry => entry.includes('worktree add -B wt/exports/landing-4'))).toBe(true)
    ship.abort()
    await running
  })

  it('serializes git worktree add while still creating a child per sibling ticket', async () => {
    let concurrent = 0
    let peak = 0
    const base = recordingGit()
    const git: ReturnType<typeof recordingGit> = Object.assign(
      async (args: readonly string[], cwd: string) => {
        if (args[0] === 'worktree' && args[1] === 'add') {
          concurrent += 1
          peak = Math.max(peak, concurrent)
          await new Promise<void>(resolve => { setTimeout(resolve, 15) })
          concurrent -= 1
        }
        return base(args, cwd)
      },
      { log: base.log },
    )
    const { ship, children } = fixture([false, false], { blockers: ['none', 'none'], git })
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.length === 2)
    expect(peak).toBe(1)
    expect(children.created.map(row => row.graphKey).sort()).toEqual(['landing:1', 'landing:2'])
    ship.abort()
    await running
  })

  it('keeps run() in flight while a landing child is unfinished and reports in-flight on the teaser', async () => {
    const teasers: Array<{ counts: { unclaimed: number; claimed: number; closed: number } | undefined; inFlight?: number }> = []
    const busy: boolean[] = []
    const { path, cwd, children, git } = fixture([false, false], { blockers: ['none', '1'] })
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: () => {},
      setTeaser: (counts, inFlight) => {
        teasers.push(inFlight === undefined ? { counts } : { counts, inFlight })
      },
    }, {
      childCreate: children,
      git,
      busy: active => { busy.push(active) },
    })
    let finished = false
    const running = ship.run('', async () => {}).then(() => { finished = true })
    await waitUntil(() => children.created.length === 1)
    await new Promise(resolve => { setTimeout(resolve, 20) })
    ship.refresh()
    expect(finished).toBe(false)
    expect(ship.inFlight).toBe(true)
    expect(ship.liveChildren).toHaveLength(1)
    expect(teasers.some(row => (row.inFlight ?? 0) > 0)).toBe(true)
    expect(busy.includes(true)).toBe(true)
    expect(children.created[0]?.prompt).toContain('Strict Red-First Execution')
    expect(readFileSync(path, 'utf8')).toMatch(/- \[ \] Ticket 1:/u)
    ship.abort()
    await running
    expect(finished).toBe(true)
    expect(busy.at(-1)).toBe(false)
  })

  it('keeps run() in flight when a landing child has no done promise', async () => {
    const created: string[] = []
    const { cwd, git } = fixture([false], { blockers: ['none'] })
    const children: ReturnType<typeof waveChildren> = {
      created: [],
      pending: new Map(),
      finish() {},
      fail() {},
      async create(request) {
        created.push(request.graphKey)
        return {
          id: `child-${request.graphKey}`,
          graphKey: request.graphKey,
          label: request.label,
          async dispose() {},
        }
      },
    }
    const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} }, {
      childCreate: children,
      git,
    })
    let finished = false
    const running = ship.run('', async () => {}).then(() => { finished = true })
    await waitUntil(() => created.length === 1)
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(finished).toBe(false)
    expect(ship.inFlight).toBe(true)
    expect(ship.liveChildren).toHaveLength(1)
    ship.abort()
    await running
    expect(finished).toBe(true)
  })

  it('does not invent a worktree directory or dispatch when git worktree add fails', async () => {
    const messages: string[] = []
    const { cwd, children } = fixture([false], { blockers: ['none'] })
    const git = recordingGit()
    const original = git as ReturnType<typeof recordingGit>
    const failing: ReturnType<typeof recordingGit> = Object.assign(
      async (args: readonly string[], workCwd: string) => {
        if (args[0] === 'worktree' && args[1] === 'add') return { code: 128, output: "fatal: invalid reference: HEAD\n" }
        return original(args, workCwd)
      },
      { log: original.log },
    )
    const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} }, {
      flash: text => { messages.push(text) },
      childCreate: children,
      git: failing,
    })
    await ship.run('', async () => {})
    expect(children.created).toHaveLength(0)
    expect(existsSync(join(cwd, '.scratch', 'exports', 'worktrees', 'landing-1'))).toBe(false)
    expect(messages.join('\n')).toMatch(/worktree|HEAD/i)
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

  it('aligns tool calls from parallel subagents with their respective tickets', async () => {
    const { ship, path, children } = fixture([false, false], {
      blockers: ['none', 'none'],
    })
    const base = spec([false, false], 'landing', 'Track-1: Offline only.\nTrack-2: Local format.', ['none', 'none'])
    const second = '- [ ] Ticket 2: Capability 2 (Blocked by: none) (Track: 2)'
    writeFileSync(path, base.replace('- [ ] Ticket 2: Capability 2 (Blocked by: none) (Track: 1)', second))
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.length === 2)
    const child1 = children.created.find(c => c.graphKey === 'landing:1')!
    const child2 = children.created.find(c => c.graphKey === 'landing:2')!
    expect(child1).toBeDefined()
    expect(child2).toBeDefined()
    expect(ship.alignTool('write', { file_path: 'src/export1.ts', supports: ['REQ-001'] }, { agentSessionId: child1.id }).allow).toBe(true)
    expect(ship.alignTool('write', { file_path: 'src/export1.ts', supports: ['REQ-002'] }, { agentSessionId: child1.id }).allow).toBe(false)
    expect(ship.alignTool('write', { file_path: 'src/export2.ts', supports: ['REQ-002'] }, { agentSessionId: child2.id }).allow).toBe(true)
    expect(ship.alignTool('write', { file_path: 'src/export2.ts', supports: ['REQ-001'] }, { agentSessionId: child2.id }).allow).toBe(false)
    expect(ship.alignTool('write', { file_path: 'src/export1.ts' }, { agentSessionId: child1.id }).supportsRequirement).toBe('REQ-001')
    expect(ship.alignTool('write', { file_path: 'src/export2.ts' }, { agentSessionId: child2.id }).supportsRequirement).toBe('REQ-002')
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

  it('drops a numbered chain so siblings of one closed ticket are unblocked together', () => {
    const plan = landingPlan([
      '## Plan',
      '',
      '- [x] Ticket 1: Engine (Blocked by: none) (Track: 1)',
      '- [ ] Ticket 2: Audio (Blocked by: 1) (Track: 1)',
      '- [ ] Ticket 3: Arsenal (Blocked by: 1, 2) (Track: 1)',
      '- [ ] Ticket 4: AI (Blocked by: 1, 2, 3) (Track: 1)',
      '- [ ] Ticket 5: Mission (Blocked by: 2, 3) (Track: 1)',
    ].join('\n'))
    expect(plan.tickets.find(ticket => ticket.id === '2')?.blockers).toEqual(['1'])
    expect(plan.tickets.find(ticket => ticket.id === '3')?.blockers).toEqual(['1'])
    expect(plan.tickets.find(ticket => ticket.id === '4')?.blockers).toEqual(['1'])
    expect(plan.tickets.find(ticket => ticket.id === '5')?.blockers).toEqual(['2', '3'])
    expect(plan.error).toBeUndefined()
  })

  it('after a Tick, a sibling 已关闭 that fails is unticked with Proof: red, Claim kept, and closed DAG dependents untick without rewriting Last proof', async () => {
    const prove = async (ticket: { id: string; kind: 'sweep' | 'land' }): Promise<'green' | 'red'> => {
      if (ticket.id === '1' && ticket.kind === 'land') return 'green'
      if (ticket.id === '2') return 'red'
      return 'green'
    }
    const { ship, path, cwd, children, git } = fixture([true, true, true, false], {
      blockers: ['none', 'none', '2', 'none'],
      prove,
    })
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.length === 1)
    expect(children.created.map(row => row.graphKey)).toEqual(['landing:4'])
    children.finish('landing:4')
    await running
    const markdown = readFileSync(path, 'utf8')
    expect(markdown).toMatch(/- \[x\] Ticket 1:/u)
    expect(markdown).toMatch(/- \[ \] Ticket 2:/u)
    expect(markdown).toMatch(/- \[ \] Ticket 3:/u)
    expect(markdown).toMatch(/- \[x\] Ticket 4:/u)
    expect(markdown).toMatch(/^## Blocker$/m)
    expect(markdown).toContain('Ticket 2:')
    const issue2 = readFileSync(join(cwd, '.scratch', 'exports', 'issues', '02-capability-2.md'), 'utf8')
    expect(issue2).toMatch(/^Claim:\s*claimed\b/mu)
    expect(issue2).toMatch(/^Proof:\s*red\b/mu)
    const issue3 = readFileSync(join(cwd, '.scratch', 'exports', 'issues', '03-capability-3.md'), 'utf8')
    expect(issue3).toMatch(/^Proof:\s*green\b/mu)
    expect(issue3).toMatch(/^Claim:\s*claimed\b/mu)
    const tickCommits = git.log.filter(entry => entry.includes('commit -m') && /tick Ticket 4|proof sweep/.test(entry))
    expect(tickCommits).toHaveLength(1)
  })

  it('freezes new dispatch and further serial merges on a Blocker while in-flight independents finish as leftover 已认领', async () => {
    const prove = async (ticket: { id: string; kind: 'sweep' | 'land' }): Promise<'green' | 'red'> => (
      ticket.id === '1' && ticket.kind === 'land' ? 'red' : 'green'
    )
    const { ship, path, cwd, children, git } = fixture([false, false, false], {
      blockers: ['none', 'none', 'none'],
      prove,
    })
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.length === 3)
    children.finish('landing:1')
    await waitUntil(() => git.log.some(entry => entry.includes('merge --no-ff') && /Ticket 1/.test(entry)))
    await waitUntil(() => readFileSync(path, 'utf8').includes('## Blocker'))
    expect(children.created).toHaveLength(3)
    expect(git.log.filter(entry => entry.includes('merge --no-ff'))).toHaveLength(1)
    children.finish('landing:2')
    await new Promise(resolve => { setTimeout(resolve, 40) })
    expect(git.log.filter(entry => entry.includes('merge --no-ff'))).toHaveLength(1)
    expect(existsSync(join(cwd, '.scratch', 'exports', 'worktrees', 'landing-2'))).toBe(true)
    expect(readFileSync(join(cwd, '.scratch', 'exports', 'issues', '02-capability-2.md'), 'utf8')).toMatch(/^Claim:\s*claimed\b/mu)
    expect(children.created.map(row => row.graphKey).sort()).toEqual(['landing:1', 'landing:2', 'landing:3'])
    ship.abort()
    await running
  })

  it('drops already-dispatched dependents of an unticked ancestor, keeping Claim and the same landing-N names', async () => {
    const prove = async (ticket: { id: string }): Promise<'green' | 'red'> => (ticket.id === '1' ? 'red' : 'green')
    const { ship, cwd, children, git } = fixture([false, false], {
      blockers: ['none', '1'],
      prove,
    })
    mkdirSync(join(cwd, '.scratch', 'exports', 'worktrees', 'landing-2'), { recursive: true })
    writeIssue(cwd, 2, 'Capability 2', 'Claim: claimed\n')
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.some(row => row.graphKey === 'landing:1'))
    children.finish('landing:1')
    await running
    expect(existsSync(join(cwd, '.scratch', 'exports', 'worktrees', 'landing-2'))).toBe(false)
    expect(readFileSync(join(cwd, '.scratch', 'exports', 'issues', '02-capability-2.md'), 'utf8')).toMatch(/^Claim:\s*claimed\b/mu)
    expect(git.log.some(entry => /worktree remove/.test(entry) && /landing-2/.test(entry))).toBe(true)
    expect(git.log.some(entry => /branch -D wt\/exports\/landing-2/.test(entry))).toBe(true)
    expect(children.created.every(row => row.graphKey !== 'landing:2')).toBe(true)
  })

  it('resumes an unticked keep-commit as In-place repair on the parent cwd with no second land merge', async () => {
    const { path, cwd, children, git, messages } = fixture([false, false], {
      blockers: ['none', 'none'],
    })
    writeIssue(cwd, 1, 'Capability 1', 'Claim: claimed\nProof: red\n')
    writeFileSync(path, spec([false, false], 'landing', 'Track-1: Offline only.', ['none', 'none']))
    const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} }, {
      flash: text => { messages.push(text) },
      childCreate: children,
      git,
    })
    const running = ship.run('', async () => {})
    await waitUntil(() => children.created.some(row => row.role === 'repair'))
    const repair = children.created.find(row => row.role === 'repair')
    expect(repair?.graphKey).toBe('landing:1')
    expect(repair?.cwd === undefined || repair?.cwd === cwd).toBe(true)
    expect(git.log.some(entry => entry.includes('merge --no-ff'))).toBe(false)
    expect(children.created.every(row => row.graphKey !== 'landing:2' || row.role === 'repair')).toBe(true)
    children.finish('landing:1')
    await waitUntil(() => git.log.some(entry => /tick Ticket 1/.test(entry)))
    expect(git.log.filter(entry => entry.includes('merge --no-ff'))).toHaveLength(0)
    expect(readFileSync(path, 'utf8')).toMatch(/- \[x\] Ticket 1:/u)
    ship.abort()
    await running
  })

  it('interrupts In-place repair with reset --hard and no Blocker; crash snapshots, restores, and writes a Blocker', async () => {
    const { path, cwd, messages } = fixture([false], { blockers: ['none'] })
    writeIssue(cwd, 1, 'Capability 1', 'Claim: claimed\nProof: red\n')
    writeFileSync(path, spec([false], 'landing', 'Track-1: Offline only.', ['none']))
    const interruptGit = recordingGit()
    const interruptChildren = waveChildren()
    const interrupt = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} }, {
      flash: text => { messages.push(text) },
      childCreate: interruptChildren,
      git: interruptGit,
    })
    const running = interrupt.run('', async () => {})
    await waitUntil(() => interruptChildren.created.some(row => row.role === 'repair'))
    interrupt.abort()
    await running
    expect(interruptGit.log.some(entry => entry.includes('reset --hard'))).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toMatch(/^## Blocker$/m)

    const crashGit = recordingGit()
    const crashChildren = waveChildren()
    const crashMessages: string[] = []
    const crash = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} }, {
      flash: text => { crashMessages.push(text) },
      childCreate: crashChildren,
      git: crashGit,
    })
    const crashing = crash.run('', async () => {})
    await waitUntil(() => crashChildren.created.some(row => row.role === 'repair'))
    crashChildren.fail('landing:1')
    await crashing
    expect(crashGit.log.some(entry => entry.includes('reset --hard'))).toBe(true)
    expect(readFileSync(path, 'utf8')).toMatch(/^## Blocker$/m)
    expect(existsSync(join(cwd, '.scratch', 'exports', 'merge-snapshots'))).toBe(true)
  })
})
