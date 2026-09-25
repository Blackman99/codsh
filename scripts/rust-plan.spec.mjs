/**
 * Ticket 179: plan mode, ask_user_question, and todos, executed by real dsh
 * through the Rust overlay and the keyless mock model. The test plays the
 * Rust client's side of the private control socket.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import {
  encodeCwdDirname,
  hasHeading,
  planFilePath,
  planGate,
  todoGateReminder,
} from '../packages/cli/bin/rust-acp-plan.mjs'
import {
  APPROVED_COMMENTS_PREFIX,
  CANCEL_TEXT,
  NO_OPERATOR_TEXT,
  QUIT_TEXT,
  cleanAnswers,
  createInteraction,
} from '../packages/cli/bin/rust-acp-interaction.mjs'

const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const roots = []
const running = []

afterEach(async () => {
  for (const item of running.splice(0)) await item.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dshPath() {
  const manifest = JSON.parse(readFileSync(dshManifest, 'utf8'))
  return join(dirname(dshManifest), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh)
}

async function waitFor(predicate, detail, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for ${detail}`)
}

function makeBox() {
  const root = mkdtempSync(join('/tmp', 'codsh-plan-'))
  roots.push(root)
  const box = { root, home: join(root, 'home'), grok: join(root, 'grok'), cwd: join(root, 'workspace') }
  for (const dir of [box.home, box.grok, box.cwd]) mkdirSync(dir)
  writeFileSync(join(root, 'overlay.yml'), rustAcpOverlay())
  return box
}

/** The Rust client's end of the control socket. */
async function controlServer(box) {
  const path = join(box.root, `c-${running.length}.sock`)
  const messages = []
  let peer
  const server = createServer((socket) => {
    peer = socket
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
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
    send: message => peer.write(`${JSON.stringify(message)}\n`),
    close: () => new Promise(resolve => server.close(() => resolve())),
    wait: (predicate, detail, timeout) => waitFor(() => messages.find(predicate), detail, timeout),
  }
}

async function startDsh(box, { env = {}, control, permission = { mode: 'always-approve' } } = {}) {
  const permissionPath = join(box.root, 'permission-policy.json')
  writeFileSync(permissionPath, JSON.stringify({ cwd: box.cwd, ...permission }))
  const child = spawn(process.execPath, [dshPath(), '--profile', 'acp', '--patch', join(box.root, 'overlay.yml')], {
    cwd: box.cwd,
    env: {
      PATH: process.env.PATH,
      HOME: box.home,
      DSH_HOME: box.home,
      GROK_HOME: box.grok,
      DSH_CODE_CLI_MOCK_TOOL: 'interaction',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      CODSH_PLAN_ROOT: join(box.grok, 'sessions', encodeCwdDirname(box.cwd)),
      ...control === undefined ? {} : {
        CODSH_CONTROL_SOCKET: control.path,
        CODSH_CONTROL_TOKEN: 'plan-token',
        CODSH_INTERACTION: 'tui',
      },
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  const stderr = []
  const permissions = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.method === 'session/request_permission') {
      permissions.push(msg.params)
      const allow = dsh.decline ? undefined : msg.params.options.find(option => option.kind === 'allow_once')
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } })}\n`)
    }
    if (msg.id != null && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
    }
  })
  createInterface({ input: child.stderr }).on('line', line => stderr.push(line))
  let nextId = 1
  const send = (method, params, timeout = 60000) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.slice(-20).join('\n')}`)), timeout)
    })
  }
  const exited = new Promise(resolve => child.on('exit', resolve))
  const dsh = {
    child,
    send,
    updates,
    stderr,
    permissions,
    async stop() {
      child.stdin.end()
      child.kill('SIGTERM')
      await exited
      await control?.close()
    },
    answerSince(from) {
      return updates.slice(from)
        .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
        .map(update => update.update.content.text)
        .join('')
    },
    async prompt(sessionId, text) {
      const from = updates.length
      await send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      return dsh.answerSince(from)
    },
  }
  running.push(dsh)
  await send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-plan-test', version: '0' } })
  return dsh
}

async function newSession(dsh, box) {
  return (await dsh.send('session/new', { cwd: box.cwd, mcpServers: [] })).sessionId
}

