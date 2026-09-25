import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { MONITOR_NOTICE_PREFIX, projectTurns } from '../packages/cli/bin/rust-acp-session-read.mjs'
import { accessFromTool } from '../packages/cli/bin/rust-acp-file-approval.mjs'
import { MARK, createBackground } from '../packages/cli/bin/rust-acp-background.mjs'
import {
  AUTO_KILL_THRESHOLD_MS,
  DESCRIPTION,
  LineProcessor,
  MAX_PENDING_EVENTS,
  MAX_TIMEOUT_MS,
  PARAMETERS,
  RateLimiter,
  USER_KILLED_NOTICE,
  batchLines,
  createMonitors,
  endDetail,
  formatEvents,
  lenientBool,
  registerMonitor,
  resolveInput,
  splitDelta,
  startedText,
  summaryOf,
  truncateBytes,
  wrapEvent,
} from '../packages/cli/bin/rust-acp-monitor.mjs'

describe('monitor input and texts follow the reference', () => {
  it('resolves timeout and persistent like MonitorInput', () => {
    expect(resolveInput({ command: 'tail -f log', description: 'watch log' })).toEqual({ command: 'tail -f log', description: 'watch log', timeoutMs: 36_000_000, persistent: false })
    expect(resolveInput({ command: 'c', description: 'd', persistent: true })).toMatchObject({ timeoutMs: 0, persistent: true })
    expect(resolveInput({ command: 'c', description: 'd', timeout_ms: 600_000 })).toMatchObject({ timeoutMs: 600_000, persistent: false })
    expect(() => resolveInput({ command: 'c', description: 'd', timeout_ms: MAX_TIMEOUT_MS + 1 })).toThrow('persistent must be true when timeout_ms exceeds 36000000ms')
    expect(resolveInput({ command: 'c', description: 'd', timeout_ms: MAX_TIMEOUT_MS + 1, persistent: 'yes' })).toMatchObject({ timeoutMs: 0, persistent: true })
    // timeout_ms 0 is no deadline, reported as persistent (reference resolved_timeout_ms == 0).
    expect(resolveInput({ command: 'c', description: 'd', timeout_ms: 0 })).toMatchObject({ timeoutMs: 0, persistent: true })
    expect(() => resolveInput({ command: '  ', description: 'd' })).toThrow('invalid command')
    expect(() => resolveInput({ command: 'c' })).toThrow('invalid description')
    expect(() => resolveInput({ command: 'c', description: 'd', timeout_ms: -1 })).toThrow('invalid timeout_ms')
    expect(() => resolveInput({ command: 'c', description: 'd', timeout_ms: 1.5 })).toThrow('invalid timeout_ms')
  })

  it('accepts the reference lenient booleans and nothing else', () => {
    for (const value of [true, 'true', ' YES ', '1', 1]) expect(lenientBool(value)).toBe(true)
    for (const value of [false, 'false', 'no', '0', 0, null, undefined]) expect(lenientBool(value)).toBe(false)
    expect(() => lenientBool('maybe')).toThrow('expected a boolean')
    expect(() => lenientBool(2)).toThrow('expected a boolean')
  })

  it('words the tool, its parameters and its result like the reference', () => {
    expect(DESCRIPTION.startsWith('Start a background monitor that streams events from a long-running script. Each stdout line is an event - you can keep working and notifications arrive in the chat. Exit ends the watch.')).toBe(true)
    expect(DESCRIPTION).toContain('**Output volume**: Every stdout line is a main-agent wake. Print only `DONE`/`FAILED`/`CANCELLED`.')
    expect(DESCRIPTION).toContain('Use `grep --line-buffered` in pipes')
    expect(DESCRIPTION).toContain('**Responsiveness**: Emit `FAILED` to notify immediately')
    expect(DESCRIPTION).toContain('the monitor runs until you call job_kill or until the session ends. Otherwise it stops at `timeout_ms` (default 10h).')
    expect(PARAMETERS.command.description).toBe('Shell command or script. Each stdout line is an event; exit ends the watch.')
    expect(PARAMETERS.timeout_ms.description).toBe('Kill the monitor after this deadline (ms). Default: 36000000 (10 hr). Max: 36000000 (10 hr).')
    expect(startedText('monitor-1', 5000)).toBe('Monitor started (task monitor-1, timeout 5000ms).\nYou will be notified on each event. Keep working -- do not poll or sleep.\nEvents may arrive while you are waiting for the user -- an event is not their reply.')
    expect(startedText('monitor-2', 0).split('\n')[0]).toBe('Monitor started (task monitor-2, persistent -- runs until job_kill or session end).')
  })

  it('processes lines, batches and wraps events like the pipeline', () => {
    const lines = new LineProcessor()
    expect(lines.push('a\n\n  b  \npart')).toEqual(['a', 'b'])
    expect(lines.push('ial\n')).toEqual(['partial'])
    expect(lines.push('tail')).toEqual([])
    expect(lines.flush()).toBe('tail')
    expect(lines.flush()).toBeUndefined()
    const long = lines.push(`${'x'.repeat(600)}\n`)[0]
    expect(long).toBe(`${'x'.repeat(500)}...(truncated)`)
    // Byte limits never split a character.
    expect(truncateBytes('ééé', 3)).toBe('é')
    expect(lines.push(`${'é'.repeat(300)}\n`)[0]).toBe(`${'é'.repeat(250)}...(truncated)`)
    expect(batchLines(['a', 'b'])).toBe('a\nb')
    const batch = batchLines(Array.from({ length: 10 }, () => 'y'.repeat(400)))
    expect(batch.endsWith('\n...(truncated)')).toBe(true)
    expect(batch.length).toBe(3000 + '\n...(truncated)'.length)
    expect(wrapEvent('say "hi"\nnow', 'DONE', 'monitor-1')).toBe('<monitor-event description="say \'hi\' now" task_id="monitor-1">\nDONE\n</monitor-event>')
    expect(formatEvents([{ taskId: 'm1', description: 'd', text: 'x' }])).toBe(wrapEvent('d', 'x', 'm1'))
    expect(formatEvents([
      { taskId: 'm1', description: 'ci', text: 'FAILED' },
      { taskId: 'm2', description: 'pr', text: 'merged' },
      { taskId: 'm1', description: 'ci', text: 'DONE' },
    ])).toBe('3 monitor events from 2 monitors (use job_list to identify each monitor):\n\n<monitor description="ci" task_id="m1">\n[1] FAILED\n[2] DONE\n</monitor>\n\n<monitor description="pr" task_id="m2">\n[1] merged\n</monitor>')
    expect(summaryOf([{ description: 'ci', text: 'FAILED a\nmore' }, { description: 'ci', text: 'x' }])).toBe('ci: FAILED a (+1 more)')
    expect(splitDelta('out\n[stderr]\nerr\n')).toEqual({ out: 'out\n', err: 'err\n' })
    expect(splitDelta('[stderr]\nonly\n')).toEqual({ out: '', err: 'only\n' })
    expect(splitDelta('plain\n')).toEqual({ out: 'plain\n', err: '' })
  })

  it('rate limits with the reference bucket, catch-up notice and auto-stop', () => {
    let now = 0
    const limiter = new RateLimiter(() => now)
    for (let i = 0; i < 10; i += 1) expect(limiter.process()).toEqual({ kind: 'allowed', notice: undefined })
    expect(limiter.process()).toEqual({ kind: 'suppressed' })
    expect(limiter.process()).toEqual({ kind: 'suppressed' })
    now = 2000
    const allowed = limiter.process()
    expect(allowed.kind).toBe('allowed')
    expect(allowed.notice).toBe('[2 events suppressed -- output rate too high. Consider using job_kill to restart this monitor with a more selective filter.]')
    // Continuous suppression past 30 s stops the monitor once.
    let outcome
    for (now = 2000; now <= 2000 + AUTO_KILL_THRESHOLD_MS + 200; now += 100) {
      outcome = limiter.process()
      if (outcome.kind === 'kill') break
    }
    expect(outcome.kind).toBe('kill')
    expect(outcome.message).toMatch(/^\[Monitor stopped -- your script produced too much output \(\d+ events suppressed over 30s\)\. Write a new monitor command that filters more aggressively -- pipe through grep --line-buffered, awk, or a wrapper script that only emits the specific events you need\.\]$/u)
    expect(limiter.process()).toEqual({ kind: 'suppressed' })
  })

  it('resets the suppression window after a quiet spell', () => {
    let now = 0
    const limiter = new RateLimiter(() => now)
    for (let i = 0; i < 11; i += 1) limiter.process()
    expect(limiter.suppressionStart).toBe(0)
    now = 7000
    expect(limiter.process().notice).toContain('1 events suppressed')
    expect(limiter.suppressionStart).toBeUndefined()
  })

  it('reports how a monitor ended', () => {
    expect(endDetail({ status: 'completed', exitCode: 3 }, undefined, 5)).toBe('monitor ended: exited (code 3)')
    expect(endDetail({ status: 'killed', signal: 'SIGTERM' }, { why: 'timeout' }, 1500)).toBe('monitor ended: timed out after 1500ms')
    expect(endDetail({ status: 'killed', signal: 'SIGTERM' }, { why: 'kill', reason: 'done' }, 5)).toBe('monitor ended: killed by signal SIGTERM (done)')
    expect(endDetail({ status: 'killed', signal: null }, { why: 'user' }, 5)).toBe('monitor ended: stopped by the user from the tasks pane')
    expect(endDetail({ status: 'killed', signal: null }, { why: 'rate' }, 5)).toBe('monitor ended: stopped for too much output')
    expect(endDetail({ status: 'completed', exitCode: 0, sandbox: { mode: 'workspace-write', denied: true } }, undefined, 5)).toBe('monitor ended: exited (code 0); sandbox: file access denied under workspace-write mode')
    expect(endDetail({ status: 'killed', sandbox: { mode: 'read-only', runnerFailed: true } }, undefined, 5)).toContain('sandbox runner failed')
  })

  it('gates a monitor like a bash command', () => {
    expect(accessFromTool('monitor', { command: 'tail -f x', description: 'd' })).toEqual({ kind: 'bash', command: 'tail -f x' })
  })
})

