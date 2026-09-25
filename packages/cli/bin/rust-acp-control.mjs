/**
 * Private control channel between the Rust client and the dsh process it
 * spawned. It carries two things the ACP surface has no method for:
 *
 * - steer: a queued follow-up handed to the RUNNING agent with `agent.steer`,
 *   so dsh takes it at its next step boundary. Claimed, discarded, and
 *   reclaimed messages are reported back so the client never loses or
 *   double-sends the row.
 * - btw: a side question answered by a one-shot model request built from a
 *   copy of the session history. Nothing is appended to the session, so the
 *   main history never sees the question or the answer.
 * - background / job_kill: Ctrl+B and the tasks pane, handed to the
 *   rust-acp-background plugin (ticket 175). A steer also moves a running
 *   foreground command to the background, so the message is not stuck
 *   behind it.
 *
 * - schedule_delete: the tasks pane's delete for a scheduled prompt, handed
 *   to rust-acp-scheduler (ticket 177).
 * - schedule_owner: the client holding a session's owner lock hands over
 *   its token, so rust-acp-scheduler saves that session's loops and
 *   restores the saved ones (ticket 178). The socket closing means the
 *   owning client is gone: every loop stops firing and saving at once.
 *
 * - usage (ticket 65): the session usage ledger of rust-usage.mjs, folded
 *   from the live session and its subagent children (persisted children of
 *   an earlier process are read from the session store). Cost is unknown:
 *   dsh reports tokens only.
 * - questions, plan review, plan state, and todos (ticket 179): see
 *   rust-acp-interaction.mjs.
 * - workflow: `/workflow [runs | pause | resume | stop | save] [name]` and
 *   `/workflow <name> [args]`, answered by the workflow run manager of
 *   rust-acp-subagents (tickets 183, 184) with the reference reply text; a
 *   request with `launch` is a saved workflow's `/<name>` and its `text` the
 *   arguments.
 * - goal: `/goal` set, status, pause, resume, and clear, handed to the
 *   rust-acp-goal plugin (ticket 180). The answer is one `goal_result`.
 * - memory_model: one background memory request (`/flush`, `/dream`, and
 *   their automatic runs; ticket 186). The client builds the system prompt
 *   and the closing user message; a flush adds the last messages of this
 *   session. Nothing is appended to the session. The answer names the route,
 *   what was sent (message and character counts), and the provider usage.
 *
 * The client passes a Unix socket path and a one-time token in the
 * environment. Both are removed from `process.env` before anything else runs,
 * so tool children never inherit them. Without them the plugin is inert.
 */
import { createConnection } from 'node:net'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createInteraction } from './rust-acp-interaction.mjs'
import { composeLedger } from './rust-usage.mjs'

export const name = 'rust-acp-control'
export const inject = ['llm']

/** System line for side questions. The mock fixture keys on its prefix. */
export const BTW_SYSTEM = [
  'codsh side question (/btw).',
  'Answer the question at the end briefly, using the conversation so far only as context.',
  'You cannot call tools. Do not continue or change the main task.',
].join(' ')

const MAX_LINE = 4 * 1024 * 1024
/** rust-acp-background registers itself here; see that plugin. */
const BACKGROUND = Symbol.for('codsh.rust.background')
/** rust-acp-workflow publishes its run manager here. */
const WORKFLOW = Symbol.for('codsh.rust.workflow')

function backgroundPlugin() {
  return globalThis[BACKGROUND]
}

/** rust-acp-scheduler registers itself here when the scheduler is enabled. */
const SCHEDULER = Symbol.for('codsh.rust.scheduler')
/** rust-acp-goal registers itself here; see that plugin. */
const GOAL = Symbol.for('codsh.rust.goal')

/**
 * Keep only complete tool exchanges. A tool call without its result (the turn
 * is still running) or a result without its call would be rejected by most
 * providers, and a side request declares no tools.
 * @param {Array<any>} messages - session-derived history.
 */
