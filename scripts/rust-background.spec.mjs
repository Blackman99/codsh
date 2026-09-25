import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { JOB_NOTICE_PREFIX } from '../packages/cli/bin/rust-acp-session-read.mjs'
import {
  MARK,
  REGISTRY,
  apply,
  createBackground,
  exitFacts,
  foregroundWait,
  movedText,
  parsePolicy,
  resolveTimeout,
} from '../packages/cli/bin/rust-acp-background.mjs'
import { createControl } from '../packages/cli/bin/rust-acp-control.mjs'

const terminal = status => status === 'completed' || status === 'killed' || status === 'failed'
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** The dsh-jobs-local contract this plugin relies on, in memory. */
function fakeJobs() {
  const store = new Map()
  const listeners = []
  let count = 0
  const snapshot = job => ({
    id: job.id,
    kind: 'bash',
    label: job.label,
    ownerSession: job.owner?.id,
    status: job.status,
    ...job.detail !== undefined ? { detail: job.detail } : {},
    startedAt: job.startedAt,
    ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
    reported: job.reported,
  })
  const jobs = {
    maxConcurrentJobsPerOwner: 10,
    store,
    start({ owner, label }) {
      count += 1
      const id = `bash-${count}`
      store.set(id, { id, label, owner, status: 'running', out: '', readAt: 0, reported: false, waiters: 0, resolvers: new Set(), startedAt: Date.now() })
      return id
    },
    list(caller) {
      return [...store.values()].filter(job => job.owner?.id === caller?.id).map(snapshot)
    },
    get(id) {
      return snapshot(store.get(id))
    },
    read(id) {
      const job = store.get(id)
      const text = job.out.slice(job.readAt)
      job.readAt = job.out.length
      if (terminal(job.status)) job.reported = true
      return { text, snapshot: snapshot(job) }
    },
    kill(id) {
      const job = store.get(id)
      if (terminal(job.status)) {
        job.reported = true
        return 'already-finished'
      }
      job.status = 'stopping'
      job.reported = true
      setTimeout(() => jobs.settle(id, { status: 'killed', detail: 'signal: SIGTERM' }), 1)
      return 'requested'
    },
    async wait(id, timeoutMs, caller, signal) {
      const job = store.get(id)
      if (!terminal(job.status)) {
        if (signal?.aborted) throw new Error('wait aborted')
        job.waiters += 1
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(done, timeoutMs)
            function done() {
              clearTimeout(timer)
              job.resolvers.delete(done)
              signal?.removeEventListener('abort', onAbort)
              resolve()
            }
            function onAbort() {
              clearTimeout(timer)
              job.resolvers.delete(done)
              reject(new Error('wait aborted'))
            }
            job.resolvers.add(done)
            signal?.addEventListener('abort', onAbort, { once: true })
          })
        } finally {
          job.waiters -= 1
        }
      }
      if (terminal(job.status)) job.reported = true
      return snapshot(job)
    },
    onJobDone(listener) {
      listeners.push(listener)
    },
    write(id, text) {
      store.get(id).out += text
    },
    settle(id, outcome) {
      const job = store.get(id)
      if (terminal(job.status)) return
      job.status = outcome.status
      job.detail = outcome.detail
      job.finishedAt = Date.now()
      if (job.waiters > 0) job.reported = true
      for (const resolve of [...job.resolvers]) resolve()
      for (const listener of listeners) listener(snapshot(job), job.owner)
    },
  }
  return jobs
}

function fakeAgent(id = 's1', depth = 0) {
  const inbox = new Map()
  return {
    id,
    session: { id, header: { delegationDepth: depth } },
    options: {},
    injected: [],
    inbox: {
      remove(messageId) {
        if (!inbox.has(messageId)) throw new Error('not in inbox')
        inbox.delete(messageId)
      },
      add(message) {
        inbox.set(message.id, message)
      },
    },
    inject(message) {
      this.injected.push(message)
    },
  }
}

