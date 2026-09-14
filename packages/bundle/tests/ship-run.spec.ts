/**
 * One `/ship` run: chrome and phase injection through the public seam only.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShipRun, wrapHostGoals } from '../src/ship-run.ts'
import { snapshotPathFor } from '../src/ship-snapshot.ts'
import { graphPathFor } from '../src/ship-graph.ts'
import type { TeaserCounts } from '../src/ship-graph.ts'
import type { Plan } from '../src/plan.ts'
import type { SelectOutcome, SelectSpec } from '../src/selector.ts'
import type { ShipChip } from '../src/status.ts'
import type { HostGoalsService, HostGoalView, ShipGoal, ShipGoals } from '../src/ship-run.ts'

const chrome = { setPlan: () => {}, setChip: () => {} }

/** A recording goals port the occupancy tests inject. */
const recordingGoals = (initial?: ShipGoal): ShipGoals & { log: string[]; current: ShipGoal | undefined } => {
  const state: { current: ShipGoal | undefined; log: string[] } = { current: initial, log: [] }
  const remember = (goal: ShipGoal): ShipGoal => {
    state.current = goal
    return goal
  }
  return {
    get log() { return state.log },
    get current() { return state.current },
    async get() { return state.current },
    async create(objective) {
      state.log.push(`create:${objective}`)
      return remember({ id: 'goal-new', objective, phase: 'active', activation: 'armed' })
    },
    async edit(id, objective) {
      state.log.push(`edit:${id}:${objective}`)
      return remember({ id, objective, phase: state.current?.phase ?? 'paused', activation: 'disarmed' })
    },
    async pause(id) {
      state.log.push(`pause:${id}`)
      return remember({
        id,
        objective: state.current?.objective ?? '',
        phase: 'paused',
        activation: 'disarmed',
      })
    },
    async resume(id) {
      state.log.push(`resume:${id}`)
      return remember({
        id,
        objective: state.current?.objective ?? '',
        phase: 'active',
        activation: 'armed',
      })
    },
    async complete(id) {
      state.log.push(`complete:${id}`)
      return remember({
        id,
        objective: state.current?.objective ?? '',
        phase: 'complete',
        activation: 'disarmed',
      })
    },
    async clear(id) {
      state.log.push(`clear:${id}`)
      state.current = undefined
    },
  }
}

const landing = (done: 'a' | 'ab' = 'a'): string =>
  done === 'a'
    ? 'Status: landing\n\n## Plan\n\n- [x] Ticket 1: a\n- [ ] Ticket 2: b\n'
    : 'Status: landing\n\n## Plan\n\n- [x] Ticket 1: a\n- [x] Ticket 2: b\n'

const writeSpec = (cwd: string, name: string, markdown: string): string => {
  const dir = join(cwd, 'docs', 'specs')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, markdown)
  return path
}