export function sideHistory(messages) {
  const calls = new Set()
  const results = new Set()
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool-call') calls.add(block.id)
      if (block?.type === 'tool-result') results.add(block.toolCallId)
    }
  }
  const out = []
  for (const message of messages ?? []) {
    if (!Array.isArray(message?.content)) continue
    const content = message.content.filter(block => {
      if (block?.type === 'tool-call') return results.has(block.id)
      if (block?.type === 'tool-result') return calls.has(block.toolCallId)
      return true
    })
    if (content.length === 0) continue
    out.push(content.length === message.content.length ? message : { ...message, content })
  }
  return out
}

/** A delegated (subagent) agent: dsh records a nonzero delegation depth. */
export function isChildAgent(agent) {
  const runtime = agent?.options?.subagentDepth
  const header = agent?.session?.header?.delegationDepth
  return (Number.isSafeInteger(runtime) && runtime > 0) || (Number.isSafeInteger(header) && header > 0)
}

/** Route of the session's recorded request header, else the agent options. */
export function sideRoute(agent) {
  const header = agent?.session?.requestHeader?.()?.config
  const provider = header?.provider ?? agent?.options?.provider
  const model = header?.model ?? agent?.options?.model
  if (!provider || !model) return undefined
  return { provider, model }
}

/** Assemble streamed text; throw on a terminal failure. */
export async function collectText(stream) {
  let text = ''
  let finish
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') text += String(chunk.text ?? '')
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && text === '') text = String(chunk.block.text ?? '')
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(finish.failure?.message ?? finish.kind)
  }
  if (finish?.kind === 'tool-calls') throw new Error('side question model asked for a tool')
  if (text.trim() === '') throw new Error('side question model produced no text')
  return text
}

/** Memory purposes the client may ask for. */
export const MEMORY_PURPOSES = new Set(['flush', 'dream'])
/** Default and largest flush window (the reference sends the last 20 messages). */
export const MEMORY_FLUSH_WINDOW = 20
const MEMORY_MAX_WINDOW = 200

/**
 * The last `window` messages of complete exchanges, starting at a user
 * message so no provider sees an orphan assistant turn first.
 * @param {Array<any>} messages - session-derived history.
 * @param {number} window - message budget.
 */
export function memoryWindow(messages, window = MEMORY_FLUSH_WINDOW) {
  const history = sideHistory(messages)
  const typed = message => message?.role === 'user' && (message.content ?? []).some(block => block?.type === 'text')
  let start = Math.max(0, history.length - window)
  while (start < history.length && !typed(history[start])) start += 1
  if (start >= history.length) {
    // No typed user message inside the budget: fall back to the last one.
    start = history.findLastIndex(typed)
    if (start < 0) return []
  }
  const kept = sideHistory(history.slice(start))
  const first = kept.findIndex(typed)
  return first < 0 ? [] : kept.slice(first)
}

/** Characters of text the request carries (the system prompt included). */
export function sentChars(system, messages) {
  let total = String(system ?? '').length
  for (const message of messages) {
    for (const block of message?.content ?? []) {
      if (typeof block?.text === 'string') total += block.text.length
      else if (block?.type === 'tool-call') total += (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? block.input ?? {})).length
      else if (block?.type === 'tool-result') total += JSON.stringify(block.output ?? block.content ?? '').length
    }
  }
  return total
}

/** Streamed text and the provider's usage chunk; throw on a terminal failure. */
export async function collectReply(stream) {
  let text = ''
  let usage = null
  let finish
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') text += String(chunk.text ?? '')
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && text === '') text = String(chunk.block.text ?? '')
    else if (chunk?.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(finish.failure?.message ?? finish.kind)
  }
  if (finish?.kind === 'tool-calls') throw new Error('memory model asked for a tool')
  return { text, usage }
}

