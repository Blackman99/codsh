/**
 * One `/ship` run: chrome and phase injection through the public seam only.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShipRun, wrapHostGoals } from '../src/ship-run.ts'
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
    ? 'Status: landing\n\n## Plan\n\n- [x] a\n- [ ] b\n'
    : 'Status: landing\n\n## Plan\n\n- [x] a\n- [x] b\n'

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

  it('injects grill when no spec exists, then stops', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const prompts: string[] = []
    const chips: Array<ShipChip | undefined> = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: chip => { chips.push(chip) },
    })
    await ship.run('build a widget', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Follow the grill-me skill as the contract, not a summary of it')
    expect(prompts[0]).not.toContain('Pure Synthesis, Zero Interrogation')
    expect(chips[0]).toEqual({ kind: 'grill' })
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
    expect(ship.shipChip).toEqual({ kind: 'land', k: 2, n: 2 })
    expect(ship.shipPlan?.done).toBe(1)
    await ship.run('', async (prompt) => { prompts.push(prompt) })
    expect(prompts).toHaveLength(1)
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
    expect(ship.shipPlan?.current?.title).toBe('b')
    writeFileSync(path, landing('ab'))
    ship.refresh()
    expect(ship.shipPlan?.done).toBe(2)
    expect(ship.shipPlan?.current).toBeUndefined()
    expect(ship.shipChip).toEqual({ kind: 'verify' })
  })

  it('ignores a shipped spec that this session did not write', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'old.md', 'Status: shipped\n\n## Plan\n\n- [x] a\n')
    const chips: Array<ShipChip | undefined> = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: chip => { chips.push(chip) },
    })
    await ship.run('new idea', async () => {})
    expect(chips[0]).toEqual({ kind: 'grill' })
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
    const second = ship.run('two', async (prompt) => { prompts.push(prompt) })
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
    writeFileSync(path, 'Status: shipped\n\n## Plan\n\n- [x] a\n- [x] b\n')
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
    const path = writeSpec(cwd, 'widget.md', 'Status: landing\n\n## Plan\n\n- [ ] a\n- [ ] b\n')
    const chips: ShipChip[] = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: chip => { if (chip !== undefined) chips.push(chip) },
    })
    ship.noteWritten([path])
    expect(ship.shipChip).toEqual({ kind: 'land', k: 1, n: 2 })
    writeFileSync(path, 'Status: landing\n\n## Plan\n\n- [x] a\n- [ ] b\n')
    ship.refresh()
    expect(ship.shipChip).toEqual({ kind: 'land', k: 2, n: 2, flashOk: true })
    vi.advanceTimersByTime(400)
    expect(ship.shipChip).toEqual({ kind: 'land', k: 2, n: 2 })
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
    expect(prompts[0]).toContain('Follow the grill-me skill as the contract, not a summary of it')
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
    expect(prompts[0]).toContain('Follow the grill-me skill as the contract, not a summary of it')
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
})

describe('composition root', () => {
  it('constructs ShipRun with goals, occupancy, and flash ports (Track: 1,9)', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
    expect(source).toContain('wrapHostGoals')
    expect(source).toContain("ctx.get('goals')")
    expect(source).toContain('prompt.select')
    expect(source).toContain('prompt.setFlash')
    expect(source).not.toContain('GoalBar')
    expect(source).toMatch(/new ShipRun\([\s\S]*goals/)
  })
})
