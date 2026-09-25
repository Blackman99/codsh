// Rhai workflows (tickets 181, 182 and 183): a real reference-format script runs in the
// Rust engine (`codsh-rust __workflow-engine`) and its agent() calls start
// real dsh children through rust-acp-subagents. The children answer from the
// keyless mock model. Ticket 183 runs are background runs: the tool call
// returns at once and the result comes back in a completion message that
// wakes the session (the mock echoes it as PARENT_WORKFLOW_NOTICE).
// Build the debug binary first:
//   cargo build --manifest-path rust/Cargo.toml --locked -p codsh-rust
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:net'
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
import {
  formatElapsed,
  formatOverview,
  formatReminder,
  matchRuns,
  needsName,
  newRunId,
  parseCommand,
  uniqueName,
} from '../packages/cli/bin/rust-acp-workflow-runs.mjs'

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
    agent.server?.close()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dshPath() {
  const manifest = JSON.parse(readFileSync(dshManifest, 'utf8'))
  return join(dirname(dshManifest), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh)
}

function startAgent({ policy, env = {}, trusted = true, permission = { mode: 'always-approve' }, approve = true, root: reuse, control = false } = {}) {
  if (!existsSync(engine)) throw new Error(`missing ${engine}; run cargo build --manifest-path rust/Cargo.toml --locked -p codsh-rust`)
  const root = reuse ?? mkdtempSync(join('/tmp', 'codsh-workflow-'))
  if (!reuse) roots.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  const grokHome = join(root, 'grok')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(grokHome, 'workflows'), { recursive: true })
  // Ticket 183: a private control socket like the Rust client's, for /workflow.
  let server
  const controlLines = []
  const controlSocket = join(root, `control-${Date.now().toString(36)}.sock`)
  if (control) {
    server = createServer(socket => {
      socket.setEncoding('utf8')
      server.socket = socket
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk
        let at
        while ((at = buffer.indexOf('\n')) >= 0) {
          controlLines.push(JSON.parse(buffer.slice(0, at)))
          buffer = buffer.slice(at + 1)
        }
      })
    })
    server.listen(controlSocket)
  }
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
      ...control ? { CODSH_CONTROL_SOCKET: controlSocket, CODSH_CONTROL_TOKEN: 'workflow-token' } : {},
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
  let controlId = 0
  /** `/workflow <text>` over the control channel; resolves with the reply text. */
  async function slash(sessionId, text) {
    const id = `w${++controlId}`
    await waitFor(() => server?.socket && controlLines.some(line => line.type === 'hello'), 'the control hello')
    server.socket.write(`${JSON.stringify({ type: 'workflow', id, sessionId, text })}\n`)
    const reply = await waitFor(() => controlLines.find(line => line.type === 'workflow_result' && line.id === id), `workflow reply ${id}`)
    if (reply.error) throw new Error(reply.error)
    return reply.text
  }
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  const agent = { root, home, cwd, grokHome, child, send, notify, updates, events, stderr, permissions, traceLines, server, slash }
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

function answer(agent, sessionId) {
  return agent.updates
    .filter(update => update.update.sessionUpdate === 'agent_message_chunk' && (sessionId === undefined || update.sessionId === sessionId))
    .map(update => update.update.content.text)
    .join('')
}

/** Every completion message the parent echoed, in order (ticket 183). */
function notices(agent, sessionId) {
  return answer(agent, sessionId).split('PARENT_WORKFLOW_NOTICE\n').slice(1).map(text => text.split('PARENT_WORKFLOW')[0])
}

/** Wait for the completion message that names run `name`; returns its reminder. */
async function completion(agent, name, sessionId, timeout = 60000) {
  const marker = `- Workflow '${name}' (run id `
  return waitFor(() => notices(agent, sessionId).find(text => text.includes(marker)), `the completion of ${name}`, timeout)
}

/** The run's block of a reminder. */
function runBlock(reminder, name) {
  const start = reminder.indexOf(`- Workflow '${name}' (run id `)
  const next = reminder.indexOf('\n- Workflow ', start + 1)
  return reminder.slice(start, next < 0 ? undefined : next)
}

/** The Result: text of a run in a reminder (lines are indented four spaces). */
function resultText(reminder, name) {
  const block = runBlock(reminder, name)
  const at = block.indexOf('\n  Result:\n')
  if (at < 0) throw new Error(`no result in ${block}`)
  return block.slice(at + '\n  Result:\n'.length).split('\n').filter(line => line.startsWith('    ')).map(line => line.slice(4)).join('\n')
}

/** Launch through the tool and check the background start. */
async function launch(agent, sessionId, input, name) {
  agent.updates.length = 0
  await workflow(agent, sessionId, input)
  const text = answer(agent, sessionId)
  expect(text).toContain(`PARENT_WORKFLOW ok: Workflow '${name}' started in the background.`)
  return text
}