describe('plan helpers', () => {
  it('encodes the cwd like the Rust client and falls back to slug-hash for long names', () => {
    expect(encodeCwdDirname('/a b/c')).toBe('%2Fa%20b%2Fc')
    const long = `/${'x'.repeat(300)}/My Repo`
    const encoded = encodeCwdDirname(long)
    expect(encoded).toMatch(/^my-repo-[0-9a-f]{16}$/)
    expect(planFilePath('s1', { CODSH_PLAN_ROOT: '/r' })).toBe('/r/s1/plan.md')
    expect(planFilePath('s1', { GROK_HOME: '/g' }, '/w')).toBe('/g/sessions/%2Fw/s1/plan.md')
    expect(hasHeading('# Plan\nx')).toBe(true)
    expect(hasHeading('no heading')).toBe(false)
  })

  it('gates edits outside the plan file only while plan mode is on', () => {
    expect(planGate(false, 'write', { file_path: '/w/a.txt' }, '/p/plan.md')).toBeUndefined()
    expect(planGate(true, 'read', { file_path: '/w/a.txt' }, '/p/plan.md')).toBeUndefined()
    expect(planGate(true, 'write', { file_path: '/p/plan.md' }, '/p/plan.md')).toEqual({ kind: 'plan-file' })
    expect(planGate(true, 'edit', { file_path: '/w/a.txt' }, '/p/plan.md').kind).toBe('deny')
  })

  it('reminds about pending and in-progress todos only', () => {
    expect(todoGateReminder(null)).toBeNull()
    expect(todoGateReminder([{ content: 'a', status: 'completed' }])).toBeNull()
    const text = todoGateReminder([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }])
    expect(text).toContain('In-progress:\n- a')
    expect(text).toContain('Pending:\n- b')
  })
})

