// Rhai workflows (tickets 181 and 182): a real reference-format script runs in the
// Rust engine (`codsh-rust __workflow-engine`) and its agent() calls start
// real dsh children through rust-acp-subagents. The children answer from the
// keyless mock model. Build the debug binary first:
//   cargo build --manifest-path rust/Cargo.toml --locked -p codsh-rust
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { MARK, intersectCapability, childAllowList } from '../packages/cli/bin/rust-acp-subagents.mjs'
import {
  DEPTH_MESSAGE,
  RunSlots,
  concurrencyCap,
  normalizeInput,
  scratchDir,
  summarizeResult,
  unsupportedSource,
} from '../packages/cli/bin/rust-acp-workflow.mjs'

const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const engine = join(repo, 'rust/target/debug/codsh-rust')
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

function startAgent({ policy, env = {}, trusted = true, permission = { mode: 'always-approve' }, approve = true } = {}) {
  if (!existsSync(engine)) throw new Error(`missing ${engine}; run cargo build --manifest-path rust/Cargo.toml --locked -p codsh-rust`)
  const root = mkdtempSync(join('/tmp', 'codsh-workflow-'))
  roots.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  const grokHome = join(root, 'grok')
  mkdirSync(home)
  mkdirSync(cwd)
  mkdirSync(join(grokHome, 'workflows'), { recursive: true })
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const permissionPath = join(root, 'permission-policy.json')
  writeFileSync(permissionPath, JSON.stringify({ cwd, ...(typeof permission === 'function' ? permission(cwd) : permission) }))
  const trace = join(root, 'trace.jsonl')
  const child = spawn(process.execPath, [dshPath(), '--profile', 'acp', '--patch', overlay], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      GROK_HOME: grokHome,
      DSH_CODE_CLI_MOCK_TOOL: 'subagents',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      CODSH_WORKSPACE_TRUSTED: trusted ? '1' : '0',
      CODSH_WORKFLOW_ENGINE: engine,
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
      permissions.push(msg.params)
      const pick = msg.params.options.find(option => option.kind === (approve ? 'allow_once' : 'reject_once'))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } } })}\n`)
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
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.slice(-40).join('\n')}`)), timeout)
    })
  }
  const traceLines = () => (existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
  const agent = { root, home, cwd, grokHome, child, send, updates, events, stderr, permissions, traceLines }
  agents.push(agent)
  return agent
}

async function open(agent) {
  await agent.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-workflow-test', version: '0' } })
  const session = await agent.send('session/new', { cwd: agent.cwd, mcpServers: [] })
  return session.sessionId
}

function workflow(agent, sessionId, input, timeout = 90000) {
  return agent.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: `WORKFLOW_CALL ${JSON.stringify(input)}` }] }, timeout)
}

function answer(agent) {
  return agent.updates
    .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
    .map(update => update.update.content.text)
    .join('')
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

/** Engine processes whose parent is this dsh. */
function engines(agent) {
  try {
    return execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(agent.child.pid)], { encoding: 'utf8' })
      .split('\n').filter(line => line.includes('__workflow-engine'))
  } catch {
    return []
  }
}

const META = name => `let meta = #{ name: "${name}", description: "ticket 181 probe", phases: [#{ title: "fan-out" }, #{ title: "check" }] };\n`