/** Minimal dsh-jobs contract for a producer-owned monitor. */
function fakeJobs() {
  const store = new Map()
  const listeners = []
  let count = 0
  const terminal = status => ['completed', 'killed', 'failed'].includes(status)
  const snapshot = job => ({ id: job.id, kind: job.kind, label: job.label, status: job.status, detail: job.detail, startedAt: job.startedAt, finishedAt: job.finishedAt, reported: job.reported })
  return {
    store,
    start(spec) {
      count += 1
      const id = `${spec.kind}-${count}`
      const hooks = spec.run()
      const job = { id, kind: spec.kind, label: spec.label, owner: spec.owner, status: 'running', reported: false, startedAt: 0, hooks }
      store.set(id, job)
      hooks.done.then(outcome => {
        job.status = outcome.status
        job.detail = outcome.detail
        job.finishedAt = 10
        for (const listener of listeners) listener(snapshot(job), job.owner)
      })
      return id
    },
    kill(id, caller, reason) {
      const job = store.get(id)
      if (terminal(job.status)) return 'already-finished'
      job.status = 'stopping'
      job.reported = true
      job.hooks.cancel(reason)
      return 'requested'
    },
    read(id) {
      return { text: store.get(id).hooks.readOutput(), snapshot: snapshot(store.get(id)) }
    },
    onJobDone(listener) {
      listeners.push(listener)
    },
  }
}