function harness(policy = {}, extra = {}) {
  const jobs = fakeJobs()
  const events = []
  const agents = new Set()
  const deferred = []
  const background = createBackground({
    emit: event => events.push(event),
    policy: { foreground: true, autoBackground: true, budgetMs: 15000, timeoutMs: undefined, ...policy },
    jobs: () => jobs,
    shellConfig: () => ({ timeoutMs: 120000, maxTimeoutMs: 600000 }),
    canBackground: () => true,
    live: agent => agents.has(agent),
    later: (fn, ms) => (ms === 0 ? deferred.push(fn) : setTimeout(fn, ms)),
    ...extra,
  })
  jobs.onJobDone(snapshot => background.onJobDone(snapshot))
  const flush = () => {
    while (deferred.length > 0) deferred.shift()()
  }
  return { jobs, events, agents, background, flush }
}

function bashCall(jobs, agent, args, callId = 'call-1') {
  const controller = new AbortController()
  const seen = []
  const exec = {
    name: 'bash',
    callId,
    agent,
    arguments: Object.freeze({ ...args }),
    signal: controller.signal,
  }
  const next = async () => {
    seen.push(exec.arguments)
    if (exec.arguments.run_in_background === true) {
      return { isError: false, value: { kind: 'background', jobId: jobs.start({ owner: agent, label: exec.arguments.command }) } }
    }
    return { isError: false, value: { kind: 'foreground', plain: true } }
  }
  return { exec, next, controller, seen }
}

function notice(jobId, id = `n-${jobId}`) {
  return {
    id,
    content: [{ type: 'text', text: `background job ${jobId} (bash: sleep 5) finished [status: completed · exit code: 0]. Read its output with job_output.` }],
    source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: `bash sleep 5 [status: completed · exit code: 0]` },
  }
}

describe('rust-acp-background policy', () => {
  it('parses the client policy and leaves foreground commands alone without it', () => {
    expect(parsePolicy(undefined)).toEqual({ foreground: false, autoBackground: true, budgetMs: 15000, timeoutMs: undefined })
    expect(parsePolicy('not json').foreground).toBe(false)
    expect(parsePolicy('{"autoBackground":false,"budgetMs":0,"foreground":true}')).toEqual({ foreground: true, autoBackground: false, budgetMs: 0, timeoutMs: undefined })
    expect(parsePolicy('{"budgetMs":-5,"autoBackground":"yes"}')).toEqual({ foreground: true, autoBackground: true, budgetMs: 15000, timeoutMs: undefined })
    expect(parsePolicy('{"foreground":false}').foreground).toBe(false)
  })

  it('follows the reference timeout and budget rules', () => {
    const policy = { autoBackground: true, budgetMs: 15000, timeoutMs: undefined }
    expect(resolveTimeout(undefined, policy, { timeoutMs: 120000, maxTimeoutMs: 600000 })).toBe(120000)
    expect(resolveTimeout(900000, policy, { timeoutMs: 120000, maxTimeoutMs: 600000 })).toBe(600000)
    expect(resolveTimeout(5000, policy, undefined)).toBe(5000)
    expect(foregroundWait(120000, policy)).toBe(15000)
    expect(foregroundWait(5000, policy)).toBe(5000)
    expect(foregroundWait(120000, { ...policy, budgetMs: 0 })).toBe(120000)
    expect(foregroundWait(120000, { ...policy, autoBackground: false })).toBe(120000)
  })

  it('maps settled jobs to exit facts and words a move like the reference', () => {
    expect(exitFacts({ status: 'completed', detail: 'exit code: 3' })).toEqual({ exitCode: 3, signal: null })
    expect(exitFacts({ status: 'killed', detail: 'signal: SIGKILL' })).toEqual({ exitCode: null, signal: 'SIGKILL' })
    expect(exitFacts({ status: 'killed', detail: 'killed before exit' })).toEqual({ exitCode: null, signal: 'SIGTERM' })
    const auto = movedText({ jobId: 'bash-1', reason: 'auto', command: 'sleep 9', description: 'nap', waitMs: 15000, partial: 'tick\n' })
    expect(auto).toContain('[Command moved to background]')
    expect(auto).toContain('Command "nap" has been automatically moved to background because it exceeded auto-background timeout limit of 15s. Process is still running.')
    expect(auto).toContain('Job id: bash-1.')
    expect(auto.endsWith('Partial output:\ntick')).toBe(true)
    expect(movedText({ jobId: 'bash-2', reason: 'user', command: 'sleep 9', waitMs: 1500, partial: '' }))
      .toContain('User moved command "sleep 9" to background. Process is still running.')
    expect(movedText({ jobId: 'bash-2', reason: 'message', command: 'sleep 9', waitMs: 1, partial: '' }))
      .toContain('(no output yet)')
  })
})

