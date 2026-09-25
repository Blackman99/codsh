import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { MARK, childAllowList, readPolicy, withSubagentId } from '../packages/cli/bin/rust-acp-subagents.mjs'
import {
  INVALID_TARGET,
  MAX_MESSAGE_BYTES,
  MESSAGE_TOOL,
  MESSAGE_TOOL_DESCRIPTION,
  RESUME_ERRORS,
  disposition,
  outcomeText,
  parseDelivery,
  resumeSource,
  sizeOutcome,
  validTarget,
} from '../packages/cli/bin/rust-acp-subagent-messages.mjs'
import { projectTurns } from '../packages/cli/bin/rust-acp-session-read.mjs'

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

const BUILTIN = [
  { name: 'general-purpose', description: 'all tools', capability: 'all' },
  { name: 'explore', description: 'no edits', capability: 'execute', instructions: 'Do not modify files.' },
]

function startAgent({ messages = true, root: shared } = {}) {
  const root = shared ?? mkdtempSync(join('/tmp', 'codsh-messages-'))
  if (!shared) roots.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  const control = join(root, 'control')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(control, { recursive: true, mode: 0o700 })
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
      DSH_CODE_CLI_MOCK_TOOL: 'subagents',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      CODSH_SUBAGENT_CONTROL: control,
      CODSH_SUBAGENT_POLICY: JSON.stringify({ types: BUILTIN, activeAgentMessages: messages }),
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
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.slice(-40).join('\n')}`)), timeout)
    })
  }
  const agent = { root, home, cwd, child, send, updates, events, stderr }
  agents.push(agent)
  return agent
}

async function open(agent) {
  await agent.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-messages-test', version: '0' } })
  const session = await agent.send('session/new', { cwd: agent.cwd, mcpServers: [] })
  return session.sessionId
}

function answer(agent, sessionId) {
  return agent.updates
    .filter(update => update.update.sessionUpdate === 'agent_message_chunk' && (!sessionId || update.sessionId === sessionId))
    .map(update => update.update.content.text)
    .join('')
}

async function steps(agent, sessionId, list, timeout = 90000) {
  const before = answer(agent, sessionId).length
  const result = await agent.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: `STEPS ${JSON.stringify(list)}` }] }, timeout)
  expect(result.stopReason).toBe('end_turn')
  const text = answer(agent, sessionId).slice(before)
  const report = text.slice(text.lastIndexOf('PARENT_STEPS '))
  const parts = report.split(/ (?=\[\d+:(?:ok|error)\] )/u).slice(1)
  return parts.map(part => {
    const match = /^\[(\d+):(ok|error)\] ([\s\S]*)$/u.exec(part)
    return { ok: match[2] === 'ok', text: match[3] }
  })
}

async function waitFor(predicate, detail, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timeout waiting for ${detail}`)
}

const spawnStep = (kind, extra = {}) => ['subagent', { description: `${kind.toLowerCase()} probe`, prompt: `CHILD_${kind}`, subagent_type: 'general-purpose', ...extra }]
const sendStep = (index, text, extra = {}, options) => [MESSAGE_TOOL, { subagent_id: `{{id:${index}}}`, text, ...extra }, ...options ? [options] : []]
const messageRows = agent => agent.events.filter(event => event.event === 'message' && event.state !== 'sending')

