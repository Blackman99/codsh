import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { fileURLToPath } from 'node:url'
import { projectTurns, projectSession, liveSurfaceSeqs, projectBreakdown, rewindPoints, forkPrefix } from '../packages/cli/bin/rust-acp-session-read.mjs'
import { compactFailureText, parseCompactLine } from '../packages/cli/bin/rust-acp-compact.mjs'

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

function startAgent(mode, extraEnv = {}, reuse = null) {
  const root = reuse?.root ?? mkdtempSync(join('/tmp', 'codsh-acp-protocol-'))
  if (reuse == null) homes.push(root)
  const home = reuse?.home ?? join(root, 'home')
  const cwd = reuse?.cwd ?? join(root, 'workspace')
  if (reuse == null) {
    mkdirSync(home)
    mkdirSync(cwd)
  }
  const overlay = join(root, 'overlay.yml')
  const previousThreshold = process.env.CODSH_TEST_COMPACT_THRESHOLD
  if (extraEnv.CODSH_TEST_COMPACT_THRESHOLD !== undefined) {
    process.env.CODSH_TEST_COMPACT_THRESHOLD = extraEnv.CODSH_TEST_COMPACT_THRESHOLD
  }
  writeFileSync(overlay, rustAcpOverlay())
  if (previousThreshold === undefined) delete process.env.CODSH_TEST_COMPACT_THRESHOLD
  else process.env.CODSH_TEST_COMPACT_THRESHOLD = previousThreshold
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
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  const permissions = []
  const frames = []
  const stderr = []
  createInterface({ input: child.stdout }).on('line', line => {
    frames.push(line)
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.method === 'session/request_permission') permissions.push(msg)
    if (msg.id != null && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message), { error: msg.error, frames }))
      else waiter.resolve(msg.result)
    }
  })
  child.stderr.on('data', chunk => { stderr.push(String(chunk)) })
  child.stdin.on('error', error => {
    if (error?.code !== 'EPIPE') stderr.push(String(error))
  })
  function send(id, method, params) {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        if (child.killed || child.exitCode !== null || child.stdin.destroyed || !child.stdin.writable) {
          pending.delete(id)
          reject(new Error('ACP stdin is closed'))
          return
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        pending.delete(id)
        reject(error)
        return
      }
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.join('')}`)), 20000)
    })
  }
  function reply(id, result) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }
  function cancel(sessionId) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`)
  }
  return { root, home, cwd, child, send, reply, cancel, updates, permissions, frames, stderr }
}

async function waitUntil(predicate, timeout = 15000, detail = 'condition') {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`timeout waiting for ${detail}`)
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

describe('dsh session log projection', () => {
  it('marks interrupted unknown tools without fabricating success', () => {
    const turns = projectTurns([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'edit the note' }] } } },
      { type: 'tool/call', data: { callId: 't1', name: 'edit', arguments: '{"file_path":"note.txt"}' } },
      { type: 'tool/result', data: {
        error: { code: 'TOOL_OUTCOME_UNKNOWN' },
        message: { toolCallId: 't1', isError: true, content: [{ type: 'text', text: 'The tool call was interrupted after it was recorded, but no result was durably recorded.' }] },
      } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].user).toContain('edit the note')
    expect(turns[0].interrupted).toBe(true)
    expect(turns[0].tools[0].status).toBe('unknown')
    expect(JSON.stringify(turns[0]).toLowerCase()).not.toContain('success')
  })

  it('converts leftover pending tools to unknown when the turn never ended', () => {
    const turns = projectTurns([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'edit the note' }] } } },
      { type: 'tool/call', data: { callId: 'read-1', name: 'read', arguments: '{"file_path":"note.txt"}' } },
      { type: 'tool/call', data: { callId: 'edit-1', name: 'edit', arguments: '{"file_path":"note.txt"}' } },
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].interrupted).toBe(true)
    expect(turns[0].tools.map(tool => tool.status)).toEqual(['unknown', 'unknown'])
    expect(turns[0].tools.every(tool => tool.status !== 'pending' && tool.status !== 'in_progress')).toBe(true)
  })

  it('hides shadowed history after compaction while keeping original records', () => {
    const events = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'OLD_TOKEN' }] } } },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old answer' }] } } },
      { seq: 4, type: 'tool/call', data: { callId: 'todo-1', name: 'todo_write', arguments: '{"text":"TODO_KEEP"}' } },
      { seq: 5, type: 'tool/result', data: { message: { toolCallId: 'todo-1', content: [{ type: 'text', text: 'TODO_KEEP' }] } } },
      { seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } },
      { seq: 7, type: 'compaction/start', data: { compactionId: 'c1', turn: null } },
      { seq: 8, type: 'compaction/summary', data: {
        compactionId: 'c1',
        summary: [{ type: 'text', text: 'MOCK_COMPACTION_SUMMARY' }],
        shadowedSeqs: [2, 3],
        shadowedTokenCount: 40,
        provider: 'cli-mock',
        model: 'cli-mock',
      } },
      { seq: 9, type: 'user/message', data: {
        message: {
          content: [{ type: 'text', text: '<compacted-summary>\nMOCK_COMPACTION_SUMMARY\n</compacted-summary>' }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
          surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
        },
      } },
      { seq: 10, type: 'compaction/end', data: { compactionId: 'c1', turn: null } },
    ]
    const live = projectSession(events)
    expect(live.turns.some(turn => turn.user.includes('OLD_TOKEN'))).toBe(false)
    expect(live.turns.some(turn => turn.compacted && turn.answer.includes('MOCK_COMPACTION_SUMMARY'))).toBe(true)
    expect(JSON.stringify(projectTurns(events, { skipShadowed: false }))).toContain('OLD_TOKEN')
    expect(live.compaction[0].provider).toBe('cli-mock')
    expect(live.compaction[0].purpose).toBe('compaction')
    expect(live.retainedTodos.some(tool => tool.result.includes('TODO_KEEP'))).toBe(true)
  })

  it('projects dsh context buckets from live surface without fabricating occupancy', () => {
    expect(projectBreakdown([])).toBeNull()
    const events = [
      { seq: 1, type: 'system/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'You are the dsh system prompt.' }] } } },
      { seq: 2, type: 'user/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'hello world from the user' }] } } },
      { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'a short reply' }] } } },
    ]
    const breakdown = projectBreakdown(events)
    expect(breakdown.system).toBeGreaterThan(0)
    expect(breakdown.messages).toBeGreaterThan(0)
    expect(breakdown.tools).toBeUndefined()
    expect(projectSession(events).breakdown.messages).toBe(breakdown.messages)
  })

  it('projects only live post-replace surface turns and drops runtime-context orphans', () => {
    const events = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'TOKEN_OLD_ONE' }] } } },
      { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'RUST_ACP_ANSWER TOKEN_OLD_ONE' }] } } },
      { seq: 4, type: 'user/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] } } },
      { seq: 5, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'RUST_ACP_ANSWER turn=5 TOKEN_OLD_ONE leftover' }] } } },
      { seq: 6, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, data: {
        message: {
          content: [{ type: 'text', text: '<compacted-summary>\nMOCK_COMPACTION_SUMMARY instruction:keep the auth plan\n</compacted-summary>' }],
          source: { kind: 'plugin', plugin: 'compact' },
        },
      } },
    ]
    expect([...liveSurfaceSeqs(events)].sort()).toEqual([4, 5, 6])
    const live = projectSession(events)
    expect(JSON.stringify(live.turns)).not.toContain('TOKEN_OLD_ONE leftover')
    expect(live.turns.some(turn => turn.user.includes('TOKEN_OLD_ONE'))).toBe(false)
    expect(live.turns.some(turn => turn.compacted && turn.answer.includes('keep the auth plan'))).toBe(true)
  })

  it('maps manual compaction errors without treating cancel as success', () => {
    expect(parseCompactLine('/compact keep the auth plan')).toEqual({ instruction: 'keep the auth plan' })
    expect(compactFailureText({ code: 'cancelled' })).toBe('Compaction cancelled.')
    expect(compactFailureText({ code: 'summary', message: 'summarizer failed' })).toContain('useful summary')
    expect(compactFailureText({ code: 'summary' }).toLowerCase()).not.toContain('success')
  })
})

