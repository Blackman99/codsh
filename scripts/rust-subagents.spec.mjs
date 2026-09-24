import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import {
  Admission,
  LIMIT_MESSAGE,
  MARK,
  allowsTool,
  childAllowList,
  readPolicy,
} from '../packages/cli/bin/rust-acp-subagents.mjs'

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
  { name: 'plan', description: 'no edits', capability: 'execute' },
]

function startAgent({ policy, permission = { mode: 'always-approve' }, env = {}, approve = false } = {}) {
  const root = mkdtempSync(join('/tmp', 'codsh-subagents-'))
  roots.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  const control = join(root, 'control')
  mkdirSync(home)
  mkdirSync(cwd)
  mkdirSync(control, { mode: 0o700 })
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const permissionPath = join(root, 'permission-policy.json')
  writeFileSync(permissionPath, JSON.stringify({ cwd, ...permission }))
  const trace = join(root, 'trace.jsonl')
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
      CODSH_REVIEW_TRACE: trace,
      ...policy === undefined ? {} : { CODSH_SUBAGENT_POLICY: JSON.stringify(policy) },
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  const events = []
  const stderr = []
  const permissions = []
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.method === 'session/request_permission') {
      // Only the parent's own asks reach the client. `approve` allows them once.
      const allow = msg.params.options.find(option => option.kind === 'allow_once')
      const outcome = approve && allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' }
      permissions.push(msg.params)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome } })}\n`)
    }
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
  function cancelChild(id) {
    const path = join(control, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(`${path}.tmp`, JSON.stringify({ action: 'cancel', id }))
    require('node:fs').renameSync(`${path}.tmp`, path)
  }
  const agent = { root, home, cwd, control, child, send, updates, events, stderr, trace, cancelChild, permissions }
  agents.push(agent)
  return agent
}

async function open(agent) {
  await agent.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-subagents-test', version: '0' } })
  const session = await agent.send('session/new', { cwd: agent.cwd, mcpServers: [] })
  return session.sessionId
}

function prompt(agent, sessionId, text) {
  return agent.send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 60000)
}

function answer(agent) {
  return agent.updates
    .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
    .map(update => update.update.content.text)
    .join('')
}

function traceLines(agent) {
  if (!existsSync(agent.trace)) return []
  return readFileSync(agent.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function waitFor(predicate, detail, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timeout waiting for ${detail}`)
}

function ends(agent, id) {
  return agent.events.filter(event => event.event === 'end' && event.id === id)
}

