import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import {
  CHILD_MESSAGE,
  CLIENT_GONE,
  DURABLE_MESSAGE,
  EXPIRY_MS,
  MARK,
  ONE_SHOT_MESSAGE,
  OWNER_LOST,
  REGISTRY,
  SchedulerError,
  createScheduler,
  createStore,
  fireLabel,
  framedPrompt,
  intervalToHuman,
  ownerLockHeld,
  parseInterval,
  permissionMode,
  registerScheduler,
  scaledClock,
  scheduleFooter,
  unknownOutcome,
  uuidv7,
  validSessionId,
} from '../packages/cli/bin/rust-acp-scheduler.mjs'
import { MARK as SUBAGENT_MARK } from '../packages/cli/bin/rust-acp-subagents.mjs'
import { createControl } from '../packages/cli/bin/rust-acp-control.mjs'

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve))
}

/** A manual scheduler clock: timers run only when a test advances time. */
function fakeClock(start = Date.UTC(2026, 8, 25, 2, 0, 0)) {
  let time = start
  const timers = new Set()
  return {
    now: () => time,
    realNow: () => time,
    setTimer(fn, ms) {
      const handle = { at: time + ms, fn }
      timers.add(handle)
      return handle
    },
    clearTimer(handle) {
      timers.delete(handle)
    },
    async advance(ms) {
      const end = time + ms
      for (;;) {
        const next = [...timers].filter(handle => handle.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers.delete(next)
        time = next.at
        next.fn()
        await flush()
      }
      time = end
      await flush()
    },
    pending: () => timers.size,
  }
}

/** A scheduler whose fires are recorded and settled by the test. */
function harness(options = {}) {
  const clock = fakeClock(options.start)
  const events = []
  const fires = []
  let jobs = 0
  const scheduler = createScheduler({
    ...clock,
    emit: event => events.push(event),
    uuid: () => `task-${events.filter(event => event.event === 'created' && !event.updated).length + 1}`,
    startFire(spec) {
      if (options.failNext?.()) return Promise.reject(new Error('no slot for the fire'))
      let resolve
      const done = new Promise(settle => {
        resolve = settle
      })
      jobs += 1
      const fire = { ...spec, jobId: `subagent-${jobs}`, resolve, done }
      fires.push(fire)
      return Promise.resolve({ jobId: fire.jobId, subagent: `loop-${jobs}`, done })
    },
    store: options.store,
    ownerHeld: options.ownerHeld,
    mode: options.mode,
    paused: options.paused,
  })
  const owner = { id: 's1' }
  return { clock, events, fires, scheduler, owner }
}

const kinds = events => events.map(event => event.event)

describe('scheduler interval rules', () => {
  it('parses the reference interval format and clamps to 60 seconds', () => {
    expect(parseInterval('5m')).toBe(300)
    expect(parseInterval('1m')).toBe(60)
    expect(parseInterval('2h')).toBe(7200)
    expect(parseInterval('7d')).toBe(604800)
    expect(parseInterval('30s')).toBe(60)
    expect(parseInterval('1s')).toBe(60)
    expect(parseInterval('120s')).toBe(120)
    expect(parseInterval(' 10m ')).toBe(600)
    const error = text => {
      try {
        parseInterval(text)
      } catch (cause) {
        expect(cause).toBeInstanceOf(SchedulerError)
        return cause.message
      }
      throw new Error(`accepted ${text}`)
    }
    expect(error('')).toBe('invalid interval: interval cannot be empty')
    expect(error('abc')).toBe('invalid interval: invalid interval format: "abc" (expected e.g. 5m, 2h, 1d)')
    expect(error('m')).toBe('invalid interval: invalid interval format: "m" (expected e.g. 5m, 2h, 1d)')
    expect(error('5x')).toBe('invalid interval: invalid interval suffix: "x" (expected s, m, h, or d)')
    expect(error('0m')).toBe('invalid interval: interval value must be greater than 0')
    expect(error('0s')).toBe('invalid interval: interval value must be greater than 0')
    expect(error('99999999999999999999d')).toContain('invalid interval format')
    expect(error('999999999999999d')).toBe('invalid interval: interval too large: "999999999999999d"')
  })

  it('words schedules like the reference', () => {
    expect(intervalToHuman(60)).toBe('every 1 minute')
    expect(intervalToHuman(300)).toBe('every 5 minutes')
    expect(intervalToHuman(3600)).toBe('every 1 hour')
    expect(intervalToHuman(7200)).toBe('every 2 hours')
    expect(intervalToHuman(86400)).toBe('every 1 day')
    expect(intervalToHuman(172800)).toBe('every 2 days')
    expect(intervalToHuman(90)).toBe('every 90 seconds')
  })

  it('frames a fire, labels it, and words the relayed footer', () => {
    const plain = framedPrompt({ id: 't1', human: 'every 5 minutes', prompt: 'check deploy' })
    expect(plain).toBe("<system-reminder>\nScheduled task t1 (every 5 minutes). Each iteration starts fresh; the previous iteration's final status, if any, is below.\nRun the task below. End with a short status: what changed or needs attention. The status is relayed to the main agent.\n</system-reminder>\n\ncheck deploy")
    const prior = framedPrompt({ id: 't1', human: 'every 5 minutes', prompt: 'check deploy', prior: 'x'.repeat(700) })
    expect(prior).toContain(`\nYour previous iteration ended with:\n${'x'.repeat(600)}\n</system-reminder>`)
    expect(prior).not.toContain('x'.repeat(601))
    // The child has no scheduler tools, so its prompt names none.
    expect(plain).not.toContain('scheduler_delete')
    expect(fireLabel(`${'a'.repeat(70)}\nsecond line`, 'every 1 hour')).toBe(`loop: ${'a'.repeat(60)} (every 1 hour)`)
    expect(scheduleFooter('t1')).toBe('If this schedule is no longer relevant, run scheduler_delete("t1"). If it is outdated, you can update it with scheduler_create(new_prompt, interval, "t1").')
    expect(uuidv7(Date.UTC(2026, 8, 25))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('scheduler behavior with a fake clock', () => {
  it('refuses bad creates and updates with the reference sentences', () => {
    const { scheduler, owner, events } = harness()
    const refuse = args => {
      try {
        scheduler.create(args, owner, 's1')
      } catch (cause) {
        return cause.message
      }
      throw new Error('accepted')
    }
    expect(refuse({ prompt: 'x' })).toBe('interval is required when creating a task')
    expect(refuse({ interval: '5m' })).toBe('prompt is required when creating a task')
    expect(refuse({ interval: '5m', prompt: 'x', recurring: false })).toBe(ONE_SHOT_MESSAGE)
    expect(refuse({ interval: '5m', prompt: 'x', durable: true })).toBe(DURABLE_MESSAGE)
    expect(refuse({ interval: '5q', prompt: 'x' })).toBe('invalid interval: invalid interval suffix: "q" (expected s, m, h, or d)')
    expect(refuse({ task_id: 'abc123' })).toBe('nothing to update: provide interval and/or prompt alongside task_id')
    expect(refuse({ task_id: 'nope', prompt: 'x' })).toBe('no scheduled task with id nope; call scheduler_list to see active task ids')
    expect(events).toEqual([])
    // null is "not given", as in the reference schema.
    expect(scheduler.create({ interval: '5m', prompt: 'x', task_id: null, durable: null }, owner, 's1')).toEqual({ id: 'task-1', humanSchedule: 'every 5 minutes', updated: false })
    for (let index = 1; index < 50; index += 1) scheduler.create({ interval: '5m', prompt: `p${index}` }, owner, 's1')
    expect(scheduler.count('s1')).toBe(50)
    expect(refuse({ interval: '5m', prompt: 'one too many' })).toBe('maximum of 50 scheduled tasks reached')
    // The cap is per session.
    expect(scheduler.create({ interval: '5m', prompt: 'other' }, owner, 's2').updated).toBe(false)
  })

  it('waits one interval by default, then fires a background run on the cadence', async () => {
    const { scheduler, owner, events, fires, clock } = harness()
    expect(scheduler.create({ interval: '5m', prompt: 'check deploy' }, owner, 's1')).toEqual({ id: 'task-1', humanSchedule: 'every 5 minutes', updated: false })
    expect(events[0]).toMatchObject({ event: 'created', id: 'task-1', session: 's1', prompt: 'check deploy', human: 'every 5 minutes', intervalSecs: 300, updated: false, fireImmediately: false, nextFireAt: '2026-09-25T02:05:00.000Z', expiresAt: '2026-10-02T02:00:00.000Z' })
    await clock.advance(299_000)
    expect(fires).toHaveLength(0)
    await clock.advance(1000)
    expect(fires).toHaveLength(1)
    expect(fires[0].owner).toBe(owner)
    expect(fires[0].label).toBe('loop: check deploy (every 5 minutes)')
    expect(fires[0].prompt).toBe(framedPrompt({ id: 'task-1', human: 'every 5 minutes', prompt: 'check deploy' }))
    expect(fires[0].task).toMatchObject({ id: 'task-1', fire: 1 })
    expect(events.at(-1)).toMatchObject({ event: 'fired', id: 'task-1', fire: 1, job: 'subagent-1', subagent: 'loop-1', nextFireAt: '2026-09-25T02:10:00.000Z' })
    // The job carries the status for the notice and the footer for job_output.
    expect(fires[0].shape({ status: 'completed', text: 'all green\nnothing to do\n' })).toEqual({
      output: `all green\nnothing to do\n\n${scheduleFooter('task-1')}`,
      detail: 'scheduled task task-1 fire 1: all green nothing to do',
    })
    fires[0].resolve({ status: 'completed', text: 'all green' })
    await flush()
    expect(events.at(-1)).toEqual({ event: 'result', id: 'task-1', session: 's1', fire: 1, status: 'completed', summary: 'all green' })
    await clock.advance(300_000)
    expect(fires).toHaveLength(2)
    // A fresh fire gets the previous iteration's status.
    expect(fires[1].prompt).toContain('\nYour previous iteration ended with:\nall green\n')
  })

  it('fires at once with fire_immediately and keeps the cadence from that fire', async () => {
    const { scheduler, owner, events, fires, clock } = harness()
    scheduler.create({ interval: '1h', prompt: 'watch', fire_immediately: true }, owner, 's1')
    expect(events[0]).toMatchObject({ fireImmediately: true, nextFireAt: '2026-09-25T02:00:00.000Z' })
    await clock.advance(0)
    expect(fires).toHaveLength(1)
    fires[0].resolve({ status: 'completed', text: 'ok' })
    await clock.advance(3_599_000)
    expect(fires).toHaveLength(1)
    await clock.advance(1000)
    expect(fires).toHaveLength(2)
    expect(scheduler.list('s1').tasks[0]).toMatchObject({ createdAt: '2026-09-25T01:00:00.000Z', nextFireAt: '2026-09-25T04:00:00.000Z' })
  })

  it('skips a fire while the previous iteration runs; the cadence still advances', async () => {
    const { scheduler, owner, events, fires, clock } = harness()
    scheduler.create({ interval: '1m', prompt: 'slow' }, owner, 's1')
    await clock.advance(60_000)
    expect(fires).toHaveLength(1)
    await clock.advance(60_000)
    expect(fires).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ event: 'skipped', id: 'task-1', reason: 'the previous iteration is still running', nextFireAt: '2026-09-25T02:03:00.000Z' })
    fires[0].resolve({ status: 'failed', text: 'provider failed' })
    await flush()
    expect(events.at(-1)).toMatchObject({ event: 'result', status: 'failed', summary: 'provider failed' })
    await clock.advance(60_000)
    expect(fires).toHaveLength(2)
    // A failed iteration gives the next one nothing to continue from.
    expect(fires[1].prompt).not.toContain('previous iteration ended')
  })

  it('updates in place: the phase is kept, a due update does not fire, a new prompt starts clean', async () => {
    const { scheduler, owner, events, fires, clock } = harness()
    scheduler.create({ interval: '10m', prompt: 'old' }, owner, 's1')
    await clock.advance(600_000)
    fires[0].resolve({ status: 'completed', text: 'old status' })
    await clock.advance(240_000)
    // 4 minutes into the next period: 5m keeps the phase (next at +5m from the fire).
    expect(scheduler.create({ task_id: 'task-1', interval: '5m' }, owner, 's1')).toEqual({ id: 'task-1', humanSchedule: 'every 5 minutes', updated: true })
    expect(events.at(-1)).toMatchObject({ event: 'created', updated: true, nextFireAt: '2026-09-25T02:15:00.000Z' })
    // Shrinking to 1m makes the next fire overdue: it restarts from now instead.
    scheduler.create({ task_id: 'task-1', interval: '1m' }, owner, 's1')
    await flush()
    expect(fires).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ nextFireAt: '2026-09-25T02:15:00.000Z' })
    scheduler.create({ task_id: 'task-1', prompt: 'new' }, owner, 's1')
    await clock.advance(60_000)
    expect(fires).toHaveLength(2)
    expect(fires[1].prompt.endsWith('\n\nnew')).toBe(true)
    expect(fires[1].prompt).not.toContain('old status')
  })

  it('expires after 7 days without a last fire', async () => {
    const { scheduler, owner, events, fires, clock } = harness()
    scheduler.create({ interval: '1d', prompt: 'daily' }, owner, 's1')
    for (let day = 1; day <= 6; day += 1) {
      await clock.advance(86_400_000)
      fires.at(-1)?.resolve({ status: 'completed', text: `day ${day}` })
      await flush()
    }
    expect(fires).toHaveLength(6)
    await clock.advance(86_400_000)
    expect(fires).toHaveLength(6)
    expect(events.at(-1)).toEqual({ event: 'removed', id: 'task-1', session: 's1', reason: 'expired', saved: false })
    expect(scheduler.count('s1')).toBe(0)
    expect(clock.pending()).toBe(0)
    expect(EXPIRY_MS).toBe(7 * 86_400_000)
  })

  it('reports a fire that could not start and retries on the next tick', async () => {
    let fail = true
    const { scheduler, owner, events, fires, clock } = harness({ failNext: () => fail })
    scheduler.create({ interval: '1m', prompt: 'p' }, owner, 's1')
    await clock.advance(60_000)
    expect(events.at(-1)).toMatchObject({ event: 'failed', id: 'task-1', fire: 1, detail: 'no slot for the fire' })
    fail = false
    await clock.advance(60_000)
    expect(fires).toHaveLength(1)
    expect(fires[0].task.fire).toBe(1)
  })

  it('deletes without killing an in-flight fire and lists truncated prompts', async () => {
    const { scheduler, owner, events, fires, clock } = harness()
    const long = `${'p'.repeat(85)}`
    scheduler.create({ interval: '1m', prompt: long }, owner, 's1')
    scheduler.create({ interval: '2h', prompt: 'short' }, owner, 's1')
    expect(scheduler.list('s1')).toEqual({
      tasks: [
        { id: 'task-1', prompt: `${'p'.repeat(80)}...`, intervalHuman: 'every 1 minute', nextFireAt: '2026-09-25T02:01:00.000Z', createdAt: '2026-09-25T02:00:00.000Z', recurring: true },
        { id: 'task-2', prompt: 'short', intervalHuman: 'every 2 hours', nextFireAt: '2026-09-25T04:00:00.000Z', createdAt: '2026-09-25T02:00:00.000Z', recurring: true },
      ],
    })
    expect(scheduler.list('s2')).toEqual({ tasks: [] })
    await clock.advance(60_000)
    expect(scheduler.delete('task-1', 's2')).toEqual({ success: false, message: 'No scheduled task with ID task-1 found. Use scheduler_list to see active tasks.' })
    expect(scheduler.delete('task-1', 's1')).toEqual({ success: true, message: 'Scheduled task task-1 cancelled.' })
    expect(events.at(-1)).toEqual({ event: 'removed', id: 'task-1', session: 's1', reason: 'deleted', saved: false })
    fires[0].resolve({ status: 'completed', text: 'late status' })
    await flush()
    expect(events.at(-1)).toMatchObject({ event: 'result', id: 'task-1', status: 'completed', summary: 'late status' })
    await clock.advance(600_000)
    expect(fires).toHaveLength(1)
    expect(scheduler.delete('task-1', 's1').success).toBe(false)
  })

  it('ends tasks with their session and with the process', () => {
    const { scheduler, owner, events, clock } = harness()
    scheduler.create({ interval: '1m', prompt: 'a' }, owner, 's1')
    scheduler.create({ interval: '1m', prompt: 'b' }, owner, 's2')
    scheduler.dropSession('s1')
    expect(events.at(-1)).toEqual({ event: 'removed', id: 'task-1', session: 's1', reason: 'session_closed', saved: false })
    scheduler.shutdown()
    expect(events.at(-1)).toEqual({ event: 'removed', id: 'task-2', session: 's2', reason: 'shutdown', saved: false })
    expect(clock.pending()).toBe(0)
    expect(kinds(events)).toEqual(['created', 'created', 'removed', 'removed'])
  })

  it('runs a scaled clock faster than the wall clock', async () => {
    const clock = scaledClock(1000)
    const start = clock.now()
    const fired = await new Promise(resolve => {
      clock.setTimer(() => resolve(clock.now()), 60_000)
    })
    expect(fired - start).toBeGreaterThanOrEqual(59_000)
    const cleared = clock.setTimer(() => {
      throw new Error('cleared timer ran')
    }, 1000)
    clock.clearTimer(cleared)
    await new Promise(resolve => setTimeout(resolve, 20))
  })
})

describe('saved loops across restarts (ticket 178)', () => {
  const temps = []
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  /** A store in a temp dir whose saves fail while `failing.on` is set. */
  function tempStore() {
    const dir = mkdtempSync(join('/tmp', 'codsh-schedules-'))
    temps.push(dir)
    const real = createStore(dir)
    const failing = { on: false }
    const store = {
      ...real,
      save(session, records) {
        if (failing.on) throw new Error('disk full')
        return real.save(session, records)
      },
    }
    return { dir, store, failing, file: session => join(dir, `${session}.json`), read: session => JSON.parse(readFileSync(join(dir, `${session}.json`), 'utf8')) }
  }
  const lockHolder = (token = 'tok') => {
    const lock = { token }
    return { lock, ownerHeld: (_session, candidate) => candidate === lock.token }
  }

  it('saves loops once the owner hands over, restores them, and fires an overdue loop once', async () => {
    const saved = tempStore()
    const { ownerHeld } = lockHolder()
    const a = harness({ store: saved.store, ownerHeld })
    // Before the handover nothing is saved and the row says why.
    a.scheduler.create({ interval: '5m', prompt: 'early' }, a.owner, 's1')
    expect(a.events.at(-1)).toMatchObject({ event: 'created', saved: false, saveNote: 'no codsh client owns this session, so this loop ends with this process' })
    expect(existsSync(saved.file('s1'))).toBe(false)
    expect(a.scheduler.attach('s1', a.owner, 'tok')).toEqual({ restored: 0 })
    // The task created before the handover is saved with it.
    expect(saved.read('s1')).toMatchObject({ version: 1, session: 's1', tasks: [{ id: 'task-1', prompt: 'early' }] })
    a.scheduler.create({ interval: '5m', prompt: 'check deploy' }, a.owner, 's1')
    expect(a.events.at(-1)).toMatchObject({ event: 'created', saved: true, saveNote: '', restored: false, durable: false })
    expect(saved.read('s1').tasks.map(task => task.id)).toEqual(['task-1', 'task-2'])
    await a.clock.advance(300_000)
    expect(a.fires).toHaveLength(2)
    // The fire is recorded before it runs.
    expect(saved.read('s1').tasks[1].inFlight).toEqual({ fire: 1, startedAt: a.clock.now() })
    for (const fire of a.fires) fire.resolve({ status: 'completed', text: `${fire.task.id} green` })
    await flush()
    expect(saved.read('s1').tasks[1]).toMatchObject({ fires: 1, inFlight: null, prior: 'task-2 green', lastResult: { fire: 1, status: 'completed', detail: 'task-2 green' } })
    // Quitting stops the loops here; the file stays for the next resume.
    a.scheduler.shutdown()
    expect(a.events.filter(event => event.event === 'removed')).toEqual([
      { event: 'removed', id: 'task-1', session: 's1', reason: 'shutdown', saved: true },
      { event: 'removed', id: 'task-2', session: 's1', reason: 'shutdown', saved: true },
    ])
    expect(saved.read('s1').tasks).toHaveLength(2)
    // One hour later (11 missed fires) the session is resumed.
    const b = harness({ store: saved.store, ownerHeld, start: a.clock.now() + 3_600_000 })
    expect(b.scheduler.attach('s1', b.owner, 'tok')).toEqual({ restored: 2 })
    expect(kinds(b.events)).toEqual(['restore', 'created', 'created'])
    expect(b.events[0]).toEqual({ event: 'restore', session: 's1', restored: 2, path: saved.file('s1') })
    expect(b.events[2]).toMatchObject({ id: 'task-2', updated: false, restored: true, saved: true, fires: 1 })
    await b.clock.advance(0)
    // Each fires once, promptly, whatever the number of missed intervals.
    expect(b.fires.map(fire => [fire.task.id, fire.task.fire])).toEqual([['task-1', 2], ['task-2', 2]])
    expect(b.fires[1].prompt).toContain('\nYour previous iteration ended with:\ntask-2 green\n')
    for (const fire of b.fires) fire.resolve({ status: 'completed', text: 'ok' })
    await b.clock.advance(299_000)
    expect(b.fires).toHaveLength(2)
    await b.clock.advance(1000)
    expect(b.fires).toHaveLength(4)
    // Handing over the same token again changes nothing.
    expect(b.scheduler.attach('s1', b.owner, 'tok')).toEqual({ restored: 0 })
    expect(b.scheduler.count('s1')).toBe(2)
  })

  it('shows a fire that was running at a crash as unknown and never runs it again', async () => {
    const saved = tempStore()
    const { ownerHeld } = lockHolder()
    const a = harness({ store: saved.store, ownerHeld })
    a.scheduler.attach('s1', a.owner, 'tok')
    a.scheduler.create({ interval: '1m', prompt: 'deploy the site' }, a.owner, 's1')
    await a.clock.advance(60_000)
    expect(a.fires).toHaveLength(1)
    // The process dies here: no shutdown, the fire never settles.
    const b = harness({ store: saved.store, ownerHeld, start: a.clock.now() + 20_000 })
    expect(b.scheduler.attach('s1', b.owner, 'tok')).toEqual({ restored: 1 })
    expect(b.events[1]).toMatchObject({ fires: 1, lastResult: { fire: 1, status: 'unknown', detail: unknownOutcome(1) } })
    expect(saved.read('s1').tasks[0]).toMatchObject({ inFlight: null, fires: 1, lastResult: { fire: 1, status: 'unknown' } })
    await b.clock.advance(39_000)
    expect(b.fires).toHaveLength(0)
    await b.clock.advance(1000)
    expect(b.fires).toHaveLength(1)
    expect(b.fires[0].task.fire).toBe(2)
    expect(b.fires[0].prompt).toContain('The previous iteration (fire 1) was interrupted')
    expect(b.fires[0].prompt).toContain('Check the current state before repeating any external action.')
    expect(b.fires[0].prompt).not.toContain('Your previous iteration ended with')
    b.fires[0].resolve({ status: 'completed', text: 'site up' })
    await flush()
    await b.clock.advance(60_000)
    expect(b.fires[1].prompt).not.toContain('was interrupted')
    expect(b.fires[1].prompt).toContain('Your previous iteration ended with:\nsite up')
  })

  it('removes an expired loop on restore without firing it', async () => {
    const saved = tempStore()
    const { ownerHeld } = lockHolder()
    const a = harness({ store: saved.store, ownerHeld })
    a.scheduler.attach('s1', a.owner, 'tok')
    a.scheduler.create({ interval: '1h', prompt: 'weekly' }, a.owner, 's1')
    a.scheduler.shutdown()
    const b = harness({ store: saved.store, ownerHeld, start: a.clock.now() + EXPIRY_MS + 3_600_000 })
    b.scheduler.attach('s1', b.owner, 'tok')
    await b.clock.advance(0)
    expect(b.fires).toHaveLength(0)
    expect(b.events.at(-1)).toMatchObject({ event: 'removed', id: 'task-1', reason: 'expired', saved: true })
    expect(existsSync(saved.file('s1'))).toBe(false)
  })

  it('accepts durable loops only when they can be saved, and a durable expiry that cannot be saved stays stopped', async () => {
    const saved = tempStore()
    const { ownerHeld } = lockHolder()
    const { scheduler, owner, events, fires, clock } = harness({ store: saved.store, ownerHeld })
    expect(() => scheduler.create({ interval: '5m', prompt: 'x', durable: true }, owner, 's1')).toThrow(DURABLE_MESSAGE)
    scheduler.attach('s1', owner, 'tok')
    saved.failing.on = true
    expect(() => scheduler.create({ interval: '5m', prompt: 'x', durable: true }, owner, 's1')).toThrow('failed to persist scheduler resources: disk full')
    expect(scheduler.count('s1')).toBe(0)
    // A plain loop is kept in memory and says its save failed.
    scheduler.create({ interval: '1h', prompt: 'plain' }, owner, 's1')
    expect(events.at(-1)).toMatchObject({ event: 'created', saved: false, saveNote: 'the last save failed (disk full)' })
    saved.failing.on = false
    const durable = scheduler.create({ interval: '1h', prompt: 'kept', durable: true }, owner, 's1')
    expect(events.at(-1)).toMatchObject({ event: 'created', id: durable.id, durable: true, saved: true })
    // The earlier failure is cleared for the plain loop too.
    expect(events.find(event => event.event === 'state' && event.id === 'task-1' && event.saved)).toBeDefined()
    expect(saved.read('s1').tasks.map(task => [task.prompt, task.durable])).toEqual([['plain', false], ['kept', true]])
    for (let hour = 0; hour < 24 * 7 - 2; hour += 1) {
      await clock.advance(3_600_000 - 1)
      for (const fire of fires) fire.resolve({ status: 'completed', text: 'ok' })
      await clock.advance(1)
    }
    saved.failing.on = true
    await clock.advance(EXPIRY_MS)
    // The plain loop expires anyway; the durable one cannot save its
    // absence, so it stays stopped instead of coming back later.
    expect(events.find(event => event.event === 'removed' && event.id === 'task-1')).toMatchObject({ reason: 'expired' })
    expect(events.find(event => event.event === 'removed' && event.id === durable.id)).toBeUndefined()
    const blocked = events.filter(event => event.event === 'state' && event.id === durable.id).at(-1)
    expect(blocked.paused).toBe('expired, but its removal could not be saved (disk full); it stays stopped and is removed on a later resume')
    const firesThen = fires.length
    await clock.advance(3_600_000 * 3)
    expect(fires).toHaveLength(firesThen)
  })

  it('reports a delete only after the absence is saved', async () => {
    const saved = tempStore()
    const { lock, ownerHeld } = lockHolder()
    const { scheduler, owner, events } = harness({ store: saved.store, ownerHeld })
    scheduler.attach('s1', owner, 'tok')
    scheduler.create({ interval: '5m', prompt: 'a' }, owner, 's1')
    scheduler.create({ interval: '5m', prompt: 'b' }, owner, 's1')
    saved.failing.on = true
    expect(() => scheduler.delete('task-1', 's1')).toThrow('failed to persist scheduler resources: disk full')
    expect(scheduler.count('s1')).toBe(2)
    expect(saved.read('s1').tasks).toHaveLength(2)
    saved.failing.on = false
    expect(scheduler.delete('task-1', 's1')).toEqual({ success: true, message: 'Scheduled task task-1 cancelled.' })
    expect(saved.read('s1').tasks.map(task => task.id)).toEqual(['task-2'])
    expect(events.at(-1)).toEqual({ event: 'removed', id: 'task-1', session: 's1', reason: 'deleted', saved: true })
    lock.token = 'other'
    expect(() => scheduler.delete('task-2', 's1')).toThrow(`scheduler_owner_lost: ${OWNER_LOST}`)
    expect(saved.read('s1').tasks.map(task => task.id)).toEqual(['task-2'])
  })

  it('stops without firing or writing when the owner lock moves or the client goes away', async () => {
    const saved = tempStore()
    const { lock, ownerHeld } = lockHolder()
    const { scheduler, owner, events, fires, clock } = harness({ store: saved.store, ownerHeld })
    expect(scheduler.attach('s1', owner, 'wrong')).toEqual({ error: 'the session owner lock does not carry this token' })
    expect(events).toEqual([])
    scheduler.attach('s1', owner, 'tok')
    scheduler.create({ interval: '1m', prompt: 'probe' }, owner, 's1')
    const before = readFileSync(saved.file('s1'), 'utf8')
    const mtime = statSync(saved.file('s1')).mtimeMs
    lock.token = 'taken-by-another-client'
    await clock.advance(60_000)
    expect(fires).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ event: 'state', id: 'task-1', paused: OWNER_LOST })
    expect(readFileSync(saved.file('s1'), 'utf8')).toBe(before)
    expect(statSync(saved.file('s1')).mtimeMs).toBe(mtime)
    await clock.advance(600_000)
    expect(fires).toHaveLength(0)
    // The rightful owner hands over again: the loop resumes.
    lock.token = 'tok2'
    expect(scheduler.attach('s1', owner, 'tok2')).toEqual({ restored: 0 })
    await clock.advance(0)
    expect(fires).toHaveLength(1)
    fires[0].resolve({ status: 'completed', text: 'ok' })
    await flush()
    // The client exits: nothing fires or saves from then on.
    scheduler.stopAll()
    expect(events.at(-1)).toMatchObject({ event: 'state', paused: CLIENT_GONE })
    const kept = readFileSync(saved.file('s1'), 'utf8')
    await clock.advance(600_000)
    expect(fires).toHaveLength(1)
    expect(readFileSync(saved.file('s1'), 'utf8')).toBe(kept)
  })

  it('marks a permission-mode change and leaves a damaged file alone', async () => {
    const saved = tempStore()
    const { ownerHeld } = lockHolder()
    const mode = { now: 'always-approve' }
    const { scheduler, owner, events, clock } = harness({ store: saved.store, ownerHeld, mode: () => mode.now })
    scheduler.attach('s1', owner, 'tok')
    scheduler.create({ interval: '1m', prompt: 'p' }, owner, 's1')
    expect(events.at(-1)).toMatchObject({ permission: null })
    expect(saved.read('s1').tasks[0].mode).toBe('always-approve')
    mode.now = 'ask'
    await clock.advance(60_000)
    expect(events.find(event => event.event === 'fired')).toMatchObject({ permission: { created: 'always-approve', now: 'ask' } })
    // A file this build cannot read is never overwritten.
    writeFileSync(saved.file('s2'), '{"version":1,"tasks":[{"id":1}]}')
    expect(scheduler.attach('s2', owner, 'tok')).toEqual({ error: 'saved loop 1 is not valid' })
    expect(events.at(-1)).toEqual({ event: 'restore', session: 's2', restored: 0, error: 'saved loop 1 is not valid', path: saved.file('s2') })
    expect(() => scheduler.create({ interval: '1m', prompt: 'q', durable: true }, owner, 's2')).toThrow(DURABLE_MESSAGE)
    scheduler.create({ interval: '1m', prompt: 'q' }, owner, 's2')
    expect(events.at(-1)).toMatchObject({ saved: false, saveNote: 'the saved-loops file could not be read (saved loop 1 is not valid) and is left as is' })
    expect(readFileSync(saved.file('s2'), 'utf8')).toBe('{"version":1,"tasks":[{"id":1}]}')
    writeFileSync(saved.file('s3'), 'not json')
    expect(scheduler.attach('s3', owner, 'tok').error).toMatch(/JSON/)
    expect(readFileSync(saved.file('s3'), 'utf8')).toBe('not json')
  })

  it('lists saved loops as paused when subagents are off; they can still be deleted', async () => {
    const saved = tempStore()
    const { ownerHeld } = lockHolder()
    const a = harness({ store: saved.store, ownerHeld })
    a.scheduler.attach('s1', a.owner, 'tok')
    a.scheduler.create({ interval: '1m', prompt: 'a' }, a.owner, 's1')
    a.scheduler.create({ interval: '1m', prompt: 'b' }, a.owner, 's1')
    a.scheduler.shutdown()
    const reason = 'paused: subagents are off in this session, so the loop cannot fire; it stays saved'
    const b = harness({ store: saved.store, ownerHeld, paused: reason, start: a.clock.now() + 600_000 })
    expect(b.scheduler.attach('s1', b.owner, 'tok')).toEqual({ restored: 2 })
    expect(b.events.filter(event => event.event === 'created').map(event => event.paused)).toEqual([reason, reason])
    await b.clock.advance(600_000)
    expect(b.fires).toHaveLength(0)
    expect(() => b.scheduler.create({ interval: '1m', prompt: 'c' }, b.owner, 's1')).toThrow(reason)
    expect(b.scheduler.delete('task-1', 's1').success).toBe(true)
    expect(saved.read('s1').tasks.map(task => task.prompt)).toEqual(['b'])
  })

  it('reads session ids, owner locks and the permission mode strictly', () => {
    expect(validSessionId('019a-b')).toBe(true)
    for (const bad of ['', '../x', 'a/b', 'a\\b', 'a\0b', 7]) expect(validSessionId(bad)).toBe(false)
    const saved = tempStore()
    expect(() => saved.store.path('../escape')).toThrow('invalid session id')
    const home = saved.dir
    mkdirSync(join(home, 'session-owners'))
    writeFileSync(join(home, 'session-owners', 's1.lock'), JSON.stringify({ sessionId: 's1', pid: 1, token: 't1' }))
    expect(ownerLockHeld(home, 's1', 't1')).toBe(true)
    expect(ownerLockHeld(home, 's1', 't2')).toBe(false)
    expect(ownerLockHeld(home, 's1', '')).toBe(false)
    expect(ownerLockHeld(home, 's2', 't1')).toBe(false)
    expect(ownerLockHeld('', 's1', 't1')).toBe(false)
    writeFileSync(join(home, 'session-owners', 's3.lock'), JSON.stringify({ sessionId: 's1', token: 't1' }))
    expect(ownerLockHeld(home, 's3', 't1')).toBe(false)
    const policy = join(home, 'policy.json')
    writeFileSync(policy, JSON.stringify({ mode: 'ask' }))
    expect(permissionMode(policy)).toBe('ask')
    writeFileSync(policy, 'x')
    expect(permissionMode(policy)).toBe('unreadable')
    expect(permissionMode('')).toBe('')
    // Saves are whole files with owner-only permissions; an empty session removes its file.
    saved.store.save('s9', [{ id: 'a' }])
    expect(statSync(saved.file('s9')).mode & 0o777).toBe(0o600)
    saved.store.save('s9', [])
    expect(existsSync(saved.file('s9'))).toBe(false)
  })

  it('hands the owner over through the control channel', () => {
    const saved = tempStore()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = saved.dir
    const original = process.stderr.write
    process.stderr.write = () => true
    try {
      mkdirSync(join(saved.dir, 'session-owners'))
      writeFileSync(join(saved.dir, 'session-owners', 's1.lock'), JSON.stringify({ sessionId: 's1', pid: 1, token: 'good' }))
      const handlers = new Map()
      const ctx = { on: (name, handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]), tools: { register() {}, get() {} } }
      registerScheduler(ctx, { isChildAgent: () => false, refusal: null, startFire: () => new Promise(() => {}) })
      const sent = []
      const control = createControl({ llm: {} }, message => sent.push(message))
      const main = { id: 's1', session: { id: 's1' }, inject() {} }
      control.handle(JSON.stringify({ type: 'schedule_owner', id: 'o0', sessionId: 's1', token: 'good' }))
      control.onCreated(main)
      control.handle(JSON.stringify({ type: 'schedule_owner', id: 'o1', sessionId: 's1', token: 'bad' }))
      control.handle(JSON.stringify({ type: 'schedule_owner', id: 'o2', sessionId: 's1', token: 'good' }))
      expect(sent).toEqual([
        { type: 'schedule_owner_result', id: 'o0', sessionId: 's1', error: 'no live dsh session for this owner' },
        { type: 'schedule_owner_result', id: 'o1', sessionId: 's1', error: 'the session owner lock does not carry this token' },
        { type: 'schedule_owner_result', id: 'o2', sessionId: 's1', restored: 0 },
      ])
      for (const handler of handlers.get('dispose')) handler()
    } finally {
      process.stderr.write = original
      delete globalThis[REGISTRY]
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('scheduler wiring', () => {
  function fakeCtx() {
    const handlers = new Map()
    const tools = new Map()
    return {
      handlers,
      tools,
      ctx: {
        on(name, handler) {
          handlers.set(name, [...handlers.get(name) ?? [], handler])
          return () => {}
        },
        tools: {
          register(tool) {
            tools.set(tool.name, tool)
          },
          get(name) {
            return tools.get(name)
          },
        },
      },
    }
  }

  it('registers the reference tools, refuses children, and deletes from the pane with a model notice', async () => {
    const { ctx, handlers, tools } = fakeCtx()
    const writes = []
    const original = process.stderr.write
    process.stderr.write = chunk => {
      writes.push(String(chunk))
      return true
    }
    try {
      registerScheduler(ctx, { isChildAgent: agent => agent.child === true, refusal: null, startFire: () => new Promise(() => {}) })
      expect([...tools.keys()]).toEqual(['scheduler_create', 'scheduler_delete', 'scheduler_list'])
      expect(Object.keys(tools.get('scheduler_create').parameters.properties)).toEqual(['task_id', 'interval', 'prompt', 'durable', 'fire_immediately'])
      const injected = []
      const main = { id: 's1', session: { id: 's1' }, inject: message => injected.push(message) }
      const child = { id: 'c1', child: true, session: { id: 'c1' } }
      const created = JSON.parse(await tools.get('scheduler_create').execute({ interval: '5m', prompt: 'p' }, { agent: main }))
      expect(created).toMatchObject({ humanSchedule: 'every 5 minutes', updated: false })
      await expect(tools.get('scheduler_list').execute({}, { agent: child })).rejects.toThrow(CHILD_MESSAGE)
      const denied = await handlers.get('tools/pre-execute')[0]({ name: 'scheduler_create', agent: child }, () => 'next')
      expect(denied).toEqual({ kind: 'deny', reason: CHILD_MESSAGE })
      expect(await handlers.get('tools/pre-execute')[0]({ name: 'scheduler_create', agent: main }, () => 'next')).toBe('next')
      const restricted = []
      handlers.get('agent/created')[0]({ agent: { ...child, ctx: { tools: { restrict: spec => restricted.push(spec) } } } })
      expect(restricted).toEqual([{ deny: ['scheduler_create', 'scheduler_delete', 'scheduler_list'] }])
      // The tasks pane goes through the control channel and the registry.
      const sent = []
      const control = createControl({ llm: {} }, message => sent.push(message))
      control.onCreated(main)
      control.handle(JSON.stringify({ type: 'schedule_delete', id: 'd1', sessionId: 's1', taskId: created.id }))
      control.handle(JSON.stringify({ type: 'schedule_delete', id: 'd2', sessionId: 's1', taskId: created.id }))
      control.handle(JSON.stringify({ type: 'schedule_delete', id: 'd3', sessionId: 'gone', taskId: created.id }))
      expect(sent).toEqual([
        { type: 'schedule_delete_result', id: 'd1', taskId: created.id, success: true, message: `Scheduled task ${created.id} cancelled.` },
        { type: 'schedule_delete_result', id: 'd2', taskId: created.id, success: false, message: `No scheduled task with ID ${created.id} found. Use scheduler_list to see active tasks.` },
        { type: 'schedule_delete_result', id: 'd3', taskId: created.id, error: 'no live dsh session for this task' },
      ])
      expect(injected).toHaveLength(1)
      expect(injected[0].content[0].text).toBe(`scheduled task ${created.id} was deleted by the user from the tasks pane; it will not fire again.`)
      for (const handler of handlers.get('dispose')) handler()
      expect(globalThis[REGISTRY]).toBeUndefined()
      const sentAfter = []
      createControl({ llm: {} }, message => sentAfter.push(message)).handle(JSON.stringify({ type: 'schedule_delete', id: 'd4', sessionId: 's1', taskId: 'x' }))
      expect(sentAfter).toEqual([{ type: 'schedule_delete_result', id: 'd4', taskId: 'x', error: 'scheduled prompts are unavailable in this dsh' }])
    } finally {
      process.stderr.write = original
      delete globalThis[REGISTRY]
    }
    const lines = writes.filter(line => line.startsWith(MARK)).map(line => JSON.parse(line.slice(MARK.length)))
    expect(lines.map(line => [line.event, line.reason ?? ''])).toEqual([['created', ''], ['removed', 'deleted']])
  })
})

// Real dsh over ACP with the full Rust overlay, the keyless mock model, and
// a scheduler clock that runs 60 times faster (1 minute = 1 second).
const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const roots = []
const agents = []

afterEach(() => {
  for (const agent of agents.splice(0)) {
    agent.child.stdin.end()
    agent.child.kill('SIGKILL')
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dshPath() {
  const manifest = JSON.parse(readFileSync(dshManifest, 'utf8'))
  return join(dirname(dshManifest), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh)
}

/** `box` reuses an earlier dsh's root, Home and workspace (a restart). */
function startDsh(env = {}, box = undefined, mode = 'always-approve') {
  const root = box?.root ?? mkdtempSync(join('/tmp', 'codsh-scheduler-'))
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  if (!box) {
    roots.push(root)
    mkdirSync(home)
    mkdirSync(cwd)
  }
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const permissionPath = join(root, 'permission-policy.json')
  writeFileSync(permissionPath, JSON.stringify({ cwd, mode }))
  const child = spawn(process.execPath, [dshPath(), '--profile', 'acp', '--patch', overlay], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      DSH_CODE_CLI_MOCK_TOOL: 'scheduler',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      CODSH_BASH_POLICY: JSON.stringify({ foreground: true }),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  const schedule = []
  const board = []
  const status = []
  const stderr = []
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.id != null && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
    }
  })
  createInterface({ input: child.stderr }).on('line', line => {
    stderr.push(line)
    if (line.startsWith(MARK)) schedule.push(JSON.parse(line.slice(MARK.length)))
    if (line.startsWith(SUBAGENT_MARK)) board.push(JSON.parse(line.slice(SUBAGENT_MARK.length)))
    if (line.startsWith('\u241ejob\u241e')) status.push(JSON.parse(line.slice('\u241ejob\u241e'.length)))
  })
  let nextId = 1
  function send(method, params, timeout = 30000) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.join('\n')}`)), timeout)
    })
  }
  const agent = { root, home, cwd, child, send, updates, schedule, board, status, stderr }
  agents.push(agent)
  return agent
}

async function openSession(agent) {
  await agent.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-scheduler-test', version: '0' } })
  return (await agent.send('session/new', { cwd: agent.cwd, mcpServers: [] })).sessionId
}

function promptText(agent, sessionId, text) {
  return agent.send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 60000)
}

function spoken(agent) {
  return agent.updates
    .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
    .map(update => update.update.content.text)
    .join('')
}

async function until(predicate, detail, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timeout waiting for ${detail}`)
}

const idleAfter = (agent, count) => until(() => agent.status.filter(event => event.event === 'status' && event.status === 'idle').length >= count && agent.status.at(-1)?.status === 'idle', `idle #${count}`)
const LOOP = interval => `# /loop -- schedule a recurring prompt\n\nTurn the input below into a scheduler_create call.\n\n## Input\n${interval}`

/** The Rust client's end of the control channel: hello, then messages. */
async function controlServer(root, name) {
  const path = join(root, `${name}.sock`)
  const messages = []
  let peer
  const server = createServer(socket => {
    peer = socket
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (line.trim()) messages.push(JSON.parse(line))
      }
    })
  })
  await new Promise(resolve => server.listen(path, resolve))
  return {
    path,
    messages,
    env: { CODSH_CONTROL_SOCKET: path, CODSH_CONTROL_TOKEN: `${name}-token` },
    send: message => peer.write(`${JSON.stringify(message)}\n`),
    close: () => new Promise(resolve => {
      peer?.destroy()
      server.close(() => resolve())
    }),
    wait: (predicate, detail, timeout) => until(() => messages.find(predicate), detail, timeout),
  }
}