describe('question answerer', () => {
  function setup({ interactive = true, timeoutSecs = 0, planSet } = {}) {
    const sent = []
    const planCalls = []
    const ctx = {
      get: name => name === 'planMode'
        ? { get: () => ({ active: true }), set: (agent, on) => { planCalls.push(on); return planSet ?? 'committed' } }
        : undefined,
      logger: { warn() {} },
    }
    const agents = new Map()
    const agent = { session: { id: 's1' }, steered: [], steer(message) { this.steered.push(message) } }
    agents.set('s1', agent)
    const ix = createInteraction(ctx, message => sent.push(message), { interactive, timeoutSecs, agents, env: { CODSH_PLAN_ROOT: '/r' } })
    return { ix, sent, agent, planCalls }
  }
  const question = { id: 'color', question: 'Which?', options: [{ label: 'Red' }, { label: 'Blue' }] }
  const review = { id: 'plan-review', question: 'Approve?', detail: '# P', options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Approve' } }

  it('answers no-operator without a terminal and approves a review', async () => {
    const { ix, agent } = setup({ interactive: false })
    await expect(ix.ask({ agent, questions: [question] }, () => 'next')).rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_OPERATOR', message: NO_OPERATOR_TEXT })
    await expect(ix.ask({ agent, questions: [review] }, () => 'next')).resolves.toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
    // Another agent's question is not ours to answer.
    expect(ix.ask({ agent: { session: { id: 'other' } }, questions: [question] }, () => 'next')).toBe('next')
  })

  it('sends the card, keeps offered labels only, and refuses a late answer', async () => {
    const { ix, sent, agent } = setup()
    const answer = ix.ask({ agent, questions: [question] }, () => 'next')
    const card = sent.find(message => message.type === 'question')
    expect(card.questions[0].options.map(option => option.label)).toEqual(['Red', 'Blue'])
    ix.handle({ type: 'question_answer', id: card.id, answers: [{ id: 'color', selected: ['Red', 'Green'], custom: ' teal ' }] })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'color', selected: ['Red'], custom: 'teal' }] })
    ix.handle({ type: 'question_answer', id: card.id, answers: [] })
    expect(sent.at(-1)).toEqual({ type: 'question_closed', id: card.id, reason: 'stale' })
    expect(cleanAnswers([question], [{ id: 'nope', selected: ['Red'] }])).toEqual([])
  })

  it('dismisses, times out, aborts, quits the plan, and forwards approval comments', async () => {
    const { ix, sent, agent, planCalls } = setup({ timeoutSecs: 0.05 })
    const dismissed = ix.ask({ agent, questions: [question] }, () => 'next')
    ix.handle({ type: 'question_dismiss', id: sent.at(-1).id })
    await expect(dismissed).rejects.toMatchObject({ code: 'ASK_CANCELLED', message: CANCEL_TEXT })

    const timed = ix.ask({ agent, questions: [question] }, () => 'next')
    await expect(timed).rejects.toMatchObject({ code: 'ASK_TIMEOUT', message: CANCEL_TEXT })
    expect(sent.at(-1)).toMatchObject({ type: 'question_closed', reason: 'timeout' })

    const controller = new AbortController()
    const aborted = ix.ask({ agent, questions: [question], signal: controller.signal }, () => 'next')
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(sent.at(-1)).toMatchObject({ type: 'question_closed', reason: 'aborted' })

    // A review never times out.
    const quit = ix.ask({ agent, questions: [review] }, () => 'next')
    await new Promise(resolve => setTimeout(resolve, 80))
    const card = sent.filter(message => message.type === 'question').at(-1)
    expect(card.review).toEqual({ plan: '# P', planFile: '/r/s1/plan.md' })
    ix.handle({ type: 'plan_quit', id: card.id })
    await expect(quit).rejects.toMatchObject({ code: 'PLAN_ABANDONED', message: QUIT_TEXT })
    expect(planCalls).toEqual([false])

    const approved = ix.ask({ agent, questions: [review] }, () => 'next')
    const next = sent.filter(message => message.type === 'question').at(-1)
    ix.handle({ type: 'question_answer', id: next.id, answers: [{ id: 'plan-review', selected: ['Approve'] }], comments: 'rename x' })
    await expect(approved).resolves.toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
    expect(agent.steered[0].content[0].text).toBe(`${APPROVED_COMMENTS_PREFIX}\nrename x`)
  })

  it('sets plan mode through dsh and refuses under --no-plan or without a session', () => {
    const { ix, sent } = setup({ planSet: 'queued' })
    ix.handle({ type: 'plan_set', id: 'p1', sessionId: 's1', active: true })
    expect(sent).toContainEqual({ type: 'plan_result', id: 'p1', outcome: 'queued', message: '' })
    expect(sent.at(-1)).toMatchObject({ type: 'plan_state', sessionId: 's1', active: true, planFile: '/r/s1/plan.md' })
    ix.handle({ type: 'plan_set', id: 'p2', sessionId: 'missing', active: true })
    expect(sent.at(-1)).toMatchObject({ type: 'plan_result', id: 'p2', outcome: 'error' })
    const sentNoPlan = []
    const agents = new Map([['s1', { session: { id: 's1' } }]])
    const noPlan = createInteraction({ get: () => undefined }, message => sentNoPlan.push(message), { interactive: true, agents, env: { CODSH_NO_PLAN: '1' } })
    noPlan.handle({ type: 'plan_set', id: 'p3', sessionId: 's1', active: true })
    expect(sentNoPlan.at(-1)).toMatchObject({ type: 'plan_result', id: 'p3', outcome: 'error', message: expect.stringContaining('--no-plan') })
  })
})