describe('rust-acp-background foreground commands', () => {
  it('answers a command that finishes in time as a normal foreground result', async () => {
    const { jobs, events, background, flush } = harness()
    const agent = fakeAgent()
    const call = bashCall(jobs, agent, { command: 'echo hi' })
    const running = background.execute(call.exec, call.next)
    await tick()
    expect(call.seen[0]).toMatchObject({ command: 'echo hi', run_in_background: true })
    expect(call.exec.arguments).toEqual({ command: 'echo hi' })
    jobs.write('bash-1', 'hi\n[stderr]\nwarn\n')
    jobs.settle('bash-1', { status: 'completed', detail: 'exit code: 2' })
    const result = await running
    expect(result).toEqual({
      isError: false,
      value: {
        kind: 'foreground', exitCode: 2, signal: null, timedOut: false, aborted: false, timeoutMs: 120000,
        stdout: { text: 'hi\n[stderr]\nwarn\n', truncated: false }, stderr: { text: '', truncated: false },
      },
    })
    expect(jobs.get('bash-1').reported).toBe(true)
    expect(events).toEqual([])
    // A notice racing the read is a duplicate and is removed.
    const message = notice('bash-1')
    agent.inbox.add(message)
    background.onInserted(agent, message)
    expect(() => agent.inbox.remove(message.id)).toThrow()
    background.onDiscarded(agent, message)
    flush()
    expect(agent.injected).toEqual([])
    expect(background.foregroundJobs.size).toBe(0)
  })

  it('moves a command past the budget and reports its completion once', async () => {
    const { jobs, events, agents, background, flush } = harness({ budgetMs: 20 })
    const agent = fakeAgent()
    agents.add(agent)
    const call = bashCall(jobs, agent, { command: 'sleep 9', description: 'nap' })
    const running = background.execute(call.exec, call.next)
    await tick()
    jobs.write('bash-1', 'tick\n')
    const result = await running
    expect(result).toEqual({ isError: false, value: { kind: 'background', jobId: 'bash-1' } })
    expect(jobs.get('bash-1').status).toBe('running')
    expect(events).toEqual([{ event: 'start', id: 'bash-1', session: 's1', label: 'sleep 9', callId: 'call-1', reason: 'auto', output: 'tick\n' }])
    const decision = await background.postExecute(call.exec, result, async () => ({ kind: 'accept' }))
    expect(decision.content[0].text).toContain('exceeded auto-background timeout limit of 0.02s')
    expect(decision.content[0].text).toContain('Partial output:\ntick')
    // The notice for a moved command is wanted: not removed, not doubled.
    const message = notice('bash-1')
    agent.inbox.add(message)
    background.onInserted(agent, message)
    agent.inbox.remove(message.id)
    jobs.settle('bash-1', { status: 'completed', detail: 'exit code: 0' })
    expect(events.at(-1)).toMatchObject({ event: 'end', id: 'bash-1', session: 's1', status: 'completed', detail: 'exit code: 0' })
    // A cancel that clears the notice puts one copy back.
    background.onDiscarded(agent, message)
    flush()
    expect(agent.injected).toHaveLength(1)
    expect(agent.injected[0].content).toEqual(message.content)
    expect(agent.injected[0].id).not.toBe(message.id)
    expect(events.at(-1)).toEqual({ event: 'requeued', session: 's1', job: 'bash-1' })
    background.onClaimed(agent, message)
    expect(events.at(-1)).toMatchObject({ event: 'notice', session: 's1', job: 'bash-1', summary: 'bash sleep 5 [status: completed · exit code: 0]' })
  })

  it('moves the running command on Ctrl+B or a message, once', async () => {
    const { jobs, events, background } = harness()
    const agent = fakeAgent()
    const call = bashCall(jobs, agent, { command: 'sleep 9' })
    const running = background.execute(call.exec, call.next)
    await tick()
    expect(background.promote('other', 'user')).toBe(0)
    expect(background.promote('s1', 'user')).toBe(1)
    expect(background.promote('s1', 'message')).toBe(0)
    const result = await running
    expect(result.value).toEqual({ kind: 'background', jobId: 'bash-1' })
    expect(events[0]).toMatchObject({ event: 'start', reason: 'user' })
    const decision = await background.postExecute(call.exec, result, async () => ({ kind: 'accept' }))
    expect(decision.content[0].text).toContain('User moved command "sleep 9" to background.')
    expect(background.promote('s1', 'user')).toBe(0)
  })

  it('keeps a moved command alive when the turn cancel lands right after the move', async () => {
    const { jobs, events, background } = harness()
    const agent = fakeAgent()
    const call = bashCall(jobs, agent, { command: 'sleep 9' })
    const running = background.execute(call.exec, call.next)
    await tick()
    expect(background.promote('s1', 'message')).toBe(1)
    call.controller.abort()
    const result = await running
    expect(result.value.kind).toBe('background')
    expect(jobs.get('bash-1').status).toBe('running')
    expect(events[0]).toMatchObject({ event: 'start', reason: 'message' })
  })

  it('kills the command when the turn is cancelled and fails the call like dsh', async () => {
    const { jobs, events, background } = harness()
    const agent = fakeAgent()
    const call = bashCall(jobs, agent, { command: 'sleep 9' })
    const running = background.execute(call.exec, call.next)
    await tick()
    call.controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError', message: 'tool call aborted' })
    expect(jobs.get('bash-1').status).toBe('killed')
    expect(jobs.get('bash-1').reported).toBe(true)
    expect(events).toEqual([])
  })

  it('kills at the timeout when auto-background is off', async () => {
    const { jobs, background } = harness({ autoBackground: false })
    const agent = fakeAgent()
    const call = bashCall(jobs, agent, { command: 'sleep 9', timeoutMs: 20 })
    const result = await background.execute(call.exec, call.next)
    expect(result.value).toMatchObject({ kind: 'foreground', timedOut: true, timeoutMs: 20, exitCode: null, signal: 'SIGTERM' })
    expect(jobs.get('bash-1').status).toBe('killed')
  })

  it('leaves children, plain turns, and a full job table on the plain path', async () => {
    const cases = [
      [{}, fakeAgent('s1', 1)],
      [{ foreground: false }, fakeAgent()],
    ]
    for (const [policy, agent] of cases) {
      const { jobs, background } = harness(policy)
      const call = bashCall(jobs, agent, { command: 'true' })
      expect(await background.execute(call.exec, call.next)).toEqual({ isError: false, value: { kind: 'foreground', plain: true } })
      expect(call.seen).toEqual([{ command: 'true' }])
    }
    const refused = harness({}, { canBackground: () => false })
    const agent = fakeAgent()
    const call = bashCall(refused.jobs, agent, { command: 'true' })
    expect((await refused.background.execute(call.exec, call.next)).value.plain).toBe(true)
    const full = harness()
    full.jobs.maxConcurrentJobsPerOwner = 1
    full.jobs.start({ owner: agent, label: 'x' })
    const crowded = bashCall(full.jobs, agent, { command: 'true' })
    expect((await full.background.execute(crowded.exec, crowded.next)).value.plain).toBe(true)
  })
})