/** What the Rust client does after it takes the session's owner lock. */
async function handOver(agent, control, sessionId, token, id) {
  await control.wait(message => message.type === 'hello', 'hello')
  const lockDir = join(agent.home, 'session-owners')
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, `${sessionId}.lock`), JSON.stringify({ sessionId, pid: process.pid, token }))
  control.send({ type: 'schedule_owner', id, sessionId, token })
  return control.wait(message => message.type === 'schedule_owner_result' && message.id === id, `owner result ${id}`)
}

describe('scheduled prompts in real dsh', () => {
  it('restores saved loops after a crash: the running fire is unknown and not replayed, then expiry removes the loop unfired', async () => {
    const epoch = String(Date.now())
    const clock = { CODSH_SCHEDULER: '1', CODSH_TEST_SCHEDULER_TIME_SCALE: '60', CODSH_TEST_SCHEDULER_EPOCH: epoch }
    const first = { root: mkdtempSync(join('/tmp', 'codsh-scheduler-')) }
    roots.push(first.root)
    mkdirSync(join(first.root, 'home'))
    mkdirSync(join(first.root, 'workspace'))
    const firstControl = await controlServer(first.root, 'c1')
    const a = startDsh({ ...clock, ...firstControl.env }, first)
    const sessionId = await openSession(a)
    // No owner yet: a durable loop is refused, as the reference does
    // without a durable store.
    await promptText(a, sessionId, 'SCHED_CALL {"interval":"1m","prompt":"LOOP_PROBE","durable":true}')
    expect(spoken(a)).toContain('durable tasks need a saved session')
    expect(await handOver(a, firstControl, sessionId, 'owner-1', 'o1')).toEqual({ type: 'schedule_owner_result', id: 'o1', sessionId, restored: 0 })
    await promptText(a, sessionId, 'SCHED_CALL {"interval":"1m","prompt":"LOOP_SLOW restart probe","durable":true,"fire_immediately":true}')
    expect(spoken(a)).toMatch(/SCHED_RESULT ok \{"id":"[0-9a-f-]{36}","humanSchedule":"every 1 minute","updated":false\}/u)
    const created = a.schedule.find(event => event.event === 'created')
    expect(created).toMatchObject({ session: sessionId, durable: true, saved: true, saveNote: '' })
    await until(() => a.schedule.find(event => event.event === 'fired'), 'first fire')
    const file = join(a.home, 'codsh-schedules', `${sessionId}.json`)
    await until(() => JSON.parse(readFileSync(file, 'utf8')).tasks[0]?.inFlight?.fire === 1, 'in-flight record')
    // The dsh process dies while fire 1 runs.
    a.child.kill('SIGKILL')
    await new Promise(resolve => a.child.once('exit', resolve))
    await firstControl.close()
    const secondControl = await controlServer(first.root, 'c2')
    const b = startDsh({ ...clock, ...secondControl.env }, first)
    await b.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-scheduler-test', version: '0' } })
    await b.send('session/resume', { sessionId, cwd: b.cwd, mcpServers: [] })
    // A client whose token is not in the lock gets nothing restored.
    secondControl.send({ type: 'schedule_owner', id: 'bad', sessionId, token: 'someone-else' })
    expect(await secondControl.wait(message => message.id === 'bad', 'refused owner')).toMatchObject({ error: 'the session owner lock does not carry this token' })
    expect(b.schedule.filter(event => event.event === 'created')).toEqual([])
    expect(await handOver(b, secondControl, sessionId, 'owner-2', 'o2')).toEqual({ type: 'schedule_owner_result', id: 'o2', sessionId, restored: 1 })
    const restored = b.schedule.find(event => event.event === 'created')
    expect(restored).toMatchObject({ id: created.id, restored: true, durable: true, saved: true, fires: 1, lastResult: { fire: 1, status: 'unknown' } })
    // Fire 1 is never run again; the next fire is told it was interrupted.
    const next = await until(() => b.schedule.find(event => event.event === 'fired'), 'fire after restore')
    expect(next.fire).toBe(2)
    await until(() => spoken(b).includes('interrupted=1'), 'interrupted status', 30000)
    expect(b.schedule.filter(event => event.event === 'fired').map(event => event.fire)).not.toContain(1)
    await until(() => JSON.parse(readFileSync(file, 'utf8')).tasks[0]?.lastResult?.fire === 2, 'fire 2 saved')
    b.child.stdin.end()
    await new Promise(resolve => b.child.once('exit', resolve))
    await secondControl.close()
    expect(JSON.parse(readFileSync(file, 'utf8')).tasks).toHaveLength(1)
    // Eight days of downtime: the loop expired and goes without a fire.
    const thirdControl = await controlServer(first.root, 'c3')
    const c = startDsh({ ...clock, ...thirdControl.env, CODSH_TEST_SCHEDULER_OFFSET_MS: String(8 * 86_400_000) }, first)
    await c.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-scheduler-test', version: '0' } })
    await c.send('session/resume', { sessionId, cwd: c.cwd, mcpServers: [] })
    await handOver(c, thirdControl, sessionId, 'owner-3', 'o3')
    await until(() => c.schedule.find(event => event.event === 'removed'), 'expiry')
    expect(c.schedule.find(event => event.event === 'removed')).toEqual({ event: 'removed', id: created.id, session: sessionId, reason: 'expired', saved: true })
    expect(c.schedule.filter(event => event.event === 'fired')).toEqual([])
    expect(existsSync(file)).toBe(false)
    await thirdControl.close()
  }, 120000)

  it('schedules, fires independent background runs, wakes the session, and stops after delete', async () => {
    const agent = startDsh({ CODSH_SCHEDULER: '1', CODSH_TEST_SCHEDULER_TIME_SCALE: '30' })
    const sessionId = await openSession(agent)
    const result = await promptText(agent, sessionId, LOOP('1m LOOP_PROBE check the deploy'))
    expect(result.stopReason).toBe('end_turn')
    expect(spoken(agent)).toMatch(/LOOP_SCHEDULED ok \{"id":"[0-9a-f-]{36}","humanSchedule":"every 1 minute","updated":false\}/u)
    const created = agent.schedule.find(event => event.event === 'created')
    expect(created).toMatchObject({ session: sessionId, prompt: 'LOOP_PROBE check the deploy', human: 'every 1 minute', fireImmediately: true })
    // The first fire runs at once as a real background subagent.
    const fired = await until(() => agent.schedule.find(event => event.event === 'fired'), 'first fire')
    expect(fired).toMatchObject({ id: created.id, fire: 1, label: 'loop: LOOP_PROBE check the deploy (every 1 minute)' })
    expect(fired.job).toMatch(/^subagent-/u)
    const job = agent.board.find(event => event.event === 'job' && event.job === fired.job)
    expect(job).toMatchObject({ id: fired.subagent, type: 'general-purpose', background: true, schedule: created.id, label: fired.label })
    // Its status wakes the idle main session once, with the footer.
    await until(() => spoken(agent).includes(`LOOP_WOKE job=${fired.job}`), 'first wake')
    const first = spoken(agent)
    expect(first).toContain('LOOP_STATUS n=1 prompt=LOOP_PROBE check the deploy prior=none sched=no')
    expect(first).toContain(`If this schedule is no longer relevant, run scheduler_delete("${created.id}")`)
    expect(agent.schedule.find(event => event.event === 'result' && event.fire === 1)).toMatchObject({ status: 'completed' })
    // The next fire, two seconds later here, starts fresh from that status.
    await until(() => spoken(agent).includes('LOOP_STATUS n=2'), 'second fire', 20000)
    expect(spoken(agent)).toMatch(/LOOP_STATUS n=2 prompt=LOOP_PROBE check the deploy prior=LOOP_STATUS n=1/u)
    await idleAfter(agent, 3)
    const deleted = await promptText(agent, sessionId, 'SCHED_DELETE first')
    expect(deleted.stopReason).toBe('end_turn')
    expect(spoken(agent)).toContain(`SCHED_DELETED {"success":true,"message":"Scheduled task ${created.id} cancelled."}`)
    expect(agent.schedule.find(event => event.event === 'removed')).toEqual({ event: 'removed', id: created.id, session: sessionId, reason: 'deleted', saved: false })
    const firesAtDelete = agent.schedule.filter(event => event.event === 'fired').length
    await new Promise(resolve => setTimeout(resolve, 4500))
    expect(agent.schedule.filter(event => event.event === 'fired')).toHaveLength(firesAtDelete)
    const listed = await promptText(agent, sessionId, 'SCHED_LIST')
    expect(listed.stopReason).toBe('end_turn')
    expect(spoken(agent)).toContain('SCHED_LISTED {"tasks":[]}')
  }, 90000)

  it('skips fires while one runs, keeps it running after delete, and refuses durable tasks without an owner', async () => {
    const agent = startDsh({ CODSH_SCHEDULER: '1', CODSH_TEST_SCHEDULER_TIME_SCALE: '60' })
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'SCHED_CALL {"interval":"1m","prompt":"LOOP_PROBE","durable":true}')
    expect(spoken(agent)).toContain('SCHED_RESULT error')
    expect(spoken(agent)).toContain('durable tasks need a saved session')
    await promptText(agent, sessionId, 'SCHED_CALL {"interval":"1m","prompt":"LOOP_SLOW probe","fire_immediately":true}')
    expect(spoken(agent)).toMatch(/SCHED_RESULT ok \{"id":"[0-9a-f-]{36}","humanSchedule":"every 1 minute","updated":false\}/u)
    const created = agent.schedule.find(event => event.event === 'created')
    await until(() => agent.schedule.filter(event => event.event === 'skipped').length >= 2, 'two skipped fires', 15000)
    expect(agent.schedule.filter(event => event.event === 'fired')).toHaveLength(1)
    const fired = agent.schedule.find(event => event.event === 'fired')
    await promptText(agent, sessionId, `SCHED_DELETE ${created.id}`)
    expect(spoken(agent)).toContain(`SCHED_DELETED {"success":true,"message":"Scheduled task ${created.id} cancelled."}`)
    // Delete stops the schedule, not the run already in flight.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(agent.board.filter(event => event.id === fired.subagent && event.event === 'end')).toEqual([])
    expect(agent.board.find(event => event.id === fired.subagent && event.event === 'start')).toBeDefined()
  }, 90000)

  it('offers no scheduler without the interactive client switch', async () => {
    const agent = startDsh({})
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'SCHED_LIST')
    expect(spoken(agent)).toContain('SCHED_LISTED')
    expect(spoken(agent)).not.toContain('{"tasks":[]}')
    expect(agent.schedule).toEqual([])
  }, 60000)
})