describe('ShipRun', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('injects wayfinder before grill when no spec exists, then stops', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const prompts: string[] = []
    const chips: Array<ShipChip | undefined> = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: chip => { chips.push(chip) },
    })
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Follow the wayfinder skill as the contract, not a summary of it')
    expect(prompts[0]).not.toContain('Follow the grill-me skill as the contract, not a summary of it')
    expect(prompts[0]).not.toContain('Pure Synthesis, Zero Interrogation')
    expect(chips[0]).toEqual({ kind: 'wayfinder' })
  })

  it('hands off from wayfinder to grill and then spec in separate turns', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const prompts: string[] = []
    const chips: Array<ShipChip | undefined> = []
    const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: chip => { chips.push(chip) } })
    await ship.run('build a widget', async prompt => {
      prompts.push(prompt)
      if (prompts.length === 1) writeSpec(cwd, 'widget.md', 'Status: grilling\n\n## Wayfinder\n\n[Map](../../map.md)\n')
      if (prompts.length === 2) writeSpec(cwd, 'widget.md', 'Status: interviewing\n')
    })
    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toContain('Follow the wayfinder skill')
    expect(prompts[1]).toContain('Follow the grill-me skill')
    expect(prompts[1]).not.toContain('Follow the wayfinder skill')
    expect(prompts[2]).toContain('Pure Synthesis, Zero Interrogation')
    expect(chips).toEqual([{ kind: 'wayfinder' }, { kind: 'grill' }, { kind: 'spec' }])
  })

  it('resumes an unresolved map without repeating pre-flight or entering grill', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'widget.md', 'Status: wayfinding\n\n## Wayfinder\n\n[Map](../../map.md)\n')
    const ship = new ShipRun(cwd, chrome)
    const prompts: string[] = []
    await ship.run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Follow the wayfinder skill')
    expect(prompts[0]).not.toContain('git checkout -b')
    expect(prompts[0]).not.toContain('Follow the grill-me skill')
    expect(ship.shipChip).toEqual({ kind: 'wayfinder' })
  })

  it('does not enter grill after wayfinder is aborted even if the ledger advanced', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const ship = new ShipRun(cwd, chrome)
    const prompts: string[] = []
    await ship.run('widget', async prompt => {
      prompts.push(prompt)
      writeSpec(cwd, 'widget.md', 'Status: grilling\n')
      ship.abort()
    })
    expect(prompts).toHaveLength(1)
  })

  it('does not jump backward into grill when a later phase rewrites the status', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', 'Status: confirmed\n')
    const ship = new ShipRun(cwd, chrome)
    const prompts: string[] = []
    await ship.run('', async prompt => {
      prompts.push(prompt)
      writeFileSync(path, 'Status: grilling\n')
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Strict Vertical Tracer Slicing')
  })

  it('resumes the grill handoff without repeating wayfinder', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'widget.md', 'Status: grilling\n')
    const ship = new ShipRun(cwd, chrome)
    const prompts: string[] = []
    await ship.run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Follow the grill-me skill')
    expect(prompts[0]).not.toContain('Follow the wayfinder skill')
    expect(ship.shipChip).toEqual({ kind: 'grill' })
  })

  it('injects to-spec then tickets when Status advances between turns', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', 'Status: interviewing\n')
    const prompts: string[] = []
    const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} })
    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) writeFileSync(path, 'Status: confirmed\n')
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Pure Synthesis, Zero Interrogation')
    expect(prompts[1]).toContain('Strict Vertical Tracer Slicing')
  })

  it('resumes landing from an unfinished spec instead of grilling', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', landing())
    const plans: Array<Plan | undefined> = []
    const chips: Array<ShipChip | undefined> = []
    const prompts: string[] = []
    const ship = new ShipRun(cwd, {
      setPlan: plan => { plans.push(plan) },
      setChip: chip => { chips.push(chip) },
    })
    ship.noteWritten([path])
    expect(ship.shipChip).toEqual({ kind: 'land', k: 1, n: 2 })
    expect(ship.shipPlan?.done).toBe(1)
    await ship.run('', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Strict Red-First Execution')
    expect(prompts[0]).not.toContain('Relentless Frontier Exploration')
    expect(chips.some(chip => chip?.kind === 'land')).toBe(true)
  })

  it('does not inject a later phase after abort', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', 'Status: interviewing\n')
    const prompts: string[] = []
    const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} })
    await ship.run('x', async (prompt) => {
      prompts.push(prompt)
      writeFileSync(path, 'Status: confirmed\n')
      ship.abort()
    })
    expect(prompts).toHaveLength(1)
  })

  it('pins plan progress from a session write and ticks when the checkbox moves', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', landing('a'))
    const plans: Array<Plan | undefined> = []
    const ship = new ShipRun(cwd, {
      setPlan: plan => { plans.push(plan) },
      setChip: () => {},
    })
    ship.noteWritten([path])
    expect(ship.shipPlan?.current?.title).toBe('Ticket 2: b')
    writeFileSync(path, landing('ab'))
    ship.refresh()
    expect(ship.shipPlan?.done).toBe(2)
    expect(ship.shipPlan?.current).toBeUndefined()
    expect(ship.shipChip).toEqual({ kind: 'verify' })
  })

  it('ignores a shipped spec that this session did not write', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'old.md', 'Status: shipped\n\n## Plan\n\n- [x] Ticket 1: a\n')
    const chips: Array<ShipChip | undefined> = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: chip => { chips.push(chip) },
    })
    await ship.run('new idea', async () => {})
    expect(chips[0]).toEqual({ kind: 'wayfinder' })
    expect(ship.shipPlan).toBeUndefined()
  })

  it('stops the poll when inject throws, then still refreshes', async () => {
    vi.useFakeTimers()
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', 'Status: interviewing\n')
    const todos: number[] = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: () => {},
      setTodos: () => { todos.push(1) },
    })
    await expect(ship.run('x', async () => {
      writeFileSync(path, 'Status: confirmed\n')
      throw new Error('turn failed')
    })).rejects.toThrow('turn failed')
    expect(ship.shipChip).toEqual({ kind: 'tickets' })
    const before = todos.length
    await vi.advanceTimersByTimeAsync(1100)
    expect(todos.length).toBe(before)
  })

  it('aborts the first run when a second run starts', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', 'Status: interviewing\n')
    const prompts: string[] = []
    const ship = new ShipRun(cwd, { setPlan: () => {}, setChip: () => {} })
    let resumeFirst!: () => void
    const firstTurn = new Promise<void>(resolve => { resumeFirst = resolve })
    const first = ship.run('one', async (prompt) => {
      prompts.push(prompt)
      await firstTurn
    })
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    writeFileSync(path, 'Status: confirmed\n')
    const second = ship.run('', async (prompt) => { prompts.push(prompt) })
    resumeFirst()
    await Promise.all([first, second])
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Pure Synthesis, Zero Interrogation')
    expect(prompts[1]).toContain('Strict Vertical Tracer Slicing')
  })

  it('flashes done then clears the chip for a session-written shipped spec', () => {
    vi.useFakeTimers()
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', landing('ab'))
    const chips: Array<ShipChip | undefined> = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: chip => { chips.push(chip) },
    })
    ship.noteWritten([path])
    writeFileSync(path, 'Status: shipped\n\n## Plan\n\n- [x] Ticket 1: a\n- [x] Ticket 2: b\n')
    ship.refresh()
    expect(ship.shipChip).toEqual({ kind: 'done' })
    vi.advanceTimersByTime(400)
    expect(ship.shipChip).toBeUndefined()
    ship.refresh()
    expect(ship.shipChip).toBeUndefined()
  })

  it('ignores a non-markdown write', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', landing())
    const plans: Array<Plan | undefined> = []
    const ship = new ShipRun(cwd, {
      setPlan: plan => { plans.push(plan) },
      setChip: () => {},
    })
    ship.noteWritten([path.replace(/\.md$/u, '.ts')])
    expect(plans).toEqual([])
    expect(ship.shipPlan).toBeUndefined()
  })

  it('flashes land ok when a ticket ticks, then strips the flash', () => {
    vi.useFakeTimers()
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', 'Status: landing\n\n## Plan\n\n- [ ] Ticket 1: a\n- [ ] Ticket 2: b\n')
    const chips: ShipChip[] = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: chip => { if (chip !== undefined) chips.push(chip) },
    })
    ship.noteWritten([path])
    expect(ship.shipChip).toEqual({ kind: 'land', k: 0, n: 2 })
    writeFileSync(path, 'Status: landing\n\n## Plan\n\n- [x] Ticket 1: a\n- [ ] Ticket 2: b\n')
    ship.refresh()
    expect(ship.shipChip).toEqual({ kind: 'land', k: 1, n: 2, flashOk: true })
    vi.advanceTimersByTime(400)
    expect(ship.shipChip).toEqual({ kind: 'land', k: 1, n: 2 })
  })

  it('creates a [ship] placeholder then pauses before the first grill inject (Track: 5,7)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const goals = recordingGoals()
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals })
    await ship.run('build a widget', async (prompt) => {
      goals.log.push('inject')
      prompts.push(prompt)
    })
    expect(goals.log).toEqual(['create:[ship] build a widget', 'pause:goal-new', 'inject'])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('goal-new')
    expect(prompts[0]).toContain('Follow the wayfinder skill as the contract, not a summary of it')
  })

  it('pauses a stranger then asks ship · occupancy before any inject (Track: 6)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const goals = recordingGoals({
      id: 'stranger-1',
      objective: 'write a novel',
      phase: 'active',
      activation: 'armed',
    })
    const asked: SelectSpec[] = []
    const occupancy = async (spec: SelectSpec): Promise<SelectOutcome> => {
      asked.push(spec)
      return { kind: 'chosen', indices: [0] }
    }
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals, occupancy })
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(goals.log[0]).toBe('pause:stranger-1')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.title).toBe('ship · occupancy')
    expect(asked[0]?.options.map(option => option.label)).toEqual(['Replace', 'Abort'])
    expect(goals.log).toEqual([
      'pause:stranger-1',
      'clear:stranger-1',
      'create:[ship] build a widget',
      'pause:goal-new',
    ])
    expect(prompts).toHaveLength(1)
  })

  it('resumes the stranger and injects nothing when occupancy is Abort (Track: 6)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const goals = recordingGoals({
      id: 'stranger-1',
      objective: 'write a novel',
      phase: 'active',
      activation: 'armed',
    })
    const occupancy = async (): Promise<SelectOutcome> => ({ kind: 'chosen', indices: [1] })
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals, occupancy })
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(goals.log).toEqual(['pause:stranger-1', 'resume:stranger-1'])
    expect(prompts).toEqual([])
  })

  it('treats a throwing occupancy ask as Abort and injects nothing (Track: 6)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const goals = recordingGoals({
      id: 'stranger-1',
      objective: 'write a novel',
      phase: 'active',
      activation: 'armed',
    })
    const occupancy = async (): Promise<SelectOutcome> => { throw new Error('escaped') }
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals, occupancy })
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(goals.log).toEqual(['pause:stranger-1', 'resume:stranger-1'])
    expect(prompts).toEqual([])
  })

  it('treats occupancy cancel/Esc as Abort and injects nothing (Track: 6)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const goals = recordingGoals({
      id: 'stranger-1',
      objective: 'write a novel',
      phase: 'paused',
      activation: 'disarmed',
    })
    const occupancy = async (): Promise<SelectOutcome> => ({ kind: 'cancelled' })
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals, occupancy })
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(goals.log).toEqual(['pause:stranger-1', 'resume:stranger-1'])
    expect(prompts).toEqual([])
  })

  it('auto-Replaces a stranger when occupancy ask is absent (Track: 6)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const goals = recordingGoals({
      id: 'stranger-1',
      objective: 'write a novel',
      phase: 'active',
      activation: 'armed',
    })
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals })
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(goals.log).toEqual([
      'pause:stranger-1',
      'clear:stranger-1',
      'create:[ship] build a widget',
      'pause:goal-new',
    ])
    expect(prompts).toHaveLength(1)
  })

  it('reuses ours by Goal-Id or [ship] prefix without asking (Track: 6)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'widget.md', 'Status: interviewing\nGoal-Id: goal-ours\n')
    const byId = recordingGoals({
      id: 'goal-ours',
      objective: 'something else',
      phase: 'paused',
      activation: 'disarmed',
    })
    const asked: SelectSpec[] = []
    const occupancy = async (spec: SelectSpec): Promise<SelectOutcome> => {
      asked.push(spec)
      return { kind: 'chosen', indices: [1] }
    }
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals: byId, occupancy })
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(asked).toEqual([])
    expect(byId.log[0]).toMatch(/^edit:goal-ours:\[ship\] /)
    expect(byId.log).toContain('pause:goal-ours')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Pure Synthesis, Zero Interrogation')

    const byPrefix = recordingGoals({
      id: 'goal-prefix',
      objective: '[ship] leftover compass',
      phase: 'active',
      activation: 'armed',
    })
    const askedPrefix: SelectSpec[] = []
    const occupancyPrefix = async (spec: SelectSpec): Promise<SelectOutcome> => {
      askedPrefix.push(spec)
      return { kind: 'chosen', indices: [1] }
    }
    const prefixPrompts: string[] = []
    const prefixShip = new ShipRun(cwd, chrome, { goals: byPrefix, occupancy: occupancyPrefix })
    await prefixShip.run('build a widget', async (prompt) => { prefixPrompts.push(prompt) })
    expect(askedPrefix).toEqual([])
    expect(byPrefix.log.some(entry => entry.startsWith('edit:goal-prefix:[ship] '))).toBe(true)
    expect(byPrefix.log).toContain('pause:goal-prefix')
    expect(prefixPrompts).toHaveLength(1)
  })

  it('degrades when goals are missing or throw and still injects (Track: 5)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const flashes: string[] = []
    const prompts: string[] = []
    const missing = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await missing.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Follow the wayfinder skill as the contract, not a summary of it')
    expect(flashes).toEqual(['/goal was not updated'])

    const throwing: ShipGoals = {
      async get() { throw new Error('no host') },
      async create() { throw new Error('no host') },
      async edit() { throw new Error('no host') },
      async pause() { throw new Error('no host') },
      async resume() { throw new Error('no host') },
      async complete() { throw new Error('no host') },
      async clear() { throw new Error('no host') },
    }
    const thrownPrompts: string[] = []
    const thrownFlashes: string[] = []
    const thrown = new ShipRun(cwd, chrome, {
      goals: throwing,
      flash: text => { thrownFlashes.push(text) },
    })
    await expect(thrown.run('build a widget', async (prompt) => { thrownPrompts.push(prompt) })).resolves.toBeUndefined()
    expect(thrownPrompts).toHaveLength(1)
    expect(thrownFlashes).toEqual(['/goal was not updated'])

    const createThrows: ShipGoals = {
      async get() { return undefined },
      async create() { throw new Error('create failed') },
      async edit() { throw new Error('unused') },
      async pause() { throw new Error('pause failed') },
      async resume() { throw new Error('unused') },
      async complete() { throw new Error('unused') },
      async clear() { throw new Error('unused') },
    }
    const createPrompts: string[] = []
    const createFlashes: string[] = []
    const createShip = new ShipRun(cwd, chrome, {
      goals: createThrows,
      flash: text => { createFlashes.push(text) },
    })
    await expect(createShip.run('build a widget', async (prompt) => { createPrompts.push(prompt) })).resolves.toBeUndefined()
    expect(createPrompts).toHaveLength(1)
    expect(createFlashes).toEqual(['/goal was not updated'])

    const pauseThrows: ShipGoals = {
      async get() { return undefined },
      async create(objective) {
        return { id: 'goal-new', objective, phase: 'active', activation: 'armed' }
      },
      async edit() { throw new Error('unused') },
      async pause() { throw new Error('pause failed') },
      async resume() { throw new Error('unused') },
      async complete() { throw new Error('unused') },
      async clear() { throw new Error('unused') },
    }
    const pausePrompts: string[] = []
    const pauseFlashes: string[] = []
    const pauseShip = new ShipRun(cwd, chrome, {
      goals: pauseThrows,
      flash: text => { pauseFlashes.push(text) },
    })
    await expect(pauseShip.run('build a widget', async (prompt) => { pausePrompts.push(prompt) })).resolves.toBeUndefined()
    expect(pausePrompts).toHaveLength(1)
    expect(pauseFlashes).toEqual(['/goal was not updated'])
  })

  it('creates a placeholder over a complete current goal without asking (Track: 6)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const goals = recordingGoals({
      id: 'old-complete',
      objective: 'finished work',
      phase: 'complete',
      activation: 'disarmed',
    })
    const asked: SelectSpec[] = []
    const occupancy = async (spec: SelectSpec): Promise<SelectOutcome> => {
      asked.push(spec)
      return { kind: 'chosen', indices: [1] }
    }
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals, occupancy })
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(asked).toEqual([])
    expect(goals.log).toEqual(['create:[ship] build a widget', 'pause:goal-new'])
    expect(prompts).toHaveLength(1)
  })

  it('wraps a host goals service without importing its type (Track: 1,5)', async () => {
    let current: HostGoalView = {
      id: 'host-1',
      objective: 'write a novel',
      phase: 'active',
      activation: 'armed',
      revision: 3,
    }
    const host: HostGoalsService = {
      get: () => current,
      create: (_agent, request) => {
        current = {
          id: 'host-new',
          objective: request.objective,
          phase: 'active',
          activation: 'armed',
          revision: 1,
        }
        return current
      },
      edit: (_agent, ref, request) => {
        current = {
          ...current,
          id: ref.id,
          objective: request.objective ?? current.objective,
          revision: ref.revision + 1,
        }
        return current
      },
      pause: (_agent, ref) => {
        current = { ...current, id: ref.id, phase: 'paused', activation: 'disarmed', revision: ref.revision + 1 }
        return current
      },
      resume: (_agent, ref) => {
        current = { ...current, id: ref.id, phase: 'active', activation: 'armed', revision: ref.revision + 1 }
        return current
      },
      complete: (_agent, ref) => {
        current = { ...current, id: ref.id, phase: 'complete', activation: 'disarmed', revision: ref.revision + 1 }
        return current
      },
      clear: () => { current = { ...current, id: 'cleared', revision: current.revision + 1 } },
    }
    const wrapped = wrapHostGoals(host, () => ({}))
    await expect(wrapped.get()).resolves.toEqual({
      id: 'host-1',
      objective: 'write a novel',
      phase: 'active',
      activation: 'armed',
    })
    await expect(wrapped.create('[ship] idea')).resolves.toMatchObject({
      id: 'host-new',
      objective: '[ship] idea',
      phase: 'active',
      activation: 'armed',
    })
    await wrapped.pause('host-new')
    expect(current.phase).toBe('paused')
    await wrapped.clear('host-new')
    expect(current.id).toBe('cleared')
  })

  it('prepends the Confirm snapshot on later injects and halts if the file Main Track is rewritten (Track: 3,4)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const sealed = [
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.** No harness fork.',
    ].join('\n')
    const rewritten = [
      '## Main Track',
      '',
      '**Idea.** silently rewritten design.',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', `Status: interviewing\n\n${sealed}\n`)
    const prompts: string[] = []
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) writeFileSync(path, `Status: confirmed\n\n${sealed}\n`)
      else if (prompts.length === 2) writeFileSync(path, `Status: planned\n\n${rewritten}\n`)
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('**Idea.** Bind /goal into /ship.')
    expect(prompts[0]).toContain('Pure Synthesis, Zero Interrogation')
    expect(prompts[1]).toContain('**Idea.** Bind /goal into /ship.')
    expect(prompts[1]).toContain('Strict Vertical Tracer Slicing')
    expect(prompts[1]).not.toContain('silently rewritten design')
    expect(flashes.some(text => /Frozen ## Main Track/i.test(text))).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('silently rewritten design')
  })

  it('re-asserts a drifted or armed compass on later injects (Track: 1,7)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const track = [
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', `Status: interviewing\n\n${track}\n`)
    const goals = recordingGoals()
    const ship = new ShipRun(cwd, chrome, { goals })
    let drifted = false
    await ship.run('build a widget', async () => {
      if (!drifted && goals.current !== undefined) {
        drifted = true
        goals.current.objective = 'human edited the compass'
        goals.current.activation = 'armed'
        goals.current.phase = 'active'
      }
      writeFileSync(path, `Status: confirmed\n\n${track}\n`)
    })
    expect(goals.log).toContain('edit:goal-new:[ship] ## Main Track\n\n**Idea.** Bind /goal into /ship.\n**Track-1.** Hybrid compass.')
    expect(goals.log.filter(entry => entry === 'pause:goal-new').length).toBeGreaterThanOrEqual(2)
    expect(goals.current?.activation).toBe('disarmed')
    expect(goals.current?.phase).toBe('paused')
  })

  it('edits the compass to the draft then the sealed track and completes on shipped (Track: 7)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const draft = [
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
    ].join('\n')
    const sealed = [
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.** No harness fork.',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', `Status: interviewing\n\n${draft}\n`)
    const goals = recordingGoals()
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals })
    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) writeFileSync(path, `Status: confirmed\n\n${sealed}\n`)
      else if (prompts.length === 2) writeFileSync(path, `Status: planned\n\n${sealed}\n\n## Plan\n\n- [ ] Ticket 1: Goal\n`)
      else if (prompts.length === 3) writeFileSync(path, `Status: landing\n\n${sealed}\n\n## Plan\n\n- [x] Ticket 1: Goal\n`)
      else writeFileSync(path, `Status: shipped\n\n${sealed}\n\n## Plan\n\n- [x] Ticket 1: Goal\n`)
    })
    expect(goals.log[0]).toBe('create:[ship] build a widget')
    expect(goals.log).toContain('edit:goal-new:[ship] ## Main Track\n\n**Idea.** Bind /goal into /ship.\n**Track-1.** Hybrid compass.')
    expect(goals.log).toContain('edit:goal-new:[ship] ## Main Track\n\n**Idea.** Bind /goal into /ship.\n**Track-1.** Hybrid compass.\n**Out of Scope.** No harness fork.')
    expect(goals.log).toContain('complete:goal-new')
    expect(goals.log.at(-1)).toBe('complete:goal-new')
    expect(prompts[0]).toContain('**Idea.** Bind /goal into /ship.')
    expect(prompts[1]).toContain('**Out of Scope.** No harness fork.')
  })

  it('leaves the placeholder paused on abort instead of completing (Track: 7)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', 'Status: interviewing\n')
    const goals = recordingGoals()
    const ship = new ShipRun(cwd, chrome, { goals })
    await ship.run('build a widget', async () => {
      writeFileSync(path, 'Status: confirmed\n')
      ship.abort()
    })
    expect(goals.log).toEqual(['create:[ship] build a widget', 'pause:goal-new'])
    expect(goals.log).not.toContain('complete:goal-new')
  })

  it('puts the sealed track and spec path into the active ticket brief (Track: 4)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const sealed = [
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.** No harness fork.',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', `Status: planned\n\n${sealed}\n\n## Plan\n\n- [ ] Ticket 1: Goal\n`)
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome)
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt); ship.abort() })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('**Idea.** Bind /goal into /ship.')
    expect(prompts[0]).toContain('**Track-1.** Hybrid compass.')
    expect(prompts[0]).toContain('Active Ticket: Ticket 1: Goal')
    expect(prompts[0]).toContain(path)
  })

  it('pins one bound spec and ignores a later unfinished markdown write', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const sealed = [
      '## Original Requirement',
      '',
      'Bind /goal into /ship.',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', `Status: interviewing\n\n${sealed}\n`)
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome)
    await ship.run('', async (prompt) => {
      prompts.push(prompt)
      const other = writeSpec(cwd, 'other.md', 'Status: landing\n\n## Original Requirement\n\nUnrelated work.\n\n## Plan\n\n- [x] Ticket 1: steal\n')
      ship.noteWritten([other])
      if (prompts.length === 1) writeFileSync(path, `Status: confirmed\n\n${sealed}\n`)
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Bind /goal into /ship.')
    expect(prompts[0]).toContain(JSON.stringify(path))
    expect(prompts.every(prompt => !prompt.includes('Unrelated work.'))).toBe(true)
    expect(prompts[1]).toContain('Strict Vertical Tracer Slicing')
  })

  it('resumes the frozen original across run instances even if the file track is rewritten', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const original = 'Keep offline use.\nNever upload files.'
    const sealed = [
      '## Original Requirement',
      '',
      original,
      '',
      '## Main Track',
      '',
      '**Idea.** Keep offline use.',
      '**Track-1.** Local-only.',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', `Status: interviewing\n\n${sealed}\n`)
    const first = new ShipRun(cwd, chrome)
    await first.run('', async (prompt) => {
      expect(prompt).toContain(original)
      writeFileSync(path, `Status: confirmed\n\n${sealed}\n`)
    })
    writeFileSync(path, `Status: planned\n\n${sealed}\n\n## Plan\n\n- [ ] Ticket 1: Offline\n`)
    const prompts: string[] = []
    const second = new ShipRun(cwd, chrome)
    await second.run('', async (prompt) => { prompts.push(prompt); second.abort() })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(original)
    expect(prompts[0]).toContain('**Idea.** Keep offline use.')
    expect(prompts[0]).toContain(JSON.stringify(path))

    writeFileSync(path, [
      'Status: planned',
      '',
      '## Original Requirement',
      '',
      original,
      '',
      '## Main Track',
      '',
      '**Idea.** silently rewritten design.',
    ].join('\n'))
    const drifted: string[] = []
    const flashes: string[] = []
    const third = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await third.run('', async (prompt) => { drifted.push(prompt) })
    expect(drifted).toEqual([])
    expect(flashes.some(text => /Frozen ## Main Track/i.test(text))).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('silently rewritten design')
  })

  it('blocks a typed idea that conflicts with the saved original', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const original = 'Keep offline use.'
    writeSpec(cwd, 'widget.md', [
      'Status: interviewing',
      '',
      '## Original Requirement',
      '',
      original,
    ].join('\n'))
    const flashes: string[] = []
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await ship.run('build a different product', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toEqual([])
    expect(flashes.some(text => /conflicts with the saved original/i.test(text))).toBe(true)
  })

  it('keeps a saved original on empty resume and never edits the compass to [ship] empty', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const original = 'Keep offline use.'
    writeSpec(cwd, 'widget.md', [
      'Status: interviewing',
      '',
      '## Original Requirement',
      '',
      original,
    ].join('\n'))
    const goals = recordingGoals()
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals })
    await ship.run('', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(original)
    expect(goals.log[0]).toBe(`create:[ship] ${original}`)
    expect(goals.log.some(entry => entry === 'create:[ship] ' || entry === 'edit:goal-new:[ship] ')).toBe(false)
  })

  it('asks ship · spec when several unfinished specs exist, and blocks a pipe without a selector', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'alpha.md', 'Status: interviewing\n\n## Original Requirement\n\nAlpha idea.\n')
    writeSpec(cwd, 'beta.md', 'Status: landing\n\n## Original Requirement\n\nBeta idea.\n\n## Main Track\n\nTrack-1: Beta.\n\n## Plan\n\n- [ ] Ticket 1: Beta\n')
    const asked: SelectSpec[] = []
    const selectSpec = async (spec: SelectSpec): Promise<SelectOutcome> => {
      asked.push(spec)
      return { kind: 'chosen', indices: [1] }
    }
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { selectSpec })
    await ship.run('', async (prompt) => { prompts.push(prompt); ship.abort() })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.title).toBe('ship · spec')
    expect(asked[0]?.options.map(option => option.label)).toEqual(['alpha.md', 'beta.md'])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Beta idea.')
    expect(prompts[0]).not.toContain('Alpha idea.')

    const flashes: string[] = []
    const blocked: string[] = []
    const pipe = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await pipe.run('', async (prompt) => { blocked.push(prompt) })
    expect(blocked).toEqual([])
    expect(flashes.some(text => /Multiple unfinished specs/i.test(text))).toBe(true)
  })

  it('reuses occupancy with a distinct title when selectSpec is absent', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'alpha.md', 'Status: interviewing\n\n## Original Requirement\n\nAlpha idea.\n')
    writeSpec(cwd, 'beta.md', 'Status: landing\n\n## Original Requirement\n\nBeta idea.\n\n## Main Track\n\nTrack-1: Beta.\n\n## Plan\n\n- [ ] Ticket 1: Beta\n')
    const asked: SelectSpec[] = []
    const occupancy = async (spec: SelectSpec): Promise<SelectOutcome> => {
      asked.push(spec)
      return { kind: 'chosen', indices: [0] }
    }
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { occupancy })
    await ship.run('', async (prompt) => { prompts.push(prompt) })
    expect(asked[0]?.title).toBe('ship · spec')
    expect(prompts[0]).toContain('Alpha idea.')
  })

  it('asks for a requirement on bare ship when there is no saved work', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome)
    await ship.run('', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('ask for the one-sentence requirement')
  })

  it('does not skip phases or loop backward when Status jumps', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const original = '## Original Requirement\n\nKeep offline use.\n'
    const path = writeSpec(cwd, 'widget.md', `Status: interviewing\n\n${original}`)
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome)
    await ship.run('', async (prompt) => {
      prompts.push(prompt)
      writeFileSync(path, `Status: landing\n\n${original}`)
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Pure Synthesis, Zero Interrogation')
    expect(prompts[0]).not.toContain('Strict Red-First Execution')
  })

  it('does not complete the goal when a turn throws even if Status says shipped', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const original = '## Original Requirement\n\nKeep offline use.\n'
    const path = writeSpec(cwd, 'widget.md', `Status: interviewing\n\n${original}`)
    const goals = recordingGoals()
    const ship = new ShipRun(cwd, chrome, { goals })
    await expect(ship.run('', async () => {
      writeFileSync(path, `Status: shipped\n\n${original}`)
      throw new Error('turn failed')
    })).rejects.toThrow('turn failed')
    expect(goals.log).not.toContain('complete:goal-new')
  })

  it('stays read-only in plan mode: one inject, no snapshot, no goal writes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const original = 'Keep offline use.'
    const path = writeSpec(cwd, 'widget.md', [
      'Status: interviewing',
      '',
      '## Original Requirement',
      '',
      original,
    ].join('\n'))
    const goals = recordingGoals()
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { goals, isPlanMode: () => true })
    await ship.run('a new request that must not write', async (prompt) => {
      prompts.push(prompt)
      writeFileSync(path, `Status: confirmed\n\n## Original Requirement\n\n${original}\n`)
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(original)
    expect(goals.log).toEqual([])
    expect(existsSync(snapshotPathFor(path))).toBe(false)
  })

  it('refuses a malformed snapshot without overwriting it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', 'Status: interviewing\n\n## Original Requirement\n\nKeep offline use.\n')
    const sidecar = snapshotPathFor(path)
    writeFileSync(sidecar, '{not json')
    const flashes: string[] = []
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await ship.run('', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toEqual([])
    expect(flashes.some(text => /not valid JSON|corrupt/i.test(text))).toBe(true)
    expect(readFileSync(sidecar, 'utf8')).toBe('{not json')
  })

  it('halts when a frozen original or Main Track is deleted after Confirm', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const sealed = [
      '## Original Requirement',
      '',
      'Keep offline use.',
      '',
      '## Main Track',
      '',
      '**Idea.** Keep offline use.',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', `Status: interviewing\n\n${sealed}\n`)
    const flashes: string[] = []
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await ship.run('', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) writeFileSync(path, `Status: confirmed\n\n${sealed}\n`)
      else writeFileSync(path, 'Status: planned\n\n## Requirement\n\nA design summary.\n')
    })
    expect(prompts).toHaveLength(2)
    expect(flashes.some(text => /Frozen ## (?:Original Requirement|Main Track)/i.test(text))).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('## Requirement')
    expect(readFileSync(path, 'utf8')).not.toContain('## Original Requirement')
    expect(readFileSync(path, 'utf8')).not.toContain('## Main Track')
  })

  it('still validates disk when optional goals throw', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const original = 'Keep offline use.'
    const path = writeSpec(cwd, 'widget.md', [
      'Status: confirmed',
      '',
      '## Original Requirement',
      '',
      original,
      '',
      '## Main Track',
      '',
      '**Idea.** Keep offline use.',
    ].join('\n'))
    const first = new ShipRun(cwd, chrome)
    await first.run('', async () => {})
    writeFileSync(path, 'Status: confirmed\n\n## Requirement\n\nA design summary.\n')
    const throwing: ShipGoals = {
      async get() { throw new Error('no host') },
      async create() { throw new Error('no host') },
      async edit() { throw new Error('no host') },
      async pause() { throw new Error('no host') },
      async resume() { throw new Error('no host') },
      async complete() { throw new Error('no host') },
      async clear() { throw new Error('no host') },
    }
    const flashes: string[] = []
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, {
      goals: throwing,
      flash: text => { flashes.push(text) },
    })
    await ship.run('', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toEqual([])
    expect(flashes.some(text => /Frozen ## (?:Original Requirement|Main Track)/i.test(text))).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('## Requirement')
    expect(readFileSync(path, 'utf8')).not.toContain('## Original Requirement')
    expect(readFileSync(path, 'utf8')).not.toContain('## Main Track')
  })

  it('does not substitute $ARGUMENTS that live in the original requirement or track', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const original = 'Keep literal $ARGUMENTS and $&; preserve offline use.'
    writeSpec(cwd, 'widget.md', [
      'Status: interviewing',
      '',
      '## Original Requirement',
      '',
      original,
      '',
      '## Main Track',
      '',
      'Track-1: preserve $ARGUMENTS exactly.',
    ].join('\n'))
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome)
    await ship.run('', async (prompt) => { prompts.push(prompt) })
    expect(prompts[0]).toContain(original)
    expect(prompts[0]).toContain('Track-1: preserve $ARGUMENTS exactly.')
    expect(prompts[0]?.includes('$ARGUMENTS')).toBe(true)
  })

  it('notices limited history on a legacy spec without claiming a historical seal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'widget.md', [
      'Status: interviewing',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
    ].join('\n'))
    const flashes: string[] = []
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await ship.run('', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('**Idea.** Bind /goal into /ship.')
    expect(flashes.some(text => /Earlier history cannot be verified/i.test(text))).toBe(true)
  })
})