/** Launch, wait for the completion, and return the run's reminder block. */
async function runToEnd(agent, sessionId, input, name) {
  await launch(agent, sessionId, input, name)
  return runBlock(await completion(agent, name, sessionId), name)
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
    expect(normalizeInput({ source: { type: 'resume', resume_from_run_id: ' wf_1 ' }, agent_budget: 9 }))
      .toEqual({ source: { type: 'resume', value: 'wf_1' }, agentBudget: 9, args: null, validateOnly: false })
    const refused = [
      [{}, 'missing workflow source'],
      [{ script: 'a', name: 'b' }, 'mutually exclusive'],
      [{ source: { type: 'script', script: 'a' }, script: 'b' }, 'cannot be combined with legacy'],
      [{ source: { type: 'script', script: 'a' }, agent_budget: 0 }, '`agent_budget` must be a positive integer'],
      [{ source: { type: 'script', script: 'a' }, agent_budget: 1025 }, '`agent_budget` must be at most 1024 agents'],
      [{ source: { type: 'script', script: 'a' }, agent_budget: 1.5 }, 'positive integer'],
      [{ source: { type: 'script', script: '   ' } }, 'workflow source value must not be blank'],
      [{ source: { type: 'stop', run_id: 'r' }, args: {} }, '`args` only applies to a launch'],
      [{ source: { type: 'resume', resume_from_run_id: 'r' }, args: { a: 1 } }, '`args` only applies to a launch'],
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
    // Ticket 183: resume, pause and stop are real sources now.
    for (const type of ['resume', 'pause', 'stop', 'script', 'script_path']) expect(unsupportedSource({ type, value: 'r' })).toBeUndefined()
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

  it('names, orders, matches and reports runs like the reference tracker (ticket 183)', () => {
    expect(newRunId(0)).toMatch(/^wf_0000000000007[0-9a-f]{3}[89ab][0-9a-f]{15}$/)
    expect(newRunId()).not.toBe(newRunId())
    expect(uniqueName('scan', [])).toBe('scan')
    expect(uniqueName('scan', ['scan', 'scan-2'])).toBe('scan-3')
    expect(formatElapsed(59999)).toBe('59s')
    expect(formatElapsed(61000)).toBe('1m 1s')
    expect(formatElapsed(3 * 3600 * 1000 + 120000)).toBe('3h 2m')
    expect(parseCommand('')).toEqual({ kind: 'overview' })
    expect(parseCommand(' runs ')).toEqual({ kind: 'overview' })
    expect(parseCommand('pause scan-2')).toEqual({ kind: 'manage', op: 'pause', name: 'scan-2' })
    expect(parseCommand('scan-2 Stop')).toEqual({ kind: 'manage', op: 'stop', name: 'scan-2' })
    expect(parseCommand('resume')).toEqual({ kind: 'manage', op: 'resume', name: '' })
    expect(parseCommand('deep-research find x')).toEqual({ kind: 'launch', name: 'deep-research', args: 'find x' })
    const run = (id, name, status, extra = {}) => ({ id, name, status, objective: '', phases: [], agents: [], elapsedFloor: 0, ...extra })
    const runs = [
      run('wf_1', 'deep-research', 'complete'),
      run('wf_2', 'deep-research-2', 'active', { currentPhase: 'check', phases: [{ title: 'scan' }, { title: 'check' }], agents: [{ state: 'done' }, { state: 'running' }, { state: 'failed' }], activeSince: Date.now() - 61000, objective: 'find\n  the   bug' }),
      run('wf_3', 'triage', 'user_paused', { elapsedFloor: 5000 }),
    ]
    // Exact names win over a prefix; a prefix narrows by what the op applies to.
    expect(matchRuns(runs, 'deep-research', 'stop').map(r => r.name)).toEqual(['deep-research'])
    expect(matchRuns(runs, 'deep', 'stop').map(r => r.name)).toEqual(['deep-research-2'])
    expect(matchRuns(runs, 'deep', 'save')).toHaveLength(2)
    expect(matchRuns(runs, 'wf_3', 'resume').map(r => r.name)).toEqual(['triage'])
    expect(needsName('stop', runs)).toBe('Say which run to stop:\n  deep-research-2 (active)\n  triage (user paused)\n(/workflow stop <name>)')
    expect(needsName('pause', [runs[0]])).toBe('No runs to pause.')
    const overview = formatOverview(runs)
    expect(overview).toBe(`- 'deep-research-2' — active\n  Phase: check (2/2)\n  Agents: 1 done, 1 running, 1 failed\n  Elapsed: 1m 1s\n  Objective: find the bug\n- 'triage' — user paused\n  Elapsed: 5s\n- 'deep-research' — complete\n  Elapsed: 0s\nManage with /workflow pause|resume|stop <name>.`)
    expect(overview).not.toContain('wf_')
    expect(formatOverview([])).toBe('No workflow runs in this session yet. Ask the agent to run a workflow script (inline or a script_path); saved workflows cannot be launched by name in this build.')
    const reminder = formatReminder([
      run('wf_9', 'scan', 'complete', { resultSummary: 'line one\nline two', elapsedFloor: 2000 }),
      run('wf_8', 'fan', 'budget_limited', { pauseMessage: 'workflow agent budget exceeded:  requested 2', agentsUsed: 1 }),
      run('wf_7', 'broken', 'failed', { pauseMessage: 'boom' }),
    ], { reportPath: r => (r.id === 'wf_9' ? '/s/workflows/wf_9/scratch/report.md' : undefined) })
    expect(reminder).toBe([
      'While you were idle, 3 background workflow runs stopped (finished or paused):',
      '',
      "- Workflow 'scan' (run id wf_9) — status: complete",
      '  Elapsed: 2s',
      '  Result:',
      '    line one',
      '    line two',
      '  Full report: /s/workflows/wf_9/scratch/report.md (use read on that path to view it)',
      '',
      "- Workflow 'fan' (run id wf_8) — status: budget_limited",
      '  Elapsed: 0s',
      '  Detail: workflow agent budget exceeded: requested 2',
      '  Resumable: call the workflow tool with source: { type: "resume", resume_from_run_id: "wf_8" } and a raised agent_budget (the resume is rejected while usage is at or over the cap).',
      '',
      "- Workflow 'broken' (run id wf_7) — status: failed",
      '  Elapsed: 0s',
      '  Detail: boom',
      '  Resumable: call the workflow tool with source: { type: "resume", resume_from_run_id: "wf_7" } — completed agents replay from the journal and the failed step re-executes.',
      '',
    ].join('\n'))
    expect(formatReminder([run('wf_1', 'a', 'complete', { resultSummary: 'x' })])).toMatch(/^While you were idle, 1 background workflow run finished:\n/)
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
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script }, args: { files: ['a.rs', 'b.rs'] }, agent_budget: 5 }, 'fan-out-probe')
    expect(block).toContain("- Workflow 'fan-out-probe' (run id wf_")
    expect(block).toContain('— status: complete')
    expect(block).toContain('Objective: ticket 181 probe')
    const json = JSON.parse(resultText(block, 'fan-out-probe'))
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
    // The board saw three real children tagged with the workflow run.
    const starts = agent.events.filter(event => event.event === 'start')
    expect(starts).toHaveLength(3)
    expect(starts.every(event => event.workflow === 'fan-out-probe' && event.child && event.workflowRun.startsWith('wf_'))).toBe(true)
    expect(starts.find(event => event.label === 'routed')).toMatchObject({ type: 'explore', model: 'cli-mock/cli-mock-fork', phase: 'check' })
    const ends = agent.events.filter(event => event.event === 'end')
    expect(ends.map(event => event.status)).toEqual(['completed', 'completed', 'completed'])
    const runs = agent.events.filter(event => event.event === 'workflow')
    expect(runs.at(-1)).toMatchObject({ name: 'fan-out-probe', status: 'complete', agents: 3, running: 0, done: 3, session: sessionId })
    expect(runs.at(-1).call).toMatch(/^rust-acp-workflow-/)
    await waitFor(() => engines(agent).length === 0, 'the engine exited')
  }, 120000)

  it('runs a script_path from the project (trusted) or $GROK_HOME/workflows, and refuses an untrusted project file', async () => {
    const script = `let meta = #{ name: "scan", description: "d" };\nagent("CHILD_SAY " + args.what).output`
    const agent = startAgent()
    writeFileSync(join(agent.cwd, 'scan.rhai'), script)
    const sessionId = await open(agent)
    const block = await runToEnd(agent, sessionId, { source: { type: 'script_path', script_path: 'scan.rhai' }, args: { what: 'from-file' } }, 'scan')
    expect(resultText(block, 'scan')).toBe('CHILD_SAID from-file')

    const untrusted = startAgent({ trusted: false })
    writeFileSync(join(untrusted.cwd, 'scan.rhai'), script)
    writeFileSync(join(untrusted.grokHome, 'workflows', 'scan.rhai'), script)
    const second = await open(untrusted)
    await workflow(untrusted, second, { script_path: 'scan.rhai', args: { what: 'x' } })
    expect(answer(untrusted)).toContain('PARENT_WORKFLOW error: Error: workflow_resolve_failed: workflow path is not trusted:')
    expect(answer(untrusted)).toContain('(project workflows require folder trust)')
    const user = await runToEnd(untrusted, second, { script_path: join(untrusted.grokHome, 'workflows', 'scan.rhai'), args: { what: 'user-dir' } }, 'scan')
    expect(resultText(user, 'scan')).toBe('CHILD_SAID user-dir')
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
    expect(agent.events.filter(event => event.event === 'start' || event.event === 'workflow')).toEqual([])
  }, 120000)

  it('hands a failed child to the script, and fails the run on an uncaught host error', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('failure-probe')}let r = agent("CHILD_FAIL now");\nif r.success { "unexpected" } else { "child failed: " + r.output }`
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script } }, 'failure-probe')
    expect(resultText(block, 'failure-probe')).toMatch(/^child failed: subagent run failed/)
    expect(agent.events.find(event => event.event === 'end')).toMatchObject({ status: 'failed', workflow: 'failure-probe' })

    const failed = await runToEnd(agent, sessionId, { source: { type: 'script', script: `${META('host-error')}agent("CHILD_SAY x", #{ agent_type: "ghost" })` } }, 'host-error')
    expect(failed).toContain('— status: failed')
    expect(failed).toContain('Detail: Runtime error: unknown or disabled subagent type "ghost"')
    expect(failed).toMatch(/Resumable: call the workflow tool with source: \{ type: "resume", resume_from_run_id: "wf_[0-9a-f]+" \} — completed agents replay from the journal and the failed step re-executes\./)
  }, 120000)

  it('refuses unsupported sources, unknown runs and bad options explicitly', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const refused = [
      [{ source: { type: 'name', name: 'deep-research' } }, 'workflow_unsupported: registered workflow names are not available in this build'],
      [{ source: { type: 'resume', resume_from_run_id: 'wf_1' } }, 'workflow_resume_failed: workflow run not found: wf_1'],
      [{ source: { type: 'stop', run_id: 'wf_1' } }, "workflow_control_failed: no workflow run in this session matches 'wf_1'"],
      [{ source: { type: 'pause', run_id: 'nope' } }, "workflow_control_failed: no workflow run in this session matches 'nope'"],
    ]
    for (const [input, message] of refused) {
      agent.updates.length = 0
      await workflow(agent, sessionId, input)
      expect(answer(agent), JSON.stringify(input)).toContain(`PARENT_WORKFLOW error: Error: ${message}`)
    }
    // Script-level refusals fail the background run; the completion says why.
    const failures = [
      ['schema', `agent("CHILD_SAY x", #{ output_schema: #{ type: 7 } })`, 'output_schema is not a valid self-contained JSON Schema: '],
      ['resume', `agent("CHILD_SAY x", #{ resume_from: "c1" })`, 'resume_from is not supported by this host yet'],
      ['fork', `agent("CHILD_SAY x", #{ fork_context: true })`, 'fork_context is restricted to built-in workflows'],
      ['effort', `agent("CHILD_SAY x", #{ effort: "turbo" })`, 'invalid workflow agent effort'],
      ['effort-model', `agent("CHILD_SAY x", #{ effort: "medium" })`, 'workflow agent effort "medium" is not available for model cli-mock/cli-mock'],
      ['capability', `agent("CHILD_SAY x", #{ capability_mode: "root" })`, "invalid capability_mode 'root' (expected read-only, read-write, execute, or all)"],
      ['scratch', `write_scratch_file("../a", "b")`, 'scratch file name must be a single relative path component, got: ../a'],
      ['diff', `git_diff_since("HEAD; rm -rf /")`, 'git_diff_since expects a commit hash, got: HEAD; rm -rf /'],
    ]
    for (const [name, body, message] of failures) {
      const block = await runToEnd(agent, sessionId, { source: { type: 'script', script: `${META(name)}${body}` } }, name)
      expect(block, name).toContain('— status: failed')
      expect(block, name).toContain(message)
    }
    expect(agent.events.filter(event => event.event === 'start')).toEqual([])
  }, 180000)

  it('stops a panel over the agent budget before any child starts, and smoke-checks without children', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('budget-probe')}parallel([#{ prompt: "CHILD_SAY a" }, #{ prompt: "CHILD_SAY b" }])`
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script }, agent_budget: 1 }, 'budget-probe')
    expect(block).toContain('— status: budget_limited')
    expect(block).toContain('Detail: workflow agent budget exceeded: requested 2, maximum 1 — finished work is kept; resume the run with a higher absolute agent budget to continue')
    expect(block).toContain('and a raised agent_budget (the resume is rejected while usage is at or over the cap).')
    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'script', script }, validate_only: true })
    expect(answer(agent)).toContain("PARENT_WORKFLOW ok: Smoke check passed for workflow 'budget-probe' (2 declared phases; canned-host path completed:")
    expect(agent.events.filter(event => event.event === 'start')).toEqual([])
  }, 120000)

  it('ends an endless script at the operation limit', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const started = Date.now()
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script: `${META('spin')}loop { }` } }, 'spin')
    expect(block).toContain('— status: failed')
    expect(block).toContain('Too many operations')
    expect(Date.now() - started).toBeLessThan(60000)
    await waitFor(() => engines(agent).length === 0, 'the engine exited')
  }, 120000)

  it('never lets a child start a workflow', async () => {
    const agent = startAgent({ policy: { maxDepth: 2 } })
    const sessionId = await open(agent)
    // A workflow child at depth 1 with room to delegate (maxDepth 2).
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script: `${META('nested-probe')}agent("CHILD_WORKFLOW try").output` } }, 'nested-probe')
    const text = resultText(block, 'nested-probe')
    expect(text).toContain('CHILD_WORKFLOW tools=')
    expect(/CHILD_WORKFLOW tools=(\S*)/.exec(text)[1].split(',')).not.toContain('workflow')
    expect(text).toContain(`result=error:Error: workflow_depth_exceeded: ${DEPTH_MESSAGE}`)
    expect(agent.events.filter(event => event.event === 'workflow' && event.name === 'nested')).toEqual([])
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