/** A dsh bash executor stand-in whose process the test drives. */
function fakeShell() {
  const procs = []
  return {
    procs,
    resolve: request => ({ ...request, timeoutMs: 1 }),
    start(spec) {
      let settle
      const proc = {
        spec,
        status: 'running',
        exitCode: null,
        signal: null,
        pending: '',
        done: new Promise(resolve => { settle = resolve }),
        readOutput() {
          const delta = proc.pending
          proc.pending = ''
          return { delta, lossy: false }
        },
        write(text) {
          proc.pending += text
        },
        exit(code) {
          proc.status = 'completed'
          proc.exitCode = code
          settle()
        },
        kill() {
          if (proc.status !== 'running') return false
          proc.status = 'killed'
          proc.signal = 'SIGTERM'
          settle()
          return true
        },
      }
      procs.push(proc)
      return proc
    },
  }
}

function fakeAgent(id = 's1') {
  const agent = {
    id,
    status: 'idle',
    session: { id, header: { cwd: '/tmp' } },
    followed: [],
    injected: [],
    inbox: {
      nextStep: [],
      remove(messageId) {
        const index = agent.inbox.nextStep.findIndex(message => message.id === messageId)
        if (index === -1) return false
        agent.inbox.nextStep.splice(index, 1)
        return true
      },
    },
    followup(message) {
      agent.followed.push(message)
      agent.status = 'running'
    },
    inject(message) {
      agent.injected.push(message)
      agent.inbox.nextStep.push(message)
    },
  }
  return agent
}

function monitorHarness() {
  const jobs = fakeJobs()
  const shell = fakeShell()
  const events = []
  const polls = []
  const timers = []
  const agents = new Set()
  let now = 0
  const monitors = createMonitors({
    emit: event => events.push(event),
    jobs: () => jobs,
    shell: () => shell,
    env: () => ({ DSH_SESSION: 'x' }),
    policy: () => undefined,
    live: agent => agents.has(agent),
    now: () => now,
    every: fn => { polls.push(fn); return fn },
    cancelEvery: fn => { const index = polls.indexOf(fn); if (index !== -1) polls.splice(index, 1) },
    later: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer },
    cancelLater: timer => { const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1) },
    isChildAgent: agent => agent.child === true,
  })
  jobs.onJobDone(snapshot => monitors.onJobDone(snapshot))
  const poll = () => { for (const fn of [...polls]) fn() }
  const fire = ms => {
    for (const timer of timers.filter(entry => entry.ms === ms)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.fn()
    }
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  return { jobs, shell, events, monitors, agents, poll, fire, tick, timers, advance: ms => { now += ms } }
}

const textOf = message => message.content[0].text

describe('monitor events in the replayed transcript', () => {
  const said = (text, source) => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text }], source } } })
  const answer = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  it('marks each delivered event and shares one turn for messages taken at one step', () => {
    const turns = projectTurns([
      { type: 'turn/start', data: { turn: 1 } },
      said('MON_CALL watch'),
      answer('started'),
      said('<monitor-event description="ci" task_id="monitor-1">\nOUT\n</monitor-event>', { kind: 'plugin', plugin: 'rust-acp-monitor', form: 'notice', summary: 'ci: OUT' }),
      said('background job monitor-1 (monitor: [monitor] ci) finished', { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'monitor [monitor] ci [status: completed]' }),
      answer('both seen'),
      said('<monitor-event description="ci" task_id="monitor-2">\nNEXT\n</monitor-event>', { kind: 'plugin', plugin: 'rust-acp-monitor', form: 'notice', summary: 'ci: NEXT' }),
      answer('next seen'),
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } },
    ])
    expect(turns.map(turn => [turn.user, turn.answer])).toEqual([
      ['MON_CALL watch', 'started'],
      [`${MONITOR_NOTICE_PREFIX} · ci: OUT\n◎ Task completed · monitor [monitor] ci [status: completed]`, 'both seen'],
      [`${MONITOR_NOTICE_PREFIX} · ci: NEXT`, 'next seen'],
    ])
  })
})