describe('composition root', () => {
  it('constructs ShipRun with goals, occupancy, and flash ports (Track: 1,9)', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
    expect(source).toContain('wrapHostGoals')
    expect(source).toContain("ctx.get('goals')")
    expect(source).toContain('prompt.select')
    expect(source).toContain('prompt.setFlash')
    expect(source).toContain('tools/pre-execute')
    expect(source).toContain('alignTool')
    expect(source).not.toContain('GoalBar')
    expect(source).toMatch(/new ShipRun\([\s\S]*goals/)
    expect(source).toContain('selectSpec')
    expect(source).toContain('isPlanMode')
    expect(source).toContain('sessionFolds.planMode')
  })

  it('compiles and writes a Mission Contract at Confirm and prepends it later', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const markdown = [
      'Status: interviewing',
      'Branch: ship/widget',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.**',
      '- No harness fork.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', markdown)
    const prompts: string[] = []
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) {
        writeFileSync(path, markdown.replace('Status: interviewing', 'Status: confirmed'))
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
        ].join('\n'))
      }
    })
    expect(ship.missionContract).toBeDefined()
    expect(ship.missionContract?.objective).toBe('Bind /goal into /ship.')
    expect(ship.missionContract?.requirements[0]?.id).toBe('REQ-001')
    expect(ship.missionContract?.excluded[0]?.text).toContain('No harness fork')
    expect(ship.missionContractFile).toBeDefined()
    expect(existsSync(ship.missionContractFile!)).toBe(true)
    expect(readFileSync(ship.missionContractFile!, 'utf8')).toContain('"REQ-001"')
    expect(prompts.length).toBeGreaterThanOrEqual(2)
    expect(prompts[1]).toContain('## Mission Contract')
    expect(prompts[1]).toContain('REQ-001')
    expect(prompts[1]).toContain('Bind /goal into /ship.')
    expect(prompts[1]).not.toContain('silently rewritten design')
    expect(prompts.length).toBe(2)
    expect(flashes.some(f => /Frozen ## Main Track/i.test(f))).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('silently rewritten design')
    expect(readFileSync(ship.missionContractFile!, 'utf8')).toContain('Bind /goal into /ship.')
    expect(readFileSync(ship.missionContractFile!, 'utf8')).not.toContain('silently rewritten design')
  })



  it('halts on a rewritten sealed Main Track, keeps the modified file, and still injects only the active ticket on land', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const markdown = [
      'Status: interviewing',
      'Branch: ship/widget',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Track-2.** Compact payload.',
      '**Out of Scope.**',
      '- No harness fork.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Spec schema (Track: 1)',
      '- [ ] Ticket 2: Prompt contracts (Track: 2)',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', markdown)
    const prompts: string[] = []
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    const rewritten = [
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
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Spec schema (Track: 1)',
      '- [ ] Ticket 2: Prompt contracts (Track: 2)',
    ].join('\n')
    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) {
        writeFileSync(path, markdown.replace('Status: interviewing', 'Status: confirmed'))
      } else if (prompts.length === 2) {
        writeFileSync(path, rewritten)
      }
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('## Mission Contract')
    expect(prompts[1]).toContain('REQ-001')
    expect(prompts[1]).toContain('Bind /goal into /ship.')
    expect(prompts[1]).not.toContain('silently rewritten design')
    expect(flashes.some(f => /Frozen ## Main Track/i.test(f))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(rewritten)
    expect(readFileSync(ship.missionContractFile!, 'utf8')).toContain('Bind /goal into /ship.')
    expect(readFileSync(ship.missionContractFile!, 'utf8')).not.toContain('silently rewritten design')

    const land = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const landPath = writeSpec(land, 'widget.md', markdown.replace('Status: interviewing', 'Status: planned'))
    const landPrompts: string[] = []
    const landShip = new ShipRun(land, chrome)
    await landShip.run('build a widget', async (prompt) => {
      landPrompts.push(prompt)
      landShip.abort()
    })
    expect(landPrompts).toHaveLength(1)
    expect(landPrompts[0]).toContain('## Active Ticket')
    expect(landPrompts[0]).toContain('Ticket 1: Spec schema')
    expect(landPrompts[0]).toContain('REQ-001')
    expect(landPrompts[0]).not.toContain('Ticket 2: Prompt contracts')
    expect(readFileSync(landPath, 'utf8')).toContain('**Idea.** Bind /goal into /ship.')
  })



  it('loads an existing Mission Contract on resume instead of recompiling over it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const markdown = [
      'Status: planned',
      'Branch: ship/widget',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.**',
      '- No harness fork.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Spec schema (Track: 1)',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', markdown)
    const first = new ShipRun(cwd, chrome)
    await first.run('build a widget', async () => {})
    expect(first.missionContractFile).toBeDefined()
    const sealed = readFileSync(first.missionContractFile!, 'utf8')
    expect(sealed).toContain('Bind /goal into /ship.')

    // Interrupt rewrite of Main Track on disk, then resume a fresh run.
    const drifted = markdown.replace('Bind /goal into /ship.', 'silently rewritten after interrupt')
    writeFileSync(path, drifted)
    const flashes: string[] = []
    const second = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    const prompts: string[] = []
    await second.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(second.missionContract?.objective).toBe('Bind /goal into /ship.')
    expect(readFileSync(second.missionContractFile!, 'utf8')).toBe(sealed)
    expect(readFileSync(path, 'utf8')).toBe(drifted)
    expect(readFileSync(path, 'utf8')).toContain('silently rewritten after interrupt')
    expect(prompts).toEqual([])
    expect(flashes.some(f => /Frozen ## Main Track/i.test(f))).toBe(true)
  })

  it('advances land turns when the Active Ticket completes without a phase change', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const markdown = [
      'Status: planned',
      'Branch: ship/widget',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Track-2.** Compact payload.',
      '**Out of Scope.**',
      '- No harness fork.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Spec schema (Track: 1)',
      '- [ ] Ticket 2: Prompt contracts (Track: 2)',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', markdown)
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome)
    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) {
        writeFileSync(path, markdown.replace('- [ ] Ticket 1: Spec schema (Track: 1)', '- [x] Ticket 1: Spec schema (Track: 1)'))
      }
    })
    expect(prompts.length).toBeGreaterThanOrEqual(2)
    expect(prompts[0]).toContain('Ticket 1: Spec schema')
    expect(prompts[0]).not.toContain('Ticket 2: Prompt contracts')
    expect(prompts[1]).toContain('Ticket 2: Prompt contracts')
    expect(prompts[1]).not.toContain('Ticket 1: Spec schema')
  })

  it('halts and keeps the deleted Main Track on disk as evidence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const markdown = [
      'Status: interviewing',
      'Branch: ship/widget',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.**',
      '- No harness fork.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', markdown)
    const flashes: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    const prompts: string[] = []
    const deleted = [
      'Status: planned',
      'Branch: ship/widget',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
    ].join('\n')
    await ship.run('build a widget', async (prompt) => {
      prompts.push(prompt)
      if (prompts.length === 1) {
        writeFileSync(path, markdown.replace('Status: interviewing', 'Status: confirmed'))
      } else {
        writeFileSync(path, deleted)
      }
    })
    expect(prompts).toHaveLength(2)
    expect(readFileSync(path, 'utf8')).toBe(deleted)
    expect(readFileSync(path, 'utf8')).not.toContain('## Main Track')
    expect(ship.missionContract?.objective).toBe('Bind /goal into /ship.')
    expect(readFileSync(ship.missionContractFile!, 'utf8')).toContain('Bind /goal into /ship.')
    expect(flashes.some(f => /Frozen ## Main Track/i.test(f))).toBe(true)
  })

  it('alignTool denies immutable contract writes before execution', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const markdown = [
      'Status: interviewing',
      'Branch: ship/widget',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.**',
      '- No harness fork.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Spec schema (Track: 1)',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', markdown)
    const ship = new ShipRun(cwd, chrome)
    await ship.run('build a widget', async () => {
      writeFileSync(path, markdown.replace('Status: interviewing', 'Status: confirmed'))
    })
    expect(ship.missionContractFile).toBeDefined()
    const deny = ship.alignTool('write', { path: ship.missionContractFile! })
    expect(deny.allow).toBe(false)
    const allow = ship.alignTool('write', { path: 'src/openai.ts' })
    expect(allow.allow).toBe(true)
  })


  it('loads sealed contract when Main Track was deleted before resume', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const markdown = [
      'Status: planned',
      'Branch: ship/widget',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.**',
      '- No harness fork.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Spec schema (Track: 1)',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', markdown)
    const first = new ShipRun(cwd, chrome)
    await first.run('build a widget', async () => {})
    expect(first.missionContractFile).toBeDefined()

    writeFileSync(path, [
      'Status: planned',
      'Branch: ship/widget',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Spec schema (Track: 1)',
    ].join('\n'))

    const prompts: string[] = []
    const flashes: string[] = []
    const second = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await second.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(second.missionContract?.objective).toBe('Bind /goal into /ship.')
    expect(prompts).toEqual([])
    expect(readFileSync(path, 'utf8')).not.toContain('## Main Track')
    expect(readFileSync(second.missionContractFile!, 'utf8')).toContain('Bind /goal into /ship.')
    expect(flashes.some(f => /Frozen ## Main Track/i.test(f))).toBe(true)
  })

  it('alignTool allows reading the sealed contract and denies Out of Scope rewrites', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const markdown = [
      'Status: interviewing',
      'Branch: ship/widget',
      '',
      '## Main Track',
      '',
      '**Idea.** Bind /goal into /ship.',
      '**Track-1.** Hybrid compass.',
      '**Out of Scope.**',
      '- No harness fork.',
      '',
      '## Out of Scope',
      '',
      '- No harness fork.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Spec schema (Track: 1)',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', markdown)
    const ship = new ShipRun(cwd, chrome)
    await ship.run('build a widget', async () => {
      writeFileSync(path, markdown.replace('Status: interviewing', 'Status: confirmed'))
    })
    expect(ship.missionContractFile).toBeDefined()
    expect(ship.alignTool('read', { path: ship.missionContractFile! }).allow).toBe(true)

    const current = readFileSync(path, 'utf8')
    const rewritten = current.replace('- No harness fork.', '- No harness fork.\n- also cloud GPUs')
    const deny = ship.alignTool('write', { file_path: path, content: rewritten })
    expect(deny.allow).toBe(false)
    expect(deny.reasons.some(r => /Out of Scope|immutable|section/i.test(r))).toBe(true)
  })

  it('rebuilds a missing or corrupt graph sidecar and does not stop /ship', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', landing())
    const teasers: Array<TeaserCounts | undefined> = []
    const graphs: Array<unknown> = []
    const flashes: string[] = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: () => {},
      setTeaser: counts => { teasers.push(counts) },
      setGraph: graph => { graphs.push(graph) },
    }, { flash: text => { flashes.push(text) } })
    ship.noteWritten([path])
    const sidecar = graphPathFor(path)
    expect(existsSync(sidecar)).toBe(true)
    expect(ship.shipTeaser).toEqual({ unclaimed: 1, claimed: 0, closed: 1 })
    expect(teasers.at(-1)).toEqual({ unclaimed: 1, claimed: 0, closed: 1 })
    expect(graphs.at(-1)).toEqual(ship.shipGraph)
    writeFileSync(sidecar, '{not json')
    ship.refresh()
    expect(flashes).toEqual([])
    expect(JSON.parse(readFileSync(sidecar, 'utf8')).version).toBe(1)
    writeFileSync(sidecar, `${JSON.stringify({ version: 99, specPath: 'widget.md', nodes: [], edges: [] })}\n`)
    ship.refresh()
    expect(flashes).toEqual([])
    expect(JSON.parse(readFileSync(sidecar, 'utf8')).nodes.length).toBe(2)
  })

  it('stops /ship on a Ticket N join failure with no guessed cache', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', 'Status: landing\n\n## Plan\n\n- [ ] Land the teaser\n')
    const flashes: string[] = []
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { flash: text => { flashes.push(text) } })
    await ship.run('', async prompt => { prompts.push(prompt) })
    expect(prompts).toEqual([])
    expect(flashes.some(text => /Ticket N/i.test(text))).toBe(true)
    expect(existsSync(graphPathFor(path))).toBe(false)
    expect(ship.shipGraph).toBeUndefined()
  })

  it('paints land chip as closed/total, not in-flight', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', landing())
    const ship = new ShipRun(cwd, chrome)
    ship.noteWritten([path])
    expect(ship.shipChip).toEqual({ kind: 'land', k: 1, n: 2 })
    expect(ship.shipTeaser).toEqual({ unclaimed: 1, claimed: 0, closed: 1 })
  })

  it('rebuilds the sidecar on a pipe with no occupancy ask', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeSpec(cwd, 'widget.md', landing())
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome)
    await ship.run('', async prompt => { prompts.push(prompt) })
    expect(prompts.length).toBeGreaterThan(0)
    expect(existsSync(graphPathFor(path))).toBe(true)
    expect(ship.shipGraph?.nodes.some(node => node.id === 'landing:1')).toBe(true)
  })
})
