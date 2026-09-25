import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BTW_SYSTEM, apply, collectText, createControl, isChildAgent, sideHistory, sideRoute } from '../packages/cli/bin/rust-acp-control.mjs'

function fakeAgent(sessionId, { status = 'running', messages = [] } = {}) {
  const inbox = new Set()
  return {
    session: {
      id: sessionId,
      deriveMessages: () => messages,
      requestHeader: () => ({ config: { provider: 'cli-mock', model: 'cli-mock' } }),
      appended: [],
      append(...args) { this.appended.push(args) },
    },
    options: {},
    status,
    steered: [],
    inbox: { remove: id => inbox.delete(id) },
    steer(message) {
      this.steered.push(message)
      inbox.add(message.id)
    },
  }
}

function textStream(text, finish = { kind: 'stop' }) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: finish }
  })()
}

describe('rust-acp-control /workflow (ticket 183)', () => {
  it('answers with the run manager reply, or says why it cannot', async () => {
    const key = Symbol.for('codsh.rust.workflow')
    const saved = globalThis[key]
    try {
      const sent = []
      const control = createControl({ llm: {} }, message => sent.push(message))
      delete globalThis[key]
      control.handle(JSON.stringify({ type: 'workflow', id: 'w1', sessionId: 's1', text: 'runs' }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sent.at(-1)).toEqual({ type: 'workflow_result', id: 'w1', error: 'workflows are not available in this dsh (subagents are disabled or the workflow tool is not loaded)' })
      const asked = []
      globalThis[key] = {
        command: async (sessionId, text) => {
          asked.push([sessionId, text])
          if (text === 'boom') throw new Error('broken')
          return `reply to ${text}`
        },
      }
      control.handle(JSON.stringify({ type: 'workflow', id: 'w2', sessionId: 's1', text: 'pause triage' }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sent.at(-1)).toEqual({ type: 'workflow_result', id: 'w2', text: 'reply to pause triage' })
      control.handle(JSON.stringify({ type: 'workflow', id: 'w3', sessionId: 's1', text: 'boom' }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(sent.at(-1)).toEqual({ type: 'workflow_result', id: 'w3', error: 'broken' })
      expect(asked).toEqual([['s1', 'pause triage'], ['s1', 'boom']])
    } finally {
      if (saved === undefined) delete globalThis[key]
      else globalThis[key] = saved
    }
  })
})

describe('rust-acp-control steer', () => {
  it('steers only a running agent and reports claim, discard, and idle reclaim', () => {
    const sent = []
    const control = createControl({ llm: {} }, message => sent.push(message))
    const agent = fakeAgent('s1')
    control.onCreated(agent)
    control.handle(JSON.stringify({ type: 'steer', id: 'q1', sessionId: 's1', text: 'go left' }))
    expect(sent).toEqual([{ type: 'steer_accepted', id: 'q1' }])
    expect(agent.steered).toHaveLength(1)
    expect(agent.steered[0].content).toEqual([{ type: 'text', text: 'go left' }])
    expect(agent.steered[0].source).toEqual({ kind: 'user' })
    control.onClaimed(agent, agent.steered[0])
    expect(sent.at(-1)).toEqual({ type: 'steer_claimed', id: 'q1' })
    // A claimed steer is not reclaimed at idle.
    control.onStatus(agent, 'idle')
    expect(sent).toHaveLength(2)

    control.handle(JSON.stringify({ type: 'steer', id: 'q2', sessionId: 's1', text: 'b' }))
    control.onDiscarded(agent, agent.steered[1])
    expect(sent.at(-1)).toEqual({ type: 'steer_returned', id: 'q2' })

    control.handle(JSON.stringify({ type: 'steer', id: 'q3', sessionId: 's1', text: 'c' }))
    control.onStatus(agent, 'idle')
    expect(sent.at(-1)).toEqual({ type: 'steer_returned', id: 'q3' })
    expect(control.steers.size).toBe(0)
  })

  it('refuses an idle agent (steer would start a turn) and an unknown session', () => {
    const sent = []
    const control = createControl({ llm: {} }, message => sent.push(message))
    const idle = fakeAgent('s1', { status: 'idle' })
    control.onCreated(idle)
    control.handle(JSON.stringify({ type: 'steer', id: 'q1', sessionId: 's1', text: 'x' }))
    control.handle(JSON.stringify({ type: 'steer', id: 'q2', sessionId: 'nope', text: 'x' }))
    expect(sent).toEqual([{ type: 'steer_idle', id: 'q1' }, { type: 'steer_idle', id: 'q2' }])
    expect(idle.steered).toHaveLength(0)
  })

  it('never lets a subagent child stand in for the top-level agent', () => {
    const sent = []
    const control = createControl({ llm: {} }, message => sent.push(message))
    const root = fakeAgent('s1')
    const child = fakeAgent('s1')
    child.options.subagentDepth = 1
    const headerChild = fakeAgent('s1')
    headerChild.session.header = { delegationDepth: 2 }
    control.onCreated(root)
    control.onCreated(child)
    control.onCreated(headerChild)
    control.handle(JSON.stringify({ type: 'steer', id: 'q1', sessionId: 's1', text: 'x' }))
    expect(root.steered).toHaveLength(1)
    expect(child.steered).toHaveLength(0)
    expect(headerChild.steered).toHaveLength(0)
    expect(isChildAgent(root)).toBe(false)
  })

  it('returns unclaimed steers when the agent is disposed and ignores other agents', () => {
    const sent = []
    const control = createControl({ llm: {} }, message => sent.push(message))
    const a = fakeAgent('s1')
    const b = fakeAgent('s2')
    control.onCreated(a)
    control.onCreated(b)
    control.handle(JSON.stringify({ type: 'steer', id: 'q1', sessionId: 's1', text: 'x' }))
    control.onClaimed(b, a.steered[0])
    expect(sent).toEqual([{ type: 'steer_accepted', id: 'q1' }])
    control.onDisposed(a)
    expect(sent.at(-1)).toEqual({ type: 'steer_returned', id: 'q1' })
    expect(control.agents.has('s1')).toBe(false)
  })
})

describe('rust-acp-control side questions', () => {
  it('asks from a copy of the history and never appends to the session', async () => {
    const sent = []
    const calls = []
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'main task' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'working' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
    ]
    const llm = { stream: options => { calls.push(options); return textStream('because') } }
    const control = createControl({ llm }, message => sent.push(message))
    const agent = fakeAgent('s1', { messages: history })
    control.onCreated(agent)
    control.handle(JSON.stringify({ type: 'btw', id: 'b1', sessionId: 's1', question: 'why?' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent).toEqual([{ type: 'btw_answer', id: 'b1', text: 'because' }])
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toBe(BTW_SYSTEM)
    expect(calls[0].provider).toBe('cli-mock')
    expect(calls[0].tools).toBeUndefined()
    expect(calls[0].purpose).toBeUndefined()
    // The unanswered tool call is dropped; the question is the last user message.
    expect(calls[0].messages[1].content).toEqual([{ type: 'text', text: 'working' }])
    expect(calls[0].messages.at(-1).content).toEqual([{ type: 'text', text: 'why?' }])
    expect(agent.session.appended).toEqual([])
    expect(history[1].content).toHaveLength(2)
  })

  it('reports a failed or empty answer and stays silent after cancel', async () => {
    const sent = []
    let release
    const llm = {
      stream: options => {
        if (options.messages.at(-1).content[0].text === 'slow') {
          return (async function* () {
            await new Promise(resolve => { release = resolve })
            yield* textStream('late')
          })()
        }
        return textStream('', { kind: 'error', failure: { message: 'side model failed' } })
      },
    }
    const control = createControl({ llm }, message => sent.push(message))
    control.onCreated(fakeAgent('s1'))
    control.handle(JSON.stringify({ type: 'btw', id: 'b1', sessionId: 's1', question: 'bad' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent).toEqual([{ type: 'btw_error', id: 'b1', message: 'side model failed' }])
    control.handle(JSON.stringify({ type: 'btw', id: 'b2', sessionId: 's1', question: 'slow' }))
    control.handle(JSON.stringify({ type: 'btw_cancel', id: 'b2' }))
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent).toHaveLength(1)
    control.handle(JSON.stringify({ type: 'btw', id: 'b3', sessionId: 'missing', question: 'q' }))
    expect(sent.at(-1).type).toBe('btw_error')
  })

  it('keeps only complete tool exchanges and resolves the recorded route', async () => {
    const kept = sideHistory([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'x', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'a', content: [] }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'b', name: 'x', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'zzz', content: [] }] },
    ])
    expect(kept).toHaveLength(2)
    expect(sideRoute({ session: { requestHeader: () => undefined }, options: { provider: 'p', model: 'm' } })).toEqual({ provider: 'p', model: 'm' })
    expect(sideRoute({ session: {}, options: {} })).toBeUndefined()
    await expect(collectText(textStream('   '))).rejects.toThrow('no text')
  })
})

describe('rust-acp-control transport', () => {
  it('removes the socket and token from the environment and presents the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codsh-control-'))
    const path = join(dir, 's')
    const lines = []
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      socket.on('data', chunk => lines.push(...chunk.split('\n').filter(Boolean)))
    })
    await new Promise(resolve => server.listen(path, resolve))
    process.env.CODSH_CONTROL_SOCKET = path
    process.env.CODSH_CONTROL_TOKEN = 'secret-token'
    const handlers = {}
    const ctx = { llm: {}, logger: { warn() {} }, on: (name, fn) => { handlers[name] = fn } }
    try {
      apply(ctx)
      expect(process.env.CODSH_CONTROL_SOCKET).toBeUndefined()
      expect(process.env.CODSH_CONTROL_TOKEN).toBeUndefined()
      for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(JSON.parse(lines[0])).toEqual({ type: 'hello', token: 'secret-token' })
      expect(Object.keys(handlers).sort()).toEqual(['agent/created', 'agent/disposed', 'agent/inbox/claimed', 'agent/inbox/discarded', 'agent/status', 'dispose', 'session/event', 'user-questions/request'])
    } finally {
      handlers.dispose?.()
      await new Promise(resolve => server.close(resolve))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opens no socket without the environment but still answers questions as no operator', async () => {
    delete process.env.CODSH_CONTROL_SOCKET
    delete process.env.CODSH_CONTROL_TOKEN
    process.env.CODSH_INTERACTION = 'tui'
    const handlers = {}
    apply({ llm: {}, logger: { warn() {} }, get: () => undefined, on: (name, fn) => { handlers[name] = fn } })
    // No socket: steer and inbox listeners are not registered.
    expect(Object.keys(handlers).sort()).toEqual(['agent/created', 'agent/disposed', 'dispose', 'session/event', 'user-questions/request'])
    expect(process.env.CODSH_INTERACTION).toBeUndefined()
    const agent = fakeAgent('s-plain')
    handlers['agent/created']({ agent })
    await expect(handlers['user-questions/request']({ agent, questions: [{ id: 'q', question: 'x?' }] }, () => 'next'))
      .rejects.toMatchObject({ code: 'NO_OPERATOR' })
    handlers.dispose()
  })
})