describe('subagent message helpers (ticket 173)', () => {
  it('keeps the reference tool text, outcome sentences, and dispositions', () => {
    expect(MESSAGE_TOOL_DESCRIPTION).toContain('Send a follow-up message to a subagent owned by this session.')
    expect(MESSAGE_TOOL_DESCRIPTION).toContain('`queue` waits as a later turn; `interject` is urgent')
    expect(outcomeText({ outcome: 'accepted', message_id: 'm1' })).toBe('Message accepted (message_id: m1).')
    expect(outcomeText({ outcome: 'not_found_or_not_owned' })).toBe('Subagent not found or not owned by this session.')
    expect(outcomeText({ outcome: 'not_active_or_finalizing' })).toBe('Subagent is not active or is finalizing.')
    expect(outcomeText({ outcome: 'saturated', max_in_flight: 8 })).toBe('Message admission is saturated (maximum 8 in flight).')
    expect(outcomeText({ outcome: 'quota_exceeded', kind: 'SenderTargetInFlight', limit: 4 })).toBe('Agent-message quota exceeded (SenderTargetInFlight, limit 4).')
    expect(outcomeText({ outcome: 'admission_uncertain' })).toBe('Message admission could not be confirmed; the message may or may not have been accepted.')
    expect(outcomeText({ outcome: 'not_accepted_before_deadline' })).toBe('Message was not accepted before the delivery deadline.')
    expect(outcomeText({ outcome: 'unsupported' })).toBe('Active agent messages are unsupported in this context.')
    expect(outcomeText({ outcome: 'limit', max_bytes: 32768, observed_bytes: 0 })).toBe('Message size is invalid: observed 0 bytes; maximum is 32768 bytes.')
    expect(outcomeText({ outcome: 'channel_closed' })).toBe('Message was not accepted because the subagent channel closed.')
    expect(disposition({ outcome: 'accepted' })).toBe('accepted')
    expect(disposition({ outcome: 'admission_uncertain' })).toBe('unconfirmed')
    expect(disposition({ outcome: 'saturated' })).toBe('rejected')
  })

  it('parses delivery, targets, resume_from sentinels, and the size gate', () => {
    expect(parseDelivery({})).toBe('steer')
    expect(parseDelivery({ queue: true })).toBe('queue')
    expect(parseDelivery({ queue: true, delivery: 'interject' })).toBe('interject')
    expect(() => parseDelivery({ delivery: 'shout' })).toThrow(/delivery must be one of/)
    expect(validTarget('parent')).toBe('parent')
    expect(validTarget(' rust-acp-step-0-abc ')).toBe('rust-acp-step-0-abc')
    expect(validTarget('0192f0c4-1c2d-7abc-9def-0123456789ab')).toBe('0192f0c4-1c2d-7abc-9def-0123456789ab')
    expect(validTarget('bad id')).toBeUndefined()
    expect(validTarget('')).toBeUndefined()
    expect(validTarget('../x')).toBeUndefined()
    expect(resumeSource('  null ')).toBeUndefined()
    expect(resumeSource('')).toBeUndefined()
    expect(resumeSource(' abc ')).toBe('abc')
    expect(sizeOutcome('')).toEqual({ outcome: 'limit', max_bytes: MAX_MESSAGE_BYTES, observed_bytes: 0 })
    expect(sizeOutcome('é'.repeat(MAX_MESSAGE_BYTES / 2 + 1)).observed_bytes).toBe(MAX_MESSAGE_BYTES + 2)
    expect(sizeOutcome('x'.repeat(MAX_MESSAGE_BYTES))).toBeUndefined()
    expect(withSubagentId('done', 'call-1')).toBe('done\n\n[subagent_id: call-1]')
  })

  it('reads the flag from the policy (off by default) and keeps the tool in every capability mode', () => {
    expect(readPolicy(undefined).policy.activeAgentMessages).toBe(false)
    expect(readPolicy(JSON.stringify({ types: BUILTIN, activeAgentMessages: true })).policy.activeAgentMessages).toBe(true)
    expect(readPolicy(JSON.stringify({ types: BUILTIN, activeAgentMessages: 'yes' })).policy.activeAgentMessages).toBe(false)
    for (const capability of ['read-only', 'read-write', 'execute']) {
      expect(childAllowList(['read', MESSAGE_TOOL, 'subagent'], { capability }, true)).toEqual(['read', MESSAGE_TOOL])
    }
  })

  it('shows a relayed message as its own marked turn in a child transcript', () => {
    const turns = projectTurns([
      { seq: 0, type: 'turn/start', data: {} },
      { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'CHILD_TASK do it' }], source: { kind: 'user' } } } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'working' }] } } },
      { seq: 3, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Your parent agent sent a message: look at b.rs too' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: 's' } } } },
      { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'looked' }] } } },
      { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ], { skipShadowed: false })
    expect(turns.map(turn => turn.user)).toEqual(['CHILD_TASK do it', '◎ Message from parent · look at b.rs too'])
    expect(turns[1].answer).toBe('looked')
  })
})