describe('conversation rewind points and fork prefixes', () => {
  it('offers one rewind point per typed prompt through that turn end', () => {
    const events = [
      { seq: 0, type: 'session/seed', data: {} },
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'first request' }], source: { kind: 'user' } } } },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first answer' }] } } },
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 5, type: 'turn/start', data: { turn: 2 } },
      { seq: 6, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'second request' }], source: { kind: 'user' } } } },
      { seq: 7, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'second answer' }] } } },
      { seq: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      { seq: 9, type: 'turn/start', data: { turn: 3 } },
      { seq: 10, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'third request' }], source: { kind: 'user' } } } },
      { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'third answer' }] } } },
      { seq: 12, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    ]
    expect(rewindPoints(events)).toEqual([
      { turn: 1, summary: 'first request', boundary: 4 },
      { turn: 2, summary: 'second request', boundary: 8 },
      { turn: 3, summary: 'third request', boundary: 12 },
    ])
    const kept = forkPrefix(events, 8)
    expect(kept.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(kept.some(event => event.seq === 10)).toBe(false)
  })

  it('skips injected context, refuses open turns, and does not split compaction or tools', () => {
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '<skill> injected' }], source: { kind: 'inject' } } } },
      { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'typed' }], source: { kind: 'user' } } } },
      { seq: 3, type: 'tool/call', data: { callId: 't1' } },
      { seq: 4, type: 'tool/result', data: { message: { toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] } } },
      { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 6, type: 'compaction/start', data: {} },
      { seq: 7, type: 'compaction/summary', data: {} },
      { seq: 8, type: 'compaction/end', data: {} },
      { seq: 9, type: 'turn/start', data: { turn: 2 } },
      { seq: 10, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'after compact' }], source: { kind: 'user' } } } },
      { seq: 11, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      { seq: 12, type: 'turn/start', data: { turn: 3 } },
      { seq: 13, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'running' }], source: { kind: 'user' } } } },
    ]
    expect(rewindPoints(events)).toEqual([
      { turn: 1, summary: 'typed', boundary: 5 },
      { turn: 2, summary: 'after compact', boundary: 11 },
    ])
    expect(() => forkPrefix(events, 13)).toThrow(/open turn/i)
    expect(() => forkPrefix(events, 7)).toThrow(/compaction|tool pairing/i)
    expect(() => forkPrefix(events, 3)).toThrow(/open turn|tool pairing/i)
    expect(() => forkPrefix(events, 99)).toThrow(/invalid boundary/i)
    expect(forkPrefix(events, 8).at(-1).seq).toBe(8)
  })
})

function runForkHelper(home, args) {
  return spawnSync(process.execPath, [
    resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-session-fork.mjs', import.meta.url))),
    ...args,
  ], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, DSH_BIN: dshPath() },
  })
}

function helperJson(result) {
  return JSON.parse(result.stdout.trim().split('\n').at(-1) || '{}')
}