describe('rust-acp-background explicit jobs and the task pane', () => {
  it('tracks run_in_background, job_output reads, waits, and a pane stop', async () => {
    const { jobs, events, background } = harness()
    const agent = fakeAgent()
    const call = bashCall(jobs, agent, { command: 'sleep 40', run_in_background: true })
    await background.execute(call.exec, call.next)
    expect(events[0]).toEqual({ event: 'start', id: 'bash-1', session: 's1', label: 'sleep 40', callId: 'call-1', reason: 'explicit', output: '' })
    const wait = { name: 'job_output', callId: 'call-2', agent, arguments: { job_id: 'bash-1', wait: true }, signal: new AbortController().signal }
    await background.execute(wait, async () => {
      expect(events.at(-1)).toEqual({ event: 'wait', session: 's1', job: 'bash-1', on: true })
      return { isError: false, value: { text: 'tick\n' } }
    })
    expect(events.at(-1)).toEqual({ event: 'wait', session: 's1', job: 'bash-1', on: false })
    background.onResult(wait, { isError: false, value: { text: 'tick\n' } })
    expect(events.at(-1)).toEqual({ event: 'output', id: 'bash-1', session: 's1', text: 'tick\n' })
    expect(() => background.kill(agent, 'bash-9')).toThrow(/unknown background command/)
    expect(background.kill(agent, 'bash-1')).toBe('requested')
    expect(agent.injected[0].source).toMatchObject({ kind: 'plugin', plugin: 'rust-acp-background', form: 'notice' })
    expect(agent.injected[0].content[0].text).toContain('was stopped by the user from the tasks pane')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(events.at(-1)).toMatchObject({ event: 'end', id: 'bash-1', status: 'killed' })
    expect(background.kill(agent, 'bash-1')).toBe('already-finished')
    expect(agent.injected).toHaveLength(1)
  })

  it('reports status, disposal, and skips child agents', async () => {
    const { events, background } = harness()
    const agent = fakeAgent()
    background.onStatus(agent, 'running')
    expect(events.at(-1)).toEqual({ event: 'status', session: 's1', status: 'running' })
    background.onStatus(agent, 'idle')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(events.at(-1)).toEqual({ event: 'status', session: 's1', status: 'idle' })
    // An idle that a new run overtook is dropped.
    const before = events.length
    agent.status = 'idle'
    background.onStatus(agent, 'idle')
    agent.status = 'running'
    background.onStatus(agent, 'running')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(events.slice(before)).toEqual([{ event: 'status', session: 's1', status: 'running' }])
    background.onDisposed(agent)
    expect(events.at(-1)).toEqual({ event: 'disposed', session: 's1' })
    const count = events.length
    const child = fakeAgent('c1', 1)
    background.onStatus(child, 'running')
    background.onDisposed(child)
    background.onClaimed(child, notice('bash-1'))
    expect(events).toHaveLength(count)
  })
})