describe('subagent policy helpers', () => {
  it('keeps built-ins by default and clamps invalid limits to the reference defaults', () => {
    expect(readPolicy(undefined).policy.types.map(type => type.name)).toEqual(['general-purpose', 'explore', 'plan'])
    const { policy } = readPolicy(JSON.stringify({ maxConcurrent: 0, limitBehavior: 'bogus', maxDepth: -3, types: BUILTIN }))
    expect(policy.maxConcurrent).toBe(32)
    expect(policy.limitBehavior).toBe('queue')
    expect(policy.maxDepth).toBe(1)
    expect(readPolicy('{').error).toMatch(/not JSON/)
    expect(readPolicy(JSON.stringify({ types: [{ name: 'x', capability: 'root' }] })).error).toMatch(/invalid capability "root"/)
    expect(readPolicy(JSON.stringify({ error: 'unknown Agent(ghost)', types: BUILTIN })).error).toBe('unknown Agent(ghost)')
    expect(readPolicy(JSON.stringify({ enabled: false, error: 'x' })).policy.enabled).toBe(false)
  })

  it('maps capability modes onto dsh tools and fails closed on unknown tools', () => {
    expect(allowsTool('read-only', 'read')).toBe(true)
    expect(allowsTool('read-only', 'bash')).toBe(false)
    expect(allowsTool('read-only', 'write')).toBe(false)
    expect(allowsTool('read-write', 'edit')).toBe(true)
    expect(allowsTool('read-write', 'bash')).toBe(false)
    expect(allowsTool('execute', 'bash')).toBe(true)
    expect(allowsTool('execute', 'write')).toBe(false)
    expect(allowsTool('execute', 'mcp__server__tool')).toBe(false)
    expect(allowsTool('all', 'mcp__server__tool')).toBe(true)
    const parent = ['read', 'write', 'bash', 'subagent', 'subagent_fork', 'mcp__x']
    expect(childAllowList(parent, { capability: 'execute' }, true)).toEqual(['read', 'bash'])
    expect(childAllowList(parent, { capability: 'execute' }, false)).toEqual(['read', 'bash', 'subagent', 'subagent_fork'])
    expect(childAllowList(parent, { capability: 'all', tools: ['Read', 'Bash'] }, true)).toEqual(['read', 'bash'])
  })

  it('queues past the limit, admits the next waiter on release, and fails when asked to', async () => {
    const queue = new Admission(1, 'queue')
    await queue.acquire('root')
    let admitted = false
    let queued = false
    const waiting = queue.acquire('root', undefined, () => { queued = true }).then(() => { admitted = true })
    await Promise.resolve()
    expect(queued).toBe(true)
    expect(admitted).toBe(false)
    queue.release('root')
    await waiting
    expect(admitted).toBe(true)
    expect(queue.count('root')).toBe(1)
    const controller = new AbortController()
    const aborted = queue.acquire('root', controller.signal)
    controller.abort(new Error('stop'))
    await expect(aborted).rejects.toThrow('stop')
    queue.release('root')
    expect(queue.count('root')).toBe(0)
    const fail = new Admission(1, 'fail')
    await fail.acquire('root')
    await expect(fail.acquire('root')).rejects.toThrow(LIMIT_MESSAGE(1))
    await expect(fail.acquire('other')).resolves.toBeUndefined()
  })
})

