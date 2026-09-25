import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import {
  DISABLED,
  MARK as GOAL_MARK,
  USAGE,
  budgetReached,
  createGoal,
  eventUsage,
  panelPasses,
  parseVerdict,
  readPolicy,
  storePath,
  usageTokens,
  verificationLimit,
  verifierPrompt,
} from '../packages/cli/bin/rust-acp-goal.mjs'
import { MARK as SUBAGENT_MARK } from '../packages/cli/bin/rust-acp-subagents.mjs'
import { MARK as JOB_MARK } from '../packages/cli/bin/rust-acp-background.mjs'

// Real dsh over ACP with the full Rust overlay, the keyless mock model in
// `goal` mode, and a control socket standing in for the Rust client.
const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const roots = []
const running = []

afterEach(async () => {
  for (const agent of running.splice(0)) {
    agent.child.stdin.end()
    agent.child.kill('SIGTERM')
    agent.server.close()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dshPath() {
  const manifest = JSON.parse(readFileSync(dshManifest, 'utf8'))
  return join(dirname(dshManifest), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh)
}

async function startDsh({ policy, subagents, env = {}, reuse } = {}) {
  const root = reuse?.root ?? mkdtempSync(join('/tmp', 'codsh-goal-'))
  if (reuse === undefined) roots.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  if (reuse === undefined) {
    mkdirSync(home)
    mkdirSync(cwd)
  }
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const permissionPath = join(root, 'permission-policy.json')
  writeFileSync(permissionPath, JSON.stringify({ cwd, mode: 'always-approve' }))
  const socketPath = join(root, `control-${Date.now().toString(36)}.sock`)
  const replies = []
  let socket
  let agentServer
  const connected = new Promise(resolve => {
    const server = createServer(client => {
      socket = client
      client.setEncoding('utf8')
      createInterface({ input: client }).on('line', line => {
        const value = JSON.parse(line)
        if (value.type === 'hello') resolve()
        else replies.push(value)
      })
    })
    server.listen(socketPath)
    agentServer = server
  })
  const child = spawn(process.execPath, [dshPath(), '--profile', 'acp', '--patch', overlay], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      DSH_CODE_CLI_MOCK_TOOL: 'goal',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      CODSH_CONTROL_SOCKET: socketPath,
      CODSH_CONTROL_TOKEN: 'goal-token',
      CODSH_BASH_POLICY: JSON.stringify({ foreground: true, autoBackground: true, budgetMs: 15000 }),
      ...policy === undefined ? {} : { CODSH_GOAL_POLICY: JSON.stringify(policy) },
      ...subagents === undefined ? {} : { CODSH_SUBAGENT_POLICY: JSON.stringify(subagents) },
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  const goal = []
  const board = []
  const jobs = []
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
    if (line.startsWith(GOAL_MARK)) goal.push(JSON.parse(line.slice(GOAL_MARK.length)))
    if (line.startsWith(SUBAGENT_MARK)) board.push(JSON.parse(line.slice(SUBAGENT_MARK.length)))
    if (line.startsWith(JOB_MARK)) jobs.push(JSON.parse(line.slice(JOB_MARK.length)))
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
  let controlId = 0
  async function control(sessionId, action, fields = {}) {
    const id = `g${++controlId}`
    socket.write(`${JSON.stringify({ type: 'goal', id, sessionId, action, ...fields })}\n`)
    return until(() => replies.find(reply => reply.id === id), `goal ${action} reply`)
  }
  await connected
  const agent = { root, home, cwd, child, send, notify, updates, goal, board, jobs, stderr, replies, control, server: agentServer }
  running.push(agent)
  return agent
}

async function openSession(agent) {
  await agent.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-goal-test', version: '0' } })
  return (await agent.send('session/new', { cwd: agent.cwd, mcpServers: [] })).sessionId
}

function spoken(agent) {
  return agent.updates
    .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
    .map(update => update.update.content.text)
    .join('')
}

async function until(predicate, detail, timeout = 30000) {
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

const lastState = agent => agent.goal.filter(event => event.event === 'state').at(-1)
const settled = agent => {
  const state = lastState(agent)
  return state?.goal && state.goal.phase !== 'active' ? state : undefined
}


const states = agent => agent.goal.filter(event => event.event === 'state' && event.goal)
const rounds = agent => agent.goal.filter(event => event.event === 'round').map(event => event.round)
const idle = agent => agent.jobs.filter(event => event.event === 'status').at(-1)?.status === 'idle'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('rust-acp-goal units', () => {
  it('reads the client policy with reference defaults and clamps', () => {
    expect(readPolicy(undefined)).toEqual({ enabled: true, verifierCount: 3, maxVerifications: 10, maxRounds: undefined })
    expect(readPolicy('{"enabled":false,"verifierCount":9,"maxVerifications":2}')).toMatchObject({ enabled: false, verifierCount: 5, maxVerifications: 2 })
    expect(readPolicy('{"verifierCount":0}').verifierCount).toBe(3)
    expect(readPolicy('not json').enabled).toBe(true)
  })

  it('parses the last verdict and its gaps, and applies the panel rule', () => {
    expect(parseVerdict('ok\nGAPS:\n- none\nVERDICT: ACHIEVED')).toEqual({ verdict: 'achieved', gaps: [] })
    expect(parseVerdict('GAPS:\n- tests fail\n* docs missing\n**VERDICT:** NOT_ACHIEVED')).toEqual({ verdict: 'not_achieved', gaps: ['tests fail', 'docs missing'] })
    expect(parseVerdict('VERDICT: ACHIEVED\nsecond thoughts\nVERDICT: NOT ACHIEVED').verdict).toBe('not_achieved')
    expect(parseVerdict('I think it is done.').verdict).toBeNull()
    expect(panelPasses(2, 3)).toBe(true)
    expect(panelPasses(1, 3)).toBe(false)
    expect(panelPasses(1, 2)).toBe(true)
    expect(panelPasses(0, 1)).toBe(false)
  })

  it('counts provider usage and words the verifier brief', () => {
    expect(usageTokens({ inputTokens: 3, outputTokens: 4 })).toBe(7)
    expect(usageTokens({ inputTokens: 3, outputTokens: 4, totalTokens: 10 })).toBe(10)
    expect(eventUsage({ type: 'assistant/message', data: { usage: { inputTokens: 1, outputTokens: 1 } } })).toBe(2)
    expect(eventUsage({ type: 'user/message', data: {} })).toBe(0)
    const brief = verifierPrompt({ objective: 'ship "it"', claim: 'all done', cwd: '/w', index: 2, count: 3 })
    expect(brief).toContain('You are skeptic 2 of 3')
    expect(brief).toContain('Objective: "ship \\"it\\""')
    expect(brief).toContain('Do not create, modify, or delete any file')
    expect(brief).toContain('VERDICT: ACHIEVED  (or)  VERDICT: NOT_ACHIEVED')
    expect(storePath('a/b', { DSH_HOME: '/h' })).toBe('/h/codsh-goals/a_b.json')
  })

  it('refuses every command and goal tool when goal mode is off', async () => {
    const goal = createGoal({
      goals: { get: () => undefined },
      agents: { get: () => undefined },
      policy: readPolicy('{"enabled":false}'),
      emit: () => {},
      store: { read: () => undefined, write: () => {}, remove: () => {} },
      jobs: () => undefined,
      verifier: () => undefined,
      cwd: () => '/w',
    })
    expect(goal.command({ session: { id: 's' } }, { action: 'set', objective: 'x' })).toEqual({ ok: false, message: DISABLED })
    expect(await goal.gate({ name: 'create_goal', arguments: {} })).toBe(DISABLED)
    expect(await goal.gate({ name: 'bash', arguments: {} })).toBeUndefined()
  })
})

describe('goal rounds in real dsh', () => {
  it('runs rounds through dsh and completes only after the verifier panel agrees', async () => {
    const agent = await startDsh()
    const sessionId = await openSession(agent)
    expect(await agent.control(sessionId, 'set', { objective: 'VERIFY_PASS ship it' })).toMatchObject({ ok: true, message: 'Goal set: VERIFY_PASS ship it' })
    const done = await until(() => settled(agent), 'goal settles')
    expect(done.goal).toMatchObject({ phase: 'complete', rounds: 1, objective: 'VERIFY_PASS ship it' })
    expect(done.lastVerdict).toMatchObject({ passed: true, achieved: 3, total: 3 })
    expect(done.stop.message).toBe('Goal complete — verified by 3 of 3 independent verifiers.')
    expect(rounds(agent)).toEqual([1])
    // Three real dsh children with read and run tools and no write tool.
    const starts = agent.board.filter(event => event.event === 'start')
    expect(starts.map(event => event.label).sort()).toEqual(['goal verifier 1/3', 'goal verifier 2/3', 'goal verifier 3/3'])
    for (const start of starts) {
      expect(start.parentSession).toBe(sessionId)
      expect(start.tools).toContain('bash')
      expect(start.tools).not.toContain('write')
      expect(start.tools).not.toContain('edit')
      expect(start.tools).not.toContain('update_goal')
    }
    await until(() => spoken(agent).includes('GOAL_CLOSING complete'), 'closing message')
    // An accepted claim leads straight into dsh's closing message.
    expect(spoken(agent)).not.toContain('claim=refused')
    // Goal tokens include the round and the verifiers' responses.
    await until(() => idle(agent), 'idle')
    expect(lastState(agent).tokens).toBeGreaterThanOrEqual(4 * 4)
    const status = await agent.control(sessionId, 'status')
    expect(status.message).toMatch(/^Goal: VERIFY_PASS ship it\nStatus: complete \| Round 1 of 256\nGoal tokens used: \d+ \(no budget\)\nVerification: 1 of 10 attempts, 3 verifiers each\nLast verdict: achieved \(3 of 3 verifiers\)\nStop reason: Goal complete — verified by 3 of 3 independent verifiers\.\nElapsed: \d+s$/u)
    await sleep(400)
    expect(rounds(agent)).toEqual([1])
  }, 60000)

  it('keeps the goal active when verification finds gaps, then completes once the work is real', async () => {
    const agent = await startDsh({ policy: { verifierCount: 2 } })
    const sessionId = await openSession(agent)
    await agent.control(sessionId, 'set', { objective: 'VERIFY_FILE WRITE_ROUND_2 build the file' })
    const done = await until(() => settled(agent), 'goal settles')
    expect(done.goal.phase).toBe('complete')
    expect(done.goal.rounds).toBe(2)
    expect(done.attempts).toBe(2)
    expect(rounds(agent)).toEqual([1, 2])
    await until(() => spoken(agent).includes('GOAL_CLOSING complete'), 'closing message')
    await until(() => idle(agent), 'idle')
    // The recorded session replays each round as its own marked turn, never as a prompt.
    const replay = readSession(agent, sessionId)
    expect(replay.turns.map(turn => turn.user)).toEqual(['◎ Goal round 1/256', '◎ Goal round 2/256'])
    expect(replay.turns[0].answer).toContain('GOAL_ROUND_END round=1 claim=refused')
    expect(replay.turns[1].answer).toContain('GOAL_CLOSING complete')
    expect(listSessions(agent).sessions.find(session => session.id === sessionId)?.prompts ?? []).toEqual([])
    expect(spoken(agent)).toContain('GOAL_ROUND_END round=1 claim=refused')
    expect(spoken(agent)).toContain('independent verification found the objective not achieved (0 of 2 verifiers agreed it is done)')
    expect(spoken(agent)).toContain('goal-done.txt is missing')
    expect(spoken(agent)).toContain('verification attempt 1 of 10')
    expect(spoken(agent)).not.toContain('GOAL_ROUND_END round=2')
    // Between the two rounds the goal stayed active with the rejected verdict visible.
    const between = states(agent).find(state => state.lastVerdict?.passed === false)
    expect(between.goal.phase).toBe('active')
    expect(between.lastVerdict.gaps).toEqual(['skeptic 1: goal-done.txt is missing', 'skeptic 2: goal-done.txt is missing'])
    expect(agent.goal.some(event => event.event === 'notice' && event.text === 'Goal verification: not achieved (0 of 2 verifiers) · attempt 1 of 10')).toBe(true)
    expect(existsSync(join(agent.cwd, 'goal-done.txt'))).toBe(true)
  }, 60000)

  it('never accepts the model claim alone: repeated rejections stop the goal', async () => {
    const agent = await startDsh({ policy: { verifierCount: 1, maxVerifications: 2 } })
    const sessionId = await openSession(agent)
    await agent.control(sessionId, 'set', { objective: 'VERIFY_FAIL pretend' })
    const done = await until(() => settled(agent), 'goal settles')
    expect(done.goal).toMatchObject({ phase: 'blocked', rounds: 2, blocked: { code: 'verification-limit', message: verificationLimit(2) } })
    expect(done.stop).toEqual({ kind: 'verification-limit', message: verificationLimit(2) })
    await until(() => idle(agent), 'idle')
    await sleep(400)
    expect(rounds(agent)).toEqual([1, 2])
    expect(states(agent).some(state => state.goal.phase === 'complete')).toBe(false)
    // Resume gives the verifier new attempts.
    expect(await agent.control(sessionId, 'resume')).toMatchObject({ ok: true, message: 'Goal resumed.' })
    await until(() => rounds(agent).length === 3, 'third round')
    await until(() => settled(agent) && lastState(agent).attempts === 2 && idle(agent), 'blocked again')
    expect(lastState(agent).goal.blocked.code).toBe('verification-limit')
  }, 60000)

  it('applies the reference panel rule: a split of one in three refuses, one in two passes', async () => {
    const three = await startDsh({ policy: { verifierCount: 3, maxVerifications: 1 } })
    const first = await openSession(three)
    await three.control(first, 'set', { objective: 'VERIFY_SPLIT' })
    const refused = await until(() => settled(three), 'three settle')
    expect(refused.goal.phase).toBe('blocked')
    expect(refused.lastVerdict).toMatchObject({ passed: false, achieved: 1, total: 3 })
    const two = await startDsh({ policy: { verifierCount: 2 } })
    const second = await openSession(two)
    await two.control(second, 'set', { objective: 'VERIFY_SPLIT' })
    const passed = await until(() => settled(two), 'two settle')
    expect(passed.goal.phase).toBe('complete')
    expect(passed.lastVerdict).toMatchObject({ passed: true, achieved: 1, total: 2 })
  }, 60000)

  it('counts a verifier without a verdict as not achieved', async () => {
    const agent = await startDsh({ policy: { verifierCount: 1, maxVerifications: 1 } })
    const sessionId = await openSession(agent)
    await agent.control(sessionId, 'set', { objective: 'VERIFY_SILENT' })
    const done = await until(() => settled(agent), 'goal settles')
    expect(done.goal.phase).toBe('blocked')
    expect(done.lastVerdict.failures).toEqual(['verifier 1 gave no verdict'])
    await until(() => spoken(agent).includes('GOAL_ROUND_END'), 'round end')
    expect(spoken(agent)).toContain('- verifier 1 gave no verdict')
  }, 60000)

  it('stops instead of trusting the claim when subagents are disabled', async () => {
    const agent = await startDsh({ subagents: { enabled: false } })
    const sessionId = await openSession(agent)
    await agent.control(sessionId, 'set', { objective: 'VERIFY_PASS no verifier' })
    const done = await until(() => settled(agent), 'goal settles')
    expect(done.goal.phase).toBe('blocked')
    expect(done.goal.blocked.code).toBe('verification-unavailable')
    expect(done.goal.blocked.message).toContain('subagents are disabled for this session')
    expect(done.attempts).toBe(0)
    await until(() => spoken(agent).includes('GOAL_ROUND_END'), 'round end')
    expect(spoken(agent)).toContain('independent verification is unavailable (subagents are disabled for this session)')
    expect(agent.board).toEqual([])
  }, 60000)

  it('stops at the token budget, keeps it apart from rounds, and refuses to resume', async () => {
    const agent = await startDsh()
    const sessionId = await openSession(agent)
    expect(await agent.control(sessionId, 'set', { objective: 'BURN tokens', budget: 12000 })).toMatchObject({ ok: true, message: 'Goal set (token budget 12000): BURN tokens' })
    const done = await until(() => settled(agent), 'goal settles')
    // Each BURN round reports 5000 tokens: rounds 1-2 stay under, round 3 reaches it.
    expect(done.goal).toMatchObject({ phase: 'blocked', rounds: 3, blocked: { code: 'budget-limited', message: budgetReached(15000, 12000) } })
    expect(done.tokens).toBe(15000)
    expect(done.budget).toBe(12000)
    await until(() => idle(agent), 'idle')
    await sleep(400)
    expect(rounds(agent)).toEqual([1, 2, 3])
    expect(await agent.control(sessionId, 'resume')).toEqual(expect.objectContaining({ ok: false, message: 'Goal is budget-limited. Use /goal clear, then /goal <objective>.' }))
    expect(await agent.control(sessionId, 'pause')).toEqual(expect.objectContaining({ ok: false, message: 'Goal is budget-limited.' }))
    expect((await agent.control(sessionId, 'status')).message).toContain('Status: budget-limited | Round 3 of 256\nGoal tokens used: 15000 of 12000')
    expect(agent.goal.some(event => event.event === 'notice' && event.text === budgetReached(15000, 12000))).toBe(true)
    expect(await agent.control(sessionId, 'clear')).toMatchObject({ ok: true, message: 'Goal cleared.' })
    expect(lastState(agent).goal ?? null).toBeNull()
    expect(existsSync(storePath(sessionId, { DSH_HOME: agent.home }))).toBe(false)
    expect((await agent.control(sessionId, 'status')).message).toBe('No goal is currently set. Use /goal <objective> to start one.')
  }, 60000)

  it('pauses a running round, stays paused across turn end, and resumes', async () => {
    const agent = await startDsh()
    const sessionId = await openSession(agent)
    await agent.control(sessionId, 'set', { objective: 'SLOWROUND work' })
    await until(() => rounds(agent).length === 1 && agent.jobs.some(event => event.event === 'status' && event.status === 'running'), 'round 1 running')
    expect(await agent.control(sessionId, 'pause')).toMatchObject({ ok: true, message: 'Goal paused. Use /goal resume to continue.' })
    const paused = await until(() => settled(agent), 'paused')
    expect(paused.goal.phase).toBe('paused')
    expect(paused.stop.message).toBe('Goal paused by /goal pause. Use /goal resume to continue.')
    await until(() => idle(agent), 'round cancelled')
    await sleep(500)
    expect(rounds(agent)).toEqual([1])
    expect(lastState(agent).goal.phase).toBe('paused')
    expect(await agent.control(sessionId, 'pause')).toMatchObject({ ok: false, message: 'Goal is already paused.' })
    expect(await agent.control(sessionId, 'resume')).toMatchObject({ ok: true, message: 'Goal resumed.' })
    await until(() => rounds(agent).length === 2, 'round 2 after resume')
    expect(await agent.control(sessionId, 'clear')).toMatchObject({ ok: true, message: 'Goal cleared.' })
    // Clearing stops the round in flight instead of letting it work on.
    await until(() => idle(agent), 'idle after clear', 5000)
    await sleep(400)
    expect(rounds(agent)).toEqual([1, 2])
  }, 120000)

  it('pauses the goal when the user interrupts a round', async () => {
    const agent = await startDsh()
    const sessionId = await openSession(agent)
    await agent.control(sessionId, 'set', { objective: 'SLOWROUND interrupt me' })
    await until(() => rounds(agent).length === 1 && agent.jobs.some(event => event.event === 'status' && event.status === 'running'), 'round 1 running')
    agent.notify('session/cancel', { sessionId })
    const paused = await until(() => settled(agent), 'paused after cancel')
    expect(paused.goal.phase).toBe('paused')
    expect(paused.stop.message).toBe('Goal paused: the goal round was interrupted. Use /goal resume to continue.')
    await sleep(500)
    expect(rounds(agent)).toEqual([1])
  }, 60000)

  it('cancels verification when the goal is paused mid-check and applies nothing', async () => {
    const agent = await startDsh({ policy: { verifierCount: 2 } })
    const sessionId = await openSession(agent)
    await agent.control(sessionId, 'set', { objective: 'VERIFY_SLOW careful' })
    await until(() => lastState(agent)?.verifying === true && agent.board.filter(event => event.event === 'start').length === 2, 'verifiers running')
    await agent.control(sessionId, 'pause')
    const paused = await until(() => settled(agent), 'paused')
    expect(paused.goal.phase).toBe('paused')
    await until(() => agent.board.filter(event => event.event === 'end').length === 2, 'verifiers ended')
    expect(agent.board.filter(event => event.event === 'end').map(event => event.status)).toEqual(['cancelled', 'cancelled'])
    await until(() => idle(agent), 'idle')
    expect(states(agent).some(state => state.goal.phase === 'complete')).toBe(false)
    expect(lastState(agent).verifying).toBe(false)
  }, 60000)

  it('lets a human turn take over between rounds and continues after it', async () => {
    const agent = await startDsh()
    const sessionId = await openSession(agent)
    const human = agent.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'SLOWHUMAN first' }] }, 60000)
    await until(() => agent.jobs.some(event => event.event === 'status' && event.status === 'running'), 'human turn running')
    // A goal set during a human turn waits for it; the human turn is not cancelled.
    await agent.control(sessionId, 'set', { objective: 'NEVER_CLAIM PACE keep going' })
    expect(rounds(agent)).toEqual([])
    const result = await human
    expect(result.stopReason).toBe('end_turn')
    expect(spoken(agent)).toContain('GOAL_HUMAN tools=create_goal,get_goal,update_goal SLOWHUMAN first')
    await until(() => rounds(agent).length >= 2, 'rounds after the human turn')
    // A new human message while the goal runs (paced rounds keep the round
    // cap far away): the driver yields to it.
    const second = await agent.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'SLOWHUMAN takeover' }] }, 60000)
    expect(second.stopReason).toBe('end_turn')
    expect(states(agent).some(state => state.takeover === true)).toBe(true)
    expect(spoken(agent)).toContain('SLOWHUMAN takeover')
    const before = rounds(agent).length
    await until(() => rounds(agent).length > before, 'rounds resume after takeover')
    expect(lastState(agent).goal.phase).toBe('active')
    await agent.control(sessionId, 'clear')
  }, 90000)

  it('refuses completion while a background job is still running', async () => {
    const agent = await startDsh({ policy: { verifierCount: 1 } })
    const sessionId = await openSession(agent)
    await agent.control(sessionId, 'set', { objective: 'BGJOB VERIFY_PASS wait for it' })
    await until(() => spoken(agent).includes('GOAL_ROUND_END round=1'), 'round 1 claim')
    expect(spoken(agent)).toContain('GOAL_ROUND_END round=1 claim=refused: Error: Goal completion refused: 1 background job is still running (bash-1). Wait for it with job_output or stop it with job_kill, check the result, then mark the goal complete. The goal stays active.')
    await agent.control(sessionId, 'pause')
    const state = await until(() => settled(agent), 'paused')
    expect(state.goal.phase).toBe('paused')
    expect(state.attempts).toBe(0)
    expect(agent.board).toEqual([])
  }, 60000)

  it('removes the goal tools and refuses /goal when goal mode is off', async () => {
    const agent = await startDsh({ policy: { enabled: false } })
    const sessionId = await openSession(agent)
    expect(await agent.control(sessionId, 'set', { objective: 'x' })).toMatchObject({ ok: false, message: DISABLED })
    await agent.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] }, 60000)
    expect(spoken(agent)).toContain('GOAL_HUMAN tools=(none) hello')
  }, 60000)

  it('keeps the goal, its budget, and its tokens across a dsh restart, disarmed until resumed', async () => {
    const first = await startDsh()
    const sessionId = await openSession(first)
    await first.control(sessionId, 'set', { objective: 'BURN across restarts', budget: 100000 })
    await until(() => rounds(first).length >= 2, 'two rounds')
    await first.control(sessionId, 'pause')
    await until(() => settled(first) && idle(first), 'paused and idle')
    const before = lastState(first)
    expect(before.goal.phase).toBe('paused')
    first.child.stdin.end()
    first.child.kill('SIGTERM')
    await new Promise(resolve => first.child.once('exit', resolve))
    const second = await startDsh({ reuse: first })
    await second.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-goal-test', version: '0' } })
    await second.send('session/resume', { sessionId, cwd: second.cwd, mcpServers: [] })
    const status = await second.control(sessionId, 'status')
    expect(status.message).toContain(`Status: paused | Round ${before.goal.rounds} of 256\nGoal tokens used: ${before.tokens} of 100000`)
    expect(await second.control(sessionId, 'resume')).toMatchObject({ ok: true, message: 'Goal resumed.' })
    await until(() => rounds(second).length >= 1, 'a round after the restart')
    expect(rounds(second)[0]).toBe(before.goal.rounds + 1)
    await until(() => lastState(second).tokens > before.tokens, 'tokens keep counting')
    await second.control(sessionId, 'clear')
  }, 90000)

  it('answers usage and argument errors', async () => {
    const agent = await startDsh()
    const sessionId = await openSession(agent)
    expect(await agent.control(sessionId, 'set', { objective: '  ' })).toMatchObject({ ok: false, message: USAGE })
    expect(await agent.control(sessionId, 'set', { objective: 'x', budget: 0 })).toMatchObject({ ok: false, message: 'The goal token budget must be a positive whole number.' })
    expect(await agent.control(sessionId, 'resume')).toMatchObject({ ok: false, message: 'No goal set. Use /goal <objective> to start one.' })
    expect(await agent.control(sessionId, 'clear')).toMatchObject({ ok: false, message: 'No goal is currently set.' })
    expect(await agent.control('missing-session', 'status')).toMatchObject({ ok: false, message: '/goal needs a live dsh session' })
  }, 60000)
})