/**
 * The control state machine without the socket, so it can be tested.
 * @param {object} ctx - cordis context with `llm` and `logger`.
 * @param {(message: object) => void} send - writes one message to the client.
 */
export function createControl(ctx, send, options = {}) {
  const agents = new Map()
  const steers = new Map()
  const btws = new Map()
  const memoryJobs = new Map()
  // Every session that emitted an event here (top-level and subagent
  // children), so the usage ledger folds live logs.
  const sessions = new Map()
  const interaction = createInteraction(ctx, send, {
    interactive: options.interactive === true,
    timeoutSecs: options.timeoutSecs ?? 0,
    connected: options.connected,
    agents,
    env: options.env,
  })

  const returnSteer = (messageId) => {
    const entry = steers.get(messageId)
    if (entry === undefined) return
    steers.delete(messageId)
    send({ type: 'steer_returned', id: entry.id })
  }
  /** Take back every steer this agent has not consumed. */
  const reclaim = (agent) => {
    for (const [messageId, entry] of steers) {
      if (entry.agent !== agent) continue
      // Still tracked means never claimed. Whether this removes it from the
      // inbox or dsh already dropped it, the client gets the row back.
      try {
        agent.inbox.remove(messageId)
      } catch {
        // A disposed inbox has nothing left to remove.
      }
      returnSteer(messageId)
    }
  }

  const steer = (request) => {
    const agent = agents.get(request.sessionId)
    const text = typeof request.text === 'string' ? request.text : ''
    if (agent === undefined || agent.status !== 'running' || text.trim() === '') {
      send({ type: 'steer_idle', id: request.id })
      return
    }
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    steers.set(message.id, { id: request.id, agent })
    send({ type: 'steer_accepted', id: request.id })
    try {
      agent.steer(message)
    } catch (error) {
      ctx.logger?.warn?.(`rust-acp-control: steer failed: ${String(error)}`)
      returnSteer(message.id)
      return
    }
    // The steer is taken at the next step boundary. A foreground command
    // would hold that boundary until it exits, so it moves to the background.
    backgroundPlugin()?.promote(request.sessionId, 'message')
  }

  const background = (request) => {
    const plugin = backgroundPlugin()
    const reason = request.reason === 'message' ? 'message' : 'user'
    const count = plugin === undefined ? 0 : plugin.promote(request.sessionId, reason)
    send({ type: 'background_result', id: request.id, count, available: plugin !== undefined })
  }

  const jobKill = (request) => {
    const plugin = backgroundPlugin()
    const agent = agents.get(request.sessionId)
    const jobId = typeof request.jobId === 'string' ? request.jobId : ''
    try {
      if (plugin === undefined) throw new Error('background commands are unavailable in this dsh')
      if (agent === undefined) throw new Error('no live dsh session for this command')
      const outcome = plugin.kill(agent, jobId)
      send({ type: 'job_kill_result', id: request.id, jobId, outcome })
    } catch (error) {
      send({ type: 'job_kill_result', id: request.id, jobId, error: String(error?.message ?? error) })
    }
  }

  const scheduleDelete = (request) => {
    const scheduler = globalThis[SCHEDULER]
    const agent = agents.get(request.sessionId)
    const taskId = typeof request.taskId === 'string' ? request.taskId : ''
    try {
      if (scheduler === undefined) throw new Error('scheduled prompts are unavailable in this dsh')
      if (agent === undefined) throw new Error('no live dsh session for this task')
      const result = scheduler.delete(agent, taskId)
      send({ type: 'schedule_delete_result', id: request.id, taskId, success: result.success, message: result.message })
    } catch (error) {
      send({ type: 'schedule_delete_result', id: request.id, taskId, error: String(error?.message ?? error) })
    }
  }

  const workflow = async (request) => {
    const runs = globalThis[WORKFLOW]
    try {
      if (runs === undefined) throw new Error('workflows are not available in this dsh (subagents are disabled or the workflow tool is not loaded)')
      const launch = typeof request.launch === 'string' ? request.launch : undefined
      const text = await runs.command(String(request.sessionId ?? ''), typeof request.text === 'string' ? request.text : '', { launch })
      send({ type: 'workflow_result', id: request.id, text })
    } catch (error) {
      send({ type: 'workflow_result', id: request.id, error: String(error?.message ?? error) })
    }
  }

  const goal = (request) => {
    const plugin = globalThis[GOAL]
    const agent = agents.get(request.sessionId)
    let result
    if (plugin === undefined) result = { ok: false, message: 'goal mode is unavailable in this dsh' }
    else if (agent === undefined) result = { ok: false, message: '/goal needs a live dsh session' }
    else {
      try {
        result = plugin.command(agent, request)
      } catch (error) {
        result = { ok: false, message: String(error?.message ?? error) }
      }
    }
    send({ type: 'goal_result', id: request.id, action: String(request.action ?? 'status'), ok: result.ok === true, message: String(result.message ?? '') })
  }

  const scheduleOwner = (request) => {
    const scheduler = globalThis[SCHEDULER]
    const agent = agents.get(request.sessionId)
    const token = typeof request.token === 'string' ? request.token : ''
    let outcome
    if (scheduler === undefined) outcome = { error: 'scheduled prompts are unavailable in this dsh' }
    else if (agent === undefined) outcome = { error: 'no live dsh session for this owner' }
    else outcome = scheduler.attach(agent, token)
    send({ type: 'schedule_owner_result', id: request.id, sessionId: request.sessionId, ...outcome })
  }

  const btw = async (request) => {
    const id = request.id
    const agent = agents.get(request.sessionId)
    const question = typeof request.question === 'string' ? request.question.trim() : ''
    if (agent === undefined) {
      send({ type: 'btw_error', id, message: 'no live dsh session for this side question' })
      return
    }
    if (question === '') {
      send({ type: 'btw_error', id, message: 'side question is empty' })
      return
    }
    const route = sideRoute(agent)
    if (route === undefined) {
      send({ type: 'btw_error', id, message: 'no model route is recorded for this session' })
      return
    }
    const controller = new AbortController()
    btws.set(id, controller)
    try {
      const messages = [
        ...sideHistory(agent.session.deriveMessages()),
        createUserMessage({ content: [{ type: 'text', text: question }], source: { kind: 'plugin', plugin: name } }),
      ]
      const text = await collectText(ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        system: BTW_SYSTEM,
        maxTokens: 2048,
        sessionId: agent.session.id,
        signal: controller.signal,
      }))
      if (!controller.signal.aborted) send({ type: 'btw_answer', id, text })
    } catch (error) {
      if (!controller.signal.aborted) send({ type: 'btw_error', id, message: String(error?.message ?? error) })
    } finally {
      btws.delete(id)
    }
  }

  const memoryModel = async (request) => {
    const id = request.id
    const purpose = String(request.purpose ?? '')
    const fail = (message, extra = {}) => send({ type: 'memory_model_error', id, message, ...extra })
    if (!MEMORY_PURPOSES.has(purpose)) return fail(`unknown memory request: ${purpose || '(none)'}`)
    const agent = agents.get(request.sessionId)
    if (agent === undefined) return fail('no live dsh session for this memory request')
    const route = sideRoute(agent)
    if (route === undefined) return fail('no model route is recorded for this session')
    const override = typeof request.model === 'string' ? request.model.trim() : ''
    const model = override === '' ? route.model : override
    const system = typeof request.system === 'string' ? request.system : ''
    const user = typeof request.user === 'string' ? request.user : ''
    if (system.trim() === '' || user.trim() === '') return fail('memory request is empty')
    let history = []
    if (purpose === 'flush') {
      const asked = Number(request.window)
      const window = Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, MEMORY_MAX_WINDOW) : MEMORY_FLUSH_WINDOW
      history = memoryWindow(agent.session.deriveMessages(), window)
      if (history.length === 0) return fail('this session has no conversation to flush yet', { empty: true })
    }
    const messages = [
      ...history,
      createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'plugin', plugin: name } }),
    ]
    const sent = { provider: route.provider, model, sentMessages: messages.length, sentChars: sentChars(system, messages) }
    const controller = new AbortController()
    memoryJobs.set(id, controller)
    try {
      const { text, usage } = await collectReply(ctx.llm.stream({
        provider: route.provider,
        model,
        messages,
        system,
        maxTokens: 8192,
        sessionId: agent.session.id,
        signal: controller.signal,
      }))
      if (controller.signal.aborted) fail('memory request cancelled', { cancelled: true, ...sent })
      else send({ type: 'memory_model_result', id, text, usage, ...sent })
    } catch (error) {
      if (controller.signal.aborted) fail('memory request cancelled', { cancelled: true, ...sent })
      else fail(String(error?.message ?? error), sent)
    } finally {
      memoryJobs.delete(id)
    }
  }

  const loadSession = async (sessionId) => {
    const live = sessions.get(sessionId) ?? agents.get(sessionId)?.session
    if (live !== undefined && typeof live.snapshotEvents === 'function') {
      return { events: live.snapshotEvents(), inheritedEventCount: live.inheritedEventCount ?? 0 }
    }
    const persistence = options.persistence?.()
    if (persistence === undefined || typeof persistence.open !== 'function') {
      throw new Error('the dsh session store is not available')
    }
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
    } catch (error) {
      if (error?.name === 'SessionPersistenceNotFoundError' || /not found/i.test(String(error?.message ?? error))) return undefined
      throw error
    }
    try {
      const { events } = await handle.read()
      return { events, inheritedEventCount: handle.inheritedEventCount ?? 0 }
    } finally {
      await handle.close?.().catch?.(() => undefined)
    }
  }

  const usageLedger = async (request) => {
    const id = request.id
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
    if (sessionId === '' || (!agents.has(sessionId) && !sessions.has(sessionId))) {
      send({ type: 'usage_error', id, message: 'no live dsh session for usage' })
      return
    }
    const sinceTime = Number(request.sinceTime)
    try {
      const ledger = await composeLedger(sessionId, loadSession, Number.isFinite(sinceTime) && sinceTime > 0 ? { sinceTime } : {})
      // Live surfaces need the totals only; the per-turn rows stay out of the line.
      if (request.turns === false) delete ledger.turns
      send({ type: 'usage_result', id, sessionId, ledger })
    } catch (error) {
      send({ type: 'usage_error', id, message: String(error?.message ?? error) })
    }
  }

  return {
    agents,
    steers,
    sessions,
    interaction,
    trackSession(session) {
      if (session && typeof session.id === 'string' && !sessions.has(session.id)) sessions.set(session.id, session)
    },
    onCreated(agent) {
      // Only the top-level agent of a session takes steers, side questions,
      // and the question card; a subagent child never stands in for it.
      if (isChildAgent(agent)) return
      agents.set(agent.session.id, agent)
      interaction.onCreated(agent)
    },
    onDisposed(agent) {
      reclaim(agent)
      interaction.onDisposed(agent)
      if (agents.get(agent.session.id) === agent) agents.delete(agent.session.id)
    },
    onClaimed(agent, message) {
      const entry = steers.get(message.id)
      if (entry === undefined || entry.agent !== agent) return
      steers.delete(message.id)
      send({ type: 'steer_claimed', id: entry.id })
    },
    onDiscarded(agent, message) {
      const entry = steers.get(message.id)
      if (entry === undefined || entry.agent !== agent) return
      returnSteer(message.id)
    },
    onStatus(agent, status) {
      if (status === 'idle') reclaim(agent)
    },
    handle(line) {
      let request
      try {
        request = JSON.parse(line)
      } catch {
        return
      }
      if (request === null || typeof request !== 'object' || typeof request.id !== 'string') return
      if (interaction.handle(request)) return
      if (request.type === 'steer') steer(request)
      else if (request.type === 'btw') void btw(request)
      else if (request.type === 'btw_cancel') btws.get(request.id)?.abort()
      else if (request.type === 'background') background(request)
      else if (request.type === 'job_kill') jobKill(request)
      else if (request.type === 'schedule_delete') scheduleDelete(request)
      else if (request.type === 'workflow') void workflow(request)
      else if (request.type === 'goal') goal(request)
      else if (request.type === 'schedule_owner') scheduleOwner(request)
      else if (request.type === 'memory_model') void memoryModel(request)
      else if (request.type === 'memory_model_cancel') memoryJobs.get(request.id)?.abort()
      else if (request.type === 'usage') void usageLedger(request)
    },
    close() {
      for (const controller of btws.values()) controller.abort()
      for (const controller of memoryJobs.values()) controller.abort()
      interaction.close()
    },
  }
}