describe('monitor state machine', () => {
  it('starts through the dsh executor as a monitor job and wakes an idle owner per event', async () => {
    const h = monitorHarness()
    const agent = fakeAgent()
    h.agents.add(agent)
    const result = h.monitors.start({ command: 'watch.sh', description: 'ci', timeout_ms: 5000 }, { agent })
    expect(result).toEqual({ taskId: 'monitor-1', timeoutMs: 5000, persistent: false })
    const proc = h.shell.procs[0]
    expect(proc.spec.command).toBe('exec 2>&1; watch.sh')
    expect(proc.spec.env).toEqual({ PYTHONUNBUFFERED: '1' })
    expect(proc.spec.dshEnv).toEqual({ DSH_SESSION: 'x' })
    expect(h.jobs.store.get('monitor-1')).toMatchObject({ kind: 'monitor', label: '[monitor] ci', owner: agent })
    expect(h.events[0]).toEqual({ event: 'start', id: 'monitor-1', session: 's1', kind: 'monitor', label: 'ci', reason: 'monitor', persistent: false, timeoutMs: 5000, output: '' })
    proc.write('DONE\npartial')
    h.poll()
    expect(agent.followed.map(textOf)).toEqual(['<monitor-event description="ci" task_id="monitor-1">\nDONE\n</monitor-event>'])
    // The owner is busy now: while one of its tool calls runs, the next
    // event joins the step that call's result opens.
    h.monitors.toolStarted(agent)
    proc.write(' line\n')
    h.poll()
    expect(agent.injected.map(textOf)).toEqual(['<monitor-event description="ci" task_id="monitor-1">\npartial line\n</monitor-event>'])
    h.monitors.toolEnded(agent)
    agent.inbox.nextStep.length = 0 // the step boundary took it
    // Only the claim is reported to the client, once per message.
    h.monitors.onClaimed(agent, agent.followed[0])
    h.monitors.onClaimed(agent, agent.followed[0])
    expect(h.events.filter(event => event.event === 'monitor')).toEqual([{ event: 'monitor', session: 's1', id: 'monitor-1', count: 1, summary: 'ci: DONE', text: 'DONE' }])
    // job_output reads what the script printed.
    expect(h.jobs.read('monitor-1').text).toBe('DONE\npartial line\n')
    expect(h.jobs.read('monitor-1').text).toBe('')
    proc.write('last')
    proc.exit(0)
    await h.tick()
    // The partial last line is flushed; no extra "ended" event is sent. The
    // model is answering, so it is held and goes out when the agent idles.
    expect(agent.injected).toHaveLength(1)
    expect(h.monitors.held.get(agent).map(item => item.text)).toEqual(['last'])
    expect(h.events.at(-1)).toMatchObject({ event: 'end', id: 'monitor-1', kind: 'monitor', status: 'completed', detail: 'monitor ended: exited (code 0)' })
    expect(h.timers.filter(timer => timer.ms === 5000)).toEqual([])
    agent.status = 'idle'
    h.monitors.onIdle(agent)
    h.fire(30)
    expect(agent.followed.map(textOf).at(-1)).toBe(wrapEvent('ci', 'last', 'monitor-1'))
    expect(h.monitors.held.has(agent)).toBe(false)
  })

  it('spends at most three wakes without a user message and takes stranded events back as one wake', async () => {
    const h = monitorHarness()
    const agent = fakeAgent()
    h.agents.add(agent)
    h.monitors.start({ command: 'w', description: 'ci', persistent: true }, { agent })
    const proc = h.shell.procs[0]
    for (let wake = 1; wake <= 3; wake += 1) {
      proc.write(`E${wake}\n`)
      h.poll()
      expect(agent.followed).toHaveLength(wake)
      h.monitors.onClaimed(agent, agent.followed.at(-1))
      agent.status = 'idle'
    }
    proc.write('E4\n')
    h.poll()
    expect(agent.followed).toHaveLength(3)
    expect(agent.inbox.nextStep.map(textOf)).toEqual([wrapEvent('ci', 'E4', 'monitor-1')])
    h.monitors.onIdle(agent)
    h.fire(30)
    expect(h.events.at(-1)).toEqual({ event: 'hint', session: 's1', text: '1 monitor event(s) wait for your next message (monitor wake limit of 3 reached)' })
    // A user message resets the budget; the waiting event goes with it.
    h.monitors.onClaimed(agent, { id: 'u1', source: { kind: 'user' } })
    h.monitors.onClaimed(agent, agent.inbox.nextStep.shift())
    // An event injected while a tool ran but left after the turn's last
    // step, and one held while the model answered...
    agent.status = 'running'
    h.monitors.toolStarted(agent)
    proc.write('E5\n')
    h.poll()
    h.monitors.toolEnded(agent)
    h.advance(10)
    proc.write('E6\n')
    h.poll()
    expect(agent.inbox.nextStep.map(textOf)).toEqual([wrapEvent('ci', 'E5', 'monitor-1')])
    expect(h.monitors.held.get(agent)).toHaveLength(1)
    // ...come back as one grouped wake when the agent goes idle.
    agent.status = 'idle'
    h.monitors.onIdle(agent)
    h.fire(30)
    expect(agent.inbox.nextStep).toEqual([])
    expect(textOf(agent.followed.at(-1))).toBe('2 monitor events from 1 monitor (use job_list to identify each monitor):\n\n<monitor description="ci" task_id="monitor-1">\n[1] E5\n[2] E6\n</monitor>')
    expect(agent.followed).toHaveLength(4)
  })

  it('puts back an event a cancel cleared, without waking', () => {
    const h = monitorHarness()
    const agent = fakeAgent()
    h.agents.add(agent)
    agent.status = 'running'
    h.monitors.start({ command: 'w', description: 'ci' }, { agent })
    h.monitors.toolStarted(agent)
    h.shell.procs[0].write('FAILED\n')
    h.poll()
    const message = agent.inbox.nextStep.shift()
    agent.status = 'idle'
    h.monitors.onDiscarded(agent, message)
    h.fire(0)
    expect(agent.followed).toEqual([])
    expect(agent.injected.map(textOf)).toEqual([textOf(message), textOf(message)])
    expect(h.events.at(-1)).toEqual({ event: 'requeued', session: 's1', job: 'monitor-1', what: 'monitor "ci" event' })
    // A message this module removed on purpose is not put back.
    h.monitors.onDiscarded(agent, { id: 'other', source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' } })
    expect(h.timers.filter(timer => timer.ms === 0)).toEqual([])
  })

  it('caps undelivered events per agent like the reference pending queue', () => {
    const h = monitorHarness()
    const agent = fakeAgent()
    h.agents.add(agent)
    agent.status = 'running'
    h.monitors.start({ command: 'w', description: 'ci' }, { agent })
    const proc = h.shell.procs[0]
    // Held while the model answers...
    for (let i = 0; i < MAX_PENDING_EVENTS + 3; i += 1) {
      h.advance(2000)
      proc.write(`H${i}\n`)
      h.poll()
    }
    expect(h.monitors.held.get(agent)).toHaveLength(MAX_PENDING_EVENTS)
    expect(h.monitors.held.get(agent)[0].text).toBe('H3')
    h.monitors.held.delete(agent)
    // ...and in the inbox.
    h.monitors.toolStarted(agent)
    for (let i = 0; i < MAX_PENDING_EVENTS + 5; i += 1) {
      h.advance(2000)
      proc.write(`E${i}\n`)
      h.poll()
    }
    expect(agent.inbox.nextStep).toHaveLength(MAX_PENDING_EVENTS)
    expect(textOf(agent.inbox.nextStep[0])).toContain('\nE5\n')
    expect(h.events.filter(event => event.event === 'hint' && event.text.includes('oldest undelivered monitor event')).length).toBeGreaterThanOrEqual(2)
  })

  it('holds events while the model answers and sends them with the next step boundary or wake', () => {
    const h = monitorHarness()
    const agent = fakeAgent()
    h.agents.add(agent)
    agent.status = 'running'
    h.monitors.start({ command: 'w', description: 'ci', persistent: true }, { agent })
    const proc = h.shell.procs[0]
    proc.write('A\n')
    h.poll()
    // No inbox message: dsh would run one more model step for it.
    expect(agent.inbox.nextStep).toEqual([])
    expect(h.monitors.held.get(agent).map(item => item.text)).toEqual(['A'])
    // A tool call ends: its result opens a step, and the event joins it.
    h.monitors.toolStarted(agent)
    h.monitors.toolEnded(agent)
    expect(agent.inbox.nextStep.map(textOf)).toEqual([wrapEvent('ci', 'A', 'monitor-1')])
    agent.inbox.nextStep.length = 0
    // Another message for the next step extends the turn anyway.
    proc.write('B\n')
    h.poll()
    expect(agent.inbox.nextStep).toEqual([])
    const steer = { id: 'steer-1', source: { kind: 'user' } }
    agent.inbox.nextStep.push(steer)
    h.monitors.onInserted(agent, steer)
    expect(agent.inbox.nextStep.map(message => message === steer ? 'steer' : textOf(message))).toEqual(['steer', wrapEvent('ci', 'B', 'monitor-1')])
    agent.inbox.nextStep.length = 0
    // After a cancelled turn nothing wakes; the event waits for the next message.
    proc.write('C\n')
    h.poll()
    h.monitors.onTurnEnd('s1', { kind: 'aborted' })
    agent.status = 'idle'
    h.monitors.onIdle(agent)
    h.fire(30)
    expect(agent.followed).toEqual([])
    expect(agent.inbox.nextStep.map(textOf)).toEqual([wrapEvent('ci', 'C', 'monitor-1')])
    expect(h.events.at(-1)).toEqual({ event: 'hint', session: 's1', text: '1 monitor event(s) wait for your next message (the turn was cancelled)' })
    agent.inbox.nextStep.length = 0
    // A turn that ended normally: held events become one wake.
    h.monitors.onClaimed(agent, { id: 'u2', source: { kind: 'user' } })
    agent.status = 'running'
    proc.write('D\n')
    h.poll()
    h.monitors.onTurnEnd('s1', { kind: 'completed' })
    agent.status = 'idle'
    h.monitors.onIdle(agent)
    h.fire(30)
    expect(agent.followed.map(textOf)).toEqual([wrapEvent('ci', 'D', 'monitor-1')])
  })

  it('stops at the timeout with an end that dsh reports once', async () => {
    const h = monitorHarness()
    const agent = fakeAgent()
    h.agents.add(agent)
    h.monitors.start({ command: 'sleep 99', description: 'slow', timeout_ms: 1500 }, { agent })
    h.fire(1500)
    await h.tick()
    const job = h.jobs.store.get('monitor-1')
    expect(job).toMatchObject({ status: 'killed', detail: 'monitor ended: timed out after 1500ms', reported: false })
    expect(h.shell.procs[0].status).toBe('killed')
  })

  it('stops a flood, kills its process and sends the one stop notice', async () => {
    const h = monitorHarness()
    const agent = fakeAgent()
    h.agents.add(agent)
    agent.status = 'running'
    h.monitors.start({ command: 'yes', description: 'flood' }, { agent })
    h.monitors.toolStarted(agent)
    const proc = h.shell.procs[0]
    for (let i = 0; i < 400 && proc.status === 'running'; i += 1) {
      h.advance(200)
      proc.write('tick\n')
      h.poll()
    }
    await h.tick()
    expect(proc.status).toBe('killed')
    const texts = agent.injected.map(textOf)
    expect(texts.some(text => text.includes('events suppressed -- output rate too high'))).toBe(true)
    expect(texts.at(-1)).toContain('[Monitor stopped -- your script produced too much output')
    expect(h.jobs.store.get('monitor-1')).toMatchObject({ status: 'killed', reported: true, detail: 'monitor ended: stopped for too much output' })
    expect(h.events.some(event => event.event === 'hint' && event.text === 'monitor "flood" stopped: its script produced too much output')).toBe(true)
  })

  it('stops from the tasks pane once, tells the model and fences other sessions', async () => {
    const h = monitorHarness()
    const agent = fakeAgent()
    const other = fakeAgent('s2')
    h.agents.add(agent)
    h.monitors.start({ command: 'w', description: 'pr', persistent: true }, { agent })
    expect(() => h.monitors.kill(other, 'monitor-1')).toThrow('unknown monitor monitor-1')
    expect(h.monitors.kill(agent, 'monitor-1')).toBe('requested')
    await h.tick()
    expect(agent.injected.map(textOf)).toEqual([`Monitor "monitor-1" (pr) was stopped by the user from the tasks pane.\n${USER_KILLED_NOTICE}`])
    expect(h.jobs.store.get('monitor-1')).toMatchObject({ status: 'killed', reported: true, detail: 'monitor ended: stopped by the user from the tasks pane' })
    expect(h.monitors.kill(agent, 'monitor-1')).toBe('already-finished')
    expect(agent.injected).toHaveLength(1)
  })

  it('refuses subagents and leaves no job behind on bad input', () => {
    const h = monitorHarness()
    const child = { ...fakeAgent('c1'), child: true }
    expect(() => h.monitors.start({ command: 'w', description: 'd' }, { agent: child })).toThrow('monitor is only available to the main agent')
    expect(() => h.monitors.start({ command: 'w', description: 'd', timeout_ms: MAX_TIMEOUT_MS + 1 }, { agent: fakeAgent() })).toThrow('persistent must be true')
    expect(h.jobs.store.size).toBe(0)
    expect(h.shell.procs).toHaveLength(0)
  })

  it('routes a tasks-pane stop of a monitor through the background registry', () => {
    const calls = []
    const background = createBackground({
      emit: () => {},
      policy: { foreground: false },
      jobs: () => ({ kill: () => { throw new Error('not a bash job') } }),
      live: () => true,
      monitors: () => ({ has: id => id === 'monitor-1', kill: (agent, id) => { calls.push(id); return 'requested' } }),
    })
    expect(background.kill(fakeAgent(), 'monitor-1')).toBe('requested')
    expect(calls).toEqual(['monitor-1'])
    expect(() => background.kill(fakeAgent(), 'bash-9')).toThrow()
  })

  it('registers only for the interactive client', () => {
    const registered = []
    const ctx = { tools: { register: tool => registered.push(tool.name), get: () => undefined }, get: () => undefined, on: () => {}, inject: () => {} }
    delete process.env.CODSH_MONITOR
    expect(registerMonitor(ctx, { emit: () => {}, isChildAgent: () => false, live: () => true })).toBeUndefined()
    process.env.CODSH_MONITOR = '1'
    expect(registerMonitor(ctx, { emit: () => {}, isChildAgent: () => false, live: () => true })).toBeDefined()
    expect(process.env.CODSH_MONITOR).toBeUndefined()
    expect(registered).toEqual(['monitor'])
  })
})

// Real dsh over ACP with the full Rust overlay and the keyless mock model.
const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const roots = []
const agents = []
const servers = []

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    agent.child.stdin.end()
    agent.child.kill('SIGTERM')
  }
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dshPath() {
  const manifest = JSON.parse(readFileSync(dshManifest, 'utf8'))
  return join(dirname(dshManifest), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh)
}

function startDsh(env = {}) {
  const root = mkdtempSync(join('/tmp', 'codsh-monitor-'))
  roots.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  mkdirSync(home)
  mkdirSync(cwd)
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const permissionPath = join(root, 'permission-policy.json')
  writeFileSync(permissionPath, JSON.stringify({ cwd, mode: 'always-approve' }))
  const trace = join(root, 'trace.jsonl')
  const child = spawn(process.execPath, [dshPath(), '--profile', 'acp', '--patch', overlay], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      DSH_CODE_CLI_MOCK_TOOL: 'monitor',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      CODSH_MOCK_MONITOR_TRACE: trace,
      CODSH_MONITOR: '1',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  const events = []
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
    if (line.startsWith(MARK)) events.push(JSON.parse(line.slice(MARK.length)))
  })
  let nextId = 1
  function send(method, params, timeout = 30000) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.slice(-20).join('\n')}`)), timeout)
    })
  }
  const agent = { root, home, cwd, child, send, updates, events, stderr, trace }
  agents.push(agent)
  return agent
}

async function openSession(agent) {
  await agent.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-monitor-test', version: '0' } })
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

/** Model requests so far, by the latest user text each one saw. */
function calls(agent) {
  if (!existsSync(agent.trace)) return []
  return readFileSync(agent.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).latest)
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

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))
const idleAgain = agent => agent.events.filter(event => event.event === 'status').at(-1)?.status === 'idle'

function running(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim() !== ''
  } catch {
    return false
  }
}

const sessionRead = new URL('../packages/cli/bin/rust-acp-session-read.mjs', import.meta.url).pathname

function readSession(agent, sessionId) {
  return JSON.parse(execFileSync(process.execPath, [sessionRead, '--session-id', sessionId], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DSH_HOME: agent.home, DSH_BIN: dshPath() },
  }))
}

async function controlServer(root) {
  const path = join(root, 'control.sock')
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
  const handle = {
    messages,
    env: { CODSH_CONTROL_SOCKET: path, CODSH_CONTROL_TOKEN: 'monitor-token' },
    send: message => peer.write(`${JSON.stringify(message)}\n`),
    close: () => new Promise(resolve => {
      peer?.destroy()
      server.close(() => resolve())
    }),
  }
  servers.push(handle)
  return handle
}

describe('monitors in real dsh', () => {
  it('delivers each event to the idle owning session once, then the exit once', async () => {
    const agent = startDsh()
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'MON_CALL {"command":"sleep 0.6; echo \\"DONE build 176\\"; sleep 0.8; echo FAILED test; exit 4","description":"ci \\"main\\"","timeout_ms":60000}')
    expect(spoken(agent)).toContain('RUST_MON_STARTED Monitor started (task monitor-1, timeout 60000ms).⏎You will be notified on each event.')
    expect(agent.events.find(event => event.event === 'start')).toEqual({ event: 'start', id: 'monitor-1', session: sessionId, kind: 'monitor', label: 'ci "main"', reason: 'monitor', persistent: false, timeoutMs: 60000, output: '' })
    await until(() => spoken(agent).includes('RUST_MON_ENDED'), 'exit notice', 15000)
    await until(() => idleAgain(agent), 'idle')
    await settle(600)
    const text = spoken(agent)
    expect(text).toContain('RUST_MON_EVENT <monitor-event description="ci \'main\'" task_id="monitor-1">⏎DONE build 176⏎</monitor-event>')
    expect(text).toContain('RUST_MON_EVENT <monitor-event description="ci \'main\'" task_id="monitor-1">⏎FAILED test⏎</monitor-event>')
    expect(text).toContain('RUST_MON_ENDED background job monitor-1 (monitor: [monitor] ci "main") finished [status: completed, monitor ended: exited (code 4)]')
    // One request for the prompt and its tool call, one per event, one for the exit.
    const seen = calls(agent)
    expect(seen.filter(latest => latest.startsWith('<monitor-event') && latest.includes('DONE build 176'))).toHaveLength(1)
    expect(seen.filter(latest => latest.startsWith('<monitor-event') && latest.includes('FAILED test'))).toHaveLength(1)
    expect(seen.filter(latest => latest.startsWith('background job monitor-1'))).toHaveLength(1)
    expect(seen).toHaveLength(5)
    expect(agent.events.filter(event => event.event === 'monitor').map(event => event.summary)).toEqual(['ci "main": DONE build 176', 'ci "main": FAILED test'])
    expect(agent.events.filter(event => event.event === 'end')).toEqual([expect.objectContaining({ id: 'monitor-1', kind: 'monitor', status: 'completed', detail: 'monitor ended: exited (code 4)' })])
    // The replay shows each delivered event as its own marked turn.
    const replay = readSession(agent, sessionId)
    const users = replay.turns.map(turn => turn.user)
    expect(users[0].startsWith('MON_CALL')).toBe(true)
    expect(users).toContain(`${MONITOR_NOTICE_PREFIX} · ci "main": DONE build 176`)
    expect(users).toContain(`${MONITOR_NOTICE_PREFIX} · ci "main": FAILED test`)
  }, 60000)

  it('injects events into a busy turn without an extra wake', async () => {
    const agent = startDsh()
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'MON_BUSY {"command":"sleep 0.4; echo FAILED lint; nosuchcmd176; exit 2","description":"lint"}')
    await settle(800)
    const text = spoken(agent)
    expect(text).toContain('RUST_MON_BUSY saw=1 notices=1 <monitor-event description="lint" task_id="monitor-1">⏎FAILED lint⏎bash: line 1: nosuchcmd176: command not found⏎</monitor-event>')
    expect(calls(agent)).toHaveLength(3)
    expect(text).not.toContain('RUST_MON_EVENT')
    expect(text).not.toContain('RUST_MON_ENDED')
  }, 60000)

  it('stops at the timeout, reports it once and leaves no process', async () => {
    const agent = startDsh()
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'MON_CALL {"command":"echo WATCHING; sleep 31.176","description":"slow","timeout_ms":1500}')
    await until(() => spoken(agent).includes('RUST_MON_ENDED'), 'timeout notice', 15000)
    expect(spoken(agent)).toContain('finished [status: killed, monitor ended: timed out after 1500ms]')
    await until(() => !running('sleep 31.176'), 'process gone', 5000)
    await until(() => idleAgain(agent), 'idle')
    expect(calls(agent)).toHaveLength(4)
  }, 60000)

  it('runs a persistent monitor until the model stops it, with no notice after the kill', async () => {
    const agent = startDsh()
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'MON_CALL {"command":"sleep 32.176","description":"pr","persistent":"yes"}')
    expect(spoken(agent)).toContain('Monitor started (task monitor-1, persistent -- runs until job_kill or session end).')
    expect(running('sleep 32.176')).toBe(true)
    await promptText(agent, sessionId, 'MON_LIST')
    expect(spoken(agent)).toContain('RUST_MON_LIST monitor-1 [monitor] running — [monitor] pr')
    await promptText(agent, sessionId, 'MON_KILL monitor-1')
    expect(spoken(agent)).toContain('RUST_MON_KILL requested cancellation of job monitor-1')
    await until(() => !running('sleep 32.176'), 'process gone', 5000)
    await until(() => agent.events.find(event => event.event === 'end'), 'end line')
    expect(agent.events.find(event => event.event === 'end')).toMatchObject({ status: 'killed', detail: expect.stringMatching(/^monitor ended: killed/u) })
    await settle(800)
    expect(spoken(agent)).not.toContain('RUST_MON_ENDED')
    expect(calls(agent)).toHaveLength(6)
  }, 60000)

  it('refuses a deadline past the cap unless persistent', async () => {
    const agent = startDsh()
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'MON_CALL {"command":"echo x","description":"d","timeout_ms":36000001}')
    expect(spoken(agent)).toContain('RUST_MON_ERROR')
    expect(spoken(agent)).toContain('persistent must be true when timeout_ms exceeds 36000000ms')
    expect(agent.events.filter(event => event.event === 'start')).toEqual([])
  }, 60000)

  it('stops a flood, kills it and never wakes more than the budget', async () => {
    const agent = startDsh({ CODSH_TEST_MONITOR_TIME_SCALE: '10' })
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'MON_CALL {"command":"while true; do echo tick176; sleep 0.002; done","description":"flood"}')
    await until(() => agent.events.find(event => event.event === 'end'), 'auto stop', 20000)
    expect(agent.events.find(event => event.event === 'end')).toMatchObject({ status: 'killed', detail: 'monitor ended: stopped for too much output' })
    expect(agent.events.some(event => event.event === 'hint' && event.text === 'monitor "flood" stopped: its script produced too much output')).toBe(true)
    await until(() => !running('echo tick176'), 'flood gone', 5000)
    await until(() => idleAgain(agent), 'idle')
    await settle(1000)
    // The prompt's two requests plus at most three wakes, however many events.
    const wakes = calls(agent).slice(2)
    expect(wakes.length).toBeLessThanOrEqual(3 + 2)
    expect(agent.events.filter(event => event.event === 'status' && event.status === 'running').length).toBeLessThanOrEqual(4)
    // The stop notice waits for the next message and arrives with it.
    await promptText(agent, sessionId, 'MON_OUTPUT monitor-1')
    const last = calls(agent).at(-1)
    expect(last).toContain('MON_OUTPUT')
    expect(spoken(agent)).toContain('RUST_MON_OUTPUT tick176')
  }, 60000)

  it('stops a monitor from the tasks pane through the control channel', async () => {
    const box = mkdtempSync(join('/tmp', 'codsh-monitor-ctl-'))
    roots.push(box)
    const control = await controlServer(box)
    const agent = startDsh(control.env)
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'MON_CALL {"command":"sleep 33.176","description":"deploy","persistent":true}')
    await until(() => control.messages.find(message => message.type === 'hello'), 'hello')
    control.send({ type: 'job_kill', id: 'k1', sessionId, jobId: 'monitor-1' })
    await until(() => control.messages.find(message => message.type === 'job_kill_result'), 'kill result')
    expect(control.messages.find(message => message.type === 'job_kill_result')).toEqual({ type: 'job_kill_result', id: 'k1', jobId: 'monitor-1', outcome: 'requested' })
    await until(() => !running('sleep 33.176'), 'process gone', 5000)
    await until(() => agent.events.find(event => event.event === 'end'), 'end')
    expect(agent.events.find(event => event.event === 'end')).toMatchObject({ status: 'killed', detail: 'monitor ended: stopped by the user from the tasks pane' })
    // The model hears it once, with the next message, and is told not to restart.
    await settle(500)
    expect(calls(agent)).toHaveLength(2)
    await promptText(agent, sessionId, 'MON_LIST')
    expect(spoken(agent)).toContain('RUST_MON_LIST monitor-1 [monitor] killed')
    expect(spoken(agent)).toMatch(/RUST_MON_LIST .* told=1/)
    expect(calls(agent)).toHaveLength(4)
  }, 60000)

  it('ends monitors with the dsh process and offers no tool without the client switch', async () => {
    const agent = startDsh()
    const sessionId = await openSession(agent)
    await promptText(agent, sessionId, 'MON_CALL {"command":"sleep 34.176","description":"tail","persistent":true}')
    expect(running('sleep 34.176')).toBe(true)
    agent.child.stdin.end()
    agent.child.kill('SIGTERM')
    await until(() => !running('sleep 34.176'), 'process gone with dsh', 10000)

    const plain = startDsh({ CODSH_MONITOR: '' })
    const plainSession = await openSession(plain)
    await promptText(plain, plainSession, 'MON_CALL {"command":"sleep 35.176","description":"tail"}')
    expect(spoken(plain)).toContain('RUST_MON_ERROR')
    expect(running('sleep 35.176')).toBe(false)
  }, 60000)
})
