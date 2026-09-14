/**
 * One `/ship` run: chrome and phase injection through the public seam only.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShipRun, wrapHostGoals, type ShipChildCreate, type ShipChildHandle, type ShipFoldBind } from '../src/ship-run.ts'
import { classifyConflictFiles, inspectConflictResolution } from '../src/ship-conflict.ts'
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

  it('injects the next grill frontier round after HITL in the same run()', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'widget.md', 'Status: grilling\n')
    const ship = new ShipRun(cwd, chrome)
    const prompts: string[] = []
    await ship.run('', async prompt => {
      prompts.push(prompt)
      return prompts.length === 1 ? { hitl: true } : undefined
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Follow the grill-me skill')
    expect(prompts[1]).toContain('Follow the grill-me skill')
    expect(prompts[1]).not.toContain('Follow the wayfinder skill')
    expect(prompts[1]).not.toContain('Pure Synthesis, Zero Interrogation')
  })

  it('does not inject again when abort settles a grill HITL turn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'widget.md', 'Status: grilling\n')
    const ship = new ShipRun(cwd, chrome)
    const prompts: string[] = []
    await ship.run('', async prompt => {
      prompts.push(prompt)
      ship.abort()
      return { hitl: true }
    })
    expect(prompts).toHaveLength(1)
  })

  it('injects the next wayfinder turn after a grilling-ticket HITL without leaving wayfinding', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'widget.md', 'Status: wayfinding\n\n## Wayfinder\n\n[Map](../../map.md)\n')
    const ship = new ShipRun(cwd, chrome)
    const prompts: string[] = []
    await ship.run('', async prompt => {
      prompts.push(prompt)
      return prompts.length === 1 ? { hitl: true } : undefined
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Follow the wayfinder skill')
    expect(prompts[1]).toContain('Follow the wayfinder skill')
    expect(prompts[1]).not.toContain('Follow the grill-me skill')
    expect(prompts[1]).not.toContain('git checkout -b')
    expect(prompts[1]).not.toContain('ship · preflight')
    expect(ship.shipChip).toEqual({ kind: 'wayfinder' })
  })

  it('continues after preflight HITL into wayfinder in the same run()', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const ship = new ShipRun(cwd, chrome)
    const prompts: string[] = []
    await ship.run('build a widget', async prompt => {
      prompts.push(prompt)
      if (prompts.length === 1) {
        writeSpec(cwd, 'widget.md', 'Status: wayfinding\n\n## Wayfinder\n\n[Map](../../map.md)\n')
        return { hitl: true }
      }
      return undefined
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('ship · preflight')
    expect(prompts[0]).toContain('Follow the wayfinder skill')
    expect(prompts[1]).toContain('Follow the wayfinder skill')
    expect(prompts[1]).not.toContain('ship · preflight')
    expect(prompts[1]).not.toContain('git checkout -b')
    expect(prompts[1]).not.toContain('Follow the grill-me skill')
  })

  it('does not treat a gate HITL as auto-continue when Status is unchanged', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'widget.md', 'Status: interviewing\n')
    const ship = new ShipRun(cwd, chrome)
    const prompts: string[] = []
    await ship.run('', async prompt => {
      prompts.push(prompt)
      return { hitl: true }
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Pure Synthesis, Zero Interrogation')
  })

  it('pauses an accidentally armed /goal before the next HITL inject', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeSpec(cwd, 'widget.md', 'Status: grilling\n\n## Original Requirement\n\nKeep offline use.\n')
    const goals = recordingGoals()
    const ship = new ShipRun(cwd, chrome, { goals })
    let turns = 0
    await ship.run('', async () => {
      turns += 1
      if (goals.current !== undefined) {
        goals.current.activation = 'armed'
        goals.current.phase = 'active'
      }
      return turns === 1 ? { hitl: true } : undefined
    })
    expect(turns).toBe(2)
    expect(goals.current?.activation).toBe('disarmed')
    expect(goals.current?.phase).toBe('paused')
    expect(goals.log.filter(entry => entry === 'pause:goal-new').length).toBeGreaterThanOrEqual(2)
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
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Strict Red-First Execution')
    expect(prompts[0]).toContain('In-flight:')
    expect(prompts[0]).toContain('Ready-set:')
    expect(prompts[0]).not.toContain('Relentless Frontier Exploration')
    expect(prompts[0]).not.toContain('Active Ticket:')
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

  it('puts the sealed track, spec path, and in-flight / Ready-set into the land prepend (Track: 4)', async () => {
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
    expect(prompts[0]).toContain('In-flight:')
    expect(prompts[0]).toContain('Ready-set:')
    expect(prompts[0]).not.toContain('Active Ticket:')
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
    expect(source).toContain('shipAskSettledHitl')
    expect(source).toContain('hitl: true')
    expect(source).not.toMatch(/hitl[\s\S]{0,80}subagent/)
    expect(source).toContain('childCreate')
    expect(source).toContain('bindRunnerView')
    expect(source).toContain('createChild')
    expect(source).toContain('liveChildren')
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
    expect(landPrompts[0]).toContain('In-flight:')
    expect(landPrompts[0]).toContain('Ready-set:')
    expect(landPrompts[0]).toContain('REQ-001')
    expect(landPrompts[0]).not.toContain('Active Ticket:')
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

  it('lands independent tickets as a wave without one parent turn per ticket', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const issues = join(cwd, '.scratch', 'widget', 'issues')
    mkdirSync(issues, { recursive: true })
    writeFileSync(join(issues, '01-spec-schema.md'), 'Ticket 1: Spec schema\n')
    writeFileSync(join(issues, '02-prompt-contracts.md'), 'Ticket 2: Prompt contracts\n')
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
      '- [ ] Ticket 1: Spec schema (Blocked by: none) (Track: 1)',
      '- [ ] Ticket 2: Prompt contracts (Blocked by: none) (Track: 2)',
    ].join('\n')
    const path = writeSpec(cwd, 'widget.md', markdown)
    const created: string[] = []
    const git: string[] = []
    const children: ShipChildCreate = {
      async create(request) {
        created.push(request.graphKey)
        const handle: ShipChildHandle = {
          id: `child-${request.graphKey}`,
          graphKey: request.graphKey,
          label: request.label,
          done: Promise.resolve(),
          async dispose() {},
        }
        return handle
      },
    }
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, {
      childCreate: children,
      git: async (args, workCwd) => {
        git.push(`${args.join(' ')} @ ${workCwd}`)
        if (args[0] === 'worktree' && args[1] === 'add') {
          const dest = args[args.length - 1]
          if (dest !== undefined && dest !== '') mkdirSync(dest, { recursive: true })
        }
        return { code: 0, output: '' }
      },
    })
    await ship.run('build a widget', async prompt => {
      prompts.push(prompt)
      if (prompt.includes('Phase 5 — done means verified')) {
        const landed = readFileSync(path, 'utf8')
          .replace(/^Status:\s*\S+/mu, 'Status: shipped')
        writeFileSync(path, landed.includes('## Verification')
          ? landed
          : `${landed.trimEnd()}\n\n## Verification\n\n- ACC-001: \`pnpm test\` exit 0\n`)
      }
    })
    expect(created.sort()).toEqual(['landing:1', 'landing:2'])
    const land1 = git.findIndex(entry => entry.includes('merge --no-ff') && /Ticket 1/.test(entry))
    const land2 = git.findIndex(entry => entry.includes('merge --no-ff') && /Ticket 2/.test(entry))
    expect(land1).toBeGreaterThan(-1)
    expect(land2).toBeGreaterThan(land1)
    expect(prompts.some(prompt => prompt.includes('Phase 5 — done means verified'))).toBe(true)
    expect(prompts.every(prompt => !prompt.includes('Active Ticket:'))).toBe(true)
    expect(git.filter(entry => /tick Ticket/.test(entry))).toHaveLength(2)
    expect(readFileSync(path, 'utf8')).toMatch(/- \[x\] Ticket 1:/u)
    expect(readFileSync(path, 'utf8')).toMatch(/- \[x\] Ticket 2:/u)
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
    const flashes: string[] = []
    const ship = new ShipRun(cwd, {
      setPlan: () => {},
      setChip: () => {},
      setTeaser: counts => { teasers.push(counts) },
    }, { flash: text => { flashes.push(text) } })
    ship.noteWritten([path])
    const sidecar = graphPathFor(path)
    expect(existsSync(sidecar)).toBe(true)
    expect(ship.shipTeaser).toEqual({ unclaimed: 1, claimed: 0, closed: 1 })
    expect(teasers.at(-1)).toEqual({ unclaimed: 1, claimed: 0, closed: 1 })
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

  const recordingChildCreate = (): ShipChildCreate & { created: Array<{ prompt: string; cwd?: string; graphKey: string }> } => {
    const created: Array<{ prompt: string; cwd?: string; graphKey: string }> = []
    return {
      created,
      async create(request) {
        created.push({
          prompt: request.prompt,
          graphKey: request.graphKey,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        })
        const handle: ShipChildHandle = {
          id: `child-${String(created.length)}`,
          graphKey: request.graphKey,
          label: request.label,
          async dispose() {},
        }
        return handle
      },
    }
  }

  const recordingFolds = (): ShipFoldBind & { bound: Array<{ id: string; label: string }>; released: string[] } => {
    const bound: Array<{ id: string; label: string }> = []
    const released: string[] = []
    return {
      bound,
      released,
      bind(id, label) { bound.push({ id, label }) },
      release(id) { released.push(id) },
    }
  }

  const landingMarkdown = (): string => [
    'Status: landing',
    'Branch: ship/widget',
    '',
    '## Original Requirement',
    '',
    'Keep offline use.',
    '',
    '## Main Track',
    '',
    '**Idea.** Keep offline use.',
    '**Track-1.** Hybrid compass.',
    '',
    '## Plan',
    '',
    '- [x] Ticket 1: Graph join (Track: 1)',
    '- [ ] Ticket 2: Land the teaser (Track: 1)',
  ].join('\n')

  const writeResearch = (cwd: string, claimed: boolean): string => {
    const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
    mkdirSync(dir, { recursive: true })
    const body = [
      '# Repo facts',
      '',
      'Type: research',
      claimed ? 'Status: claimed' : 'Status: open',
      '',
    ].join('\n')
    writeFileSync(join(dir, '01-repo-facts.md'), body)
    return writeSpec(cwd, 'widget.md', [
      'Status: wayfinding',
      'Branch: ship/widget',
      '',
      '## Original Requirement',
      '',
      'Keep offline use.',
      '',
      '## Wayfinder',
      '',
      '[Map](../../.scratch/widget/wayfinder/map.md)',
    ].join('\n'))
  }

  it('does not AFK-dispatch an unclaimed research ticket', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeResearch(cwd, false)
    const children = recordingChildCreate()
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { childCreate: children })
    await ship.run('', async prompt => {
      prompts.push(prompt)
      return prompts.length === 1 ? { hitl: true } : undefined
    })
    expect(children.created).toEqual([])
    expect(prompts.length).toBeGreaterThan(0)
  })

  it('dispatches a claimed unblocked research ticket as an AFK child with no extra parent prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeResearch(cwd, true)
    const children = recordingChildCreate()
    const folds = recordingFolds()
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, { childCreate: children, folds })
    await ship.run('', async prompt => {
      prompts.push(prompt)
      return undefined
    })
    expect(children.created).toHaveLength(1)
    expect(children.created[0]?.graphKey).toBe('decision:local:1')
    expect(children.created[0]?.cwd).toBe(join(cwd, '.scratch', 'widget', 'worktrees', 'decision-1'))
    expect(folds.bound).toEqual([{ id: 'child-1', label: 'Repo facts' }])
    expect(prompts).toHaveLength(1)
    const scratch = readFileSync(join(cwd, '.scratch', 'widget', 'wayfinder', '01-repo-facts.md'), 'utf8')
    expect(scratch).toMatch(/^Status:\s*claimed\b/imu)
    expect(scratch).not.toMatch(/session-/iu)
  })

  it('writes landing Claim: claimed before worktree and dispatch, leaving the plan checkbox open', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const issues = join(cwd, '.scratch', 'widget', 'issues')
    mkdirSync(issues, { recursive: true })
    writeFileSync(join(issues, '02-land-the-teaser.md'), 'Ticket 2: Land the teaser\n')
    const path = writeSpec(cwd, 'widget.md', landingMarkdown())
    const children = recordingChildCreate()
    const folds = recordingFolds()
    const git: string[] = []
    const prompts: string[] = []
    const ship = new ShipRun(cwd, chrome, {
      childCreate: children,
      folds,
      git: async (args, workCwd) => {
        git.push(`${args.join(' ')} @ ${workCwd}`)
        return { code: 0, output: '' }
      },
    })
    await ship.run('', async prompt => { prompts.push(prompt) })
    const scratch = readFileSync(join(issues, '02-land-the-teaser.md'), 'utf8')
    expect(scratch).toMatch(/^Claim:\s*claimed\b/mu)
    expect(scratch).not.toMatch(/Claim:\s*unclaimed/u)
    expect(readFileSync(path, 'utf8')).toMatch(/- \[ \] Ticket 2:/u)
    expect(children.created).toHaveLength(1)
    expect(children.created[0]?.graphKey).toBe('landing:2')
    expect(children.created[0]?.cwd).toBe(join(cwd, '.scratch', 'widget', 'worktrees', 'landing-2'))
    expect(git.some(entry => entry.includes('worktree add'))).toBe(true)
    const claimAt = git.findIndex(entry => /commit/.test(entry) && /Claim/.test(entry) === false)
    const worktreeAt = git.findIndex(entry => entry.includes('worktree add'))
    expect(worktreeAt).toBeGreaterThan(-1)
    expect(claimAt === -1 || claimAt < worktreeAt || git.some(entry => /commit/.test(entry))).toBe(true)
    expect(folds.bound[0]?.label).toBe('Ticket 2: Land the teaser')
    expect(ship.shipGraph?.nodes.find(node => node.id === 'landing:2')?.claim).toBe('claimed')
  })

  it('reclaims a leftover worktree by writing Claim: claimed and paints no Fold without a Session', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const issues = join(cwd, '.scratch', 'widget', 'issues')
    mkdirSync(issues, { recursive: true })
    writeFileSync(join(issues, '02-land-the-teaser.md'), 'Ticket 2: Land the teaser\n')
    const worktrees = join(cwd, '.scratch', 'widget', 'worktrees')
    mkdirSync(join(worktrees, 'landing-2'), { recursive: true })
    writeFileSync(join(worktrees, '.gitignore'), '*\n')
    writeSpec(cwd, 'widget.md', landingMarkdown())
    const children = recordingChildCreate()
    const folds = recordingFolds()
    const ship = new ShipRun(cwd, chrome, { childCreate: children, folds })
    await ship.run('', async () => {})
    expect(readFileSync(join(issues, '02-land-the-teaser.md'), 'utf8')).toMatch(/^Claim:\s*claimed\b/mu)
    expect(ship.shipGraph?.nodes.find(node => node.id === 'landing:2')?.claim).toBe('claimed')
    expect(folds.bound).toEqual([])
    expect(readdirSync(join(worktrees)).includes('landing-2')).toBe(true)
  })

  it('does not unclaim on occupancy Abort or run abort', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const issues = join(cwd, '.scratch', 'widget', 'issues')
    mkdirSync(issues, { recursive: true })
    writeFileSync(join(issues, '02-land-the-teaser.md'), 'Ticket 2: Land the teaser\nClaim: claimed\n')
    writeSpec(cwd, 'widget.md', landingMarkdown())
    const goals = recordingGoals({
      id: 'stranger-1',
      objective: 'write a novel',
      phase: 'active',
      activation: 'armed',
    })
    const occupancy = async (): Promise<SelectOutcome> => ({ kind: 'chosen', indices: [1] })
    const ship = new ShipRun(cwd, chrome, { goals, occupancy, childCreate: recordingChildCreate() })
    await ship.run('', async () => {})
    expect(readFileSync(join(issues, '02-land-the-teaser.md'), 'utf8')).toMatch(/^Claim:\s*claimed\b/mu)

    const running = new ShipRun(cwd, chrome, { childCreate: recordingChildCreate() })
    await running.run('', async () => { running.abort() })
    expect(readFileSync(join(issues, '02-land-the-teaser.md'), 'utf8')).toMatch(/^Claim:\s*claimed\b/mu)
  })

  it('binds a runner Fold and drops it on release; a pipe never binds', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeResearch(cwd, true)
    const children = recordingChildCreate()
    const folds = recordingFolds()
    const tty = new ShipRun(cwd, chrome, { childCreate: children, folds, isTty: true })
    await tty.run('', async () => {})
    expect(folds.bound).toHaveLength(1)
    await tty.releaseChild(folds.bound[0]!.id)
    expect(folds.released).toEqual([folds.bound[0]!.id])

    const pipeFolds = recordingFolds()
    const pipe = new ShipRun(cwd, chrome, { childCreate: recordingChildCreate(), folds: pipeFolds, isTty: false })
    await pipe.run('', async () => {})
    expect(pipeFolds.bound).toEqual([])
  })
})

describe('Conflict-resolution child', () => {
  const conflictHunk = [
    'export function greet(name: string): string {',
    '<<<<<<< HEAD',
    "  return `hi ${name}`",
    '=======',
    "  return `hello ${name}`",
    '>>>>>>> wt/widget/landing-1',
    '}',
    '',
  ].join('\n')

  const filledHunk = [
    'export function greet(name: string): string {',
    "  return `hello ${name}`",
    '}',
    '',
  ].join('\n')

  it('classifies fillable source hunks and skips lockfile, protected, and no-marker paths', () => {
    expect(classifyConflictFiles([{ path: 'src/greet.ts', content: conflictHunk }])).toEqual({
      kind: 'fillable',
      paths: ['src/greet.ts'],
    })
    expect(classifyConflictFiles([{ path: 'pnpm-lock.yaml', content: conflictHunk }])).toEqual({
      kind: 'skip',
      reason: 'lockfile',
    })
    expect(classifyConflictFiles([{
      path: 'docs/notes.md',
      content: '## Main Track\n\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> them\n',
    }])).toEqual({ kind: 'skip', reason: 'protected-heading' })
    expect(classifyConflictFiles([{ path: 'src/binary.bin', content: 'no markers' }])).toEqual({
      kind: 'skip',
      reason: 'no-marker',
    })
    expect(inspectConflictResolution(
      [{ path: 'src/greet.ts', content: conflictHunk }],
      [{ path: 'src/greet.ts', content: conflictHunk }],
    )).toBe('leftover-markers')
    expect(inspectConflictResolution(
      [{ path: 'src/greet.ts', content: conflictHunk }],
      [{ path: 'src/greet.ts', content: filledHunk }],
      ['src/extra.ts'],
    )).toBe('out-of-span')
    expect(inspectConflictResolution(
      [{ path: 'src/greet.ts', content: conflictHunk }],
      [{ path: 'src/greet.ts', content: filledHunk }],
    )).toBeUndefined()
  })

  function writeLandingSpec(cwd: string): string {
    const issues = join(cwd, '.scratch', 'widget', 'issues')
    mkdirSync(issues, { recursive: true })
    writeFileSync(join(issues, '01-spec-schema.md'), 'Ticket 1: Spec schema\n')
    return writeSpec(cwd, 'widget.md', [
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
      '- [ ] Ticket 1: Spec schema (Blocked by: none) (Track: 1)',
    ].join('\n'))
  }

  function conflictGit(opts: {
    cwd: string
    conflictPath: string
    conflictContent: string
    fill?: string
    unmerged?: string
    porcelain?: string
  }) {
    const log: string[] = []
    let merging = false
    const unmerged = opts.unmerged ?? `100644 abc123 1\t${opts.conflictPath}\n100644 def456 2\t${opts.conflictPath}\n100644 ghi789 3\t${opts.conflictPath}\n`
    return {
      log,
      git: async (args: readonly string[], workCwd: string) => {
        log.push(`${args.join(' ')} @ ${workCwd}`)
        if (args[0] === 'config' && args[1] === 'user.name') return { code: 0, output: 'Ada Lovelace\n' }
        if (args[0] === 'config' && args[1] === 'user.email') return { code: 0, output: 'ada@example.com\n' }
        if (args[0] === 'worktree' && args[1] === 'add') {
          const dest = args[args.length - 1]
          if (dest !== undefined && dest !== '') mkdirSync(dest, { recursive: true })
        }
        if (args.includes('merge') && args.includes('--no-ff')) {
          merging = true
          mkdirSync(join(opts.cwd, dirname(opts.conflictPath)), { recursive: true })
          writeFileSync(join(opts.cwd, opts.conflictPath), opts.conflictContent)
          return { code: 1, output: `CONFLICT (content): Merge conflict in ${opts.conflictPath}\nAutomatic merge failed\n` }
        }
        if (args[0] === 'ls-files' && args[1] === '-u') {
          return { code: 0, output: merging ? unmerged : '' }
        }
        if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
          return { code: 0, output: merging ? `${opts.conflictPath}\n` : '' }
        }
        if (args[0] === 'status' && args.includes('--porcelain')) {
          return { code: 0, output: opts.porcelain ?? (merging ? `UU ${opts.conflictPath}\n` : '') }
        }
        if (args[0] === 'add') {
          if (opts.fill !== undefined && args.includes(opts.conflictPath)) {
            writeFileSync(join(opts.cwd, opts.conflictPath), opts.fill)
          }
          return { code: 0, output: '' }
        }
        if (args.includes('merge') && args.includes('--continue')) {
          merging = false
          return { code: 0, output: '' }
        }
        if (args.includes('merge') && args.includes('--abort')) {
          merging = false
          return { code: 0, output: '' }
        }
        return { code: 0, output: '' }
      },
    }
  }

  it('dispatches one Conflict-resolution child in the merge-target tree then merge --continue', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeLandingSpec(cwd)
    const created: Array<{ graphKey: string; cwd?: string; role?: string; prompt: string }> = []
    const git = conflictGit({ cwd, conflictPath: 'src/greet.ts', conflictContent: conflictHunk, fill: filledHunk })
    const children: ShipChildCreate = {
      async create(request) {
        created.push({
          graphKey: request.graphKey,
          prompt: request.prompt,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.role === undefined ? {} : { role: request.role }),
        })
        if (request.role === 'conflict') writeFileSync(join(cwd, 'src/greet.ts'), filledHunk)
        const handle: ShipChildHandle = {
          id: `child-${request.graphKey}-${request.role ?? 'tdd'}`,
          graphKey: request.graphKey,
          label: request.label,
          ...(request.role === undefined ? {} : { role: request.role }),
          done: Promise.resolve(),
          async dispose() {},
        }
        return handle
      },
    }
    const ship = new ShipRun(cwd, chrome, { childCreate: children, git: git.git })
    await ship.run('build a widget', async prompt => {
      if (prompt.includes('Phase 5 — done means verified')) {
        const path = join(cwd, 'docs', 'specs', 'widget.md')
        const landed = readFileSync(path, 'utf8').replace(/^Status:\s*\S+/mu, 'Status: shipped')
        writeFileSync(path, landed.includes('## Verification')
          ? landed
          : `${landed.trimEnd()}\n\n## Verification\n\n- ACC-001: \`pnpm test\` exit 0\n`)
      }
    })
    const conflictKids = created.filter(row => row.role === 'conflict')
    expect(conflictKids).toHaveLength(1)
    expect(conflictKids[0]?.cwd).toBe(cwd)
    expect(conflictKids[0]?.graphKey).toBe('landing:1')
    expect(conflictKids[0]?.prompt).toContain('Conflict-resolution is not TDD')
    expect(git.log.filter(entry => entry.includes('merge --continue'))).toHaveLength(1)
    expect(git.log.some(entry => /add -- src\/greet\.ts/.test(entry))).toBe(true)
    expect(git.log.some(entry => entry.includes('merge --abort'))).toBe(false)
    expect(readFileSync(join(cwd, '.scratch', 'widget', 'issues', '01-spec-schema.md'), 'utf8')).toMatch(/^Claim:\s*claimed\b/mu)
    expect(ship.shipGraph?.nodes.find(node => node.id === 'landing:1')?.claim).toBe('closed')
    expect(readFileSync(join(cwd, 'docs', 'specs', 'widget.md'), 'utf8')).not.toContain('## Blocker')
  })

  it('skips lockfile conflicts: snapshot, abort, Blocker, no child', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeLandingSpec(cwd)
    const created: string[] = []
    const git = conflictGit({
      cwd,
      conflictPath: 'pnpm-lock.yaml',
      conflictContent: '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> them\n',
    })
    const children: ShipChildCreate = {
      async create(request) {
        created.push(`${request.graphKey}:${request.role ?? 'tdd'}`)
        return {
          id: `child-${created.length}`,
          graphKey: request.graphKey,
          label: request.label,
          done: Promise.resolve(),
          async dispose() {},
        }
      },
    }
    const ship = new ShipRun(cwd, chrome, { childCreate: children, git: git.git })
    await ship.run('build a widget', async () => {})
    expect(created.filter(row => row.endsWith(':conflict'))).toEqual([])
    expect(git.log.some(entry => entry.includes('merge --abort'))).toBe(true)
    expect(git.log.some(entry => entry.includes('merge --continue'))).toBe(false)
    expect(git.log.some(entry => entry.includes('add -f --') && entry.includes('merge-snapshots'))).toBe(true)
    const spec = readFileSync(join(cwd, 'docs', 'specs', 'widget.md'), 'utf8')
    expect(spec).toContain('## Blocker')
    expect(spec).toContain('lockfile')
    const snaps = join(cwd, '.scratch', 'widget', 'merge-snapshots')
    expect(existsSync(join(snaps, '.gitignore'))).toBe(true)
    expect(existsSync(join(snaps, 'landing-1'))).toBe(true)
    expect(readFileSync(join(cwd, '.scratch', 'widget', 'issues', '01-spec-schema.md'), 'utf8')).toMatch(/^Claim:\s*claimed\b/mu)
    expect(ship.shipGraph?.nodes.find(node => node.id === 'landing:1')?.claim).toBe('claimed')
    expect(existsSync(join(cwd, '.scratch', 'widget', 'worktrees', 'landing-1'))).toBe(true)
  })

  it('skips protected-heading hunks and no-marker paths without dispatching a child', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    const path = writeLandingSpec(cwd)
    const created: string[] = []
    const children: ShipChildCreate = {
      async create(request) {
        created.push(`${request.graphKey}:${request.role ?? 'tdd'}`)
        return {
          id: `child-${created.length}`,
          graphKey: request.graphKey,
          label: request.label,
          done: Promise.resolve(),
          async dispose() {},
        }
      },
    }
    const protectedHunk = [
      '## Main Track',
      '',
      '<<<<<<< HEAD',
      '**Track-1.** Hybrid compass.',
      '=======',
      '**Track-1.** Rewrite the sealed track.',
      '>>>>>>> them',
      '',
    ].join('\n')
    const git = conflictGit({ cwd, conflictPath: 'docs/notes.md', conflictContent: protectedHunk })
    const ship = new ShipRun(cwd, chrome, { childCreate: children, git: git.git })
    await ship.run('build a widget', async () => {})
    expect(created.filter(row => row.endsWith(':conflict'))).toEqual([])
    expect(readFileSync(path, 'utf8')).toContain('## Blocker')
    expect(readFileSync(path, 'utf8')).toMatch(/protected-heading|Conflict-resolution skipped/u)

    const cwd2 = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeLandingSpec(cwd2)
    const created2: string[] = []
    const git2 = conflictGit({
      cwd: cwd2,
      conflictPath: 'src/binary.bin',
      conflictContent: 'not a marker file',
    })
    const ship2 = new ShipRun(cwd2, chrome, {
      childCreate: {
        async create(request) {
          created2.push(`${request.graphKey}:${request.role ?? 'tdd'}`)
          return {
            id: `child-${created2.length}`,
            graphKey: request.graphKey,
            label: request.label,
            done: Promise.resolve(),
            async dispose() {},
          }
        },
      },
      git: git2.git,
    })
    await ship2.run('build a widget', async () => {})
    expect(created2.filter(row => row.endsWith(':conflict'))).toEqual([])
    expect(readFileSync(join(cwd2, 'docs', 'specs', 'widget.md'), 'utf8')).toContain('## Blocker')
    expect(git2.log.some(entry => entry.includes('merge --abort'))).toBe(true)
  })

  it('interrupts a Conflict-resolution child with snapshot and abort and no ## Blocker', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeLandingSpec(cwd)
    let resolveChild: () => void = () => {}
    const childDone = new Promise<void>(resolve => { resolveChild = resolve })
    const git = conflictGit({ cwd, conflictPath: 'src/greet.ts', conflictContent: conflictHunk })
    let ship!: ShipRun
    const children: ShipChildCreate = {
      async create(request) {
        if (request.role === 'conflict') queueMicrotask(() => { ship.abort() })
        return {
          id: `child-${request.graphKey}-${request.role ?? 'tdd'}`,
          graphKey: request.graphKey,
          label: request.label,
          ...(request.role === undefined ? {} : { role: request.role }),
          done: request.role === 'conflict' ? childDone : Promise.resolve(),
          async dispose() {},
        }
      },
    }
    ship = new ShipRun(cwd, chrome, { childCreate: children, git: git.git })
    const running = ship.run('build a widget', async () => {})
    await waitFor(() => git.log.some(entry => entry.includes('merge --abort')))
    resolveChild()
    await running
    expect(git.log.some(entry => entry.includes('merge --abort'))).toBe(true)
    expect(git.log.some(entry => entry.includes('merge --continue'))).toBe(false)
    expect(readFileSync(join(cwd, 'docs', 'specs', 'widget.md'), 'utf8')).not.toContain('## Blocker')
    expect(existsSync(join(cwd, '.scratch', 'widget', 'merge-snapshots', 'landing-1'))).toBe(true)
    expect(git.log.some(entry => entry.includes('add -f --') && entry.includes('merge-snapshots'))).toBe(false)
    expect(readFileSync(join(cwd, '.scratch', 'widget', 'issues', '01-spec-schema.md'), 'utf8')).toMatch(/^Claim:\s*claimed\b/mu)
  })

  it('lets alignTool allow Conflict-resolution hunk writes without requirement mapping', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeLandingSpec(cwd)
    let resolveChild: () => void = () => {}
    const childDone = new Promise<void>(resolve => { resolveChild = resolve })
    const git = conflictGit({ cwd, conflictPath: 'src/greet.ts', conflictContent: conflictHunk, fill: filledHunk })
    let ship!: ShipRun
    let aligned: boolean | undefined
    const children: ShipChildCreate = {
      async create(request) {
        if (request.role === 'conflict') {
          writeFileSync(join(cwd, 'src/greet.ts'), filledHunk)
          aligned = ship.alignTool('write', {
            file_path: 'src/greet.ts',
            content: filledHunk,
            supports: ['REQ-999'],
          }).allow
        }
        return {
          id: `child-${request.graphKey}-${request.role ?? 'tdd'}`,
          graphKey: request.graphKey,
          label: request.label,
          ...(request.role === undefined ? {} : { role: request.role }),
          done: request.role === 'conflict' ? childDone : Promise.resolve(),
          async dispose() {},
        }
      },
    }
    ship = new ShipRun(cwd, chrome, { childCreate: children, git: git.git })
    const running = ship.run('build a widget', async prompt => {
      if (prompt.includes('Phase 5 — done means verified')) {
        const path = join(cwd, 'docs', 'specs', 'widget.md')
        const landed = readFileSync(path, 'utf8').replace(/^Status:\s*\S+/mu, 'Status: shipped')
        writeFileSync(path, landed.includes('## Verification')
          ? landed
          : `${landed.trimEnd()}\n\n## Verification\n\n- ACC-001: \`pnpm test\` exit 0\n`)
      }
    })
    await waitFor(() => aligned !== undefined)
    expect(aligned).toBe(true)
    resolveChild()
    await running
  })

  it('treats leftover markers after the child as snapshot + abort + Blocker', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeLandingSpec(cwd)
    const created: string[] = []
    const git = conflictGit({ cwd, conflictPath: 'src/greet.ts', conflictContent: conflictHunk })
    const children: ShipChildCreate = {
      async create(request) {
        created.push(`${request.graphKey}:${request.role ?? 'tdd'}`)
        return {
          id: `child-${created.length}`,
          graphKey: request.graphKey,
          label: request.label,
          ...(request.role === undefined ? {} : { role: request.role }),
          done: Promise.resolve(),
          async dispose() {},
        }
      },
    }
    await new ShipRun(cwd, chrome, { childCreate: children, git: git.git }).run('build a widget', async () => {})
    expect(created.filter(row => row.endsWith(':conflict'))).toHaveLength(1)
    expect(git.log.some(entry => entry.includes('merge --abort'))).toBe(true)
    expect(git.log.some(entry => entry.includes('merge --continue'))).toBe(false)
    expect(readFileSync(join(cwd, 'docs', 'specs', 'widget.md'), 'utf8')).toContain('## Blocker')
    expect(readFileSync(join(cwd, 'docs', 'specs', 'widget.md'), 'utf8')).toContain('leftover-markers')
  })
})

describe('Delivery auto Merge-back', () => {
  const conflictHunk = [
    'export function greet(name: string): string {',
    '<<<<<<< HEAD',
    "  return `hi ${name}`",
    '=======',
    "  return `hello ${name}`",
    '>>>>>>> ship/widget',
    '}',
    '',
  ].join('\n')

  function writeDeliverySpec(cwd: string): string {
    const issues = join(cwd, '.scratch', 'widget', 'issues')
    mkdirSync(issues, { recursive: true })
    writeFileSync(join(issues, '01-spec-schema.md'), 'Claim: claimed\nProof: green\nTicket 1: Spec schema\n')
    return writeSpec(cwd, 'widget.md', [
      'Status: landing',
      'Branch: ship/widget',
      'Original-Branch: main',
      '',
      '## Original Requirement',
      '',
      'Keep offline use.',
      '',
      '## Main Track',
      '',
      '**Idea.** Keep offline use.',
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
      '- [x] Ticket 1: Spec schema (Blocked by: none) (Track: 1)',
    ].join('\n'))
  }

  function shipVerified(cwd: string): void {
    const path = join(cwd, 'docs', 'specs', 'widget.md')
    const landed = readFileSync(path, 'utf8').replace(/^Status:\s*\S+/mu, 'Status: shipped')
    writeFileSync(path, landed.includes('## Verification')
      ? landed
      : `${landed.trimEnd()}\n\n## Verification\n\n- ACC-001: \`pnpm test\` exit 0\n`)
  }

  function deliveryGit(opts: {
    cwd: string
    ff?: boolean
    squashConflict?: boolean
    conflictPath?: string
    conflictContent?: string
    fill?: string
    head?: string
  }) {
    const log: string[] = []
    const branches = new Set(['main', 'ship/widget'])
    let merging = false
    const conflictPath = opts.conflictPath ?? 'src/greet.ts'
    const unmerged = `100644 abc123 1\t${conflictPath}\n100644 def456 2\t${conflictPath}\n100644 ghi789 3\t${conflictPath}\n`
    return {
      log,
      branches,
      git: async (args: readonly string[], workCwd: string) => {
        log.push(`${args.join(' ')} @ ${workCwd}`)
        if (args[0] === 'config' && args[1] === 'user.name') return { code: 0, output: 'Ada Lovelace\n' }
        if (args[0] === 'config' && args[1] === 'user.email') return { code: 0, output: 'ada@example.com\n' }
        if (args[0] === 'rev-parse' && args.includes('HEAD')) {
          return { code: 0, output: `${opts.head ?? 'premergeabc'}\n` }
        }
        if (args.includes('merge') && args.includes('--ff-only')) {
          return opts.ff === false
            ? { code: 1, output: 'fatal: Not possible to fast-forward\n' }
            : { code: 0, output: '' }
        }
        if (args.includes('merge') && args.includes('--squash')) {
          if (opts.squashConflict === true) {
            merging = true
            mkdirSync(join(opts.cwd, dirname(conflictPath)), { recursive: true })
            writeFileSync(join(opts.cwd, conflictPath), opts.conflictContent ?? '')
            return { code: 1, output: `CONFLICT (content): Merge conflict in ${conflictPath}\nAutomatic merge failed\n` }
          }
          return { code: 0, output: '' }
        }
        if (args[0] === 'ls-files' && args[1] === '-u') {
          return { code: 0, output: merging ? unmerged : '' }
        }
        if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
          return { code: 0, output: merging ? `${conflictPath}\n` : '' }
        }
        if (args[0] === 'status' && args.includes('--porcelain')) {
          return { code: 0, output: merging ? `UU ${conflictPath}\n` : '' }
        }
        if (args[0] === 'add') {
          if (opts.fill !== undefined && args.includes(conflictPath)) {
            writeFileSync(join(opts.cwd, conflictPath), opts.fill)
          }
          return { code: 0, output: '' }
        }
        if (args.includes('merge') && args.includes('--continue')) {
          merging = false
          return { code: 0, output: '' }
        }
        if (args.includes('merge') && args.includes('--abort')) {
          merging = false
          return { code: 0, output: '' }
        }
        if (args[0] === 'branch' && (args[1] === '-D' || args[1] === '-d')) {
          const name = args[2]
          if (name !== undefined) branches.delete(name)
        }
        return { code: 0, output: '' }
      },
    }
  }

  it('fast-forwards onto Original-Branch after dual-layer proof without a deliver prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeDeliverySpec(cwd)
    const git = deliveryGit({ cwd })
    const prompts: string[] = []
    let proved = 0
    const goals = recordingGoals()
    const ship = new ShipRun(cwd, chrome, {
      git: git.git,
      goals,
      proveDelivery: async () => {
        proved += 1
        return 'green'
      },
    })
    await ship.run('Keep offline use.', async prompt => {
      prompts.push(prompt)
      if (prompt.includes('Phase 5 — done means verified')) shipVerified(cwd)
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Phase 5 — done means verified')
    expect(prompts[0]).toContain('auto-picks Merge back')
    expect(git.log.some(entry => entry.includes('checkout main'))).toBe(true)
    expect(git.log.some(entry => /merge --ff-only ship\/widget/.test(entry))).toBe(true)
    expect(git.log.some(entry => entry.includes('merge --squash'))).toBe(false)
    expect(proved).toBe(0)
    expect(goals.log).toContain('complete:goal-new')
  })

  it('squashes with the host author and spec title then re-proves when fast-forward is impossible', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeDeliverySpec(cwd)
    const git = deliveryGit({ cwd, ff: false })
    let proved = 0
    const ship = new ShipRun(cwd, chrome, {
      git: git.git,
      proveDelivery: async () => {
        proved += 1
        return 'green'
      },
    })
    await ship.run('Keep offline use.', async prompt => {
      if (prompt.includes('Phase 5 — done means verified')) shipVerified(cwd)
    })
    expect(git.log.some(entry => /merge --ff-only ship\/widget/.test(entry))).toBe(true)
    expect(git.log.some(entry => /merge --squash ship\/widget/.test(entry))).toBe(true)
    expect(git.log.some(entry =>
      entry.includes('commit')
      && entry.includes('user.name=Ada Lovelace')
      && entry.includes('Keep offline use.'),
    )).toBe(true)
    expect(proved).toBe(1)
    expect(git.log.some(entry => /branch -[Dd] ship\/widget/.test(entry))).toBe(false)
  })

  it('dispatches one Merge-back Conflict-resolution child with directory delivery', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeDeliverySpec(cwd)
    const created: Array<{ graphKey: string; cwd?: string; role?: string }> = []
    const git = deliveryGit({
      cwd,
      ff: false,
      squashConflict: true,
      conflictPath: 'src/greet.ts',
      conflictContent: conflictHunk,
    })
    const children: ShipChildCreate = {
      async create(request) {
        created.push({
          graphKey: request.graphKey,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.role === undefined ? {} : { role: request.role }),
        })
        return {
          id: `child-${request.graphKey}-${request.role ?? 'tdd'}`,
          graphKey: request.graphKey,
          label: request.label,
          ...(request.role === undefined ? {} : { role: request.role }),
          done: Promise.resolve(),
          async dispose() {},
        }
      },
    }
    await new ShipRun(cwd, chrome, { childCreate: children, git: git.git }).run('Keep offline use.', async prompt => {
      if (prompt.includes('Phase 5 — done means verified')) shipVerified(cwd)
    })
    const conflictKids = created.filter(row => row.role === 'conflict')
    expect(conflictKids).toHaveLength(1)
    expect(conflictKids[0]?.graphKey).toBe('delivery')
    expect(conflictKids[0]?.cwd).toBe(cwd)
    expect(git.log.some(entry => entry.includes('merge --abort'))).toBe(true)
    expect(existsSync(join(cwd, '.scratch', 'widget', 'merge-snapshots', 'delivery'))).toBe(true)
    expect(readFileSync(join(cwd, 'docs', 'specs', 'widget.md'), 'utf8')).toContain('## Blocker')
    expect(git.branches.has('ship/widget')).toBe(true)
  })

  it('resets Original-Branch on red delivery proof and keeps ship/<slug>', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-run-'))
    writeDeliverySpec(cwd)
    const git = deliveryGit({ cwd, ff: false, head: 'premergeabc' })
    const goals = recordingGoals()
    const ship = new ShipRun(cwd, chrome, {
      git: git.git,
      goals,
      proveDelivery: async () => 'red',
    })
    await ship.run('Keep offline use.', async prompt => {
      if (prompt.includes('Phase 5 — done means verified')) shipVerified(cwd)
    })
    expect(git.log.some(entry => /merge --squash ship\/widget/.test(entry))).toBe(true)
    expect(git.log.some(entry => /reset --hard premergeabc/.test(entry))).toBe(true)
    expect(git.log.some(entry => /branch -[Dd] ship\/widget/.test(entry))).toBe(false)
    expect(git.branches.has('ship/widget')).toBe(true)
    expect(goals.log).not.toContain('complete:goal-new')
  })
})

async function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
}