describe('rust-acp-background wiring', () => {
  it('registers once, reads and removes the policy, and writes marked lines', () => {
    const handlers = new Map()
    let disposer
    const ctx = {
      tools: { get: () => ({ parameters: { properties: { run_in_background: {} } } }) },
      get: () => undefined,
      on(name, handler) {
        handlers.set(name, handler)
        if (name === 'dispose') disposer = handler
      },
      inject: () => {},
    }
    process.env.CODSH_BASH_POLICY = '{"foreground":true,"autoBackground":true,"budgetMs":1000}'
    const writes = []
    const original = process.stderr.write
    process.stderr.write = chunk => {
      writes.push(String(chunk))
      return true
    }
    try {
      apply(ctx)
      expect(process.env.CODSH_BASH_POLICY).toBeUndefined()
      expect(globalThis[REGISTRY]).toBeDefined()
      handlers.get('agent/disposed')({ agent: fakeAgent() })
    } finally {
      process.stderr.write = original
    }
    expect(writes).toEqual([`${MARK}{"event":"disposed","session":"s1"}\n`])
    expect([...handlers.keys()].sort()).toEqual([
      'agent/disposed', 'agent/inbox/claimed', 'agent/inbox/discarded', 'agent/inbox/inserted',
      'agent/status', 'dispose', 'tools/execute', 'tools/post-execute', 'tools/result',
    ])
    disposer()
    expect(globalThis[REGISTRY]).toBeUndefined()
  })

  it('lets the control channel move, stop, and steer through the registry', () => {
    const calls = []
    globalThis[REGISTRY] = {
      promote: (session, reason) => {
        calls.push(['promote', session, reason])
        return 1
      },
      kill: (agent, jobId) => {
        calls.push(['kill', agent.session.id, jobId])
        if (jobId === 'bad') throw new Error('unknown background command bad')
        return 'requested'
      },
    }
    try {
      const sent = []
      const control = createControl({ llm: {} }, message => sent.push(message))
      const agent = { ...fakeAgent('s1'), status: 'running', steer() {} }
      control.onCreated(agent)
      control.handle(JSON.stringify({ type: 'background', id: 'g1', sessionId: 's1', reason: 'user' }))
      control.handle(JSON.stringify({ type: 'job_kill', id: 'k1', sessionId: 's1', jobId: 'bash-1' }))
      control.handle(JSON.stringify({ type: 'job_kill', id: 'k2', sessionId: 's1', jobId: 'bad' }))
      control.handle(JSON.stringify({ type: 'job_kill', id: 'k3', sessionId: 'nope', jobId: 'bash-1' }))
      control.handle(JSON.stringify({ type: 'steer', id: 'q1', sessionId: 's1', text: 'go' }))
      expect(sent).toEqual([
        { type: 'background_result', id: 'g1', count: 1, available: true },
        { type: 'job_kill_result', id: 'k1', jobId: 'bash-1', outcome: 'requested' },
        { type: 'job_kill_result', id: 'k2', jobId: 'bad', error: 'unknown background command bad' },
        { type: 'job_kill_result', id: 'k3', jobId: 'bash-1', error: 'no live dsh session for this command' },
        { type: 'steer_accepted', id: 'q1' },
      ])
      expect(calls).toEqual([
        ['promote', 's1', 'user'],
        ['kill', 's1', 'bash-1'],
        ['kill', 's1', 'bad'],
        ['promote', 's1', 'message'],
      ])
    } finally {
      delete globalThis[REGISTRY]
    }
    const sent = []
    const control = createControl({ llm: {} }, message => sent.push(message))
    control.handle(JSON.stringify({ type: 'background', id: 'g2', sessionId: 's1' }))
    expect(sent).toEqual([{ type: 'background_result', id: 'g2', count: 0, available: false }])
  })
})