describe('send_subagent_message and resume_from with real dsh children (ticket 173)', () => {
  it('is absent unless enabled; enabled, children get it and dsh send_message is gone', async () => {
    const off = startAgent({ messages: false })
    const offSession = await open(off)
    const offResults = await steps(off, offSession, [sendStep(0, 'hi'), spawnStep('WAITMSG 0')])
    expect(offResults[0].ok).toBe(false)
    expect(offResults[1].text).toContain('CHILD_HEARD [] polls=0')
    expect(offResults[1].text).not.toContain(MESSAGE_TOOL)
    const on = startAgent()
    const onSession = await open(on)
    const onResults = await steps(on, onSession, [spawnStep('WAITMSG 0'), ['send_message', { agent_id: 'x', message: 'y' }], spawnStep('TELL')])
    expect(onResults[0].text).toMatch(new RegExp(`tools=[^ ]*\\b${MESSAGE_TOOL}\\b`, 'u'))
    expect(onResults[0].text).not.toMatch(/tools=[^ ]*\bsend_message\b/u)
    expect(onResults[1].ok).toBe(false)
    // A depth-1 child's parent is the top-level session, never a target.
    expect(onResults[2].text).toContain('CHILD_TOLD ok:Subagent not found or not owned by this session.')
  }, 90000)

  it('steers a running child: the message enters its own dsh session at the next step', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const results = await steps(agent, sessionId, [
      spawnStep('WAITMSG 40', { run_in_background: true }),
      sendStep(0, 'look at b.rs too'),
      ['job_output', { job_id: '{{job:0}}', wait: true, timeout_ms: 60000 }],
    ])
    expect(results[1].text).toMatch(/^Message accepted \(message_id: \S+\)\.$/u)
    expect(results[2].text).toContain('CHILD_HEARD [look at b.rs too]')
    expect(Number(/polls=(\d+)/u.exec(results[2].text)[1])).toBeLessThan(40)
    const [row] = messageRows(agent)
    expect(row).toMatchObject({ state: 'accepted', outcome: 'accepted', delivery: 'steer', type: 'general-purpose', label: 'waitmsg 40 probe', parent: false })
    // One child agent: the steer did not start another writer.
    expect(agent.events.filter(event => event.event === 'start')).toHaveLength(1)
  }, 90000)

  it('queues behind the current turn: the child answers it as a later turn', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const results = await steps(agent, sessionId, [
      spawnStep('WAITMSG 8', { run_in_background: true }),
      sendStep(0, 'then check c.rs', { delivery: 'queue' }),
      ['job_output', { job_id: '{{job:0}}', wait: true, timeout_ms: 60000 }],
    ])
    expect(results[1].text).toMatch(/^Message accepted/u)
    // The first turn polled without hearing it; the queued turn heard it at once.
    expect(results[2].text).toContain('CHILD_HEARD [then check c.rs] polls=0')
  }, 90000)

  it('wakes a completed child with the same identity, and again for a repeated continuation', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const results = await steps(agent, sessionId, [
      spawnStep('WAITMSG 0'),
      sendStep(0, 'first follow-up'),
      ['job_output', { job_id: '{{job:1}}', wait: true, timeout_ms: 60000 }],
      sendStep(0, 'second follow-up'),
      ['job_output', { job_id: '{{job:3}}', wait: true, timeout_ms: 60000 }],
    ])
    expect(results[0].text).toMatch(/CHILD_HEARD \[\] polls=0 .*\[subagent_id: \S+\]$/u)
    expect(results[1].text).toMatch(/^Message accepted \(message_id: \S+\)\.\sThe subagent had completed, so it resumed with this message as its next turn in background job \S+\./u)
    expect(results[2].text).toContain('CHILD_HEARD [first follow-up]')
    // A new attempt answers only for itself, with the whole conversation.
    expect(results[4].text).toContain('CHILD_HEARD [first follow-up | second follow-up]')
    const id = /\[subagent_id: (\S+)\]/u.exec(results[0].text)[1]
    const starts = agent.events.filter(event => event.event === 'start' && event.id === id)
    expect(starts).toHaveLength(3)
    expect(new Set(starts.map(event => event.child)).size).toBe(1)
    expect(agent.events.filter(event => event.event === 'resume' && event.id === id).map(event => event.attempt)).toEqual([2, 3])
    const ends = agent.events.filter(event => event.event === 'end' && event.id === id)
    expect(ends.map(event => [event.status, event.attempt])).toEqual([['completed', undefined], ['completed', 2], ['completed', 3]])
  }, 120000)

  it('refuses unknown, invalid, empty, oversized, parent, cancelled, and saturated targets', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const results = await steps(agent, sessionId, [
      [MESSAGE_TOOL, { subagent_id: 'no-such-child', text: 'hi' }],
      [MESSAGE_TOOL, { subagent_id: 'bad id!', text: 'hi' }],
      [MESSAGE_TOOL, { subagent_id: 'parent', text: 'hi' }],
      spawnStep('SLOW', { run_in_background: true }),
      sendStep(3, ''),
      sendStep(3, 'x'.repeat(MAX_MESSAGE_BYTES + 1)),
      ...Array.from({ length: 9 }, (_, index) => sendStep(3, `m${index}`)),
      ['job_kill', { job_id: '{{job:3}}' }],
      sendStep(3, 'too late', {}, { delay: 500 }),
    ])
    expect(results[0].text).toBe('Subagent not found or not owned by this session.')
    expect(results[1].ok).toBe(false)
    expect(results[1].text).toContain(INVALID_TARGET)
    expect(results[2].text).toBe('Subagent not found or not owned by this session.')
    expect(results[4].text).toBe('Message size is invalid: observed 0 bytes; maximum is 32768 bytes.')
    expect(results[5].text).toBe(`Message size is invalid: observed ${MAX_MESSAGE_BYTES + 1} bytes; maximum is 32768 bytes.`)
    // A child in one long model call claims nothing: eight wait, the ninth is refused.
    for (const result of results.slice(6, 14)) expect(result.text).toMatch(/^Message accepted/u)
    expect(results[14].text).toBe('Message admission is saturated (maximum 8 in flight).')
    expect(results[16].text).toBe('Subagent is not active or is finalizing.')
    const rows = messageRows(agent)
    expect(rows[0]).toMatchObject({ state: 'rejected', outcome: 'not_found_or_not_owned', target: 'no-such-child' })
    expect(rows[0].label).toBeUndefined()
    expect(rows.at(-1)).toMatchObject({ state: 'rejected', outcome: 'not_active_or_finalizing', label: 'slow probe' })
  }, 120000)

  it('interjects: a child blocked on job_output wakes early and the job keeps running until it stops it', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const results = await steps(agent, sessionId, [
      spawnStep('INTERJECT', { run_in_background: true }),
      sendStep(0, 'stop waiting', { delivery: 'interject' }, { delay: 2500 }),
      ['job_output', { job_id: '{{job:0}}', wait: true, timeout_ms: 60000 }],
    ])
    expect(results[1].text).toMatch(/^Message accepted/u)
    expect(results[2].text).toContain('CHILD_INTERJECTED wait=error:The wait ended early because an interjected message arrived. The job is still running')
    expect(results[2].text).toContain('heard=[stop waiting]')
  }, 90000)

  it('resume_from seeds a new child with the source transcript; wrong type, running, and unknown sources fail', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const results = await steps(agent, sessionId, [
      spawnStep('WAITMSG 0'),
      ['subagent', { description: 'recall', prompt: 'CHILD_RECALL what did you do?', resume_from: '{{id:0}}' }],
      ['subagent', { description: 'recall', prompt: 'CHILD_RECALL', subagent_type: 'explore', resume_from: '{{id:0}}' }],
      ['subagent', { description: 'recall', prompt: 'CHILD_RECALL', resume_from: 'no-such-child' }],
      spawnStep('SLOW', { run_in_background: true }),
      ['subagent', { description: 'recall', prompt: 'CHILD_RECALL', resume_from: '{{id:4}}' }],
      ['job_kill', { job_id: '{{job:4}}' }],
      ['subagent', { description: 'blank', prompt: 'CHILD_WAITMSG 0', resume_from: 'null' }],
    ])
    const source = /\[subagent_id: (\S+)\]/u.exec(results[0].text)[1]
    expect(results[1].ok).toBe(true)
    expect(results[1].text).toMatch(/CHILD_RECALLED kinds=\[WAITMSG\] heard=\[\] route=\S+\/\S+/u)
    expect(results[2].text).toContain(RESUME_ERRORS.type('explore', 'general-purpose'))
    expect(results[3].text).toContain(RESUME_ERRORS.missing('no-such-child'))
    const slow = /subagent_id is (\S+?)\./u.exec(results[4].text)[1]
    expect(results[5].text).toContain(RESUME_ERRORS.running(slow))
    expect(results[7].text).toContain('CHILD_HEARD [] polls=0')
    const starts = agent.events.filter(event => event.event === 'start')
    const resumed = agent.events.find(event => event.event === 'start' && event.resumedFrom === source)
    expect(resumed).toBeDefined()
    // A new child: its own id and dsh session; the source is untouched.
    expect(resumed.child).not.toBe(starts[0].child)
    expect(agent.events.filter(event => event.event === 'start' && event.id === source)).toHaveLength(1)
  }, 120000)

  it('never reaches another session or a previous process', async () => {
    const agent = startAgent()
    const first = await open(agent)
    const [spawned] = await steps(agent, first, [spawnStep('WAITMSG 0')])
    const id = /\[subagent_id: (\S+)\]/u.exec(spawned.text)[1]
    const second = (await agent.send('session/new', { cwd: agent.cwd, mcpServers: [] })).sessionId
    const other = await steps(agent, second, [
      [MESSAGE_TOOL, { subagent_id: id, text: 'not yours' }],
      ['subagent', { description: 'steal', prompt: 'CHILD_RECALL', resume_from: id }],
    ])
    expect(other[0].text).toBe('Subagent not found or not owned by this session.')
    expect(other[1].text).toContain(RESUME_ERRORS.missing(id))
    agent.child.kill('SIGTERM')
    await waitFor(() => agent.child.exitCode !== null || agent.child.signalCode !== null, 'dsh exit')
    const restarted = startAgent({ root: agent.root })
    const again = await open(restarted)
    const after = await steps(restarted, again, [
      [MESSAGE_TOOL, { subagent_id: id, text: 'after restart' }],
      ['subagent', { description: 'recall', prompt: 'CHILD_RECALL', resume_from: id }],
    ])
    expect(after[0].text).toBe('Subagent not found or not owned by this session.')
    expect(after[1].text).toContain(RESUME_ERRORS.missing(id))
    expect(restarted.events.filter(event => event.event === 'start' || event.event === 'resume')).toHaveLength(0)
  }, 120000)
})