export function apply(ctx) {
  const path = process.env.CODSH_CONTROL_SOCKET
  const token = process.env.CODSH_CONTROL_TOKEN
  // Only the terminal UI draws a question card (the Rust client sets this).
  const tui = process.env.CODSH_INTERACTION === 'tui'
  // Tool children are built from this environment. The token must not reach them.
  delete process.env.CODSH_CONTROL_SOCKET
  delete process.env.CODSH_CONTROL_TOKEN
  delete process.env.CODSH_INTERACTION
  let socket
  let connected = false
  const write = (message) => {
    if (socket !== undefined && !socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`)
  }
  // Nothing but the hello may go out before the handshake line.
  const send = (message) => {
    if (connected) write(message)
  }
  const control = createControl(ctx, send, {
    interactive: tui && Boolean(path && token),
    timeoutSecs: Number(process.env.CODSH_ASK_USER_TIMEOUT_SECS ?? '0'),
    connected: () => connected,
    persistence: () => {
      try {
        return ctx.get?.('sessionPersistence') ?? undefined
      } catch {
        return undefined
      }
    },
  })
  // The answerer is registered even without a terminal, so a plain prompt
  // gets the no-operator answer instead of "no answerer".
  ctx.on('user-questions/request', (request, next) => control.interaction.ask(request, next))
  ctx.on('agent/created', ({ agent }) => control.onCreated(agent))
  ctx.on('agent/disposed', ({ agent }) => control.onDisposed(agent))
  ctx.on('session/event', (session, event) => {
    control.trackSession(session)
    control.interaction.onSessionEvent(session, event)
  })
  ctx.on('dispose', () => {
    control.close()
    socket?.destroy()
  })
  if (!path || !token) return
  socket = createConnection(path)
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('connect', () => {
    write({ type: 'hello', token })
    connected = true
    for (const agent of control.agents.values()) control.interaction.onCreated(agent)
  })
  socket.on('data', (chunk) => {
    buffer += chunk
    if (buffer.length > MAX_LINE) {
      socket.destroy()
      return
    }
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim() !== '') control.handle(line)
    }
  })
  socket.on('error', (error) => ctx.logger?.warn?.(`rust-acp-control: ${String(error?.message ?? error)}`))
  socket.on('close', () => {
    connected = false
    control.close()
    // The owning client is gone: its loops must not keep firing unseen.
    globalThis[SCHEDULER]?.stopAll()
  })
  // The socket must not keep dsh alive after stdin closes.
  socket.unref()
  ctx.on('agent/inbox/claimed', ({ agent, message }) => control.onClaimed(agent, message))
  ctx.on('agent/inbox/discarded', ({ agent, message }) => control.onDiscarded(agent, message))
  ctx.on('agent/status', ({ agent, status }) => control.onStatus(agent, status))
}