describe('typed dsh subagents', () => {
  it('runs real children whose type removes write tools, while general-purpose writes', async () => {
    const agent = startAgent({ policy: { types: BUILTIN } })
    const sessionId = await open(agent)
    const result = await prompt(agent, sessionId, 'SPAWN:explore:WRITE SPAWN:general-purpose:WRITE')
    expect(result.stopReason).toBe('end_turn')
    const text = answer(agent)
    const [explore, general] = text.split('[1:')
    expect(explore).toContain('CHILD_DONE tools=')
    expect(explore).not.toMatch(/tools=[^ ]*\bwrite\b/)
    expect(explore).not.toMatch(/tools=[^ ]*\bedit\b/)
    expect(explore).toMatch(/tools=[^ ]*\bbash\b/)
    expect(explore).toContain('write=denied')
    expect(general).toMatch(/tools=[^ ]*\bwrite\b/)
    expect(general).toContain('write=allowed')
    const written = readdirSync(agent.cwd).filter(name => name.startsWith('child-'))
    expect(written).toHaveLength(1)
    expect(readFileSync(join(agent.cwd, written[0]), 'utf8')).toBe('CHILD_WROTE\n')
    // The explore child saw its type instructions and no spawn tools at depth 1.
    const childRequests = traceLines(agent).filter(line => line.user.some(text => text.includes('CHILD_WRITE')))
    expect(childRequests.some(line => line.user.some(text => text.includes('<system-reminder>') && text.includes('Do not modify files.')))).toBe(true)
    for (const line of childRequests) expect(line.tools).not.toContain('subagent')
    const starts = agent.events.filter(event => event.event === 'start')
    expect(starts.map(event => event.type)).toEqual(['explore', 'general-purpose'])
    for (const start of starts) {
      expect(start.child).toMatch(/^[0-9a-f-]{36}$/u)
      expect(ends(agent, start.id)).toHaveLength(1)
      expect(ends(agent, start.id)[0].status).toBe('completed')
    }
  }, 60000)

  it('inherits the parent permission policy: ask mode rejects a child write it cannot approve', async () => {
    const agent = startAgent({ policy: { types: BUILTIN }, permission: { mode: 'ask' }, approve: true })
    const sessionId = await open(agent)
    await prompt(agent, sessionId, 'SPAWN:general-purpose:WRITE')
    expect(answer(agent)).toContain('write=denied')
    // The parent approved its own spawn; the child's write ask never reached the client.
    expect(agent.permissions).toHaveLength(1)
    expect(agent.permissions[0].toolCall.toolCallId).toMatch(/^rust-acp-spawn-0-/u)
    expect(readdirSync(agent.cwd).filter(name => name.startsWith('child-'))).toHaveLength(0)
  }, 60000)

  it('caps depth: a depth-1 child has no spawn tool; maxDepth 2 lets it spawn one grandchild', async () => {
    const capped = startAgent({ policy: { types: BUILTIN, maxDepth: 1 } })
    const cappedSession = await open(capped)
    await prompt(capped, cappedSession, 'SPAWN:general-purpose:NEST')
    expect(answer(capped)).toContain('CHILD_NEST')
    expect(answer(capped)).toContain('result=error')
    expect(capped.events.filter(event => event.event === 'start')).toHaveLength(1)
    const deep = startAgent({ policy: { types: BUILTIN, maxDepth: 2 } })
    const deepSession = await open(deep)
    await prompt(deep, deepSession, 'SPAWN:general-purpose:NEST')
    expect(answer(deep)).toContain('result=ok:CHILD_ECHO')
    const starts = deep.events.filter(event => event.event === 'start')
    expect(starts.map(event => event.depth)).toEqual([1, 2])
    // The grandchild is at the last level and is not offered the spawn tool.
    expect(answer(deep)).not.toMatch(/CHILD_ECHO tools=[^ ]*\bsubagent\b/)
  }, 60000)

  it('removes the spawn tool when subagents are disabled and refuses unknown types', async () => {
    const off = startAgent({ policy: { enabled: false, types: BUILTIN } })
    const offSession = await open(off)
    await prompt(off, offSession, 'SPAWN:general-purpose:ECHO')
    expect(answer(off)).toContain('[0:error]')
    expect(traceLines(off)[0].tools).not.toContain('subagent')
    expect(traceLines(off)[0].tools).not.toContain('subagent_fork')
    expect(off.events).toEqual([])
    const typed = startAgent({ policy: { types: BUILTIN.filter(type => type.name !== 'plan') } })
    const typedSession = await open(typed)
    await prompt(typed, typedSession, 'SPAWN:plan:ECHO')
    expect(answer(typed)).toContain('unknown or disabled subagent type "plan"; available: general-purpose, explore')
    expect(typed.events).toEqual([])
  }, 60000)

  it('runs a type on its configured model and refuses a missing model before any child starts', async () => {
    const agent = startAgent({
      policy: {
        types: [
          ...BUILTIN,
          { name: 'forked', description: 'other model', capability: 'read-only', model: 'cli-mock-fork' },
          { name: 'ghost', description: 'missing model', capability: 'read-only', provider: 'no-such-provider', model: 'none' },
        ],
      },
    })
    const sessionId = await open(agent)
    await prompt(agent, sessionId, 'SPAWN:forked:ECHO SPAWN:ghost:ECHO')
    const text = answer(agent)
    expect(text).toContain('[0:ok] CHILD_ECHO')
    expect(text).toContain('[1:error]')
    expect(text).toContain('no-such-provider/none is not available')
    const child = traceLines(agent).find(line => line.user.some(text => text.includes('CHILD_ECHO')))
    expect(child.model).toBe('cli-mock-fork')
    expect(child.tools).not.toContain('bash')
    expect(child.tools).toContain('read')
    expect(agent.events.filter(event => event.event === 'start').map(event => event.type)).toEqual(['forked'])
    expect(agent.events.find(event => event.event === 'refused').detail).toBe('no available model no-such-provider/none')
  }, 60000)

  it('cancels only a foreground child from the control channel and the parent continues', async () => {
    const agent = startAgent({ policy: { types: BUILTIN } })
    const sessionId = await open(agent)
    const turn = prompt(agent, sessionId, 'SPAWN:explore:SLOW')
    const start = await waitFor(() => agent.events.find(event => event.event === 'start'), 'child start')
    agent.cancelChild(start.id)
    const result = await turn
    expect(result.stopReason).toBe('end_turn')
    expect(answer(agent)).toContain('[0:error] Error: subagent run was cancelled by the user')
    expect(ends(agent, start.id)).toHaveLength(1)
    expect(ends(agent, start.id)[0].status).toBe('cancelled')
    agent.cancelChild(start.id)
    await waitFor(() => agent.events.find(event => event.event === 'refused'), 'refused second cancel')
    expect(agent.events.find(event => event.event === 'refused').detail).toBe('subagent already cancelled')
  }, 60000)

  it('cancels a foreground child with the parent turn', async () => {
    const agent = startAgent({ policy: { types: BUILTIN } })
    const sessionId = await open(agent)
    const turn = prompt(agent, sessionId, 'SPAWN:explore:SLOW')
    const start = await waitFor(() => agent.events.find(event => event.event === 'start'), 'child start')
    agent.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`)
    expect((await turn).stopReason).toBe('cancelled')
    await waitFor(() => ends(agent, start.id).length > 0, 'child end')
    expect(ends(agent, start.id)).toHaveLength(1)
    expect(ends(agent, start.id)[0].status).toBe('cancelled')
  }, 60000)

  it('fails a spawn past the limit with the reference sentence and frees the slot on cancel', async () => {
    const agent = startAgent({ policy: { types: BUILTIN, maxConcurrent: 1, limitBehavior: 'fail' } })
    const sessionId = await open(agent)
    await prompt(agent, sessionId, 'SPAWN:explore:SLOW:bg SPAWN:explore:ECHO:bg')
    const text = answer(agent)
    expect(text).toMatch(/\[0:ok\] started background subagent job \S+ \(explore\)/)
    expect(text).toContain(`[1:error] Error: ${LIMIT_MESSAGE(1)}`)
    const start = agent.events.find(event => event.event === 'start')
    expect(start.background).toBe(true)
    agent.cancelChild(start.id)
    await waitFor(() => ends(agent, start.id).length > 0, 'background end')
    expect(ends(agent, start.id)[0].status).toBe('cancelled')
    await prompt(agent, sessionId, 'SPAWN:explore:ECHO')
    expect(answer(agent)).toContain('CHILD_ECHO')
  }, 60000)

  it('queues past the limit and admits the queued child when the running one is cancelled', async () => {
    const agent = startAgent({ policy: { types: BUILTIN, maxConcurrent: 1 } })
    const sessionId = await open(agent)
    await prompt(agent, sessionId, 'SPAWN:explore:SLOW:bg SPAWN:explore:ECHO:bg')
    expect(answer(agent)).toMatch(/\[1:ok\] started background subagent job/)
    const queued = await waitFor(() => agent.events.find(event => event.event === 'queued'), 'queued')
    expect(queued.limit).toBe(1)
    expect(agent.events.filter(event => event.event === 'start')).toHaveLength(1)
    const first = agent.events.find(event => event.event === 'start')
    agent.cancelChild(first.id)
    const second = await waitFor(() => ends(agent, queued.id)[0], 'queued child end')
    expect(second.status).toBe('completed')
    expect(second.detail).toContain('CHILD_ECHO')
    expect(ends(agent, first.id)[0].status).toBe('cancelled')
  }, 60000)

  it('delivers a background result once through job_output', async () => {
    const agent = startAgent({ policy: { types: BUILTIN } })
    const sessionId = await open(agent)
    await prompt(agent, sessionId, 'SPAWN:explore:ECHO:bg COLLECT')
    const text = answer(agent)
    expect(text).toMatch(/\[0:ok\] started background subagent job/)
    expect(text).toMatch(/\[1:ok\] .*CHILD_ECHO/)
    expect(text.match(/CHILD_ECHO/g)).toHaveLength(1)
    const start = agent.events.find(event => event.event === 'start')
    expect(start.background).toBe(true)
    expect(ends(agent, start.id)).toHaveLength(1)
    expect(ends(agent, start.id)[0].status).toBe('completed')
  }, 60000)
})
