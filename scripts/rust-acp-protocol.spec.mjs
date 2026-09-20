import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'

const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const homes = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function dshPath() {
  const manifest = JSON.parse(require('node:fs').readFileSync(dshManifest, 'utf8'))
  const bin = manifest.bin
  return join(dirname(dshManifest), typeof bin === 'string' ? bin : bin.dsh)
}

function startAgent(mode) {
  const root = mkdtempSync(join('/tmp', 'codsh-acp-protocol-'))
  homes.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  mkdirSync(home)
  mkdirSync(cwd)
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const child = spawn(process.execPath, [dshPath(), '--profile', 'acp', '--patch', overlay], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      DSH_CODE_CLI_MOCK_TOOL: mode,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_UPDATE_CHECK: 'off',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  const frames = []
  const stderr = []
  createInterface({ input: child.stdout }).on('line', line => {
    frames.push(line)
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.id != null && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message), { error: msg.error, frames }))
      else waiter.resolve(msg.result)
    }
  })
  child.stderr.on('data', chunk => { stderr.push(String(chunk)) })
  function send(id, method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.join('')}`)), 20000)
    })
  }
  return { root, home, cwd, child, send, updates, frames, stderr }
}

async function handshake(agent, cwd = agent.cwd) {
  const init = await agent.send(1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'codsh-acp-protocol-test', version: '0.0.0' },
  })
  const session = await agent.send(2, 'session/new', { cwd, mcpServers: [] })
  return { init, session }
}

describe('public ACP/JSON-RPC against real dsh', () => {
  it('negotiates v1, streams content blocks in order, and keeps identifiers stable', async () => {
    const agent = startAgent('reasoning')
    try {
      const { init, session } = await handshake(agent)
      expect(init.protocolVersion).toBe(1)
      expect(init.agentInfo.name).toBe('deepseek-harness-acp')
      expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/u)
      expect(JSON.stringify(session.configOptions)).toContain('cli-mock')
      const first = await agent.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'first rust acp question' }],
      })
      expect(first.stopReason).toBe('end_turn')
      const thought = agent.updates.find(update => update.update.sessionUpdate === 'agent_thought_chunk')
      const answer = agent.updates.find(update => update.update.sessionUpdate === 'agent_message_chunk')
      expect(thought.update.content).toEqual({ type: 'text', text: 'RUST_ACP_THOUGHT weighing the request' })
      expect(answer.update.content.text).toContain('RUST_ACP_ANSWER turn=')
      expect(thought.update.messageId).toBe(answer.update.messageId)
      expect(thought.sessionId).toBe(session.sessionId)
      const before = agent.updates.length
      const second = await agent.send(4, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'second rust acp question' }],
      })
      expect(second.stopReason).toBe('end_turn')
      const later = agent.updates.slice(before)
      const secondAnswer = later.find(update => update.update.sessionUpdate === 'agent_message_chunk')
      expect(secondAnswer.update.messageId).not.toBe(answer.update.messageId)
      expect(secondAnswer.update.content.text).not.toBe(answer.update.content.text)
      await agent.send(5, 'session/close', { sessionId: session.sessionId })
      expect(existsSync(join(agent.home, 'sessions'))).toBe(true)
      expect(JSON.stringify(readdirSync(join(agent.home, 'sessions'), { recursive: true }))).toContain(session.sessionId)
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
    }
  }, 30000)

  it('echoes the submitted prompt through dsh without fabricating success on empty or failure', async () => {
    const echo = startAgent('echo')
    try {
      const { session } = await handshake(echo)
      const result = await echo.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_ECHO_PROBE' }],
      })
      expect(result.stopReason).toBe('end_turn')
      const echoed = echo.updates.find(update => update.update.sessionUpdate === 'agent_message_chunk')
      expect(echoed.update.content.text).toContain('TOKEN_ECHO_PROBE')
      expect(echoed.update.content.text).toContain('RUST_ACP_ANSWER')
      await echo.send(4, 'session/close', { sessionId: session.sessionId })
    } finally {
      echo.child.stdin.end()
      echo.child.kill('SIGTERM')
    }

    const empty = startAgent('empty')
    try {
      const { session } = await handshake(empty)
      const result = await empty.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'please say nothing' }],
      })
      expect(result.stopReason).toBe('end_turn')
      expect(empty.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk')).toEqual([])
      await empty.send(4, 'session/close', { sessionId: session.sessionId })
    } finally {
      empty.child.stdin.end()
      empty.child.kill('SIGTERM')
    }

    const failing = startAgent('fail-stream')
    try {
      const { session } = await handshake(failing)
      await expect(failing.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'this should fail' }],
      })).rejects.toThrow()
      const messages = failing.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk')
      for (const message of messages) {
        expect(message.update.content.text).not.toMatch(/success/i)
      }
      if (messages.length > 0) {
        expect(messages[0].update.content.text).toContain('RUST_ACP_PARTIAL')
      }
      await expect(failing.send(4, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'retry after failure' }],
      })).rejects.toThrow()
      await failing.send(5, 'session/close', { sessionId: session.sessionId }).catch(() => undefined)
    } finally {
      failing.child.stdin.end()
      failing.child.kill('SIGTERM')
    }
  }, 45000)

  it('rejects unknown methods and parse errors without claiming a successful turn', async () => {
    const agent = startAgent('echo')
    try {
      const { init, session } = await handshake(agent)
      expect(init.protocolVersion).toBe(1)
      await expect(agent.send(3, 'session/load', { sessionId: session.sessionId })).rejects.toThrow()
      agent.child.stdin.write('not-json\n')
      await new Promise(resolve => setTimeout(resolve, 300))
      const parse = agent.frames.find(frame => frame.includes('-32700'))
      expect(parse).toContain('Parse error')
      const result = await agent.send(4, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'still works' }],
      })
      expect(result.stopReason).toBe('end_turn')
      const recovered = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(recovered.update.content.text).toContain('still works')
      await agent.send(5, 'session/close', { sessionId: session.sessionId })
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
    }
  }, 30000)

  it('returns ACP v1 when the client offers an unsupported version', async () => {
    const agent = startAgent('echo')
    try {
      const init = await agent.send(1, 'initialize', { protocolVersion: 99, clientCapabilities: {} })
      expect(init.protocolVersion).toBe(1)
      expect(init.protocolVersion).not.toBe(99)
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
    }
  }, 20000)
})
