import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import {
  CHILD_MESSAGE,
  DURABLE_MESSAGE,
  EXPIRY_MS,
  MARK,
  ONE_SHOT_MESSAGE,
  REGISTRY,
  SchedulerError,
  createScheduler,
  fireLabel,
  framedPrompt,
  intervalToHuman,
  parseInterval,
  registerScheduler,
  scaledClock,
  scheduleFooter,
  uuidv7,
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
  const clock = fakeClock()
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
    expect(events.at(-1)).toEqual({ event: 'removed', id: 'task-1', session: 's1', reason: 'expired' })
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
    expect(events.at(-1)).toEqual({ event: 'removed', id: 'task-1', session: 's1', reason: 'deleted' })
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
    expect(events.at(-1)).toEqual({ event: 'removed', id: 'task-1', session: 's1', reason: 'session_closed' })
    scheduler.shutdown()
    expect(events.at(-1)).toEqual({ event: 'removed', id: 'task-2', session: 's2', reason: 'shutdown' })
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

function startDsh(env = {}) {
  const root = mkdtempSync(join('/tmp', 'codsh-scheduler-'))
  roots.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  mkdirSync(home)
  mkdirSync(cwd)
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const permissionPath = join(root, 'permission-policy.json')
  writeFileSync(permissionPath, JSON.stringify({ cwd, mode: 'always-approve' }))
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

describe('scheduled prompts in real dsh', () => {
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
    expect(agent.schedule.find(event => event.event === 'removed')).toEqual({ event: 'removed', id: created.id, session: sessionId, reason: 'deleted' })
    const firesAtDelete = agent.schedule.filter(event => event.event === 'fired').length
    await new Promise(resolve => setTimeout(resolve, 4500))
    expect(agent.schedule.filter(event => event.event === 'fired')).toHaveLength(firesAtDelete)
    const listed = await promptText(agent, sessionId, 'SCHED_LIST')
    expect(listed.stopReason).toBe('end_turn')
    expect(spoken(agent)).toContain('SCHED_LISTED {"tasks":[]}')
  }, 90000)

  it('skips fires while one runs, keeps it running after delete, and refuses durable tasks', async () => {
    const agent = startDsh({ CODSH_SCHEDULER: '1', CODSH_TEST_SCHEDULER_TIME_SCALE: '60' })
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'SCHED_CALL {"interval":"1m","prompt":"LOOP_PROBE","durable":true}')
    expect(spoken(agent)).toContain('SCHED_RESULT error')
    expect(spoken(agent)).toContain('durable tasks are not available in this build')
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