describe('workflow tool input and helpers', () => {
  it('accepts the reference tagged and legacy sources and refuses what the reference refuses', () => {
    expect(normalizeInput({ source: { type: 'script', script: 'x' } }).source).toEqual({ type: 'script', value: 'x' })
    expect(normalizeInput({ script_path: '  a.rhai ' }).source).toEqual({ type: 'script_path', value: 'a.rhai' })
    expect(normalizeInput({ source: { type: 'script', script: 'x' }, agent_budget: 1024, args: { a: 1 }, validate_only: true }))
      .toEqual({ source: { type: 'script', value: 'x' }, agentBudget: 1024, args: { a: 1 }, validateOnly: true })
    const refused = [
      [{}, 'missing workflow source'],
      [{ script: 'a', name: 'b' }, 'mutually exclusive'],
      [{ source: { type: 'script', script: 'a' }, script: 'b' }, 'cannot be combined with legacy'],
      [{ source: { type: 'script', script: 'a' }, agent_budget: 0 }, '`agent_budget` must be a positive integer'],
      [{ source: { type: 'script', script: 'a' }, agent_budget: 1025 }, '`agent_budget` must be at most 1024 agents'],
      [{ source: { type: 'script', script: 'a' }, agent_budget: 1.5 }, 'positive integer'],
      [{ source: { type: 'script', script: '   ' } }, 'workflow source value must not be blank'],
      [{ source: { type: 'stop', run_id: 'r' }, args: {} }, '`args` only applies to a launch'],
      [{ source: { type: 'pause', run_id: 'r' }, validate_only: true }, '`validate_only` cannot be used'],
      [{ source: { type: 'stop', run_id: 'r' }, agent_budget: 3 }, 'pause and stop take no options'],
      [{ source: { type: 'bogus' } }, '`source.type` must be one of'],
      [{ source: { type: 'script', script: 'a', extra: 1 } }, 'unknown field `extra`'],
    ]
    for (const [input, message] of refused) {
      expect(() => normalizeInput(input), JSON.stringify(input)).toThrow(message)
      expect(() => normalizeInput(input)).toThrow(/^workflow_invalid_input: /)
    }
  })

  it('names what this build cannot run instead of pretending', () => {
    expect(unsupportedSource({ type: 'name', value: 'deep-research' }).message).toMatch(/^workflow_unsupported: registered workflow names are not available in this build/)
    expect(unsupportedSource({ type: 'resume', value: 'r' }).message).toMatch(/resuming a workflow run is not available in this build/)
    expect(unsupportedSource({ type: 'stop', value: 'r' }).message).toMatch(/stop is not available in this build/)
    expect(unsupportedSource({ type: 'script', value: 's' })).toBeUndefined()
  })

  it('summarizes results, caps concurrency and intersects capabilities like the reference', async () => {
    expect(summarizeResult('text')).toBe('text')
    expect(summarizeResult(null)).toBe('done')
    expect(summarizeResult({ report: 'R', path: 'p.md' })).toBe('R\n\n_Full report: p.md_')
    expect(summarizeResult({ report: 'R' })).toBe('R')
    expect(summarizeResult({ a: [1] })).toBe('{"a":[1]}')
    expect(summarizeResult('x'.repeat(20000))).toHaveLength(16 * 1024 + 1)
    expect(concurrencyCap(1)).toBe(2)
    expect(concurrencyCap(8)).toBe(8)
    expect(concurrencyCap(128)).toBe(32)
    // Ticket 182: the configured cap (reference workflow_max_concurrent) is
    // at least 1 and clamped to max(2, parallelism).
    expect(concurrencyCap(128, 5)).toBe(5)
    expect(concurrencyCap(4, 16)).toBe(4)
    expect(concurrencyCap(1, 1)).toBe(1)
    expect(concurrencyCap(1, 0)).toBe(1)
    expect(concurrencyCap(64, 64)).toBe(64)
    expect(scratchDir('s-1', 'call/../x', { GROK_HOME: '/g' }, '/w')).toBe('/g/sessions/%2Fw/s-1/workflows/call_.._x/scratch')
    expect(scratchDir('s-1', '..', { CODSH_PLAN_ROOT: '/r' }, '/w')).toBe('/r/s-1/workflows/_/scratch')
    expect(scratchDir(undefined, 'c')).toBeNull()
    expect(intersectCapability('all', 'execute')).toBe('execute')
    expect(intersectCapability('read-write', 'all')).toBe('read-write')
    expect(intersectCapability('read-write', 'execute')).toBe('read-only')
    expect(intersectCapability('execute', 'read-only')).toBe('read-only')
    expect(intersectCapability(undefined, 'execute')).toBe('execute')
    // Children are never offered the workflow tool.
    expect(childAllowList(['read', 'workflow', 'bash'], { capability: 'all' }, false)).toEqual(['read', 'bash'])
    const slots = new RunSlots(1)
    await slots.acquire()
    let second = false
    const waiting = slots.acquire().then(() => { second = true })
    await Promise.resolve()
    expect(second).toBe(false)
    slots.release()
    await waiting
    expect(second).toBe(true)
    const controller = new AbortController()
    const aborted = slots.acquire(controller.signal)
    controller.abort(new Error('stop'))
    await expect(aborted).rejects.toThrow('stop')
  })
})