describe('plan mode and questions through real dsh', () => {
  it('answers a headless question with the no-operator text and hides disabled tools', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const sessionId = await newSession(dsh, box)
    const asked = await dsh.prompt(sessionId, 'ASK_ONE please')
    expect(asked).toContain('RUST_INTERACTION ASK_ONE plan=off')
    expect(asked).toContain('[0:error]')
    expect(asked).toContain('No user is available to answer questions')
    expect(asked).toContain('ask_user_question=yes enter_plan_mode=yes exit_plan_mode=yes')
    await dsh.stop()
    running.splice(running.indexOf(dsh), 1)

    const hidden = await startDsh(box, { env: { CODSH_NO_PLAN: '1', CODSH_NO_ASK_USER: '1' } })
    const second = await newSession(hidden, box)
    const status = await hidden.prompt(second, 'STATUS')
    expect(status).toContain('ask_user_question=no enter_plan_mode=no exit_plan_mode=no')
  }, 120000)

  it('sends the model back to unfinished todos at most twice with --todo-gate', async () => {
    const box = makeBox()
    const dsh = await startDsh(box, { env: { CODSH_TODO_GATE: '1' } })
    const sessionId = await newSession(dsh, box)
    const reply = await dsh.prompt(sessionId, 'TODOS list')
    expect(reply).toContain('RUST_INTERACTION TODOS')
    expect(reply).toContain('gate=2')
    expect(reply).not.toContain('gate=3')
    // Without the flag the turn simply ends.
    await dsh.stop()
    running.splice(running.indexOf(dsh), 1)
    const plain = await startDsh(box)
    const other = await newSession(plain, box)
    const quiet = await plain.prompt(other, 'TODOS list')
    expect(quiet).toContain('gate=0')
  }, 120000)

  it('drives plan mode, the plan gate, the review, the card, and restart over the control socket', async () => {
    const box = makeBox()
    const control = await controlServer(box)
    const dsh = await startDsh(box, { control })
    const sessionId = await newSession(dsh, box)
    await control.wait(message => message.type === 'hello', 'hello')
    await control.wait(message => message.type === 'plan_state' && message.sessionId === sessionId, 'initial plan state')

    control.send({ type: 'plan_set', id: 'p1', sessionId, active: true })
    const result = await control.wait(message => message.type === 'plan_result' && message.id === 'p1', 'plan result')
    expect(result.outcome).toBe('committed')
    const planFile = join(box.grok, 'sessions', encodeCwdDirname(box.cwd), sessionId, 'plan.md')
    await control.wait(message => message.type === 'plan_state' && message.active === true && message.planFile === planFile, 'plan on')

    const status = await dsh.prompt(sessionId, 'STATUS')
    expect(status).toContain('plan=on')
    expect(status).toContain(`planFile=${planFile}`)

    // Always-approve does not open the plan gate.
    const denied = await dsh.prompt(sessionId, 'PLAN_EDIT_OTHER')
    expect(denied).toContain('[0:error]')
    expect(denied).toContain('Plan mode is read-only')
    expect(existsSync(join(box.cwd, 'other.txt'))).toBe(false)

    const saved = await dsh.prompt(sessionId, 'PLAN_EDIT_FILE')
    expect(saved).toContain('[0:ok]')
    expect(readFileSync(planFile, 'utf8')).toContain('# Disk plan')

    // exit_plan_mode opens the review; approving ends plan mode.
    const exiting = dsh.prompt(sessionId, 'PLAN_EXIT')
    const card = await control.wait(message => message.type === 'question' && message.review !== undefined, 'plan review')
    expect(card.review.plan).toContain('# Mock plan')
    expect(card.review.planFile).toBe(planFile)
    control.send({ type: 'question_answer', id: card.id, answers: [{ id: card.questions[0].id, selected: ['Approve'] }], comments: 'keep it small' })
    const approved = await exiting
    expect(approved).toContain('[0:ok]')
    expect(readFileSync(planFile, 'utf8')).toContain('# Mock plan')
    const after = await dsh.prompt(sessionId, 'STATUS')
    expect(after).toContain('plan=off')

    // The question card: one answer goes back as the tool result.
    const asking = dsh.prompt(sessionId, 'ASK_ONE')
    const question = await control.wait(message => message.type === 'question' && message.review === undefined, 'question card')
    expect(question.questions[0]).toMatchObject({ id: 'color', header: 'Color', question: 'Which color?' })
    control.send({ type: 'question_answer', id: question.id, answers: [{ id: 'color', selected: ['Blue'] }] })
    const answered = await asking
    expect(answered).toContain('[0:ok]')
    expect(answered).toContain('Blue')

    // `q` in the review abandons the plan and leaves plan mode.
    control.send({ type: 'plan_set', id: 'p2', sessionId, active: true })
    await control.wait(message => message.type === 'plan_result' && message.id === 'p2', 'plan result 2')
    const quitting = dsh.prompt(sessionId, 'PLAN_EXIT again')
    const review = await control.wait(message => message.type === 'question' && message.review !== undefined && message.id !== card.id, 'second review')
    control.send({ type: 'plan_quit', id: review.id })
    const quit = await quitting
    expect(quit).toContain('[0:error]')
    expect(quit).toContain('abandoned')
    expect(await dsh.prompt(sessionId, 'STATUS')).toContain('plan=off')

    // Plan mode survives a restart: dsh restores it from the session log.
    control.send({ type: 'plan_set', id: 'p3', sessionId, active: true })
    await control.wait(message => message.type === 'plan_result' && message.id === 'p3', 'plan result 3')
    await dsh.stop()
    running.splice(running.indexOf(dsh), 1)
    const control2 = await controlServer(box)
    const again = await startDsh(box, { control: control2 })
    await again.send('session/resume', { sessionId, cwd: box.cwd, mcpServers: [] })
    await control2.wait(message => message.type === 'plan_state' && message.sessionId === sessionId && message.active === true, 'restored plan state')
    expect(await again.prompt(sessionId, 'STATUS')).toContain('plan=on')
  }, 180000)

  it('asks before entering plan mode, reviews an empty plan, and answers multi-select cards', async () => {
    const box = makeBox()
    const control = await controlServer(box)
    const dsh = await startDsh(box, { control, permission: { mode: 'ask' } })
    const sessionId = await newSession(dsh, box)
    const entered = await dsh.prompt(sessionId, 'PLAN_ENTER')
    // The approval is the ordinary permission prompt for that tool call.
    expect(dsh.permissions.map(request => request.toolCall.toolCallId)).toEqual([expect.stringContaining('plan_enter')])
    expect(entered).toContain('[0:ok]')
    expect(await dsh.prompt(sessionId, 'STATUS')).toContain('plan=on')

    // No plan in the call and none on disk: the review still opens, empty.
    const exiting = dsh.prompt(sessionId, 'PLAN_EMPTY')
    const review = await control.wait(message => message.type === 'question' && message.review !== undefined, 'empty review')
    expect(review.review.plan).toBe('')
    control.send({ type: 'question_answer', id: review.id, answers: [{ id: review.questions[0].id, selected: ['Approve'] }] })
    expect(await exiting).toContain('[0:ok]')
    expect(await dsh.prompt(sessionId, 'STATUS')).toContain('plan=off')

    // In ask mode the plan file is written without a prompt and any other
    // edit is refused without one.
    control.send({ type: 'plan_set', id: 'p1', sessionId, active: true })
    await control.wait(message => message.type === 'plan_result' && message.id === 'p1', 'plan on')
    expect(await dsh.prompt(sessionId, 'PLAN_EDIT_FILE')).toContain('[0:ok]')
    expect(await dsh.prompt(sessionId, 'PLAN_EDIT_OTHER')).toContain('Plan mode is read-only')
    expect(dsh.permissions).toHaveLength(1)
    expect(existsSync(join(box.cwd, 'other.txt'))).toBe(false)
    control.send({ type: 'plan_set', id: 'p2', sessionId, active: false })
    await control.wait(message => message.type === 'plan_result' && message.id === 'p2', 'plan off')

    const asking = dsh.prompt(sessionId, 'ASK_MULTI')
    const card = await control.wait(message => message.type === 'question' && message.review === undefined, 'multi card')
    expect(card.questions.map(question => question.multiSelect)).toEqual([true, false])
    control.send({ type: 'question_answer', id: card.id, answers: [
      { id: 'langs', selected: ['Rust', 'TS'] },
      { id: 'name', selected: [], custom: 'codsh' },
    ] })
    const answered = await asking
    expect(answered).toContain('[0:ok]')
    expect(answered).toMatch(/Rust/)
    expect(answered).toMatch(/TS/)
    expect(answered).toMatch(/codsh/)
  }, 120000)

  it('refuses entering plan mode when the user declines', async () => {
    const box = makeBox()
    const dsh = await startDsh(box, { permission: { mode: 'ask' } })
    const sessionId = await newSession(dsh, box)
    // Decline every approval from here on.
    dsh.decline = true
    const reply = await dsh.prompt(sessionId, 'PLAN_ENTER')
    expect(reply).toContain('[0:error]')
    expect(reply).toContain('User declined to enter plan mode.')
    expect(await dsh.prompt(sessionId, 'STATUS')).toContain('plan=off')
  }, 120000)

  it('closes an unanswered card at the configured timeout', async () => {
    const box = makeBox()
    const control = await controlServer(box)
    const dsh = await startDsh(box, { control, env: { CODSH_ASK_USER_TIMEOUT_SECS: '1' } })
    const sessionId = await newSession(dsh, box)
    const asking = dsh.prompt(sessionId, 'ASK_ONE')
    const question = await control.wait(message => message.type === 'question', 'question')
    await control.wait(message => message.type === 'question_closed' && message.id === question.id && message.reason === 'timeout', 'timeout close', 10000)
    const reply = await asking
    expect(reply).toContain('[0:error]')
    expect(reply).toContain('User declined to answer the questions')
    control.send({ type: 'question_answer', id: question.id, answers: [] })
    await control.wait(message => message.type === 'question_closed' && message.reason === 'stale', 'stale refusal')
  }, 120000)
})