/** Model turns of workflow children (the parent's turns carry the call). */
function childTurns(agent) {
  return agent.traceLines().filter(line => !line.user.some(text => text.includes('WORKFLOW_CALL ') || text.includes('background workflow run')))
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
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script } }, 'contract-probe')
    expect(block).toContain('— status: complete')
    const json = JSON.parse(resultText(block, 'contract-probe'))
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
    await waitFor(() => allSettled(agent), 'every child settled')
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
  }, 120000)

  it('keeps at most the configured number of children live, independent of the agent budget', async () => {
    const agent = startAgent({ policy: { workflowMaxConcurrent: 2 } })
    const sessionId = await open(agent)
    const script = `${META('concurrency-probe')}let rs = parallel([1, 2, 3, 4, 5].map(|n| #{ prompt: "CHILD_HOLD 700 item " + n, label: "hold " + n }));
#{ peaks: rs.map(|r| r.output), ok: rs.map(|r| r.success) }`
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script }, agent_budget: 5 }, 'concurrency-probe')
    const json = JSON.parse(resultText(block, 'concurrency-probe'))
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
    expect(runs.every(event => event.running <= 2)).toBe(true)
    expect(runs.filter(event => event.status === 'active').every(event => event.limit === 2)).toBe(true)
    expect(runs.at(-1)).toMatchObject({ status: 'complete', agents: 5, running: 0, peak: 2 })

    // A budget larger than the cap still runs a panel wider than the cap; a
    // later panel over the remaining budget is refused whole.
    const before = agent.events.filter(event => event.event === 'start').length
    const over = `${META('budget-cap')}let a = parallel([#{ prompt: "CHILD_SAY 1" }, #{ prompt: "CHILD_SAY 2" }, #{ prompt: "CHILD_SAY 3" }]);
log("first panel: " + a.len());
parallel([#{ prompt: "CHILD_SAY 4" }, #{ prompt: "CHILD_SAY 5" }]);
"unreachable"`
    const capped = await runToEnd(agent, sessionId, { source: { type: 'script', script: over }, agent_budget: 4 }, 'budget-cap')
    expect(capped).toContain('— status: budget_limited')
    expect(capped).toContain('Detail: workflow agent budget exceeded: requested 5, maximum 4 — finished work is kept')
    const said = agent.events.filter(event => event.event === 'start').slice(before)
    expect(said).toHaveLength(3)
    expect(childTurns(agent).some(line => line.user.some(text => /CHILD_SAY [45]/.test(text)))).toBe(false)
    await waitFor(() => allSettled(agent), 'every child settled')
  }, 120000)

  it('returns failed children as results, host refusals as (), and marks nothing that did not run as successful', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('mixed-probe')}let rs = parallel([#{ prompt: "CHILD_SAY a" }, #{ prompt: "CHILD_FAIL" }, #{ prompt: "CHILD_SAY ghost", agent_type: "ghost" }, #{ prompt: "CHILD_SAY b" }]);
rs.map(|r| if r == () { "()" } else { (if r.success { "ok: " } else { "failed: " }) + r.output })`
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script } }, 'mixed-probe')
    expect(JSON.parse(resultText(block, 'mixed-probe'))).toEqual(['ok: CHILD_SAID a', 'failed: subagent run failed', '()', 'ok: CHILD_SAID b'])
    const starts = agent.events.filter(event => event.event === 'start')
    expect(starts).toHaveLength(3)
    expect(starts.some(event => event.type === 'ghost')).toBe(false)
    await waitFor(() => allSettled(agent), 'every child settled')
    expect(agent.events.filter(event => event.event === 'end').map(event => event.status).sort()).toEqual(['completed', 'completed', 'failed'])
  }, 120000)

  it('stop cancels running children, never starts queued ones, and leaves no child or engine behind', async () => {
    const agent = startAgent({ policy: { workflowMaxConcurrent: 2 } })
    const sessionId = await open(agent)
    const script = `${META('queue-cancel')}parallel([1, 2, 3, 4].map(|n| #{ prompt: "CHILD_SLOW " + n, label: "slow " + n }))`
    await launch(agent, sessionId, { source: { type: 'script', script } }, 'queue-cancel')
    await waitFor(() => agent.events.filter(event => event.event === 'start').length === 2, 'two running children')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(agent.events.filter(event => event.event === 'start')).toHaveLength(2)
    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'stop', run_id: 'queue-cancel' } })
    expect(answer(agent)).toMatch(/PARENT_WORKFLOW ok: Stopped workflow 'queue-cancel'; its child agents were cancelled\. It keeps its journal, so it can be continued later with source: \{ type: "resume", resume_from_run_id: "wf_[0-9a-f]+" \}\./)
    await waitFor(() => allSettled(agent), 'every started child settled')
    await waitFor(() => engines(agent).length === 0, 'the engine exited')
    await new Promise(resolve => setTimeout(resolve, 500))
    const starts = agent.events.filter(event => event.event === 'start')
    expect(starts.map(event => event.label).sort()).toEqual(['slow 1', 'slow 2'])
    expect(agent.events.filter(event => event.event === 'end').map(event => event.status)).toEqual(['cancelled', 'cancelled'])
    expect(childTurns(agent).filter(line => line.user.some(text => /CHILD_SLOW [34]/.test(text)))).toEqual([])
    const last = agent.events.filter(event => event.event === 'workflow').at(-1)
    expect(last).toMatchObject({ status: 'cancelled', running: 0 })
    // The model stopped it itself: no completion message comes back.
    expect(notices(agent, sessionId)).toEqual([])
  }, 120000)

  it('fails the run when the engine dies mid-run, cancelling its children', async () => {
    const agent = startAgent()
    const sessionId = await open(agent)
    const script = `${META('engine-crash')}parallel([#{ prompt: "CHILD_SLOW one" }, #{ prompt: "CHILD_SLOW two" }])`
    await launch(agent, sessionId, { source: { type: 'script', script } }, 'engine-crash')
    await waitFor(() => agent.events.filter(event => event.event === 'start').length === 2, 'two running children')
    const [line] = engines(agent)
    process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL')
    const block = runBlock(await completion(agent, 'engine-crash', sessionId), 'engine-crash')
    expect(block).toContain('— status: failed')
    expect(block).toContain('Detail: workflow_engine_failed: the workflow engine exited without an outcome (signal SIGKILL)')
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
write_scratch_file("report.md", "# Report\\n");
let back = read_scratch_file("notes.md");
let diff = git_diff_since(args.head);
#{ path: p, back: back, diff: diff }`
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script }, args: { head } }, 'scratch-probe')
    const json = JSON.parse(resultText(block, 'scratch-probe'))
    expect(json.path).toBe('scratch/notes.md')
    expect(json.back).toBe('phase one\n')
    expect(json.diff).toContain('-before\n+after')
    const sessions = join(agent.grokHome, 'sessions')
    const [encoded] = readdirSync(sessions)
    const [session] = readdirSync(join(sessions, encoded))
    expect(session).toBe(sessionId)
    const [run] = readdirSync(join(sessions, encoded, session, 'workflows'))
    expect(run).toMatch(/^wf_[0-9a-f]{32}$/)
    const dir = join(sessions, encoded, session, 'workflows', run)
    expect(readFileSync(join(dir, 'scratch', 'notes.md'), 'utf8')).toBe('phase one\n')
    // The reference reminder points at a report the run wrote.
    expect(block).toContain(`  Full report: ${join(dir, 'scratch', 'report.md')} (use read on that path to view it)`)
    // The run keeps its immutable script, args and journal beside the scratch files.
    expect(readFileSync(join(dir, 'script.rhai'), 'utf8')).toBe(script)
    expect(JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8'))).toMatchObject({ args: { head }, definition: 'scratch-probe' })
    expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))).toMatchObject({ id: run, name: 'scratch-probe', status: 'complete' })
    expect(readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(0)
  }, 120000)
})