// Real dsh over ACP with the full Rust overlay and the keyless mock model.
const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const roots = []
const agents = []

afterEach(() => {
  for (const agent of agents.splice(0)) {
    agent.child.stdin.end()
    agent.child.kill('SIGTERM')
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dshPath() {
  const manifest = JSON.parse(readFileSync(dshManifest, 'utf8'))
  return join(dirname(dshManifest), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh)
}

function startDsh(policy) {
  const root = mkdtempSync(join('/tmp', 'codsh-background-'))
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
      DSH_CODE_CLI_MOCK_TOOL: 'background',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      ...policy === undefined ? {} : { CODSH_BASH_POLICY: JSON.stringify(policy) },
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
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.join('\n')}`)), timeout)
    })
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  const agent = { root, home, cwd, child, send, notify, updates, events, stderr }
  agents.push(agent)
  return agent
}

async function openSession(agent) {
  await agent.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-background-test', version: '0' } })
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

function toolResult(agent, prefix) {
  return agent.updates
    .filter(update => update.update.sessionUpdate === 'tool_call_update' && update.update.toolCallId.startsWith(prefix))
    .flatMap(update => update.update.content ?? [])
    .map(item => item.content?.text ?? '')
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

const sessionRead = new URL('../packages/cli/bin/rust-acp-session-read.mjs', import.meta.url).pathname

function readSession(agent, sessionId) {
  return JSON.parse(execFileSync(process.execPath, [sessionRead, '--session-id', sessionId], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DSH_HOME: agent.home, DSH_BIN: dshPath() },
  }))
}

function listSessions(agent) {
  return JSON.parse(execFileSync(process.execPath, [sessionRead, '--list'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DSH_HOME: agent.home, DSH_BIN: dshPath() },
  }))
}

function running(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim() !== ''
  } catch {
    return false
  }
}

describe('background commands in real dsh', () => {
  it('answers a quick command in the foreground with its exit code', async () => {
    const agent = startDsh({ foreground: true, autoBackground: true, budgetMs: 15000 })
    const sessionId = await openSession(agent)
    const result = await promptText(agent, sessionId, 'BG_FAST')
    expect(result.stopReason).toBe('end_turn')
    const text = spoken(agent)
    expect(text).toContain('RUST_BG_FAST')
    expect(text).toContain('FAST_OUT')
    expect(text).toContain('FAST_ERR')
    expect(text).toMatch(/exit code: 3|exit 3|"exitCode":3/u)
    expect(agent.events.filter(event => event.event === 'start')).toEqual([])
  }, 60000)

  it('moves a command past the budget, keeps it running, and wakes the idle session on completion', async () => {
    const agent = startDsh({ foreground: true, autoBackground: true, budgetMs: 700 })
    const sessionId = await openSession(agent)
    const started = Date.now()
    const result = await promptText(agent, sessionId, 'BG_AUTO')
    expect(result.stopReason).toBe('end_turn')
    expect(Date.now() - started).toBeLessThan(3000)
    expect(spoken(agent)).toContain('RUST_BG_MOVED job=bash-1 moved=auto tail=AUTO_START')
    const moved = toolResult(agent, 'rust-bg-bg_auto-')
    expect(moved).toContain('[Command moved to background]')
    expect(moved).toContain('Command "auto probe" has been automatically moved to background because it exceeded auto-background timeout limit of 0.7s.')
    expect(moved).toContain('Job id: bash-1.')
    expect(moved).toContain('Partial output:\nAUTO_START')
    expect(existsSync(join(agent.cwd, 'bg-auto-done.txt'))).toBe(false)
    const start = agent.events.find(event => event.event === 'start')
    expect(start).toMatchObject({ id: 'bash-1', session: sessionId, reason: 'auto' })
    await until(() => agent.events.find(event => event.event === 'end'), 'job end', 15000)
    expect(agent.events.find(event => event.event === 'end')).toMatchObject({ id: 'bash-1', status: 'completed', detail: 'exit code: 0' })
    expect(readFileSync(join(agent.cwd, 'bg-auto-done.txt'), 'utf8')).toBe('AUTO_END\n')
    // dsh's completion notice starts a follow-up turn with no prompt from the client.
    await until(() => spoken(agent).includes('RUST_BG_WOKE'), 'wake turn', 15000)
    expect(spoken(agent)).toContain('RUST_BG_WOKE job=bash-1 out=')
    expect(spoken(agent)).toContain('AUTO_OUT')
    expect(agent.events.find(event => event.event === 'notice')).toMatchObject({ session: sessionId, job: 'bash-1' })
    await until(() => agent.events.at(-1)?.event === 'status' && agent.events.at(-1).status === 'idle', 'idle after the wake')
    const statuses = agent.events.filter(event => event.event === 'status').map(event => event.status)
    expect(statuses).toEqual(['running', 'idle', 'running', 'idle'])
    // The recorded session replays the wake as its own marked turn, not a prompt.
    const replay = readSession(agent, sessionId)
    expect(replay.ok).toBe(true)
    expect(replay.turns).toHaveLength(2)
    expect(replay.turns[0].user).toBe('BG_AUTO')
    expect(replay.turns[1].user.startsWith(`${JOB_NOTICE_PREFIX} · bash printf 'AUTO_START`)).toBe(true)
    expect(replay.turns[1].user).toContain('[status: completed')
    expect(replay.turns[1].answer).toContain('RUST_BG_WOKE job=bash-1')
    expect(replay.rewindPoints).toHaveLength(1)
    const catalog = listSessions(agent)
    expect(catalog.sessions.find(session => session.id === sessionId).prompts).toEqual(['BG_AUTO'])
  }, 60000)

  it('kills the command and cancels the turn when the client cancels', async () => {
    const agent = startDsh({ foreground: true, autoBackground: true, budgetMs: 15000 })
    const sessionId = await openSession(agent)
    const turn = promptText(agent, sessionId, 'BG_CTRLB')
    await until(() => existsSync(join(agent.cwd, 'bg-ctrlb-started.txt')), 'command start')
    expect(running('sleep 4.175')).toBe(true)
    agent.notify('session/cancel', { sessionId })
    const result = await turn
    expect(result.stopReason).toBe('cancelled')
    await until(() => !running('sleep 4.175'), 'command killed', 5000)
    expect(agent.events.filter(event => event.event === 'start')).toEqual([])
  }, 60000)

  it('leaves foreground bash unchanged without the client policy', async () => {
    const agent = startDsh(undefined)
    const sessionId = await openSession(agent)
    const started = Date.now()
    await promptText(agent, sessionId, 'BG_AUTO')
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000)
    expect(spoken(agent)).toContain('RUST_BG_MOVED job= moved=no tail=AUTO_OUT')
    expect(toolResult(agent, 'rust-bg-bg_auto-')).not.toContain('[Command moved to background]')
    // Status lines still flow (the client uses them for wakes); nothing moved.
    expect(agent.events.filter(event => event.event !== 'status')).toEqual([])
  }, 60000)
})
