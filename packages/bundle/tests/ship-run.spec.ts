/**
 * One `/ship` run: chrome and phase injection through the public seam only.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShipRun } from '../src/ship-run.ts'
import type { Plan } from '../src/plan.ts'
import type { ShipChip } from '../src/status.ts'

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
})