describe('workflow children across permission entry points (ticket 182)', () => {
  it('asks for the workflow call in ask mode; a rejected call starts nothing and children cannot ask', async () => {
    const approved = startAgent({ permission: { mode: 'ask' } })
    const sessionId = await open(approved)
    const block = await runToEnd(approved, sessionId, { source: { type: 'script', script: `${META('ask-probe')}agent("CHILD_WRITE now").output` } }, 'ask-probe')
    expect(block).toContain('— status: complete')
    expect(resultText(block, 'ask-probe')).toContain('write=denied')
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
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script } }, 'policy-probe')
    const [secret, readOnly, plan] = JSON.parse(resultText(block, 'policy-probe'))
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
    await waitFor(() => allSettled(agent), 'every child settled')
  }, 120000)
})

/** The session's run directory for display name `name` (from run.json). */
function runDir(agent, sessionId, name) {
  const sessions = join(agent.grokHome, 'sessions')
  for (const encoded of readdirSync(sessions)) {
    const root = join(sessions, encoded, sessionId, 'workflows')
    if (!existsSync(root)) continue
    for (const run of readdirSync(root)) {
      const state = JSON.parse(readFileSync(join(root, run, 'run.json'), 'utf8'))
      if (state.name === name) return { dir: join(root, run), state }
    }
  }
  throw new Error(`no run ${name}`)
}

