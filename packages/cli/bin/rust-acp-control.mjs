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
 *
 * The client passes a Unix socket path and a one-time token in the
 * environment. Both are removed from `process.env` before anything else runs,
 * so tool children never inherit them. Without them the plugin is inert.
 */
import { createConnection } from 'node:net'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'rust-acp-control'
export const inject = ['llm']

/** System line for side questions. The mock fixture keys on its prefix. */
export const BTW_SYSTEM = [
  'codsh side question (/btw).',
  'Answer the question at the end briefly, using the conversation so far only as context.',
  'You cannot call tools. Do not continue or change the main task.',
].join(' ')

const MAX_LINE = 4 * 1024 * 1024

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

/**
 * The control state machine without the socket, so it can be tested.
 * @param {object} ctx - cordis context with `llm` and `logger`.
 * @param {(message: object) => void} send - writes one message to the client.
 */
export function createControl(ctx, send) {
  const agents = new Map()
  const steers = new Map()
  const btws = new Map()

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
    }
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

  return {
    agents,
    steers,
    onCreated(agent) {
      // Only the top-level agent of a session takes steers and side
      // questions; a subagent child never stands in for it.
      if (isChildAgent(agent)) return
      agents.set(agent.session.id, agent)
    },
    onDisposed(agent) {
      reclaim(agent)
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
      if (request.type === 'steer') steer(request)
      else if (request.type === 'btw') void btw(request)
      else if (request.type === 'btw_cancel') btws.get(request.id)?.abort()
    },
    close() {
      for (const controller of btws.values()) controller.abort()
    },
  }
}

export function apply(ctx) {
  const path = process.env.CODSH_CONTROL_SOCKET
  const token = process.env.CODSH_CONTROL_TOKEN
  // Tool children are built from this environment. The token must not reach them.
  delete process.env.CODSH_CONTROL_SOCKET
  delete process.env.CODSH_CONTROL_TOKEN
  if (!path || !token) return
  const socket = createConnection(path)
  socket.setEncoding('utf8')
  const send = (message) => {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`)
  }
  const control = createControl(ctx, send)
  let buffer = ''
  socket.on('connect', () => send({ type: 'hello', token }))
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
  socket.on('close', () => control.close())
  // The socket must not keep dsh alive after stdin closes.
  socket.unref()
  ctx.on('agent/created', ({ agent }) => control.onCreated(agent))
  ctx.on('agent/disposed', ({ agent }) => control.onDisposed(agent))
  ctx.on('agent/inbox/claimed', ({ agent, message }) => control.onClaimed(agent, message))
  ctx.on('agent/inbox/discarded', ({ agent, message }) => control.onDiscarded(agent, message))
  ctx.on('agent/status', ({ agent, status }) => control.onStatus(agent, status))
  ctx.on('dispose', () => {
    control.close()
    socket.destroy()
  })
}