describe('Rhai workflows run dsh children', () => {
  it('passes args into an original-format script whose agent() and parallel() calls are real dsh children', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('fan-out-probe')}phase("fan-out");
log("files: " + args.files.len());
let panel = parallel(args.files.map(|f| #{ prompt: "CHILD_SAY summary of " + f, label: "say " + f }));
phase("check");
let routed = agent("CHILD_MODEL report", #{ label: "routed", model: "cli-mock-fork", effort: "high", agent_type: "explore", capability_mode: "read-only" });
let b = budget();
#{ said: panel.map(|r| r.output), routed: routed.output, ok: routed.success, spent: b.spent, remaining: b.remaining }`
    const result = await workflow(agent, sessionId, { source: { type: 'script', script }, args: { files: ['a.rs', 'b.rs'] }, agent_budget: 5 })
    expect(result.stopReason).toBe('end_turn')
    const text = answer(agent)
    expect(text).toContain("PARENT_WORKFLOW ok: Workflow 'fan-out-probe' completed (3 agent calls of budget 5).")
    expect(text).toContain('Phases: fan-out → check')
    expect(text).toContain('- files: 2')
    const json = JSON.parse(text.slice(text.indexOf('Result:\n') + 'Result:\n'.length))
    expect(json.said).toEqual(['CHILD_SAID summary of a.rs', 'CHILD_SAID summary of b.rs'])
    expect(json.ok).toBe(true)
    expect(json.spent).toBe(3)
    expect(json.remaining).toBe(2)
    // Per-agent model and effort reached dsh; read-only removed shell and write tools.
    expect(json.routed).toMatch(/^CHILD_MODEL route=cli-mock\/cli-mock-fork effort=high tools=/)
    const tools = /tools=(\S*)/.exec(json.routed)[1].split(',')
    expect(tools).toContain('read')
    expect(tools).not.toContain('bash')
    expect(tools).not.toContain('write')
    expect(tools).not.toContain('workflow')
    // The board saw three real children tagged with the workflow.
    const starts = agent.events.filter(event => event.event === 'start')
    expect(starts).toHaveLength(3)
    expect(starts.every(event => event.workflow === 'fan-out-probe' && event.child)).toBe(true)
    expect(starts.find(event => event.label === 'routed')).toMatchObject({ type: 'explore', model: 'cli-mock/cli-mock-fork', phase: 'check' })
    const ends = agent.events.filter(event => event.event === 'end')
    expect(ends.map(event => event.status)).toEqual(['completed', 'completed', 'completed'])
    const runs = agent.events.filter(event => event.event === 'workflow')
    expect(runs.at(-1)).toMatchObject({ name: 'fan-out-probe', status: 'completed', agents: 3, running: 0 })
    expect(engines(agent)).toEqual([])
  }, 120000)

  it('runs a script_path from the project (trusted) or $GROK_HOME/workflows, and refuses an untrusted project file', async () => {
    const script = `let meta = #{ name: "scan", description: "d" };\nagent("CHILD_SAY " + args.what).output`
    const agent = startAgent()
    writeFileSync(join(agent.cwd, 'scan.rhai'), script)
    const sessionId = await open(agent)
    await workflow(agent, sessionId, { source: { type: 'script_path', script_path: 'scan.rhai' }, args: { what: 'from-file' } })
    expect(answer(agent)).toContain("PARENT_WORKFLOW ok: Workflow 'scan' completed (1 agent call of budget 128).\nResult:\nCHILD_SAID from-file")

    const untrusted = startAgent({ trusted: false })
    writeFileSync(join(untrusted.cwd, 'scan.rhai'), script)
    writeFileSync(join(untrusted.grokHome, 'workflows', 'scan.rhai'), script)
    const second = await open(untrusted)
    await workflow(untrusted, second, { script_path: 'scan.rhai', args: { what: 'x' } })
    expect(answer(untrusted)).toContain('PARENT_WORKFLOW error: Error: workflow_resolve_failed: workflow path is not trusted:')
    expect(answer(untrusted)).toContain('(project workflows require folder trust)')
    untrusted.updates.length = 0
    await workflow(untrusted, second, { script_path: join(untrusted.grokHome, 'workflows', 'scan.rhai'), args: { what: 'user-dir' } })
    expect(answer(untrusted)).toContain('CHILD_SAID user-dir')
  }, 120000)

  it('rejects syntax errors, bad metadata and wrong file names before any child starts', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const cases = [
      [`${META('broken')}let x = ;`, 'workflow_resolve_failed: invalid workflow script: script failed to parse'],
      ['let x = 1;\nlet meta = #{ name: "late", description: "d" };', 'first statement must be `let meta = #{ ... };`'],
      ['let meta = #{ name: "Not Kebab", description: "d" };\n1', 'meta.name must be lowercase ASCII letters or digits separated by single hyphens'],
      ['let meta = #{ name: "x", description: "" };\n1', 'description must be a non-empty string'],
    ]
    for (const [script, message] of cases) {
      agent.updates.length = 0
      await workflow(agent, sessionId, { source: { type: 'script', script } })
      expect(answer(agent)).toContain('PARENT_WORKFLOW error:')
      expect(answer(agent)).toContain(message)
    }
    writeFileSync(join(agent.cwd, 'other.rhai'), `${META('mismatch')}1`)
    agent.updates.length = 0
    await workflow(agent, sessionId, { script_path: 'other.rhai' })
    expect(answer(agent)).toContain("saved workflow filename 'other.rhai' must match meta.name 'mismatch'")
    expect(agent.events.filter(event => event.event === 'start')).toEqual([])
  }, 120000)

  it('hands a failed child to the script, and fails the run on an uncaught host error', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('failure-probe')}let r = agent("CHILD_FAIL now");\nif r.success { "unexpected" } else { "child failed: " + r.output }`
    await workflow(agent, sessionId, { source: { type: 'script', script } })
    expect(answer(agent)).toMatch(/PARENT_WORKFLOW ok: .*\nResult:\nchild failed: subagent run failed/)
    expect(agent.events.find(event => event.event === 'end')).toMatchObject({ status: 'failed', workflow: 'failure-probe' })

    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'script', script: `${META('host-error')}agent("CHILD_SAY x", #{ agent_type: "ghost" })` } })
    expect(answer(agent)).toContain("PARENT_WORKFLOW error: Error: Workflow 'host-error' failed: Runtime error: unknown or disabled subagent type \"ghost\"")
  }, 120000)

  it('refuses unsupported sources and options explicitly', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const expectations = [
      [{ source: { type: 'name', name: 'deep-research' } }, 'workflow_unsupported: registered workflow names are not available in this build'],
      [{ source: { type: 'resume', resume_from_run_id: 'wf_1' } }, 'workflow_unsupported: resuming a workflow run is not available'],
      [{ source: { type: 'stop', run_id: 'wf_1' } }, 'workflow_unsupported: stop is not available in this build'],
      [{ source: { type: 'script', script: `${META('schema')}agent("CHILD_SAY x", #{ output_schema: #{ type: 7 } })` } }, 'output_schema is not a valid self-contained JSON Schema: '],
      [{ source: { type: 'script', script: `${META('resume')}agent("CHILD_SAY x", #{ resume_from: "c1" })` } }, 'resume_from is not supported by this host yet'],
      [{ source: { type: 'script', script: `${META('fork')}agent("CHILD_SAY x", #{ fork_context: true })` } }, 'fork_context is restricted to built-in workflows'],
      [{ source: { type: 'script', script: `${META('effort')}agent("CHILD_SAY x", #{ effort: "turbo" })` } }, 'invalid workflow agent effort'],
      [{ source: { type: 'script', script: `${META('effort-model')}agent("CHILD_SAY x", #{ effort: "medium" })` } }, 'workflow agent effort "medium" is not available for model cli-mock/cli-mock'],
      [{ source: { type: 'script', script: `${META('capability')}agent("CHILD_SAY x", #{ capability_mode: "root" })` } }, "invalid capability_mode 'root' (expected read-only, read-write, execute, or all)"],
      [{ source: { type: 'script', script: `${META('scratch')}write_scratch_file("../a", "b")` } }, 'scratch file name must be a single relative path component, got: ../a'],
      [{ source: { type: 'script', script: `${META('diff')}git_diff_since("HEAD; rm -rf /")` } }, 'git_diff_since expects a commit hash, got: HEAD; rm -rf /'],
    ]
    for (const [input, message] of expectations) {
      agent.updates.length = 0
      await workflow(agent, sessionId, input)
      expect(answer(agent), JSON.stringify(input)).toContain('PARENT_WORKFLOW error:')
      expect(answer(agent), JSON.stringify(input)).toContain(message)
    }
    expect(agent.events.filter(event => event.event === 'start')).toEqual([])
  }, 120000)

  it('stops a panel over the agent budget before any child starts, and smoke-checks without children', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('budget-probe')}parallel([#{ prompt: "CHILD_SAY a" }, #{ prompt: "CHILD_SAY b" }])`
    await workflow(agent, sessionId, { source: { type: 'script', script }, agent_budget: 1 })
    expect(answer(agent)).toContain("PARENT_WORKFLOW error: Error: Workflow 'budget-probe' stopped: workflow agent budget exceeded: requested 2, maximum 1 (0 agent calls of budget 1). Resume is not available in this build")
    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'script', script }, validate_only: true })
    expect(answer(agent)).toContain("PARENT_WORKFLOW ok: Smoke check passed for workflow 'budget-probe' (2 declared phases; canned-host path completed:")
    expect(agent.events.filter(event => event.event === 'start')).toEqual([])
  }, 120000)

  it('ends an endless script at the operation limit', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const started = Date.now()
    await workflow(agent, sessionId, { source: { type: 'script', script: `${META('spin')}loop { }` } })
    expect(answer(agent)).toContain("PARENT_WORKFLOW error: Error: Workflow 'spin' failed: Too many operations")
    expect(Date.now() - started).toBeLessThan(60000)
    expect(engines(agent)).toEqual([])
  }, 120000)

  it('cancels the run, its engine and its running children when the turn is cancelled', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('cancel-probe')}parallel([#{ prompt: "CHILD_SLOW one" }, #{ prompt: "CHILD_SLOW two" }])`
    const turn = workflow(agent, sessionId, { source: { type: 'script', script } })
    await waitFor(() => agent.events.filter(event => event.event === 'start').length === 2, 'two running children')
    expect(engines(agent)).toHaveLength(1)
    const cancelledAt = Date.now()
    agent.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`)
    const result = await turn
    expect(result.stopReason).toBe('cancelled')
    await waitFor(() => agent.events.filter(event => event.event === 'end').length === 2, 'both children settled')
    expect(agent.events.filter(event => event.event === 'end').map(event => event.status)).toEqual(['cancelled', 'cancelled'])
    await waitFor(() => engines(agent).length === 0, 'the engine exited')
    expect(Date.now() - cancelledAt).toBeLessThan(15000)
    await waitFor(() => agent.events.some(event => event.event === 'workflow' && event.status === 'cancelled'), 'the run marked cancelled')
  }, 120000)

  it('never lets a child start a workflow', async () => {
    const agent = startAgent({ policy: { maxDepth: 2 } })
    const sessionId = await open(agent)
    // A workflow child at depth 1 with room to delegate (maxDepth 2).
    await workflow(agent, sessionId, { source: { type: 'script', script: `${META('nested-probe')}agent("CHILD_WORKFLOW try").output` } })
    const text = answer(agent)
    expect(text).toContain('PARENT_WORKFLOW ok:')
    expect(text).toContain('CHILD_WORKFLOW tools=')
    expect(/CHILD_WORKFLOW tools=(\S*)/.exec(text)[1].split(',')).not.toContain('workflow')
    expect(text).toContain(`result=error:Error: workflow_depth_exceeded: ${DEPTH_MESSAGE}`)
    expect(text).not.toContain("Workflow 'nested' completed")
    // A plain subagent child is refused the same way.
    agent.updates.length = 0
    const fresh = (await agent.send('session/new', { cwd: agent.cwd, mcpServers: [] })).sessionId
    await agent.send('session/prompt', { sessionId: fresh, prompt: [{ type: 'text', text: 'SPAWN:general-purpose:WORKFLOW' }] }, 60000)
    const spawned = answer(agent)
    expect(spawned).toContain('PARENT_DONE [0:ok] CHILD_WORKFLOW tools=')
    expect(/CHILD_WORKFLOW tools=(\S*)/.exec(spawned)[1].split(',')).not.toContain('workflow')
    expect(spawned).toContain(`result=error:Error: workflow_depth_exceeded: ${DEPTH_MESSAGE}`)
    expect(agent.stderr.join('\n')).not.toContain("Workflow 'nested'")
  }, 120000)

  it('is masked by the headless Agent deny and by an allow-list without it', async () => {
    for (const tools of ['deny:Agent', 'allow:read,grep']) {
      const agent = startAgent({ env: { CODSH_PLAIN_TOOLS: tools } })
      const sessionId = await open(agent)
      await workflow(agent, sessionId, { source: { type: 'script', script: `${META('masked')}agent("CHILD_SAY no").output` } })
      const text = answer(agent)
      expect(text, tools).toContain('PARENT_WORKFLOW error:')
      expect(text, tools).not.toContain('CHILD_SAID')
      expect(agent.events.filter(event => event.event === 'workflow' || event.event === 'start'), tools).toEqual([])
    }
    // Naming the tool itself works as for any registered tool.
    const named = startAgent({ env: { CODSH_PLAIN_TOOLS: 'deny:workflow' } })
    const sessionId = await open(named)
    await workflow(named, sessionId, { source: { type: 'script', script: `${META('masked')}1` } })
    expect(answer(named)).toContain('PARENT_WORKFLOW error:')
    expect(named.events.filter(event => event.event === 'workflow')).toEqual([])
  }, 120000)

  it('has no workflow tool when subagents are disabled', async () => {
    const agent = startAgent({ policy: { enabled: false } })
    const sessionId = await open(agent)
    await workflow(agent, sessionId, { source: { type: 'script', script: `${META('off')}1` } })
    expect(answer(agent)).toContain('PARENT_WORKFLOW error: Error: subagents are disabled for this session')
    expect(engines(agent)).toEqual([])
  }, 60000)
})

/** The Result: JSON of a completed run. */
function resultJson(agent) {
  const text = answer(agent)
  return JSON.parse(text.slice(text.indexOf('Result:\n') + 'Result:\n'.length))
}

/** Model turns of workflow children (the parent's turns carry the call). */
function childTurns(agent) {
  return agent.traceLines().filter(line => !line.user.some(text => text.includes('WORKFLOW_CALL ')))
}

/** Every started child has settled (the board saw its end). */
function allSettled(agent) {
  const starts = agent.events.filter(event => event.event === 'start').map(event => event.id)
  const ends = agent.events.filter(event => event.event === 'end').map(event => event.id)
  return starts.length === ends.length && starts.every(id => ends.includes(id))
}

const SCHEMA = '#{ type: "object", required: ["files"], properties: #{ files: #{ type: "integer", minimum: 0 } } }'

describe('workflow parallelism, budget and output contract (ticket 182)', () => {
  it('validates output_schema answers, resumes the same child once to correct a miss, and fails after the retry', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('contract-probe')}let ok = agent("CHILD_JSON FIRST<<Scanned. \`\`\`json {\\"files\\": 3} \`\`\`>>", #{ label: "first-try", output_schema: ${SCHEMA} });
let fixed = agent("CHILD_JSON FIRST<<all clear>> RETRY<<\`\`\`json {\\"files\\": 7} \`\`\`>>", #{ label: "retried", output_schema: ${SCHEMA} });
let bad = agent("CHILD_JSON FIRST<<{\\"files\\": -1}>> RETRY<<still no json>>", #{ label: "failed", output_schema: ${SCHEMA} });
let b = budget();
#{ ok: ok.output, ok_success: ok.success, fixed: fixed.output, fixed_id: fixed.agent_id, bad_success: bad.success, bad: bad.output, spent: b.spent }`
    await workflow(agent, sessionId, { source: { type: 'script', script } })
    expect(answer(agent)).toContain("PARENT_WORKFLOW ok: Workflow 'contract-probe' completed (3 agent calls of budget 128).")
    const json = resultJson(agent)
    expect(json.ok).toEqual({ files: 3 })
    expect(json.ok_success).toBe(true)
    expect(json.fixed).toEqual({ files: 7 })
    expect(json.bad_success).toBe(false)
    expect(json.bad).toMatch(/^structured output validation failed: final message did not contain valid JSON \(expected a ```json fenced block\): /)
    // Retries are free for the budget: one logical call each.
    expect(json.spent).toBe(3)
    // Three real children, one board row each; the retried one kept its id.
    const starts = agent.events.filter(event => event.event === 'start')
    expect(starts.map(event => event.label)).toEqual(['first-try', 'retried', 'failed'])
    expect(json.fixed_id).toBe(starts[1].child)
    const ends = agent.events.filter(event => event.event === 'end')
    expect(ends.map(event => event.status)).toEqual(['completed', 'completed', 'failed'])
    expect(ends[2].detail).toContain('structured output validation failed')
    // The child saw the reference contract; the correction turn ran in the
    // same child session, with its first prompt and answer in context.
    const turns = childTurns(agent).filter(line => line.user.some(text => text.includes('CHILD_JSON')))
    const first = turns.find(line => line.user.some(text => text.includes('RETRY<<\`\`\`json')) && line.assistant.length === 0)
    expect(first.user.join('\n')).toContain('<output-contract>\nDo the work above with your tools first. Then end your final message with a single ```json fenced block')
    expect(first.user.join('\n')).toContain('"required":["files"]')
    const retry = turns.find(line => line.user.some(text => text.startsWith('Your final message did not satisfy the output contract: ')) && line.user.some(text => text.includes('RETRY<<\`\`\`json')))
    expect(retry.assistant).toEqual(['all clear'])
    expect(retry.user.at(-1)).toMatch(/^Your final message did not satisfy the output contract: final message did not contain valid JSON \(expected a ```json fenced block\): .*\nReply with a single ```json fenced block containing one JSON value conforming to the schema from <output-contract>, and nothing else\.$/s)
    const badRetry = turns.find(line => line.user.some(text => text.includes('RETRY<<still no json>>')) && line.assistant.length === 1)
    expect(badRetry.user.at(-1)).toContain('output does not match the required schema: ')
    // No retry for the child that passed at once.
    expect(turns.filter(line => line.user.some(text => text.includes('Scanned.')))).toHaveLength(1)
    expect(allSettled(agent)).toBe(true)
  }, 120000)

  it('keeps at most the configured number of children live, independent of the agent budget', async () => {
    const agent = startAgent({ policy: { workflowMaxConcurrent: 2 } })
    const sessionId = await open(agent)
    const script = `${META('concurrency-probe')}let rs = parallel([1, 2, 3, 4, 5].map(|n| #{ prompt: "CHILD_HOLD 700 item " + n, label: "hold " + n }));
#{ peaks: rs.map(|r| r.output), ok: rs.map(|r| r.success) }`
    await workflow(agent, sessionId, { source: { type: 'script', script }, agent_budget: 5 })
    expect(answer(agent)).toContain("Workflow 'concurrency-probe' completed (5 agent calls of budget 5).")
    const json = resultJson(agent)
    expect(json.ok).toEqual([true, true, true, true, true])
    // Children saw two HOLD turns at once at most, and did see two.
    const peaks = json.peaks.map(text => Number(/peak=(\d+)/.exec(text)[1]))
    expect(Math.max(...peaks)).toBe(2)
    // Results come back in panel order; the queue admits the first two
    // first (start events of children admitted together may interleave).
    const starts = agent.events.filter(event => event.event === 'start').map(event => event.label)
    expect(starts.slice(0, 2).sort()).toEqual(['hold 1', 'hold 2'])
    expect(starts.slice(2).sort()).toEqual(['hold 3', 'hold 4', 'hold 5'])
    const runs = agent.events.filter(event => event.event === 'workflow')
    expect(runs.every(event => event.running <= 2 && event.limit === 2)).toBe(true)
    expect(runs.at(-1)).toMatchObject({ status: 'completed', agents: 5, running: 0, peak: 2 })

    // A budget larger than the cap still runs a panel wider than the cap; a
    // later panel over the remaining budget is refused whole.
    agent.updates.length = 0
    const before = agent.events.filter(event => event.event === 'start').length
    const over = `${META('budget-cap')}let a = parallel([#{ prompt: "CHILD_SAY 1" }, #{ prompt: "CHILD_SAY 2" }, #{ prompt: "CHILD_SAY 3" }]);
log("first panel: " + a.len());
parallel([#{ prompt: "CHILD_SAY 4" }, #{ prompt: "CHILD_SAY 5" }]);
"unreachable"`
    await workflow(agent, sessionId, { source: { type: 'script', script: over }, agent_budget: 4 })
    const text = answer(agent)
    expect(text).toContain("PARENT_WORKFLOW error: Error: Workflow 'budget-cap' stopped: workflow agent budget exceeded: requested 5, maximum 4 (3 agent calls of budget 4).")
    expect(text).toContain('- first panel: 3')
    const said = agent.events.filter(event => event.event === 'start').slice(before)
    expect(said).toHaveLength(3)
    expect(childTurns(agent).some(line => line.user.some(text => /CHILD_SAY [45]/.test(text)))).toBe(false)
    expect(allSettled(agent)).toBe(true)
  }, 120000)

  it('returns failed children as results, host refusals as (), and marks nothing that did not run as successful', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('mixed-probe')}let rs = parallel([#{ prompt: "CHILD_SAY a" }, #{ prompt: "CHILD_FAIL" }, #{ prompt: "CHILD_SAY ghost", agent_type: "ghost" }, #{ prompt: "CHILD_SAY b" }]);
rs.map(|r| if r == () { "()" } else { (if r.success { "ok: " } else { "failed: " }) + r.output })`
    await workflow(agent, sessionId, { source: { type: 'script', script } })
    expect(answer(agent)).toContain("Workflow 'mixed-probe' completed (4 agent calls of budget 128).")
    expect(resultJson(agent)).toEqual(['ok: CHILD_SAID a', 'failed: subagent run failed', '()', 'ok: CHILD_SAID b'])
    const starts = agent.events.filter(event => event.event === 'start')
    expect(starts).toHaveLength(3)
    expect(starts.some(event => event.type === 'ghost')).toBe(false)
    expect(agent.events.filter(event => event.event === 'end').map(event => event.status).sort()).toEqual(['completed', 'completed', 'failed'])
    expect(allSettled(agent)).toBe(true)
  }, 120000)

  it('cancels running children, never starts queued ones, and leaves no child or engine behind', async () => {
    const agent = startAgent({ policy: { workflowMaxConcurrent: 2 } })
    const sessionId = await open(agent)
    const script = `${META('queue-cancel')}parallel([1, 2, 3, 4].map(|n| #{ prompt: "CHILD_SLOW " + n, label: "slow " + n }))`
    const turn = workflow(agent, sessionId, { source: { type: 'script', script } })
    await waitFor(() => agent.events.filter(event => event.event === 'start').length === 2, 'two running children')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(agent.events.filter(event => event.event === 'start')).toHaveLength(2)
    agent.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`)
    expect((await turn).stopReason).toBe('cancelled')
    await waitFor(() => allSettled(agent), 'every started child settled')
    await waitFor(() => engines(agent).length === 0, 'the engine exited')
    await new Promise(resolve => setTimeout(resolve, 500))
    const starts = agent.events.filter(event => event.event === 'start')
    expect(starts.map(event => event.label).sort()).toEqual(['slow 1', 'slow 2'])
    expect(agent.events.filter(event => event.event === 'end').map(event => event.status)).toEqual(['cancelled', 'cancelled'])
    expect(childTurns(agent).filter(line => line.user.some(text => /CHILD_SLOW [34]/.test(text)))).toEqual([])
    await waitFor(() => agent.events.some(event => event.event === 'workflow' && event.status === 'cancelled'), 'the run marked cancelled')
    expect(agent.events.filter(event => event.event === 'workflow').at(-1).running).toBe(0)
  }, 120000)

  it('cancels its children when the engine dies mid-run and reports the failure', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('engine-crash')}parallel([#{ prompt: "CHILD_SLOW one" }, #{ prompt: "CHILD_SLOW two" }])`
    const turn = workflow(agent, sessionId, { source: { type: 'script', script } })
    await waitFor(() => agent.events.filter(event => event.event === 'start').length === 2, 'two running children')
    const [line] = engines(agent)
    process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL')
    await turn
    expect(answer(agent)).toContain('PARENT_WORKFLOW error: Error: workflow_engine_failed: the workflow engine exited without an outcome (signal SIGKILL)')
    await waitFor(() => allSettled(agent), 'every started child settled')
    expect(agent.events.filter(event => event.event === 'end').map(event => event.status)).toEqual(['cancelled', 'cancelled'])
  }, 120000)

  it('keeps scratch files under the session directory and diffs the session checkout', async () => {
    const agent = startAgent()
    const git = (...args) => execFileSync('git', args, { cwd: agent.cwd, env: { PATH: process.env.PATH, HOME: agent.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }, encoding: 'utf8' })
    git('init', '-q')
    writeFileSync(join(agent.cwd, 'tracked.txt'), 'before\n')
    git('add', 'tracked.txt')
    git('commit', '-q', '-m', 'base')
    const head = git('rev-parse', 'HEAD').trim()
    writeFileSync(join(agent.cwd, 'tracked.txt'), 'after\n')
    const sessionId = await open(agent)
    const script = `${META('scratch-probe')}let p = write_scratch_file("notes.md", "phase one\\n");
let back = read_scratch_file("notes.md");
let diff = git_diff_since(args.head);
#{ path: p, back: back, diff: diff }`
    await workflow(agent, sessionId, { source: { type: 'script', script }, args: { head } })
    const json = resultJson(agent)
    expect(json.path).toBe('scratch/notes.md')
    expect(json.back).toBe('phase one\n')
    expect(json.diff).toContain('-before\n+after')
    const sessions = join(agent.grokHome, 'sessions')
    const [encoded] = readdirSync(sessions)
    const [session] = readdirSync(join(sessions, encoded))
    expect(session).toBe(sessionId)
    const [run] = readdirSync(join(sessions, encoded, session, 'workflows'))
    expect(readFileSync(join(sessions, encoded, session, 'workflows', run, 'scratch', 'notes.md'), 'utf8')).toBe('phase one\n')
  }, 120000)
})

describe('workflow children across permission entry points (ticket 182)', () => {
  it('asks for the workflow call in ask mode; a rejected call starts nothing and children cannot ask', async () => {
    const approved = startAgent({ permission: { mode: 'ask' } })
    const sessionId = await open(approved)
    await workflow(approved, sessionId, { source: { type: 'script', script: `${META('ask-probe')}agent("CHILD_WRITE now").output` } })
    const text = answer(approved)
    expect(text).toContain("Workflow 'ask-probe' completed")
    expect(text).toContain('write=denied')
    expect(approved.permissions).toHaveLength(1)
    expect(approved.permissions[0].toolCall.toolCallId).toMatch(/^rust-acp-workflow-/u)
    expect(readdirSync(approved.cwd).filter(name => name.startsWith('child-'))).toEqual([])

    const rejected = startAgent({ permission: { mode: 'ask' }, approve: false })
    const second = await open(rejected)
    await workflow(rejected, second, { source: { type: 'script', script: `${META('ask-probe')}agent("CHILD_SAY no").output` } })
    expect(answer(rejected)).toContain('PARENT_WORKFLOW error:')
    expect(rejected.events.filter(event => event.event === 'workflow' || event.event === 'start')).toEqual([])
    expect(engines(rejected)).toEqual([])
  }, 120000)

  it('applies deny rules, capability limits and disabled types to workflow children', async () => {
    const agent = startAgent({
      permission: cwd => ({ mode: 'always-approve', rules: [{ action: 'deny', tool: 'edit', pattern: `${cwd}/secret.txt`, patternMode: 'glob' }] }),
      policy: { types: [{ name: 'general-purpose', description: 'all', capability: 'all' }, { name: 'explore', description: 'ro', capability: 'execute' }] },
    })
    const sessionId = await open(agent)
    const script = `${META('policy-probe')}let rs = parallel([
  #{ prompt: "CHILD_SECRET write" },
  #{ prompt: "CHILD_ECHO read-only", capability_mode: "read-only" },
  #{ prompt: "CHILD_ECHO planner", agent_type: "plan" },
]);
rs.map(|r| if r == () { "()" } else { r.output })`
    await workflow(agent, sessionId, { source: { type: 'script', script } })
    const [secret, readOnly, plan] = resultJson(agent)
    expect(secret).toContain('CHILD_SECRET_DONE error')
    expect(secret).toContain('Denied by permission policy')
    expect(existsSync(join(agent.cwd, 'secret.txt'))).toBe(false)
    const tools = /tools=(\S*)/.exec(readOnly)[1].split(',')
    expect(tools).toContain('read')
    expect(tools).not.toContain('write')
    expect(tools).not.toContain('bash')
    // A type the policy disabled (Agent(plan) in --disallowed-tools) is a host refusal.
    expect(plan).toBe('()')
    expect(agent.events.filter(event => event.event === 'start')).toHaveLength(2)
    expect(allSettled(agent)).toBe(true)
  }, 120000)
})