describe('background runs, pause, resume and stop (ticket 183)', () => {
  it('returns at once, names repeated launches uniquely, and reports each completion once to its own session', async () => {
    const agent = startAgent({ control: true })
    const first = await open(agent)
    const second = (await agent.send('session/new', { cwd: agent.cwd, mcpServers: [] })).sessionId
    const script = tag => `let meta = #{ name: "dup-probe", description: "hold then answer" };\nagent("CHILD_HOLD 1500 ${tag}").output`
    const startedAt = Date.now()
    await launch(agent, first, { source: { type: 'script', script: script('one') }, args: { objective: 'first  launch' } }, 'dup-probe')
    // The call came back while its child was still holding.
    expect(Date.now() - startedAt).toBeLessThan(1500)
    expect(agent.events.filter(event => event.event === 'end')).toEqual([])
    await launch(agent, first, { source: { type: 'script', script: script('two') } }, 'dup-probe-2')
    await launch(agent, second, { source: { type: 'script', script: script('three') } }, 'dup-probe')
    // The text view agrees with the board while the runs are live.
    await waitFor(() => agent.events.filter(event => event.event === 'start').length === 3, 'three holding children')
    const live = await agent.slash(first, 'runs')
    expect(live).toMatch(/^- 'dup-probe-2' — active\n  Agents: 0 done, 1 running\n  Elapsed: \ds\n  Objective: hold then answer\n- 'dup-probe' — active\n  Agents: 0 done, 1 running\n  Elapsed: \ds\n  Objective: first launch\nManage with \/workflow pause\|resume\|stop <name>\.$/)
    expect(await agent.slash(second, '')).toMatch(/^- 'dup-probe' — active\n/)
    const one = await completion(agent, 'dup-probe', first)
    const two = await completion(agent, 'dup-probe-2', first)
    const three = await completion(agent, 'dup-probe', second)
    expect(resultText(one, 'dup-probe')).toMatch(/^CHILD_HELD peak=\d$/)
    expect(resultText(two, 'dup-probe-2')).toMatch(/^CHILD_HELD peak=\d$/)
    expect(resultText(three, 'dup-probe')).toMatch(/^CHILD_HELD peak=\d$/)
    // Each run is reported once, and only in the session that launched it.
    await new Promise(resolve => setTimeout(resolve, 1000))
    const count = (sessionId, name) => notices(agent, sessionId).join('\n').split(`- Workflow '${name}' (run id `).length - 1
    expect(count(first, 'dup-probe')).toBe(1)
    expect(count(first, 'dup-probe-2')).toBe(1)
    expect(count(second, 'dup-probe')).toBe(1)
    expect(count(second, 'dup-probe-2')).toBe(0)
    expect(await agent.slash(first, 'runs')).toMatch(/^- 'dup-probe-2' — complete\n  Agents: 1 done\n/)
    // Controls answer with the reference text.
    expect(await agent.slash(first, 'pause dup-probe')).toBe("Run 'dup-probe' is not active (status: complete).")
    expect(await agent.slash(first, 'stop dup')).toBe("Several runs could be 'stop' — pick one by name:\n  dup-probe (complete)\n  dup-probe-2 (complete)\n(/workflow stop <name>)")
    expect(await agent.slash(first, 'resume nothing')).toBe("No workflow run matches 'nothing'.")
    expect(await agent.slash(first, 'resume dup-probe')).toBe("Run 'dup-probe' cannot be resumed (status: complete). Start a new run instead.")
    expect(await agent.slash(first, 'save dup-probe')).toContain("Could not save workflow 'dup-probe': saving a run as a named workflow is not available in this build")
    expect(await agent.slash(first, 'deep-research look')).toContain("Workflow 'deep-research' unavailable: registered workflow names are not available in this build")
    expect(await agent.slash(first, 'stop')).toBe('No runs to stop.')
  }, 180000)

  it('allows four active runs per session and refuses a fifth; a user stop is reported, a model stop is not', async () => {
    const agent = startAgent({ control: true })
    const sessionId = await open(agent)
    const script = `let meta = #{ name: "slow-probe", description: "d" };\nagent("CHILD_SLOW x").output`
    for (const name of ['slow-probe', 'slow-probe-2', 'slow-probe-3', 'slow-probe-4']) await launch(agent, sessionId, { source: { type: 'script', script } }, name)
    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'script', script } })
    expect(answer(agent)).toContain('PARENT_WORKFLOW error: Error: workflow_launch_failed: session already has the maximum of 4 active workflow runs')
    await waitFor(() => agent.events.filter(event => event.event === 'start').length === 4, 'four running children')
    expect(await agent.slash(sessionId, 'stop slow-probe-3')).toBe('Stopped slow-probe-3.')
    const stopped = runBlock(await completion(agent, 'slow-probe-3', sessionId), 'slow-probe-3')
    expect(stopped).toContain('— status: cancelled')
    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'stop', run_id: 'slow-probe-4' } })
    expect(answer(agent)).toContain("PARENT_WORKFLOW ok: Stopped workflow 'slow-probe-4'; its child agents were cancelled.")
    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'stop', run_id: 'slow-probe-4' } })
    expect(answer(agent)).toContain("PARENT_WORKFLOW error: Error: workflow_control_failed: run 'slow-probe-4' is cancelled and cannot be stopped")
    // A freed slot takes a new launch.
    await launch(agent, sessionId, { source: { type: 'script', script } }, 'slow-probe-5')
    expect(await agent.slash(sessionId, 'stop slow-probe')).toBe('Stopped slow-probe.')
    await workflow(agent, sessionId, { source: { type: 'stop', run_id: 'slow-probe-2' } })
    await workflow(agent, sessionId, { source: { type: 'stop', run_id: 'slow-probe-5' } })
    await waitFor(() => allSettled(agent), 'every child settled')
    await waitFor(() => engines(agent).length === 0, 'every engine exited')
    await completion(agent, 'slow-probe', sessionId)
    await new Promise(resolve => setTimeout(resolve, 800))
    const all = notices(agent, sessionId).join('\n')
    expect(all).not.toContain("- Workflow 'slow-probe-4'")
    expect(all).not.toContain("- Workflow 'slow-probe-2'")
    expect(all).not.toContain("- Workflow 'slow-probe-5'")
  }, 180000)

  it('pauses with its real children stopped, and resumes from the journal: finished children replay, cancelled ones run again', async () => {
    const agent = startAgent({ control: true })
    const sessionId = await open(agent)
    const script = `let meta = #{ name: "pause-probe", description: "d", phases: [#{ title: "first" }, #{ title: "second" }] };
phase("first");
let a = agent("CHILD_SAY finished before the pause", #{ label: "early" });
phase("second");
let b = agent("CHILD_ONCE pause-tag", #{ label: "held" });
[a.output, b.output]`
    await launch(agent, sessionId, { source: { type: 'script', script }, args: { objective: 'pause me' } }, 'pause-probe')
    await waitFor(() => agent.events.some(event => event.event === 'start' && event.label === 'held'), 'the held child')
    expect(await agent.slash(sessionId, 'runs')).toContain("- 'pause-probe' — active\n  Phase: second (2/2)\n  Agents: 1 done, 1 running\n")
    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'pause', run_id: 'pause-probe' } })
    const paused = answer(agent)
    expect(paused).toMatch(/PARENT_WORKFLOW ok: Paused workflow 'pause-probe'; its child agents were cancelled\. It keeps its journal, so it can be continued later with source: \{ type: "resume", resume_from_run_id: "(wf_[0-9a-f]+)" \}\./)
    const runId = /resume_from_run_id: "(wf_[0-9a-f]+)"/.exec(paused)[1]
    // The real child was cancelled and the engine exited.
    await waitFor(() => agent.events.some(event => event.event === 'end' && event.label === 'held' && event.status === 'cancelled'), 'the held child cancelled')
    await waitFor(() => engines(agent).length === 0, 'the engine exited')
    expect(agent.events.filter(event => event.event === 'workflow').at(-1)).toMatchObject({ status: 'user_paused', running: 0 })
    expect(await agent.slash(sessionId, 'runs')).toContain("- 'pause-probe' — user paused\n  Phase: second (2/2)\n  Agents: 1 done\n")
    expect(await agent.slash(sessionId, 'pause pause-probe')).toBe("Run 'pause-probe' is not active (status: user_paused).")
    // Args are fixed at launch.
    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'resume', resume_from_run_id: runId }, args: { objective: 'other' } })
    expect(answer(agent)).toContain('`args` only applies to a launch')
    // A pause is not a completion: nothing was reported.
    expect(notices(agent, sessionId)).toEqual([])

    // Resume by the user with /workflow, from the journal.
    expect(await agent.slash(sessionId, 'resume pause-probe')).toBe('Resumed pause-probe from its journal.')
    const block = runBlock(await completion(agent, 'pause-probe', sessionId), 'pause-probe')
    expect(block).toContain(`- Workflow 'pause-probe' (run id ${runId}) — status: complete`)
    expect(block).toContain('Objective: pause me')
    expect(JSON.parse(resultText(block, 'pause-probe'))).toEqual(['CHILD_SAID finished before the pause', 'CHILD_ONCE_DONE pause-tag'])
    // The finished child replayed (one model turn); the cancelled one ran again.
    const turns = childTurns(agent)
    expect(turns.filter(line => line.user.some(text => text.includes('CHILD_SAY finished before the pause')))).toHaveLength(1)
    expect(turns.filter(line => line.user.some(text => text.includes('CHILD_ONCE pause-tag')))).toHaveLength(2)
    const starts = agent.events.filter(event => event.event === 'start')
    expect(starts.map(event => event.label)).toEqual(['early', 'held', 'held'])
    expect(new Set(starts.map(event => event.id)).size).toBe(3)
    expect(runDir(agent, sessionId, 'pause-probe').state).toMatchObject({ id: runId, status: 'complete', epoch: 2, agentsUsed: 2 })
    expect(await agent.slash(sessionId, 'runs')).toContain("- 'pause-probe' — complete\n  Phase: second (2/2)\n  Agents: 2 done\n")
  }, 180000)

  it('continues a budget stop only under an explicitly raised cap', async () => {
    const agent = startAgent({ control: true })
    const sessionId = await open(agent)
    const script = `let meta = #{ name: "budget-resume", description: "d" };
let a = agent("CHILD_SAY one");
let b = agent("CHILD_SAY two");
[a.output, b.output]`
    const block = await runToEnd(agent, sessionId, { source: { type: 'script', script }, agent_budget: 1 }, 'budget-resume')
    expect(block).toContain('— status: budget_limited')
    expect(block).toContain('Detail: workflow agent budget exceeded: requested 2, maximum 1 — finished work is kept')
    expect(await agent.slash(sessionId, 'resume budget-resume')).toBe('Run \'budget-resume\' exhausted its agent budget (1/1 agents). Resuming keeps all finished work but needs a higher absolute cap — ask the agent to resume it with an agent budget above 1, e.g. "resume budget-resume with an agent budget of 65".')
    expect(await agent.slash(sessionId, 'stop budget-resume')).toBe("Run 'budget-resume' cannot be stopped (status: budget_limited); it has already finished or hit its agent budget.")
    for (const budget of [undefined, 1]) {
      agent.updates.length = 0
      await workflow(agent, sessionId, { source: { type: 'resume', resume_from_run_id: 'budget-resume' }, ...budget ? { agent_budget: budget } : {} })
      expect(answer(agent)).toContain('PARENT_WORKFLOW error: Error: workflow_resume_failed: run is budget-limited at 1 of 1 agents; resume it with an agent_budget above 1')
    }
    expect(engines(agent)).toEqual([])
    agent.updates.length = 0
    await workflow(agent, sessionId, { source: { type: 'resume', resume_from_run_id: 'budget-resume' }, agent_budget: 2 })
    expect(answer(agent)).toContain("PARENT_WORKFLOW ok: Workflow 'budget-resume' started in the background.")
    const done = runBlock(await completion(agent, 'budget-resume', sessionId), 'budget-resume')
    expect(done).toContain('— status: complete')
    expect(JSON.parse(resultText(done, 'budget-resume'))).toEqual(['CHILD_SAID one', 'CHILD_SAID two'])
    expect(childTurns(agent).filter(line => line.user.some(text => text.includes('CHILD_SAY one')))).toHaveLength(1)
    expect(runDir(agent, sessionId, 'budget-resume').state).toMatchObject({ status: 'complete', agentBudget: 2, agentsUsed: 2 })
  }, 180000)

  it('refuses to resume after a dsh restart: an active run is interrupted and a paused one stays paused', async () => {
    const agent = startAgent({ control: true })
    const sessionId = await open(agent)
    const done = `let meta = #{ name: "restart-done", description: "d" };\nagent("CHILD_SAY kept").output`
    const slow = name => `let meta = #{ name: "${name}", description: "d" };\nagent("CHILD_SLOW ${name}").output`
    await runToEnd(agent, sessionId, { source: { type: 'script', script: done } }, 'restart-done')
    await launch(agent, sessionId, { source: { type: 'script', script: slow('restart-paused') } }, 'restart-paused')
    await launch(agent, sessionId, { source: { type: 'script', script: slow('restart-active') } }, 'restart-active')
    await waitFor(() => agent.events.filter(event => event.event === 'start').length === 3, 'two slow children')
    expect(await agent.slash(sessionId, 'pause restart-paused')).toBe('Paused restart-paused. /workflow resume restart-paused to continue.')
    await waitFor(() => runDir(agent, sessionId, 'restart-paused').state.status === 'user_paused', 'the paused run saved')
    // The main process dies without any chance to clean up.
    agent.child.kill('SIGKILL')
    await new Promise(resolve => agent.child.once('exit', resolve))
    expect(runDir(agent, sessionId, 'restart-active').state.status).toBe('active')

    const again = startAgent({ root: agent.root, control: true })
    await again.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-workflow-test', version: '0' } })
    await again.send('session/resume', { sessionId, cwd: again.cwd, mcpServers: [] })
    const overview = await again.slash(sessionId, 'runs')
    expect(overview).toContain("- 'restart-paused' — user paused\n")
    expect(overview).toContain("- 'restart-active' — interrupted\n")
    expect(overview).toContain("- 'restart-done' — complete\n")
    expect(overview.indexOf("'restart-paused'")).toBeLessThan(overview.indexOf("'restart-active'"))
    expect(runDir(again, sessionId, 'restart-active').state).toMatchObject({ status: 'interrupted', pauseMessage: 'the session ended while this workflow was active; start a new run' })
    const refusal = 'it was started by an earlier codsh process, and workflow runs resume only in the process that started them (process restarts are terminal)'
    expect(await again.slash(sessionId, 'resume restart-paused')).toBe(`Run 'restart-paused' cannot be resumed (status: user_paused): ${refusal}. Start a new run instead.`)
    expect(await again.slash(sessionId, 'resume restart-active')).toBe(`Run 'restart-active' cannot be resumed (status: interrupted): ${refusal}. Start a new run instead.`)
    const { state } = runDir(again, sessionId, 'restart-paused')
    await workflow(again, sessionId, { source: { type: 'resume', resume_from_run_id: state.id }, agent_budget: 5 })
    expect(answer(again)).toContain(`PARENT_WORKFLOW error: Error: workflow_resume_failed: run is not resumable (status: user_paused): ${refusal}; start a new run`)
    expect(engines(again)).toEqual([])
    // Nothing from the earlier process is reported again.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(notices(again, sessionId)).toEqual([])
    // New launches take fresh display names beside the restored ones.
    await launch(again, sessionId, { source: { type: 'script', script: done } }, 'restart-done-2')
    await completion(again, 'restart-done-2', sessionId)
  }, 180000)

  it('a plain prompt (CODSH_WORKFLOW_FOREGROUND=1) waits for its run, sends no notice, and a cancelled turn stops the run', async () => {
    const agent = startAgent({ env: { CODSH_WORKFLOW_FOREGROUND: '1' } })
    const sessionId = await open(agent)
    const script = `let meta = #{ name: "plain-run", description: "a plain prompt waits" };\nagent("CHILD_SAY plain").output`
    await workflow(agent, sessionId, { source: { type: 'script', script } })
    const text = answer(agent)
    expect(text).toContain("PARENT_WORKFLOW ok: Workflow 'plain-run' ended; a plain prompt waits for its workflow runs.")
    expect(text).toMatch(/- Workflow 'plain-run' \(run id wf_[0-9a-f]{32}\) — status: complete\n  Objective: a plain prompt waits\n  Elapsed: \d+s\n  Result:\n    CHILD_SAID plain\n/)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(notices(agent, sessionId)).toEqual([])
    expect(runDir(agent, sessionId, 'plain-run').state).toMatchObject({ status: 'complete', reportedEpoch: 1 })
    // Cancelling the waiting turn stops the run and its child.
    agent.updates.length = 0
    const slow = `let meta = #{ name: "plain-slow", description: "d" };\nagent("CHILD_SLOW plain").output`
    const turn = workflow(agent, sessionId, { source: { type: 'script', script: slow } })
    const child = await waitFor(() => agent.events.find(event => event.event === 'start' && event.workflow === 'plain-slow'), 'the slow child')
    agent.notify('session/cancel', { sessionId })
    const stopped = await turn
    expect(stopped.stopReason).toBe('cancelled')
    await waitFor(() => runDir(agent, sessionId, 'plain-slow').state.status === 'cancelled', 'the stopped run saved')
    await waitFor(() => agent.events.some(event => event.event === 'end' && event.id === child.id && event.status === 'cancelled'), 'the child cancelled')
    await waitFor(() => engines(agent).length === 0, 'no engine left')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(notices(agent, sessionId)).toEqual([])
  }, 120000)
})
