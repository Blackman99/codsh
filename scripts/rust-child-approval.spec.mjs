/**
 * #220: a subagent's or workflow child's approval request goes to the main
 * session over the control channel instead of being refused. The real
 * file-approval pre-execute hook runs against a fake cordis context; the
 * test plays the Rust client's side of the control messages.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply as applyFileApproval } from '../packages/cli/bin/rust-acp-file-approval.mjs'
import { createControl } from '../packages/cli/bin/rust-acp-control.mjs'
import { createChildApprovals, isChild, rootOf } from '../packages/cli/bin/rust-acp-child-approval.mjs'

let dir
let savedPolicy

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codsh-child-approval-'))
  savedPolicy = process.env.CODSH_PERMISSION_POLICY
})

afterEach(() => {
  if (savedPolicy === undefined) delete process.env.CODSH_PERMISSION_POLICY
  else process.env.CODSH_PERMISSION_POLICY = savedPolicy
  rmSync(dir, { recursive: true, force: true })
})

function writePolicy(extra = {}) {
  const path = join(dir, 'permission-policy.json')
  writeFileSync(path, JSON.stringify({ mode: 'ask', interactive: true, rememberToolApprovals: true, cwd: dir, grantsPath: join(dir, 'grants.json'), rules: [], ...extra }))
  process.env.CODSH_PERMISSION_POLICY = path
}

function rootAgent(id = 'root') {
  return { id, session: { id, header: { id, cwd: dir } }, options: {} }
}

function childAgent(id, parent = 'root') {
  return { id, session: { id, header: { id, cwd: dir, origin: 'subagent', parentSession: parent, delegationDepth: 1 } }, options: { subagentDepth: 1 } }
}

/** File approval + control wired as in dsh, with a fake cordis context. */
function harness({ interactive = true, connected = true } = {}) {
  const handlers = new Map()
  const registry = new Map()
  const ctx = {
    llm: {},
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
    },
    get(name) {
      if (name === 'agents') return registry
      return undefined
    },
    async waterfall(name, args, fallback) {
      const list = handlers.get(name) ?? []
      const run = index => (index < list.length ? list[index](args, () => run(index + 1)) : fallback())
      return run(0)
    },
  }
  const sent = []
  const state = { connected }
  const lineage = new Map()
  // Only this feature's messages; the question plumbing also sends plan state and todos.
  const control = createControl(ctx, message => {
    if (String(message.type).startsWith('child_approval')) sent.push(message)
  }, {
    interactive,
    connected: () => state.connected,
    lineage: () => ({ describe: id => lineage.get(id) }),
  })
  applyFileApproval(ctx)
  ctx.on('approval/request', (request, next) => control.childApprovals.request(request, next))
  const root = rootAgent()
  registry.set(root.id, root)
  control.onCreated(root)
  const call = (agent, name, args, signal = new AbortController().signal) =>
    handlers.get('tools/pre-execute')[0]({ agent, name, arguments: args, callId: `call-${Math.random()}`, signal }, () => 'ran')
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  return { ctx, sent, control, root, registry, lineage, call, tick, state }
}

