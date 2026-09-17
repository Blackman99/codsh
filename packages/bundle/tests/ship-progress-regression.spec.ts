import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShipRun, type WebPanoramaBindRequest } from '../src/ship-run.ts'
import { graphPathFor } from '../src/ship-graph.ts'
import { snapshotPathFor } from '../src/ship-snapshot.ts'
import { shipPromptFor } from '../src/ship.ts'
import type { Plan } from '../src/plan.ts'
import type { ShipChip } from '../src/status.ts'

const chrome = { setPlan: () => {}, setChip: () => {} }
const roots: string[] = []
function workspace(): { cwd: string; path: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'ship-progress-'))
  roots.push(cwd)
  const path = join(cwd, 'docs', 'specs', 'widget.md')
  mkdirSync(dirname(path), { recursive: true })
  return { cwd, path }
}

const original = '## Original Requirement\n\nBuild a widget.'
const track = '## Main Track\n\n**Idea.** Build a widget.\n**Track-1.** Show the widget.'
const acceptance = '## Acceptance Criteria\n\n1. `pnpm test` exits 0.'

afterEach(() => {
  vi.useRealTimers()
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true })
})

describe('ship progress regressions', () => {
  it('retires completed ship chrome and guards without losing the final graph', async () => {
    vi.useFakeTimers()
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: landing\n\n${original}\n\n${track}\n\n## Plan\n\n- [x] Ticket 1: Widget (Track: 1) (Blocked by: none)\n`)
    const setPlan = vi.fn()
    const setTeaser = vi.fn()
    const setGraph = vi.fn()
    const ship = new ShipRun(cwd, { setPlan, setChip: () => {}, setTeaser, setGraph })
    await ship.run('', async () => {
      writeFileSync(path, readFileSync(path, 'utf8').replace('Status: landing', 'Status: shipped'))
      ship.noteWritten([path])
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(ship.shipPlan).toBeUndefined()
    expect(ship.shipChip).toBeUndefined()
    expect(ship.shipTeaser).toBeUndefined()
    expect(setPlan).toHaveBeenLastCalledWith(undefined)
    expect(setTeaser).toHaveBeenLastCalledWith(undefined, 0)
    expect(setGraph).toHaveBeenLastCalledWith(undefined, 0)
    expect(ship.shipGraph?.nodes).toContainEqual(expect.objectContaining({ id: 'landing:1', claim: 'closed' }))
    expect(ship.missionContract).toBeUndefined()
    const graph = readFileSync(graphPathFor(path), 'utf8')
    ship.refresh()
    ship.noteWritten([join(cwd, 'unrelated.md')])
    await vi.advanceTimersByTimeAsync(1_100)
    expect(setTeaser).toHaveBeenLastCalledWith(undefined, 0)
    expect(readFileSync(graphPathFor(path), 'utf8')).toBe(graph)
  })

  it.each(['abort', 'throw', 'blocker', 'evidence'] as const)('keeps unfinished chrome and guards after %s', async outcome => {
    vi.useFakeTimers()
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: landing\n\n${original}\n\n${track}\n\n${outcome === 'evidence' ? acceptance : ''}\n\n## Plan\n\n- [x] Ticket 1: Widget (Track: 1) (Blocked by: none)\n`)
    const complete = vi.fn()
    const ship = new ShipRun(cwd, { ...chrome, complete })
    const running = ship.run('', async () => {
      if (outcome === 'abort') ship.abort()
      else if (outcome === 'throw') throw new Error('turn failed')
      else writeFileSync(path, readFileSync(path, 'utf8').replace('Status: landing', 'Status: shipped')
        + (outcome === 'blocker' ? '\n## Blocker\n\nDelivery unresolved.\n' : ''))
    })
    if (outcome === 'throw') await expect(running).rejects.toThrow('turn failed')
    else await running
    await vi.advanceTimersByTimeAsync(1_100)
    expect(complete).not.toHaveBeenCalled()
    expect(ship.shipTeaser).toBeDefined()
    expect(ship.missionContract).toBeDefined()
    if (outcome === 'evidence') {
      expect(ship.shipPlan?.done).toBe(0)
      expect(readFileSync(path, 'utf8')).toContain('Status: landing')
    }
  })

  it('keeps following plan ticks after a mid-run interrupt without another /ship', async () => {
    vi.useFakeTimers()
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: landing\n\n${original}\n\n${track}\n\n## Plan\n\n- [x] Ticket 1: Widget (Track: 1) (Blocked by: none)\n- [ ] Ticket 2: Second (Track: 1) (Blocked by: none)\n`)
    const plans: Array<Plan | undefined> = []
    const chips: Array<ShipChip | undefined> = []
    const ship = new ShipRun(cwd, {
      setPlan: plan => { plans.push(plan) },
      setChip: chip => { chips.push(chip) },
    })
    await ship.run('', async () => { ship.abort() })
    expect(ship.shipPlan?.done).toBe(1)
    expect(ship.shipChip).toEqual({ kind: 'land', k: 1, n: 2 })
    writeFileSync(path, readFileSync(path, 'utf8').replace('- [ ] Ticket 2:', '- [x] Ticket 2:'))
    await vi.advanceTimersByTimeAsync(1_100)
    expect(ship.shipPlan?.done).toBe(2)
    expect(ship.shipChip).toEqual({ kind: 'verify' })
    expect(plans.at(-1)?.done).toBe(2)
    expect(chips.at(-1)).toEqual({ kind: 'verify' })
  })

  it('keeps following plan ticks after /ship idles on unfinished landing', async () => {
    vi.useFakeTimers()
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: landing\n\n${original}\n\n${track}\n\n## Plan\n\n- [x] Ticket 1: Widget (Track: 1) (Blocked by: none)\n- [ ] Ticket 2: Second (Track: 1) (Blocked by: none)\n`)
    const ship = new ShipRun(cwd, chrome)
    await ship.run('', async () => {})
    expect(ship.shipPlan?.done).toBe(1)
    writeFileSync(path, readFileSync(path, 'utf8').replace('- [ ] Ticket 2:', '- [x] Ticket 2:'))
    await vi.advanceTimersByTimeAsync(1_100)
    expect(ship.shipPlan?.done).toBe(2)
    expect(ship.shipChip).toEqual({ kind: 'verify' })
  })

  it('does not start a spec poll from abort before any /ship', async () => {
    vi.useFakeTimers()
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: landing\n\n${original}\n\n${track}\n\n## Plan\n\n- [x] Ticket 1: Widget (Track: 1) (Blocked by: none)\n- [ ] Ticket 2: Second (Track: 1) (Blocked by: none)\n`)
    const ship = new ShipRun(cwd, chrome)
    ship.abort()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(ship.shipPlan).toBeUndefined()
    expect(ship.shipChip).toBeUndefined()
  })

  it('waits for merge-back and starts the next ship with fresh chrome', async () => {
    vi.useFakeTimers()
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: landing\nBranch: ship/widget\nOriginal-Branch: main\n\n${original}\n\n${track}\n\n## Plan\n\n- [x] Ticket 1: Widget (Track: 1) (Blocked by: none)\n`)
    let finishMerge!: () => void
    const merge = new Promise<void>(resolve => { finishMerge = resolve })
    const started = vi.fn()
    const complete = vi.fn()
    const ship = new ShipRun(cwd, { ...chrome, complete }, {
      git: async args => {
        if (args[0] === 'merge') { started(); await merge }
        return { code: 0, output: '' }
      },
    })
    const run = ship.run('', async () => {
      writeFileSync(path, readFileSync(path, 'utf8').replace('Status: landing', 'Status: shipped'))
      ship.noteWritten([path])
    })
    await vi.waitFor(() => { expect(started).toHaveBeenCalled() })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(complete).not.toHaveBeenCalled()
    expect(ship.shipTeaser).toBeDefined()
    finishMerge()
    await run
    expect(complete).toHaveBeenCalledOnce()
    expect(ship.shipTeaser).toBeUndefined()
    const next = join(dirname(path), 'next.md')
    writeFileSync(next, 'Status: wayfinding\n\n## Original Requirement\n\nBuild another widget.\n')
    await ship.run('', async () => {
      await vi.advanceTimersByTimeAsync(1_100)
      expect(ship.shipChip).toEqual({ kind: 'wayfinder' })
      expect(ship.shipTeaser).toBeDefined()
    })
    expect(complete).toHaveBeenCalledOnce()
  })

  it('specifies the local decision filename and metadata contract to Wayfinder', () => {
    const prompt = shipPromptFor('wayfinding')
    expect(prompt).toContain('NN-slug.md')
    expect(prompt).toContain('Type: research|prototype|grilling|task')
    expect(prompt).toContain('Status: open|claimed|resolved')
    expect(prompt).toContain('comma-separated local ticket integers')
  })

  it('continues through both gates when Main Track first appears at Confirm', async () => {
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: interviewing\n\n${original}\n`)
    const flashes: string[] = []
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await ship.run('', async prompt => {
      prompts.push(prompt)
      if (prompt.includes('Pure Synthesis, Zero Interrogation')) {
        writeFileSync(path, `Status: interviewing\n\n${original}\n\n${track}\n\n${acceptance}\n`)
        expect(ship.confirmGate(1)).toBe(true)
      } else if (prompt.includes('Strict Vertical Tracer Slicing')) {
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n## Plan\n\n- [ ] Ticket 1: Widget (Track: 1) (Blocked by: none)\n`)
        expect(ship.confirmGate(2)).toBe(true)
      } else {
        ship.abort()
      }
    })
    expect(flashes.filter(text => /snapshot is missing or changed/i.test(text))).toEqual([])
    expect(prompts).toHaveLength(3)
    expect(prompts[2]).toContain('Strict Red-First Execution')
    expect(JSON.parse(readFileSync(snapshotPathFor(path), 'utf8'))).toMatchObject({
      mainTrack: track,
      trackSealed: true,
      acceptanceCriteria: '1. `pnpm test` exits 0.',
    })
  })

  it('resumes the same run after sealing and ignores JSON key order', async () => {
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: interviewing\n\n${original}\n`)
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await ship.run('', async () => {
      writeFileSync(path, `Status: interviewing\n\n${original}\n\n${track}\n\n${acceptance}\n`)
      expect(ship.confirmGate(1)).toBe(true)
      ship.abort()
    })
    const sidecar = snapshotPathFor(path)
    const snapshot = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>
    writeFileSync(sidecar, JSON.stringify(Object.fromEntries(Object.entries(snapshot).reverse())))
    const prompts: string[] = []
    await ship.run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Strict Vertical Tracer Slicing')
    expect(flashes.some(text => /snapshot is missing or changed/i.test(text))).toBe(false)
  })

  it.each(['missing', 'changed', 'corrupt'] as const)('still stops when a known snapshot is %s', async change => {
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: confirmed\n\n${original}\n\n${track}\n\n${acceptance}\n`)
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    let turns = 0
    await ship.run('', async () => {
      turns += 1
      const sidecar = snapshotPathFor(path)
      if (change === 'missing') rmSync(sidecar)
      else if (change === 'corrupt') writeFileSync(sidecar, '{bad JSON')
      else {
        const snapshot = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>
        writeFileSync(sidecar, JSON.stringify({ ...snapshot, originalRequirement: 'A different request.' }))
      }
    })
    expect(turns).toBe(1)
    expect(flashes.some(text => /snapshot is missing or changed/i.test(text))).toBe(true)
  })

  it.each(['open', 'closed'] as const)('reclaims decision-prefixed files without reopening a %s ticket or duplicating Status', async status => {
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: wayfinding\nBranch: ship/widget\n\n${original}\n`)
    const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(cwd, '.scratch', 'widget', 'worktrees', 'decision-1'), { recursive: true })
    const ticket = join(dir, 'decision-01-facts.md')
    writeFileSync(ticket, `# Facts\n\n- **Status**: ${status}\n- **Type**: wayfinder:research\n`)
    const ship = new ShipRun(cwd, chrome)
    await ship.run('', async () => {})
    expect(ship.shipGraph?.nodes[0]).toMatchObject({
      id: 'decision:local:1', claim: status === 'closed' ? 'closed' : 'claimed', ticketType: 'research',
    })
    const text = readFileSync(ticket, 'utf8')
    expect(text.match(/Status/g)).toHaveLength(1)
    expect(text).toContain(status === 'closed' ? '- **Status**: closed' : 'Status: claimed')
  })

  it('preserves status and type parsing when plain metadata has trailing notes', async () => {
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: wayfinding\nBranch: ship/widget\n\n${original}\n`)
    const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '01-facts.md'), '# Facts\nStatus: resolved (see evidence)\nType: research (read-only)\n')
    const ship = new ShipRun(cwd, chrome)
    await ship.run('', async () => {})
    expect(ship.shipGraph?.nodes[0]).toMatchObject({ claim: 'closed', ticketType: 'research' })
  })

  it('rejects duplicate decision identities across both filename forms', async () => {
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: wayfinding\nBranch: ship/widget\n\n${original}\n`)
    const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '01-facts.md'), '# Facts\nStatus: open\n')
    writeFileSync(join(dir, 'decision-01-engine.md'), '# Engine\nStatus: open\n')
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    let turns = 0
    await ship.run('', async () => { turns += 1 })
    expect(turns).toBe(0)
    expect(flashes.some(text => /Duplicate decision key decision:local:1/.test(text))).toBe(true)
  })

  it('dispatches a formatted research ticket only after its dependency closes', async () => {
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: wayfinding\nBranch: ship/widget\n\n${original}\n`)
    const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
    mkdirSync(dir, { recursive: true })
    const blocker = join(dir, 'decision-01-perspective.md')
    writeFileSync(blocker, '# Perspective\n- **Status**: Open\n- **Type**: wayfinder:grilling\n')
    writeFileSync(join(dir, 'decision-02-facts.md'), '# Facts\n- **Status**: Claimed\n- **Type**: wayfinder:research\n- **Blocked by**: 1\n')
    const dispatched: string[] = []
    const ship = new ShipRun(cwd, chrome, {
      childCreate: { async create(request) {
        dispatched.push(request.graphKey)
        return { id: 'research-child', graphKey: request.graphKey, label: request.label, async dispose() {} }
      } },
    })
    await ship.run('', async () => { expect(dispatched).toEqual([]) })
    writeFileSync(blocker, readFileSync(blocker, 'utf8').replace('Open', 'Closed'))
    await ship.run('', async () => {})
    expect(dispatched).toEqual(['decision:local:2'])
    await ship.releaseChild('research-child')
  })

  it('updates the same live web graph for each generated decision ticket during a turn', async () => {
    vi.useFakeTimers()
    const { cwd, path } = workspace()
    writeFileSync(path, `Status: wayfinding\nBranch: ship/widget\n\n${original}\n\n## Wayfinder\n\n[Map](../../.scratch/widget/wayfinder/map.md)\n`)
    let request: WebPanoramaBindRequest | undefined
    const ship = new ShipRun(cwd, chrome, {
      bind: async value => {
        request = value
        return { url: 'http://127.0.0.1:12345', close() {} }
      },
    })
    try {
      await ship.run('', async () => {
        expect(request?.graph()?.nodes).toEqual([])
        const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
        mkdirSync(dir, { recursive: true })
        const first = join(dir, 'decision-01-perspective.md')
        writeFileSync(first, '# [wayfinder:grilling] Choose perspective\n\n- **Status**: Open\n- **Type**: wayfinder:grilling\n')
        ship.noteWritten([first])
        expect(request?.graph()?.nodes).toEqual([
          expect.objectContaining({ id: 'decision:local:1', claim: 'unclaimed', ticketType: 'grilling' }),
        ])
        const second = join(dir, '02-engine.md')
        writeFileSync(second, '# Choose engine\n\nType: prototype\nStatus: open\nBlocked by: 1\n')
        await vi.advanceTimersByTimeAsync(1_000)
        expect(request?.graph()?.nodes).toHaveLength(2)
        expect(request?.graph()?.edges).toContainEqual({ from: 'decision:local:2', to: 'decision:local:1', kind: 'blocked-by' })
        writeFileSync(first, readFileSync(first, 'utf8').replace('Status**: Open', 'Status**: Closed'))
        ship.noteWritten([first])
        expect(request?.graph()?.nodes.find(node => node.id === 'decision:local:1')?.claim).toBe('closed')
        expect(ship.shipTeaser).toEqual({ unclaimed: 1, claimed: 0, closed: 1 })
        expect(JSON.parse(readFileSync(graphPathFor(path), 'utf8'))).toEqual(request?.graph())
        ship.abort()
      })
    } finally {
      ship.closeWebPanorama()
    }
  })
})