describe('dsh conversation fork/rewind persistence', () => {
  it('seeds a child from a completed prefix without restoring files or the discarded turn', async () => {
    const first = startAgent('echo')
    writeFileSync(join(first.cwd, 'note.txt'), 'alpha\n')
    let parentId
    try {
      const { session } = await handshake(first)
      parentId = session.sessionId
      for (const [id, text] of [[3, 'TOKEN_KEEP'], [4, 'TOKEN_MIDDLE'], [5, 'TOKEN_DROP']]) {
        const result = await first.send(id, 'session/prompt', {
          sessionId: parentId,
          prompt: [{ type: 'text', text }],
        })
        expect(result.stopReason).toBe('end_turn')
      }
      writeFileSync(join(first.cwd, 'note.txt'), 'BETA independently edited\n')
      await first.send(6, 'session/close', { sessionId: parentId })
    } finally {
      first.child.stdin.end()
      first.child.kill('SIGTERM')
      await new Promise(resolve => first.child.once('exit', resolve))
    }
    expect(readFileSync(join(first.cwd, 'note.txt'), 'utf8')).toBe('BETA independently edited\n')

    const listed = runForkHelper(first.home, ['--session-id', parentId, '--list'])
    expect(listed.status).toBe(0)
    const points = helperJson(listed)
    expect(points.rewindPoints.map(point => point.summary)).toEqual(['TOKEN_KEEP', 'TOKEN_MIDDLE', 'TOKEN_DROP'])
    const keepBoundary = points.rewindPoints[1].boundary
    const restored = runForkHelper(first.home, ['--session-id', parentId, '--boundary', String(keepBoundary), '--restore-code'])
    expect(restored.status).not.toBe(0)
    expect(helperJson(restored).error).toMatch(/does not restore files|--restore-code is unavailable/i)
    const invalid = runForkHelper(first.home, ['--session-id', parentId, '--boundary', '999999'])
    expect(invalid.status).not.toBe(0)
    expect(helperJson(invalid).error).toMatch(/invalid boundary/i)

    const forked = runForkHelper(first.home, ['--session-id', parentId, '--boundary', String(keepBoundary)])
    expect(forked.status).toBe(0)
    const child = helperJson(forked)
    expect(child.ok).toBe(true)
    expect(child.sessionId).not.toBe(parentId)
    expect(child.parentSession).toBe(parentId)
    expect(child.isSeeded).toBe(true)
    expect(child.filesRestored).toBe(false)
    expect(child.turns.some(turn => turn.user.includes('TOKEN_KEEP'))).toBe(true)
    expect(child.turns.some(turn => turn.user.includes('TOKEN_MIDDLE'))).toBe(true)
    expect(child.turns.some(turn => turn.user.includes('TOKEN_DROP'))).toBe(false)
    expect(readFileSync(join(first.cwd, 'note.txt'), 'utf8')).toBe('BETA independently edited\n')

    const second = startAgent('echo', {}, { root: first.root, home: first.home, cwd: first.cwd })
    try {
      const init = await second.send(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'codsh-acp-protocol-test', version: '0.0.0' },
      })
      expect(init.agentCapabilities.sessionCapabilities).toMatchObject({ list: {}, resume: {} })
      const listedSessions = await second.send(2, 'session/list', { cwd: second.cwd })
      expect(listedSessions.sessions.some(entry => entry.sessionId === parentId)).toBe(true)
      expect(listedSessions.sessions.some(entry => entry.sessionId === child.sessionId)).toBe(true)
      await second.send(3, 'session/resume', { sessionId: child.sessionId, cwd: second.cwd, mcpServers: [] })
      const follow = await second.send(4, 'session/prompt', {
        sessionId: child.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_AFTER_REWIND' }],
      })
      expect(follow.stopReason).toBe('end_turn')
      const answer = second.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('TOKEN_AFTER_REWIND')
      expect(answer.update.content.text).toContain('TOKEN_KEEP')
      expect(answer.update.content.text).toContain('TOKEN_MIDDLE')
      expect(answer.update.content.text).not.toContain('TOKEN_DROP')
      expect(readFileSync(join(second.cwd, 'note.txt'), 'utf8')).toBe('BETA independently edited\n')
      const copy = runForkHelper(first.home, ['--session-id', parentId])
      expect(copy.status).toBe(0)
      const peer = helperJson(copy)
      expect(peer.sessionId).not.toBe(parentId)
      expect(peer.sessionId).not.toBe(child.sessionId)
      expect(peer.parentSession).toBe(parentId)
      expect(peer.turns.some(turn => turn.user.includes('TOKEN_DROP'))).toBe(true)
      await second.send(5, 'session/close', { sessionId: child.sessionId }).catch(() => undefined)
      await second.send(6, 'session/resume', { sessionId: peer.sessionId, cwd: second.cwd, mcpServers: [] })
      const switched = await second.send(7, 'session/set_config_option', {
        sessionId: peer.sessionId,
        configId: 'model',
        value: '["cli-mock","cli-mock-fork"]',
      })
      expect(JSON.stringify(switched)).toMatch(/cli-mock-fork/)
      const modeled = await second.send(8, 'session/prompt', {
        sessionId: peer.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_FORK_MODEL' }],
      })
      expect(modeled.stopReason).toBe('end_turn')
      const forkAnswer = second.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(forkAnswer.update.content.text).toContain('TOKEN_FORK_MODEL')
      expect(forkAnswer.update.content.text).toContain('model=cli-mock-fork')
      expect(forkAnswer.update.content.text).toContain('TOKEN_DROP')
      await second.send(9, 'session/close', { sessionId: peer.sessionId }).catch(() => undefined)
    } finally {
      second.child.stdin.end()
      second.child.kill('SIGTERM')
    }
  }, 60000)
})

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

  it('sets advertised model/effort without silent fallback and echoes the live route', async () => {
    const agent = startAgent('echo')
    try {
      const { session } = await handshake(agent)
      const options = JSON.stringify(session.configOptions)
      expect(options).toContain('cli-mock')
      expect(options).toContain('reasoning_effort')
      const model = session.configOptions.find(option => option.id === 'model')
      const effort = session.configOptions.find(option => option.id === 'reasoning_effort')
      const high = (effort?.options ?? []).find(item => item.value === 'high' || item.name === 'High')
      expect(high).toBeTruthy()
      const updated = await agent.send(3, 'session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'reasoning_effort',
        value: high.value,
      })
      const current = (updated.configOptions ?? updated).find?.(option => option.id === 'reasoning_effort')
        ?? updated.configOptions?.find(option => option.id === 'reasoning_effort')
      expect(JSON.stringify(updated)).toContain(high.value)
      await expect(agent.send(4, 'session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'reasoning_effort',
        value: 'not-a-real-effort',
      })).rejects.toThrow()
      const result = await agent.send(5, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'route check' }],
      })
      expect(result.stopReason).toBe('end_turn')
      const answer = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('route=cli-mock/cli-mock')
      expect(answer.update.content.text).toContain('effort=')
      expect(answer.update.content.text).not.toContain('effort=xhigh')
      await agent.send(6, 'session/close', { sessionId: session.sessionId })
      expect(model.currentValue ?? model.current).toBeTruthy()
      expect(current === undefined || current.currentValue === high.value || JSON.stringify(updated).includes(high.value)).toBe(true)
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
    }
  }, 30000)

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

  it('asks once for a real dsh file edit, writes on allow, and ignores a duplicate reply', async () => {
    const agent = startAgent('file-edit')
    try {
      expect(rustAcpOverlay()).toContain('rust-acp-file-approval')
      expect(rustAcpOverlay()).toContain('rust-acp-compact')
      writeFileSync(join(agent.cwd, 'note.txt'), 'alpha\n')
      const { session } = await handshake(agent)
      const prompt = agent.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'edit the note' }],
      })
      await waitUntil(() => agent.permissions.length > 0, 20000, 'permission request')
      const permission = agent.permissions[0]
      const callId = permission.params.toolCall.toolCallId
      const read = agent.updates.find(update => update.update.sessionUpdate === 'tool_call' && update.update.title === 'read')
      const edit = agent.updates.find(update => update.update.sessionUpdate === 'tool_call' && update.update.title === 'edit')
      expect(read.update.rawInput).toEqual({ file_path: 'note.txt' })
      expect(edit.update.rawInput).toMatchObject({ file_path: 'note.txt', old_string: 'alpha', new_string: 'ALPHA' })
      expect(edit.update.toolCallId).toBe(callId)
      expect(permission.params.options.map(option => option.optionId)).toEqual(['allow-once', 'reject-once'])
      const outcome = { outcome: { outcome: 'selected', optionId: 'allow-once' } }
      agent.reply(permission.id, outcome)
      agent.reply(permission.id, outcome)
      const result = await prompt
      expect(result.stopReason).toBe('end_turn')
      const done = agent.updates.find(update =>
        update.update.sessionUpdate === 'tool_call_update' && update.update.toolCallId === callId)
      expect(done.update.status).toBe('completed')
      expect(JSON.stringify(done.update.content)).toMatch(/updated successfully|Updated file|Created file/u)
      expect(readFileSync(join(agent.cwd, 'note.txt'), 'utf8')).toBe('ALPHA\n')
      const answer = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('RUST_ACP_FILE_DONE')
      await agent.send(4, 'session/close', { sessionId: session.sessionId })
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
    }
  }, 45000)

  it('leaves the file unchanged when the linked permission is rejected', async () => {
    const agent = startAgent('file-edit')
    try {
      writeFileSync(join(agent.cwd, 'note.txt'), 'alpha\n')
      const { session } = await handshake(agent)
      const prompt = agent.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'edit the note' }],
      })
      await waitUntil(() => agent.permissions.length > 0, 20000, 'permission request')
      agent.reply(agent.permissions[0].id, { outcome: { outcome: 'selected', optionId: 'reject-once' } })
      const result = await prompt
      expect(result.stopReason).toBe('end_turn')
      const failed = agent.updates.find(update => update.update.sessionUpdate === 'tool_call_update' && update.update.status === 'failed')
      expect(failed).toBeTruthy()
      expect(JSON.stringify(failed.update.content).toLowerCase()).not.toContain('success')
      expect(readFileSync(join(agent.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')
      const answer = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('RUST_ACP_FILE_ERROR')
      await agent.send(4, 'session/close', { sessionId: session.sessionId })
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
    }
  }, 45000)

  it('reports missing files and tool errors without fabricating success', async () => {
    const missing = startAgent('file-missing')
    try {
      const { session } = await handshake(missing)
      const result = await missing.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'read the missing note' }],
      })
      expect(result.stopReason).toBe('end_turn')
      expect(missing.permissions).toEqual([])
      const failed = missing.updates.find(update => update.update.sessionUpdate === 'tool_call_update')
      expect(failed.update.status).toBe('failed')
      expect(JSON.stringify(failed.update.content)).toMatch(/not found/i)
      expect(JSON.stringify(failed.update.content).toLowerCase()).not.toContain('success')
      expect(existsSync(join(missing.cwd, 'missing-note.txt'))).toBe(false)
      const answer = missing.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('RUST_ACP_FILE_ERROR')
      await missing.send(4, 'session/close', { sessionId: session.sessionId })
    } finally {
      missing.child.stdin.end()
      missing.child.kill('SIGTERM')
    }

    const failing = startAgent('file-error')
    try {
      writeFileSync(join(failing.cwd, 'note.txt'), 'alpha\n')
      const { session } = await handshake(failing)
      const prompt = failing.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'edit with a missing hunk' }],
      })
      await waitUntil(() => failing.permissions.length > 0, 20000, 'error-path permission')
      failing.reply(failing.permissions[0].id, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
      const result = await prompt
      expect(result.stopReason).toBe('end_turn')
      const failed = failing.updates.find(update => update.update.sessionUpdate === 'tool_call_update' && update.update.status === 'failed')
      expect(failed).toBeTruthy()
      expect(JSON.stringify(failed.update.content).toLowerCase()).not.toContain('success')
      expect(readFileSync(join(failing.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')
      const answer = failing.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('RUST_ACP_FILE_ERROR')
      await failing.send(4, 'session/close', { sessionId: session.sessionId })
    } finally {
      failing.child.stdin.end()
      failing.child.kill('SIGTERM')
    }
  }, 45000)

  it('cancels a delayed stream, ignores a late permission reply, and continues with a new turn', async () => {
    const delayed = startAgent('echo', { DSH_CODE_CLI_MOCK_DELAY_MS: '4000' })
    try {
      const { session } = await handshake(delayed)
      const prompt = delayed.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_CANCEL_STREAM' }],
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      delayed.cancel(session.sessionId)
      const result = await prompt
      expect(result.stopReason).toBe('cancelled')
      const answers = delayed.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk')
      for (const answer of answers) {
        expect(answer.update.content.text).not.toMatch(/success/i)
      }
      expect(answers.some(answer => String(answer.update.content.text).includes('TOKEN_CANCEL_STREAM'))).toBe(false)
      const next = await delayed.send(4, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_AFTER_CANCEL' }],
      })
      expect(next.stopReason).toBe('end_turn')
      const recovered = delayed.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(recovered.update.content.text).toContain('TOKEN_AFTER_CANCEL')
      expect(recovered.update.content.text).toContain('RUST_ACP_ANSWER')
      await delayed.send(5, 'session/close', { sessionId: session.sessionId })
    } finally {
      delayed.child.stdin.end()
      delayed.child.kill('SIGTERM')
    }

    const pending = startAgent('file-edit')
    try {
      writeFileSync(join(pending.cwd, 'note.txt'), 'alpha\n')
      const { session } = await handshake(pending)
      const prompt = pending.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'edit then cancel' }],
      })
      await waitUntil(() => pending.permissions.length > 0, 20000, 'permission before cancel')
      const permission = pending.permissions[0]
      pending.cancel(session.sessionId)
      const result = await prompt
      expect(result.stopReason).toBe('cancelled')
      pending.reply(permission.id, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(readFileSync(join(pending.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')
      await pending.send(4, 'session/close', { sessionId: session.sessionId }).catch(() => undefined)
    } finally {
      pending.child.stdin.end()
      pending.child.kill('SIGTERM')
    }
  }, 45000)

  it('cancels during a running file tool and at completion without extra writes', async () => {
    const running = startAgent('file-edit', { DSH_CODE_CLI_TOOL_DELAY_MS: '4000' })
    try {
      writeFileSync(join(running.cwd, 'note.txt'), 'alpha\n')
      const { session } = await handshake(running)
      const prompt = running.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'edit slowly' }],
      })
      await waitUntil(() => running.permissions.length > 0, 20000, 'permission before in-tool cancel')
      running.reply(running.permissions[0].id, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
      await new Promise(resolve => setTimeout(resolve, 200))
      running.cancel(session.sessionId)
      const result = await prompt
      expect(result.stopReason).toBe('cancelled')
      expect(readFileSync(join(running.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')
      await running.send(4, 'session/close', { sessionId: session.sessionId })
    } finally {
      running.child.stdin.end()
      running.child.kill('SIGTERM')
    }

    const race = startAgent('echo')
    try {
      const { session } = await handshake(race)
      const prompt = race.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_COMPLETE_RACE' }],
      })
      race.cancel(session.sessionId)
      const result = await prompt
      expect(['cancelled', 'end_turn']).toContain(result.stopReason)
      if (result.stopReason === 'end_turn') {
        const answer = race.updates.find(update => update.update.sessionUpdate === 'agent_message_chunk')
        expect(answer.update.content.text).toContain('TOKEN_COMPLETE_RACE')
      } else {
        const answers = race.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk')
        for (const answer of answers) {
          expect(answer.update.content.text).not.toMatch(/success/i)
        }
      }
      const next = await race.send(4, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_AFTER_RACE' }],
      })
      expect(next.stopReason).toBe('end_turn')
      const recovered = race.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(recovered.update.content.text).toContain('TOKEN_AFTER_RACE')
      await race.send(5, 'session/close', { sessionId: session.sessionId })
    } finally {
      race.child.stdin.end()
      race.child.kill('SIGTERM')
    }
  }, 45000)

  it('lists and resumes a closed session without replaying tools', async () => {
    const first = startAgent('echo')
    let sessionId
    try {
      const { init, session } = await handshake(first)
      expect(init.agentCapabilities.sessionCapabilities).toMatchObject({ list: {}, resume: {}, close: {} })
      sessionId = session.sessionId
      const result = await first.send(3, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_RESUME_ONE' }],
      })
      expect(result.stopReason).toBe('end_turn')
      await first.send(4, 'session/close', { sessionId })
    } finally {
      first.child.stdin.end()
      first.child.kill('SIGTERM')
      await new Promise(resolve => first.child.once('exit', resolve))
    }

    const second = startAgent('echo', {}, { root: first.root, home: first.home, cwd: first.cwd })
    try {
      await second.send(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'codsh-acp-protocol-test', version: '0.0.0' },
      })
      const listed = await second.send(2, 'session/list', { cwd: second.cwd })
      expect(listed.sessions.some(entry => entry.sessionId === sessionId)).toBe(true)
      await second.send(3, 'session/resume', { sessionId, cwd: second.cwd, mcpServers: [] })
      const next = await second.send(4, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_RESUME_TWO' }],
      })
      expect(next.stopReason).toBe('end_turn')
      const answer = second.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('TOKEN_RESUME_TWO')
      expect(answer.update.content.text).toContain('TOKEN_RESUME_ONE')
      expect(answer.update.content.text).toMatch(/turn=\d+/)
      const helper = spawnSync(process.execPath, [
        resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-session-read.mjs', import.meta.url))),
        '--session-id', sessionId,
      ], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: first.home, DSH_BIN: dshPath() },
      })
      expect(helper.status).toBe(0)
      const projected = JSON.parse(helper.stdout)
      expect(projected.ok).toBe(true)
      expect(projected.sessionId).toBe(sessionId)
      expect(projected.turns.some(turn => turn.user.includes('TOKEN_RESUME_ONE'))).toBe(true)
      expect(projected.turns.some(turn => turn.user.includes('TOKEN_RESUME_TWO'))).toBe(true)
      await second.send(5, 'session/close', { sessionId })
    } finally {
      second.child.stdin.end()
      second.child.kill('SIGTERM')
    }
  }, 45000)

  it('refuses a second writer while the session is active', async () => {
    const owner = startAgent('echo')
    try {
      const { session } = await handshake(owner)
      const rival = startAgent('echo', {}, { root: owner.root, home: owner.home, cwd: owner.cwd })
      try {
        await rival.send(1, 'initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'codsh-acp-protocol-test', version: '0.0.0' },
        })
        await expect(rival.send(2, 'session/resume', {
          sessionId: session.sessionId,
          cwd: rival.cwd,
          mcpServers: [],
        })).rejects.toThrow(/already active|already owned|not resumable|Internal error/i)
        await expect(rival.send(3, 'session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'TOKEN_STALE_WRITER' }],
        })).rejects.toThrow()
        await owner.send(4, 'session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'TOKEN_OWNER_KEEPS' }],
        })
        const answer = owner.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
        expect(answer.update.content.text).toContain('TOKEN_OWNER_KEEPS')
      } finally {
        rival.child.stdin.end()
        rival.child.kill('SIGTERM')
      }
      await owner.send(5, 'session/close', { sessionId: session.sessionId })
    } finally {
      owner.child.stdin.end()
      owner.child.kill('SIGTERM')
    }
  }, 45000)

  it('recovers an interrupted file tool without replaying the write', async () => {
    const first = startAgent('file-edit', { DSH_CODE_CLI_TOOL_DELAY_MS: '8000' })
    writeFileSync(join(first.cwd, 'note.txt'), 'alpha\n')
    let sessionId
    try {
      const { session } = await handshake(first)
      sessionId = session.sessionId
      first.send(3, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'edit the note' }],
      }).catch(() => undefined)
      await waitUntil(() => first.permissions.length > 0, 20000, 'permission before kill')
      first.reply(first.permissions[0].id, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
      await new Promise(resolve => setTimeout(resolve, 150))
      first.child.kill('SIGKILL')
      await new Promise(resolve => first.child.once('exit', resolve))
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null) {
        first.child.kill('SIGKILL')
      }
    }
    expect(readFileSync(join(first.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')

    const second = startAgent('echo', {}, { root: first.root, home: first.home, cwd: first.cwd })
    try {
      await second.send(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'codsh-acp-protocol-test', version: '0.0.0' },
      })
      await second.send(2, 'session/resume', { sessionId, cwd: second.cwd, mcpServers: [] })
      expect(readFileSync(join(second.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')
      const helper = spawnSync(process.execPath, [
        resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-session-read.mjs', import.meta.url))),
        '--session-id', sessionId,
      ], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: first.home, DSH_BIN: dshPath() },
      })
      expect(helper.status).toBe(0)
      const projected = JSON.parse(helper.stdout)
      expect(projected.ok).toBe(true)
      expect(projected.turns.some(turn => turn.interrupted === true || turn.tools.some(tool => tool.status === 'unknown'))).toBe(true)
      for (const turn of projected.turns) {
        for (const tool of turn.tools) {
          expect(tool.status).not.toBe('pending')
          expect(tool.status).not.toBe('in_progress')
        }
      }
      const follow = await second.send(3, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_AFTER_INTERRUPT' }],
      })
      expect(follow.stopReason).toBe('end_turn')
      expect(readFileSync(join(second.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')
      const answer = second.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('TOKEN_AFTER_INTERRUPT')
      await second.send(4, 'session/close', { sessionId }).catch(() => undefined)
    } finally {
      second.child.stdin.end()
      second.child.kill('SIGTERM')
    }
  }, 60000)

  it('does not let a disconnected owner write after a successor resumes', async () => {
    const first = startAgent('echo')
    let sessionId
    try {
      const { session } = await handshake(first)
      sessionId = session.sessionId
      const before = await first.send(3, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_BEFORE_DISCONNECT' }],
      })
      expect(before.stopReason).toBe('end_turn')
      first.child.stdin.end()
      expect(first.child.stdin.writableEnded).toBe(true)
      expect(first.child.stdin.writable).toBe(false)
      first.child.kill('SIGTERM')
      await Promise.race([
        new Promise(resolve => first.child.once('exit', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('owner did not exit')), 10000)),
      ])
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null) {
        first.child.kill('SIGKILL')
      }
    }

    const second = startAgent('echo', {}, { root: first.root, home: first.home, cwd: first.cwd })
    try {
      await second.send(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'codsh-acp-protocol-test', version: '0.0.0' },
      })
      await second.send(2, 'session/resume', { sessionId, cwd: second.cwd, mcpServers: [] })
      const next = await second.send(3, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_AFTER_DISCONNECT' }],
      })
      expect(next.stopReason).toBe('end_turn')
      const answer = second.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('TOKEN_AFTER_DISCONNECT')
      expect(answer.update.content.text).toContain('TOKEN_BEFORE_DISCONNECT')
      expect(answer.update.content.text).not.toContain('TOKEN_STALE_AFTER_DISCONNECT')
      await second.send(4, 'session/close', { sessionId })
    } finally {
      second.child.stdin.end()
      second.child.kill('SIGTERM')
    }
  }, 45000)

  it('compacts through dsh, retains later tools, and does not invent lost context on failure', async () => {
    const agent = startAgent('echo')
    try {
      const { session } = await handshake(agent)
      for (const text of ['TOKEN_OLD_ONE TODO_KEEP', 'TOKEN_OLD_TWO', 'TOKEN_OLD_THREE', 'TOKEN_OLD_FOUR']) {
        const result = await agent.send(agent.updates.length + 10, 'session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text }],
        })
        expect(result.stopReason).toBe('end_turn')
      }
      const compact = await agent.send(80, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/compact keep the auth plan' }],
      })
      expect(compact.stopReason).toBe('cancelled')
      const compactAnswers = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk')
        .map(update => update.update.content.text)
      expect(compactAnswers.filter(text => text.includes('/compact keep the auth plan') && text.includes('RUST_ACP_ANSWER'))).toEqual([])
      const helper = spawnSync(process.execPath, [
        resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-session-read.mjs', import.meta.url))),
        '--session-id', session.sessionId,
      ], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: agent.home, DSH_BIN: dshPath() },
      })
      expect(helper.status).toBe(0)
      const projected = JSON.parse(helper.stdout)
      expect(projected.ok).toBe(true)
      expect(projected.compaction.length).toBeGreaterThan(0)
      expect(projected.compaction.at(-1).purpose).toBe('compaction')
      expect(projected.compaction.at(-1).provider).toBe('cli-mock')
      expect(projected.compaction.at(-1).model).toBe('cli-mock')
      expect(projected.compaction.at(-1).summary).toContain('keep the auth plan')
      expect(projected.compaction.at(-1).summary).toContain('instruction:')
      expect(projected.turns.some(turn => turn.user.includes('keep the auth plan'))).toBe(false)
      expect(JSON.stringify(projected.turns)).not.toContain('TOKEN_OLD_ONE')
      expect(projected.originalTurnCount).toBeGreaterThan(projected.turns.length)
      const follow = await agent.send(81, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_AFTER_COMPACT' }],
      })
      expect(follow.stopReason).toBe('end_turn')
      const after = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(after.update.content.text).toContain('TOKEN_AFTER_COMPACT')
      expect(after.update.content.text).toContain('compacted-summary')
      expect(after.update.content.text).not.toContain('TOKEN_OLD_ONE')
      await agent.send(82, 'session/close', { sessionId: session.sessionId })
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
    }

    const failing = startAgent('compact-fail')
    try {
      const { session } = await handshake(failing)
      await failing.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_KEEP_ORIGINAL' }],
      })
      await failing.send(4, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_KEEP_SECOND' }],
      })
      const failed = await failing.send(5, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      })
      expect(failed.stopReason).toBe('cancelled')
      const helper = spawnSync(process.execPath, [
        resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-session-read.mjs', import.meta.url))),
        '--session-id', session.sessionId,
      ], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: failing.home, DSH_BIN: dshPath() },
      })
      expect(helper.status).toBe(0)
      const projected = JSON.parse(helper.stdout)
      expect(JSON.stringify(projected.turns)).toContain('TOKEN_KEEP_ORIGINAL')
      expect(JSON.stringify(projected.turns)).toContain('TOKEN_KEEP_SECOND')
      expect(projected.compaction.at(-1)?.error).toBeTruthy()
      expect(JSON.stringify(projected.compaction).toLowerCase()).not.toContain('success')
      const stillLive = await failing.send(6, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_AFTER_FAIL' }],
      })
      expect(stillLive.stopReason).toBe('end_turn')
      const afterFail = failing.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(afterFail.update.content.text).toContain('TOKEN_AFTER_FAIL')
      expect(afterFail.update.content.text).toContain('TOKEN_KEEP_ORIGINAL')
      await failing.send(7, 'session/close', { sessionId: session.sessionId }).catch(() => undefined)
    } finally {
      failing.child.stdin.end()
      failing.child.kill('SIGTERM')
    }
  }, 90000)

  it('auto-compacts at the mapped dsh threshold and keeps a live todo result', async () => {
    const agent = startAgent('echo', {
      CODSH_TEST_COMPACT_THRESHOLD: '0.5',
      DSH_CODE_CLI_MOCK_CONTEXT_WINDOW: '8000',
    })
    try {
      const { session } = await handshake(agent)
      const pad = ' PAD'.repeat(40)
      for (const text of ['TOKEN_OLD_ONE', 'TOKEN_OLD_TWO', 'TOKEN_OLD_THREE', 'TOKEN_OLD_FOUR', 'TOKEN_OLD_FIVE', 'TOKEN_OLD_SIX']) {
        const result = await agent.send(agent.updates.length + 10, 'session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: `${text}${pad}` }],
        })
        expect(result.stopReason).toBe('end_turn')
      }
      const todoPrompt = agent.send(70, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'WRITE_TODO TOKEN_KEEP' }],
      })
      try {
        await waitUntil(() => agent.permissions.length > 0, 4000, 'todo permission')
        agent.reply(agent.permissions[0].id, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
      } catch {
        // todo_write does not require file approval on this profile
      }
      const todo = await todoPrompt
      expect(todo.stopReason).toBe('end_turn')
      expect(agent.updates.some(update => JSON.stringify(update).includes('todo_write') || JSON.stringify(update).includes('TODO_KEEP'))).toBe(true)
      const trigger = await agent.send(71, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_AUTO_TRIGGER' }],
      })
      expect(trigger.stopReason).toBe('end_turn')
      const helper = spawnSync(process.execPath, [
        resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-session-read.mjs', import.meta.url))),
        '--session-id', session.sessionId,
      ], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: agent.home, DSH_BIN: dshPath() },
      })
      expect(helper.status).toBe(0)
      const projected = JSON.parse(helper.stdout)
      expect(projected.ok).toBe(true)
      expect(projected.compaction.length).toBeGreaterThan(0)
      expect(projected.compaction.some(record => record.purpose === 'compaction')).toBe(true)
      expect(projected.turns.some(turn => turn.user.includes('TOKEN_OLD_ONE'))).toBe(false)
      expect(JSON.stringify(projected.turns)).toContain('TODO_KEEP')
      expect(
        projected.turns.some(turn => turn.compacted)
        || projected.turns.some(turn => (turn.answer || '').includes('compacted-summary'))
        || projected.compaction.some(record => !record.error),
      ).toBe(true)
      await agent.send(72, 'session/close', { sessionId: session.sessionId }).catch(() => undefined)
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
    }
  }, 90000)

  it('cancels compaction through dsh, keeps originals, and accepts a following prompt', async () => {
    const agent = startAgent('echo', { DSH_CODE_CLI_MOCK_DELAY_MS: '4000' })
    try {
      const { session } = await handshake(agent)
      await agent.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_CANCEL_ONE' }],
      })
      await agent.send(4, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_CANCEL_TWO' }],
      })
      const compact = agent.send(5, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      })
      await new Promise(resolve => setTimeout(resolve, 400))
      agent.cancel(session.sessionId)
      const result = await compact
      expect(result.stopReason).toBe('cancelled')
      const helper = spawnSync(process.execPath, [
        resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-session-read.mjs', import.meta.url))),
        '--session-id', session.sessionId,
      ], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: agent.home, DSH_BIN: dshPath() },
      })
      expect(helper.status).toBe(0)
      const projected = JSON.parse(helper.stdout)
      expect(JSON.stringify(projected.turns)).toContain('TOKEN_CANCEL_ONE')
      expect(JSON.stringify(projected.turns)).toContain('TOKEN_CANCEL_TWO')
      const follow = await agent.send(6, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'TOKEN_AFTER_CANCEL' }],
      })
      expect(follow.stopReason).toBe('end_turn')
      const after = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(after.update.content.text).toContain('TOKEN_AFTER_CANCEL')
      await agent.send(7, 'session/close', { sessionId: session.sessionId }).catch(() => undefined)
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
    }
  }, 90000)

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

  it('denies a matching bash rule under always-approve without executing', async () => {
    const policy = join('/tmp', `codsh-perm-deny-${Date.now()}.json`)
    writeFileSync(policy, `${JSON.stringify({
      mode: 'always-approve',
      rememberToolApprovals: true,
      interactive: false,
      cwd: '/tmp',
      grantsPath: '',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob', source: 'cli' }],
      grants: { allowedBash: ['rm -rf denied-target'], deniedBash: [], allowedMcp: [], deniedMcp: [], allowedDomains: [], deniedDomains: [], allowedEdits: false },
    })}\n`)
    const agent = startAgent('bash-rm', { CODSH_PERMISSION_POLICY: policy })
    try {
      const { session } = await handshake(agent)
      const result = await agent.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'remove the target' }],
      })
      expect(result.stopReason).toBe('end_turn')
      expect(agent.permissions).toEqual([])
      const failed = agent.updates.find(update => update.update.sessionUpdate === 'tool_call_update')
      expect(failed.update.status).toBe('failed')
      expect(JSON.stringify(failed.update.content)).toMatch(/Denied by permission policy|rm -rf/i)
      expect(JSON.stringify(failed.update.content).toLowerCase()).not.toContain('success')
      const answer = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('RUST_ACP_BASH_DENIED')
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
      rmSync(policy, { force: true })
    }
  }, 45000)

  it('denies timeout-wrapped rm under always-approve without executing', async () => {
    const policy = join('/tmp', `codsh-perm-timeout-${Date.now()}.json`)
    writeFileSync(policy, `${JSON.stringify({
      mode: 'always-approve',
      rememberToolApprovals: true,
      interactive: false,
      cwd: '/tmp',
      grantsPath: '',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob', source: 'cli' }],
      grants: { allowedBash: [], deniedBash: [], allowedMcp: [], deniedMcp: [], allowedDomains: [], deniedDomains: [], allowedEdits: false, allowedEditPaths: [] },
    })}\n`)
    const agent = startAgent('bash-timeout-rm', { CODSH_PERMISSION_POLICY: policy })
    try {
      const { session } = await handshake(agent)
      const result = await agent.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'remove the target' }],
      })
      expect(result.stopReason).toBe('end_turn')
      expect(agent.permissions).toEqual([])
      const failed = agent.updates.find(update => update.update.sessionUpdate === 'tool_call_update')
      expect(failed.update.status).toBe('failed')
      expect(JSON.stringify(failed.update.content)).toMatch(/Denied by permission policy|rm -rf/i)
      const answer = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('RUST_ACP_BASH_DENIED')
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
      rmSync(policy, { force: true })
    }
  }, 45000)

  it('denies quoted and eval rm under always-approve without executing', async () => {
    const policy = join('/tmp', `codsh-perm-quoted-${Date.now()}.json`)
    writeFileSync(policy, `${JSON.stringify({
      mode: 'always-approve',
      rememberToolApprovals: true,
      interactive: false,
      cwd: '/tmp',
      grantsPath: '',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob', source: 'cli' }],
      grants: { allowedBash: [], deniedBash: [], allowedMcp: [], deniedMcp: [], allowedDomains: [], deniedDomains: [], allowedEdits: false, allowedEditPaths: [] },
    })}\n`)
    for (const mode of ['bash-quoted-rm', 'bash-eval-rm', 'bash-path-rm']) {
      const agent = startAgent(mode, { CODSH_PERMISSION_POLICY: policy })
      try {
        const { session } = await handshake(agent)
        const result = await agent.send(3, 'session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'remove the target' }],
        })
        expect(result.stopReason).toBe('end_turn')
        expect(agent.permissions).toEqual([])
        const failed = agent.updates.find(update => update.update.sessionUpdate === 'tool_call_update')
        expect(failed.update.status, mode).toBe('failed')
        expect(JSON.stringify(failed.update.content), mode).toMatch(/Denied by permission policy|rm -rf/i)
        const answer = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
        expect(answer.update.content.text).toContain('RUST_ACP_BASH_DENIED')
      } finally {
        agent.child.stdin.end()
        agent.child.kill('SIGTERM')
      }
    }
    rmSync(policy, { force: true })
  }, 45000)

  it('denies nice-wrapped rm under always-approve without executing', async () => {
    const policy = join('/tmp', `codsh-perm-nice-${Date.now()}.json`)
    writeFileSync(policy, `${JSON.stringify({
      mode: 'always-approve',
      rememberToolApprovals: true,
      interactive: false,
      cwd: '/tmp',
      grantsPath: '',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob', source: 'cli' }],
      grants: { allowedBash: [], deniedBash: [], allowedMcp: [], deniedMcp: [], allowedDomains: [], deniedDomains: [], allowedEdits: false, allowedEditPaths: [] },
    })}\n`)
    const agent = startAgent('bash-nice-rm', { CODSH_PERMISSION_POLICY: policy })
    try {
      const { session } = await handshake(agent)
      const result = await agent.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'remove the target' }],
      })
      expect(result.stopReason).toBe('end_turn')
      expect(agent.permissions).toEqual([])
      const failed = agent.updates.find(update => update.update.sessionUpdate === 'tool_call_update')
      expect(failed.update.status).toBe('failed')
      expect(JSON.stringify(failed.update.content)).toMatch(/Denied by permission policy|rm -rf/i)
      const answer = agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').at(-1)
      expect(answer.update.content.text).toContain('RUST_ACP_BASH_DENIED')
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
      rmSync(policy, { force: true })
    }
  }, 45000)

  it('skips non-shell ask under always-approve and still reads the path', async () => {
    const policy = join('/tmp', `codsh-perm-ask-${Date.now()}.json`)
    writeFileSync(policy, `${JSON.stringify({
      mode: 'always-approve',
      rememberToolApprovals: true,
      interactive: true,
      cwd: '/tmp',
      grantsPath: '',
      rules: [{ action: 'ask', tool: 'read', pattern: 'secret/**', patternMode: 'glob', source: 'config.toml' }],
      grants: { allowedBash: [], deniedBash: [], allowedMcp: [], deniedMcp: [], allowedDomains: [], deniedDomains: [], allowedEdits: false },
    })}\n`)
    const agent = startAgent('file-secret', { CODSH_PERMISSION_POLICY: policy })
    try {
      mkdirSync(join(agent.cwd, 'secret'))
      writeFileSync(join(agent.cwd, 'secret/key.txt'), 'SECRET\n')
      const { session } = await handshake(agent)
      const result = await agent.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'read the secret' }],
      })
      expect(result.stopReason).toBe('end_turn')
      expect(agent.permissions).toEqual([])
      const failed = agent.updates.find(update => update.update.sessionUpdate === 'tool_call_update' && update.update.status === 'failed')
      expect(failed).toBeUndefined()
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
      rmSync(policy, { force: true })
    }
  }, 45000)

  it('fail-closed denies a mutating tool when permission-policy.json is corrupt', async () => {
    const policy = join('/tmp', `codsh-perm-corrupt-${Date.now()}.json`)
    writeFileSync(policy, '{not-json')
    const agent = startAgent('file-edit', { CODSH_PERMISSION_POLICY: policy })
    try {
      writeFileSync(join(agent.cwd, 'note.txt'), 'alpha\n')
      const { session } = await handshake(agent)
      const result = await agent.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'edit the note' }],
      })
      expect(result.stopReason).toBe('end_turn')
      expect(agent.permissions).toEqual([])
      const failed = agent.updates.find(update => update.update.sessionUpdate === 'tool_call_update' && update.update.status === 'failed')
      expect(JSON.stringify(failed.update.content)).toMatch(/unreadable|invalid|refusing/i)
      expect(readFileSync(join(agent.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')
    } finally {
      agent.child.stdin.end()
      agent.child.kill('SIGTERM')
      rmSync(policy, { force: true })
    }
  }, 45000)

  it('keeps allow-once from persisting a grant, then hook deny still wins over a later prompt', async () => {
    const root = mkdtempSync(join('/tmp', 'codsh-perm-grant-'))
    homes.push(root)
    const grantsPath = join(root, 'permission.toml')
    const policy = join(root, 'policy.json')
    writeFileSync(policy, `${JSON.stringify({
      mode: 'ask',
      rememberToolApprovals: true,
      interactive: true,
      cwd: root,
      grantsPath,
      rules: [],
      grants: { allowedBash: [], deniedBash: [], allowedMcp: [], deniedMcp: [], allowedDomains: [], deniedDomains: [], allowedEdits: false },
    })}\n`)
    const first = startAgent('file-edit', { CODSH_PERMISSION_POLICY: policy })
    try {
      writeFileSync(join(first.cwd, 'note.txt'), 'alpha\n')
      const { session } = await handshake(first)
      const prompt = first.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'edit the note' }],
      })
      await waitUntil(() => first.permissions.length > 0, 20000, 'first once-only permission')
      expect(first.permissions[0].params.options.map(option => option.optionId)).toEqual(['allow-once', 'reject-once'])
      first.reply(first.permissions[0].id, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
      await prompt
      expect(readFileSync(join(first.cwd, 'note.txt'), 'utf8')).toBe('ALPHA\n')
      expect(existsSync(grantsPath)).toBe(false)
    } finally {
      first.child.stdin.end()
      first.child.kill('SIGTERM')
    }
    const hooked = startAgent('file-edit', { CODSH_PERMISSION_POLICY: policy, CODSH_HOOK_DENY: 'blocked by test hook' })
    try {
      writeFileSync(join(hooked.cwd, 'note.txt'), 'alpha\n')
      const { session } = await handshake(hooked)
      const result = await hooked.send(3, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'edit despite grant' }],
      })
      expect(result.stopReason).toBe('end_turn')
      const failed = hooked.updates.find(update => update.update.sessionUpdate === 'tool_call_update' && update.update.status === 'failed')
      expect(JSON.stringify(failed.update.content)).toMatch(/Denied by hook/)
      expect(readFileSync(join(hooked.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')
    } finally {
      hooked.child.stdin.end()
      hooked.child.kill('SIGTERM')
    }
  }, 60000)
})