describe('child approvals in the main session (#220)', () => {
  it('routes a workflow child ask with attribution; allow runs the tool', async () => {
    writePolicy()
    const h = harness()
    const child = childAgent('c1')
    h.registry.set(child.id, child)
    h.lineage.set('c1', { label: 'researcher-1', type: 'researcher', root: 'root', workflow: 'deep-research', workflowRun: 'run-7' })
    const pending = h.call(child, 'web_fetch', { url: 'https://example.org/a' })
    await h.tick()
    expect(h.sent).toHaveLength(1)
    const message = h.sent[0]
    expect(message).toMatchObject({
      type: 'child_approval',
      sessionId: 'root',
      child: 'c1',
      label: 'researcher-1',
      agentType: 'researcher',
      workflow: 'deep-research',
      run: 'run-7',
      tool: 'web_fetch',
      input: { url: 'https://example.org/a' },
    })
    h.control.handle(JSON.stringify({ type: 'child_approval_answer', id: message.id, outcome: 'allowed-once' }))
    expect(await pending).toBe('ran')
    expect(h.control.childApprovals.pending()).toEqual([])
  })

  it('deny returns the refusal to the child as a tool error', async () => {
    writePolicy()
    const h = harness()
    const child = childAgent('c1')
    const pending = h.call(child, 'web_fetch', { url: 'https://example.org/a' })
    await h.tick()
    expect(h.sent[0].label).toBe('')
    h.control.handle(JSON.stringify({ type: 'child_approval_answer', id: h.sent[0].id, outcome: 'rejected' }))
    expect(await pending).toEqual({ kind: 'deny', reason: 'the user rejected tool "web_fetch"' })
    // An unknown outcome is treated as a reject, never as an allow.
    const second = h.call(child, 'web_fetch', { url: 'https://example.org/b' })
    await h.tick()
    h.control.handle(JSON.stringify({ type: 'child_approval_answer', id: h.sent[1].id, outcome: 'allowed-always-please' }))
    expect(await second).toEqual({ kind: 'deny', reason: 'the user rejected tool "web_fetch"' })
  })

  it('an aborted child call (workflow cancel, Ctrl+C) settles and closes the card; a late answer is stale', async () => {
    writePolicy()
    const h = harness()
    const child = childAgent('c1')
    const controller = new AbortController()
    const pending = h.call(child, 'web_fetch', { url: 'https://example.org/a' }, controller.signal)
    await h.tick()
    const id = h.sent[0].id
    controller.abort()
    expect(await pending).toEqual({ kind: 'deny', reason: 'approval for tool "web_fetch" was cancelled' })
    expect(h.sent[1]).toEqual({ type: 'child_approval_closed', id, reason: 'aborted' })
    h.control.handle(JSON.stringify({ type: 'child_approval_answer', id, outcome: 'allowed-once' }))
    expect(h.sent[2]).toEqual({ type: 'child_approval_closed', id, reason: 'stale' })
    // Already aborted before asking: nothing is shown.
    const done = new AbortController()
    done.abort()
    expect(await h.call(child, 'web_fetch', { url: 'https://example.org/b' }, done.signal)).toEqual({ kind: 'deny', reason: 'approval for tool "web_fetch" was cancelled' })
    expect(h.sent).toHaveLength(3)
  })

  it('queues concurrent requests from several children; each gets its own answer', async () => {
    writePolicy()
    const h = harness()
    const calls = ['c1', 'c2', 'c3'].map(id => h.call(childAgent(id), 'web_fetch', { url: `https://${id}.test/` }))
    await h.tick()
    expect(h.sent.map(message => message.child)).toEqual(['c1', 'c2', 'c3'])
    expect(new Set(h.sent.map(message => message.id)).size).toBe(3)
    h.control.handle(JSON.stringify({ type: 'child_approval_answer', id: h.sent[2].id, outcome: 'allowed-once' }))
    h.control.handle(JSON.stringify({ type: 'child_approval_answer', id: h.sent[0].id, outcome: 'rejected' }))
    h.control.handle(JSON.stringify({ type: 'child_approval_answer', id: h.sent[1].id, outcome: 'allowed-once' }))
    expect(await Promise.all(calls)).toEqual([
      { kind: 'deny', reason: 'the user rejected tool "web_fetch"' },
      'ran',
      'ran',
    ])
  })

  it('headless, a disconnected channel, or an unknown root keep the old refusal', async () => {
    writePolicy()
    for (const options of [{ interactive: false }, { connected: false }]) {
      const h = harness(options)
      expect(await h.call(childAgent('c1'), 'web_fetch', { url: 'https://example.org/' })).toEqual({ kind: 'deny', reason: 'permission mode ask' })
      expect(h.sent).toEqual([])
    }
    const h = harness()
    expect(await h.call(childAgent('c9', 'someone-else'), 'web_fetch', { url: 'https://example.org/' })).toEqual({ kind: 'deny', reason: 'permission mode ask' })
    expect(h.sent).toEqual([])
  })

  it('the main session’s own ask is left to dsh-acp', async () => {
    writePolicy()
    const h = harness()
    // No dsh-acp in this harness, so the fallthrough is the old refusal.
    expect(await h.call(h.root, 'web_fetch', { url: 'https://example.org/' })).toEqual({ kind: 'deny', reason: 'permission mode ask' })
    expect(h.sent).toEqual([])
  })

  it('allow rules, grants, and always-approve bypass the prompt; deny rules still apply', async () => {
    writePolicy({ rules: [{ tool: 'web_fetch', action: 'allow', pattern: 'example.org', patternMode: 'domain' }] })
    let h = harness()
    expect(await h.call(childAgent('c1'), 'web_fetch', { url: 'https://docs.example.org/' })).toBe('ran')
    writePolicy({ grants: { allowedDomains: ['granted.test'] } })
    expect(await h.call(childAgent('c1'), 'web_fetch', { url: 'https://granted.test/x' })).toBe('ran')
    writePolicy({ mode: 'always-approve' })
    expect(await h.call(childAgent('c1'), 'web_fetch', { url: 'https://other.test/' })).toBe('ran')
    expect(h.sent).toEqual([])
    writePolicy({ rules: [{ tool: 'web_fetch', action: 'deny', pattern: 'blocked.test', patternMode: 'domain' }] })
    h = harness()
    const denied = await h.call(childAgent('c1'), 'web_fetch', { url: 'https://blocked.test/' })
    expect(denied.kind).toBe('deny')
    expect(h.sent).toEqual([])
  })

  it('the root going away or the channel closing settles every open request', async () => {
    writePolicy()
    const h = harness()
    const first = h.call(childAgent('c1'), 'web_fetch', { url: 'https://a.test/' })
    const second = h.call(childAgent('c2'), 'web_fetch', { url: 'https://b.test/' })
    await h.tick()
    h.control.onDisposed(childAgent('c1'))
    expect(await first).toEqual({ kind: 'deny', reason: 'approval for tool "web_fetch" was cancelled' })
    h.control.close()
    expect(await second).toEqual({ kind: 'deny', reason: 'permission mode ask' })
    const third = h.call(childAgent('c3'), 'web_fetch', { url: 'https://c.test/' })
    await h.tick()
    h.control.onDisposed(h.root)
    expect(await third).toEqual({ kind: 'deny', reason: 'approval for tool "web_fetch" was cancelled' })
  })
})

describe('child approval helpers', () => {
  it('knows children and walks to the root', () => {
    const agents = new Map()
    const mid = childAgent('mid', 'root')
    const leaf = childAgent('leaf', 'mid')
    agents.set('mid', mid)
    expect(isChild(rootAgent())).toBe(false)
    expect(isChild(leaf)).toBe(true)
    expect(rootOf(leaf, id => agents.get(id))).toBe('root')
    expect(rootOf(rootAgent('r2'), () => undefined)).toBe('r2')
  })

  it('a request from a non-child passes through untouched', async () => {
    const approvals = createChildApprovals({}, () => { throw new Error('nothing is sent') }, { interactive: true, agents: new Map() })
    expect(await approvals.request({ agent: rootAgent() }, () => 'next')).toBe('next')
    expect(await approvals.request({}, () => 'next')).toBe('next')
    expect(approvals.handle({ type: 'other' })).toBe(false)
  })
})
