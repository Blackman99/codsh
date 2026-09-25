/**
 * The model-facing `workflow` tool for the Rust client (ticket 181).
 *
 * Ticket 182 adds the reference `output_schema` contract (one correction
 * turn in the same child), scratch files, `git_diff_since`, and a configurable
 * live-child cap per run ([subagents] workflow_max_concurrent or
 * GROK_WORKFLOW_MAX_CONCURRENT_AGENTS, default 32, clamped to
 * max(2, available parallelism)) that is independent of the agent budget.
 *
 * Ticket 183 makes a run a background run of its session, as in the
 * reference: the tool call returns once the engine has started the script,
 * the run gets a session-unique display name (name, name-2, ...), and the
 * reference tracker statuses (active, user_paused, budget_limited, complete,
 * failed, cancelled, interrupted, ...) drive `/workflow runs` and
 * `/workflow pause|resume|stop <name>` (through the control channel) and
 * the tool's own `pause`, `stop` and `resume` sources. Each run keeps its
 * immutable script and args and the engine's journal under
 * `<session dir>/workflows/<run id>/`; resume replays the journaled agent
 * calls and runs again the ones that were cancelled or unfinished, so their
 * side effects may repeat (nothing here is exactly-once). Resume works only
 * in the dsh process that started the run: a later process restores the
 * runs for the overview, marks an active one interrupted, and refuses to
 * resume any of them. When a run ends or hits its agent budget, the
 * session's agent gets one completion message per run launch (a wake turn
 * when idle, the next turn when busy); the rust-acp-background plugin puts
 * it back if a cancel discards it. A plain `-p` prompt ends with its turn,
 * so there (CODSH_WORKFLOW_FOREGROUND=1) the tool call waits for the run and
 * returns its block instead, and cancelling the turn stops the run.
 *
 * Ticket 184 adds saved workflows: the `name` source and `/workflow <name>
 * [--agent-budget N] [--effort LEVEL] [args]` (or `/<name>` from the client)
 * launch a `<meta.name>.rhai` file of the trusted project's `.grok/workflows`
 * or of `$GROK_HOME/workflows` (the engine's `catalog` op scans them, the
 * project scope wins, nothing is run while scanning), `/workflow save <name>`
 * writes a run's immutable script into the project catalog without replacing
 * a file, and each turn of a top-level agent sees the catalog listing when it
 * changed. A run copies the script it resolved at launch, so an edit of the
 * file reaches only later launches and resume keeps the stored copy.
 *
 * A workflow is a Rhai script in the reference format: its first statement is
 * `let meta = #{ name, description, ... }`, the tool call's `args` are bound
 * to the script's `args`, and `agent(prompt, opts)` / `parallel([...])` start
 * real dsh subagents and return their results. The script runs in the Rust
 * executable (`codsh-rust __workflow-engine`, the vendored reference engine);
 * this module is the host side: it resolves nothing itself, starts the
 * engine, and turns each `spawn_agent` request into a dsh child through the
 * subagents plugin, so workflow children get the same types, capability
 * allow-lists, model preflight, worktree isolation, board and /tasks cancel
 * as the `subagent` tool.
 *
 * Differences from the reference that this build states instead of hiding:
 * - There are no built-in workflows in the catalog. Project and personal
 *   files come first; active plugins add theirs as `<plugin>:<name>` (and the
 *   bare name when nothing else owns it), which the reference registry has
 *   no scope for. A run started from a plugin keeps its origin (plugin,
 *   version, commit) with its script copy; resuming it needs the plugin to
 *   be active again but still replays the copy taken at launch.
 * - `resume_from` is refused by the engine with an explicit error: dsh
 *   children are disposed when their call ends, so there is no finished
 *   child session to resume from a later agent() call.
 * - There is no editable script projection per launch.
 *
 * The engine is a separate process with Rhai operation and size limits. It
 * is not a security sandbox.
 */
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { planFilePath } from './rust-acp-plan.mjs'
import {
  MAX_ACTIVE_RUNS,
  MAX_AGENT_ROWS,
  RESTART_REFUSAL,
  RunStore,
  WAKE_PROMPT,
  accepts,
  elapsedMs,
  formatOverview,
  formatReminder,
  formatRunBlock,
  isReportable,
  isResumable,
  matchRuns,
  needsName,
  newRunId,
  parseCommand,
  parseNamedArgs,
  pauseStatus,
  uniqueName,
} from './rust-acp-workflow-runs.mjs'

export const WORKFLOW_TOOL = 'workflow'
export const ENGINE_SUBCOMMAND = '__workflow-engine'
export const DEFAULT_AGENT_BUDGET = 128
export const MAX_AGENT_BUDGET = 1024
/** Reference default live-child cap per run, clamped to the machine. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 32
/** How long cancelled children may take to settle (reference drain timeout). */
export const CHILD_DRAIN_MS = 20000
/** How long the engine may take to report a cancelled outcome before it is killed. */
export const ENGINE_CANCEL_GRACE_MS = 5000
/** Largest child output handed back to the script (Rhai strings stop at 16 MiB). */
export const MAX_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_RESULT_CHARS = 16 * 1024
const MAX_LOG_LINES = 20

export const DEPTH_MESSAGE = 'Workflows can only be launched from a top-level session (subagents and workflow-spawned agents cannot start workflows)'

export class WorkflowToolError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`)
    this.code = code
    this.detail = detail
  }
}

/**
 * Reference `workflow_max_concurrent_agents`: the configured cap (default 32,
 * at least 1) clamped to max(2, available parallelism).
 */
export function concurrencyCap(parallelism = safeParallelism(), configured = DEFAULT_MAX_CONCURRENT_AGENTS) {
  const clamp = Math.max(2, Number.isSafeInteger(parallelism) ? parallelism : DEFAULT_MAX_CONCURRENT_AGENTS)
  const requested = Math.max(1, Number.isSafeInteger(configured) ? configured : DEFAULT_MAX_CONCURRENT_AGENTS)
  return Math.min(requested, clamp)
}

/** This run's scratch directory beside the session's plan.md (reference layout). */
export function scratchDir(sessionId, runId, env = process.env, cwd = process.cwd()) {
  if (!sessionId) return null
  const safeRun = String(runId).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_') || 'run'
  return join(dirname(planFilePath(sessionId, env, cwd)), 'workflows', safeRun, 'scratch')
}

function safeParallelism() {
  try {
    return availableParallelism()
  } catch {
    return DEFAULT_MAX_CONCURRENT_AGENTS
  }
}

const nonblank = value => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

/**
 * The reference input contract: a tagged `source` or one legacy flat field,
 * then the reference `validate()` checks. Returns { source, agentBudget,
 * args, validateOnly }; throws WorkflowToolError('workflow_invalid_input').
 */
export function normalizeInput(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const invalid = detail => new WorkflowToolError('workflow_invalid_input', detail)
  const legacy = {
    name: nonblank(input.name),
    script: nonblank(input.script),
    script_path: nonblank(input.script_path),
    resume_from_run_id: nonblank(input.resume_from_run_id),
  }
  const legacyCount = Object.values(legacy).filter(value => value !== undefined).length
  const hasSource = input.source !== undefined && input.source !== null
  if (hasSource && legacyCount !== 0) {
    throw invalid('`source` cannot be combined with legacy `name`, `script`, `script_path`, or `resume_from_run_id` fields')
  }
  if (legacyCount > 1) {
    throw invalid('workflow source fields are mutually exclusive; provide exactly one of `name`, `script`, `script_path`, or `resume_from_run_id`')
  }
  let source
  if (hasSource) {
    const tagged = input.source
    const shapes = {
      name: ['name'],
      script: ['script'],
      script_path: ['script_path'],
      resume: ['resume_from_run_id'],
      pause: ['run_id'],
      stop: ['run_id'],
    }
    const fields = typeof tagged === 'object' && !Array.isArray(tagged) ? shapes[tagged.type] : undefined
    if (!fields) {
      throw invalid('`source.type` must be one of `name`, `script`, `script_path`, `resume`, `pause`, or `stop`')
    }
    const unknown = Object.keys(tagged).filter(key => key !== 'type' && !fields.includes(key))
    if (unknown.length > 0) throw invalid(`unknown field \`${unknown[0]}\` in \`source\` of type \`${tagged.type}\``)
    const value = tagged[fields[0]]
    if (typeof value !== 'string') throw invalid(`\`source\` of type \`${tagged.type}\` needs a string \`${fields[0]}\``)
    source = { type: tagged.type, value }
  } else if (legacy.name !== undefined) source = { type: 'name', value: legacy.name }
  else if (legacy.script !== undefined) source = { type: 'script', value: legacy.script }
  else if (legacy.script_path !== undefined) source = { type: 'script_path', value: legacy.script_path }
  else if (legacy.resume_from_run_id !== undefined) source = { type: 'resume', value: legacy.resume_from_run_id }
  else {
    throw invalid('missing workflow source; provide `source` with exactly one of the `name`, `script`, `script_path`, `resume`, `pause`, or `stop` variants')
  }
  // normalize(): trim names, paths and run ids; a blank script becomes empty.
  if (source.type === 'script') source.value = source.value.trim() === '' ? '' : source.value
  else source.value = source.value.trim()

  let agentBudget
  if (input.agent_budget !== undefined && input.agent_budget !== null) {
    const budget = input.agent_budget
    if (!Number.isSafeInteger(budget) || budget <= 0) throw invalid('`agent_budget` must be a positive integer')
    if (budget > MAX_AGENT_BUDGET) throw invalid(`\`agent_budget\` must be at most ${MAX_AGENT_BUDGET} agents`)
    agentBudget = budget
  }
  const validateOnly = input.validate_only === true
  const args = input.args === undefined ? undefined : input.args
  if (source.type === 'resume' || source.type === 'pause' || source.type === 'stop') {
    if (args !== undefined && args !== null) throw invalid('`args` only applies to a launch; resume, pause, and stop act on an existing run')
    if (validateOnly) throw invalid('`validate_only` cannot be used when resuming, pausing, or stopping a run')
    if (agentBudget !== undefined && source.type !== 'resume') throw invalid('`agent_budget` only applies to a launch or resume; pause and stop take no options')
  }
  if (source.value.trim() === '') throw invalid('workflow source value must not be blank')
  return { source, agentBudget, args: args ?? null, validateOnly }
}

/** The engine's `source` for a launch or validate of a tool/slash source. */
export function engineSource(source) {
  if (source.type === 'script') return { type: 'script', script: source.value }
  if (source.type === 'name') return { type: 'name', name: source.value }
  return { type: 'script_path', script_path: source.value }
}

/** Reference `summarize_result`: the text a finished run reports. */
export function summarizeResult(result) {
  let text
  if (typeof result === 'string') text = result
  else if (result === null || result === undefined) text = 'done'
  else if (typeof result === 'object' && !Array.isArray(result) && typeof result.report === 'string') {
    text = typeof result.path === 'string' ? `${result.report}\n\n_Full report: ${result.path}_` : result.report
  } else text = JSON.stringify(result)
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text
}

function clipOutput(text) {
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_CHILD_OUTPUT_BYTES) return text
  const clipped = Buffer.from(text).subarray(0, MAX_CHILD_OUTPUT_BYTES).toString('utf8').replace(/\uFFFD$/, '')
  return `${clipped}\n… [truncated: the child output exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes]`
}

function engineEnv() {
  const env = {}
  // PATH and the home directory are for git_diff_since's `git diff`.
  for (const key of ['SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

/**
 * Run the engine for one call. `onRequest(request)` resolves to
 * { ok: AgentResult } or { error: { kind, message } }; `onEvent(line)` sees
 * started/phase/log lines. Resolves with the final line (outcome, validated
 * or rejected). Cancelling `signal` asks the engine to cancel, then kills it
 * after the grace period.
 */
export function runEngine({ enginePath, start, onRequest, onEvent = () => {}, signal }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(enginePath, [ENGINE_SUBCOMMAND], { stdio: ['pipe', 'pipe', 'pipe'], env: engineEnv(), windowsHide: true })
    } catch (cause) {
      reject(new WorkflowToolError('workflow_not_available', `the workflow engine could not start: ${cause instanceof Error ? cause.message : cause}`))
      return
    }
    let final
    let stderr = ''
    let killTimer
    let settled = false
    const write = value => {
      if (child.stdin.writable) {
        try {
          child.stdin.write(`${JSON.stringify(value)}\n`)
        } catch {}
      }
    }
    const onAbort = () => {
      write({ type: 'cancel' })
      killTimer = setTimeout(() => child.kill('SIGKILL'), ENGINE_CANCEL_GRACE_MS)
      killTimer.unref?.()
    }
    child.stdin.on('error', () => {})
    child.stderr.on('data', chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })
    child.on('error', cause => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(new WorkflowToolError('workflow_not_available', `the workflow engine could not start (${enginePath}): ${cause.message}`))
    })
    createInterface({ input: child.stdout }).on('line', line => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.type === 'request') {
        Promise.resolve()
          .then(() => onRequest(message))
          .then(
            reply => write({ type: 'reply', id: message.id, ...reply }),
            cause => write({ type: 'reply', id: message.id, error: { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) } }),
          )
        return
      }
      if (message.type === 'outcome' || message.type === 'validated' || message.type === 'rejected' || message.type === 'catalog' || message.type === 'saved') {
        final = message
        return
      }
      onEvent(message)
    })
    child.on('close', (code, sig) => {
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      if (settled) return
      settled = true
      if (final) {
        resolve(final)
        return
      }
      if (signal?.aborted) {
        resolve({ type: 'outcome', outcome: 'cancelled', killed: true })
        return
      }
      const tail = stderr.trim().split('\n').slice(-5).join('\n')
      reject(new WorkflowToolError('workflow_engine_failed', `the workflow engine exited without an outcome (${sig ? `signal ${sig}` : `code ${code}`})${tail ? `: ${tail}` : ''}`))
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    write(start)
  })
}

const BACKGROUND_SENTENCE = 'The call returns immediately; progress appears in /workflow runs and completion is reported automatically — do not poll or sleep-wait.'
const FOREGROUND_SENTENCE = 'This is a plain prompt that ends with its turn, so the call waits for the run and returns its result.'
const DESCRIPTION = `Launch or control a workflow: a Rhai script that orchestrates subagents as one background run. Provide exactly one \`source\`: the \`name\` of a saved workflow (the available ones are listed in a system reminder; a trusted project's .grok/workflows shadows $GROK_HOME/workflows), an inline \`script\`, a \`script_path\` (a .rhai file named after its meta.name, inside this project or $GROK_HOME/workflows), a same-process \`resume\`, or a \`pause\` / \`stop\` of a run this session launched (by \`run_id\` or display name). Optionally pass \`args\` (bound to the script's \`args\`) and \`agent_budget\`, an absolute cap on cumulative child-agent calls: every agent() and parallel() item consumes one slot (schema retries do not); default 128, at most 1024. The host also caps live children per run (32 by default, configurable, clamped to the machine); this cap is separate from the budget — larger parallel() panels are queued in order and still act as a barrier. A session runs at most 4 workflows at once. The call returns immediately; progress appears in /workflow runs and completion is reported automatically — do not poll or sleep-wait. A run keeps the script it resolved at launch. \`validate_only: true\` runs a path-specific smoke check (metadata, compile, one canned-host path) without starting agents.

A started run gets a session-unique display name (e.g. \`review-changes\`, \`review-changes-2\`) — the handle to show the user, who manages runs with \`/workflow pause|resume|stop <name>\`; keep run IDs internal. To stop or pause a run yourself, call this tool with \`source: { type: "stop", run_id }\` or \`{ type: "pause", run_id }\` (run id or display name); both cancel the run's child agents and keep its journal, so either can be continued later with \`resume\`. Pause only applies to an active run; stop applies to any run that has not finished or hit its agent budget (a budget-limited run is already stopped and needs \`resume\` with a higher \`agent_budget\`). Use the \`resume\` source (\`resume_from_run_id\`: run id or display name) only for a paused, stopped, failed or budget-limited run of this dsh process (process restarts are terminal); it reuses the run's original immutable script and args, replays finished agent calls from the run's journal, and runs again the calls that were cancelled or unfinished — their side effects may repeat. A budget-limited run resumes only with a higher \`agent_budget\`.

Script format: the first statement must be a pure-literal \`let meta = #{ name: "kebab-name", description: "..." };\` (optional when_to_use and phases: [#{ title, detail }]). Host functions:
- agent(prompt) / agent(prompt, #{ label, phase, model, effort, agent_type, capability_mode, isolation_worktree, output_schema }) runs one subagent to completion and returns #{ agent_id, success, output, cancelled, tokens_used, duration_ms }; output is the child's final text (or its error when success is false). effort is one of none, minimal, low, medium, high, xhigh, max and must be offered by the model; capability_mode (read-only, read-write, execute, all) can only narrow the agent type. With output_schema (a self-contained JSON Schema map) the child is asked to end with a \`\`\`json block; output is the parsed value, and a reply that does not match gets one correction turn in the same child before success becomes false with "structured output validation failed: ...". resume_from is not available in this build.
- parallel([#{ prompt, ...same options }, ...]) runs a panel concurrently and returns results in order; a failed child is a result with success false, and a child the host refuses becomes ().
- phase(title), log(message), budget() -> #{ total, spent, reserved, remaining }, complete(value), pause(kind, message), json_encode(value), fingerprint(text).
- write_scratch_file(name, text) -> "scratch/<name>" and read_scratch_file(name) keep run-local notes (one plain file name, at most 10 MiB each, 64 files, 64 MiB); git_diff_since(commit_hash) returns \`git diff <hash>\` in the session directory (20 s, 256 KiB).
The last expression (or complete(value)) is the result. There is no other filesystem, network, clock or process access in the script; agents do the work. Children cannot start workflows.`

export const REGISTRY = Symbol.for('codsh.rust.workflow')
export const NOTICE_PLUGIN = 'rust-acp-workflow'
const INTERRUPTED = 'the session ended while this workflow was active; start a new run'
const ACTIVE_LIMIT = `session already has the maximum of ${MAX_ACTIVE_RUNS} active workflow runs`

const LAUNCH_REMINDER_CAP = 256
const squashText = text => String(text ?? '').split(/\s+/).filter(Boolean).join(' ')
function truncateBytes(text, cap) {
  const bytes = Buffer.from(text)
  if (bytes.length <= cap) return text
  return bytes.subarray(0, cap).toString('utf8').replace(/\uFFFD$/, '')
}

const started = name => `Workflow '${name}' started in the background. Progress appears in /workflow runs and completion is reported automatically. '${name}' is the session-unique display handle for user-facing status and /workflow management; keep the structured run id internal.`

/**
 * Background runs per session (ticket 183). `deps`:
 *   spawnChild(spec), emit(event), maxConcurrent, isChildAgent(agent),
 *   enginePath() (the engine binary or undefined), env, later(fn, ms).
 */
export function createWorkflowRuns(deps) {
  const { spawnChild, emit = () => {} } = deps
  const env = deps.env ?? process.env
  const later = deps.later ?? ((fn, ms) => setTimeout(fn, ms))
  /** sessionId -> { id, cwd, agent, store, runs: Map<runId, run>, launching, pending } */
  const sessions = new Map()

  const sessionIdOf = agent => agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
  const list = session => [...session.runs.values()]
  const activeCount = session => list(session).filter(run => run.status === 'active').length + session.launching

  function persist(session, run) {
    try {
      session.store.save(run)
    } catch (cause) {
      process.stderr.write(`rust-acp-workflow: could not save run ${run.id}: ${cause instanceof Error ? cause.message : cause}\n`)
    }
  }

  function announce(session, run) {
    const count = state => run.agents.filter(agent => agent.state === state).length
    emit({
      event: 'workflow',
      id: run.id,
      call: run.call ?? '',
      session: session.id,
      name: run.name,
      status: run.status,
      phase: run.currentPhase ?? '',
      agents: run.agents.length,
      running: count('running'),
      done: count('done'),
      failed: count('failed'),
      limit: run.live?.slots.limit ?? 0,
      peak: run.peak ?? 0,
      elapsedMs: elapsedMs(run),
      budget: run.agentBudget,
      used: run.agentsUsed,
    })
  }

  const touch = (session, run, save = true) => {
    run.revision = (run.revision ?? 0) + 1
    if (save) persist(session, run)
    announce(session, run)
  }

  /** Leave the active state: bank elapsed time, cancel rows still running. */
  function settle(run) {
    if (run.activeSince) {
      run.elapsedFloor = (run.elapsedFloor ?? 0) + Math.max(0, Date.now() - run.activeSince)
      run.activeSince = null
    }
    for (const row of run.agents) if (row.state === 'running') row.state = 'cancelled'
  }

  function sessionFor(agent) {
    const id = sessionIdOf(agent)
    if (!id) throw new Error('workflow runs need a dsh session id')
    let session = sessions.get(id)
    if (!session) {
      const cwd = agent?.session?.header?.cwd ?? process.cwd()
      session = { id, cwd, agent: undefined, store: new RunStore(dirname(planFilePath(id, env, cwd))), runs: new Map(), launching: 0, pending: [] }
      sessions.set(id, session)
      restore(session)
    }
    if (agent && !deps.isChildAgent?.(agent)) session.agent = agent
    return session
  }

  /**
   * Runs a previous dsh process recorded for this session. An active one
   * ended with that process (interrupted); none of them can be resumed here.
   */
  function restore(session) {
    for (const run of session.store.list()) {
      if (session.runs.has(run.id)) continue
      run.restored = true
      run.agents = Array.isArray(run.agents) ? run.agents : []
      if (run.status === 'active') {
        settle(run)
        run.status = 'interrupted'
        run.pauseMessage = INTERRUPTED
        run.reportedEpoch = run.epoch
        persist(session, run)
      } else {
        for (const row of run.agents) if (row.state === 'running') row.state = 'cancelled'
      }
      session.runs.set(run.id, run)
      // A run that ended (not with its process) before its notice went out.
      if (isReportable(run.status) && run.status !== 'interrupted' && run.reportedEpoch !== run.epoch) queueNotice(session, run)
    }
  }

  function queueNotice(session, run) {
    if (!isReportable(run.status) || run.reportedEpoch === run.epoch) return
    run.reportedEpoch = run.epoch
    persist(session, run)
    session.pending.push(run)
    later(() => deliver(session), 0)
  }

  /** scratch/report.md of a run, when the script wrote one. */
  const reportPathIn = session => run => {
    const path = join(session.store.dir(run.id), 'scratch', 'report.md')
    try {
      return statSync(path).isFile() ? path : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Plain `-p` (CODSH_WORKFLOW_FOREGROUND): the tool call waits for the run
   * and returns its block, so no completion notice follows; cancelling the
   * turn stops the run.
   */
  async function waitForeground(session, run, signal) {
    const live = run.live
    if (live) {
      run.reportedEpoch = run.epoch
      const onAbort = () => {
        if (run.live === live && accepts(run.status, 'stop')) control(session, run.id, 'stop', { byModel: true })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await live.done
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }
    return `Workflow '${run.name}' ended; a plain prompt waits for its workflow runs.\n${formatRunBlock(run, { reportPath: reportPathIn(session) })}`
  }

  /** One completion message for the runs that stopped, to this session's agent. */
  function deliver(session) {
    const agent = session.agent
    if (!agent || session.pending.length === 0) return
    const runs = session.pending.splice(0)
    const reminder = formatReminder(runs, { reportPath: reportPathIn(session) })
    const summary = runs.map(run => `workflow ${run.name} [${run.status.replaceAll('_', ' ')}]`).join(', ')
    const message = createUserMessage({
      content: [{ type: 'text', text: `<system-reminder>\n${reminder}</system-reminder>` }, { type: 'text', text: WAKE_PROMPT }],
      source: { kind: 'plugin', plugin: NOTICE_PLUGIN, form: 'notice', summary },
    })
    try {
      // A follow-up wakes an idle agent, and on a busy one opens its own
      // turn right after the running turn instead of splicing into it.
      agent.followup(message)
    } catch (cause) {
      // A disposed agent: keep the runs for the session's next agent.
      session.pending.unshift(...runs)
      process.stderr.write(`rust-acp-workflow: completion notice not delivered: ${cause instanceof Error ? cause.message : cause}\n`)
    }
  }

  function find(session, key) {
    return session.runs.get(key) ?? list(session).find(run => run.name === key)
  }

  /**
   * Start the engine for a new run or a resume. Resolves with the engine's
   * first line (`started`, or the `rejected` final line); the run goes on
   * in the background after `started`.
   */
  function startEngine(session, run, start, parent, { resume, objective: launchObjective }) {
    const enginePath = deps.enginePath()
    const controller = new AbortController()
    const live = {
      controller,
      intent: undefined,
      slots: new RunSlots(concurrencyCap(undefined, deps.maxConcurrent)),
      children: new Set(),
      open: new Map(),
      running: 0,
      epoch: run.epoch,
    }
    run.live = live
    let resolveFirst
    const first = new Promise(resolve => { resolveFirst = resolve })
    let begun = false
    const track = promise => {
      live.children.add(promise)
      promise.finally(() => live.children.delete(promise)).catch(() => {})
      return promise
    }
    const releaseSlot = () => {
      live.running -= 1
      live.slots.release()
    }
    const result = (outcome, seq, startedAt) => ({
      agent_id: outcome.childId ?? `${run.id}:agent-${seq}`,
      success: outcome.status === 'completed',
      output: clipOutput(outcome.text ?? ''),
      cancelled: outcome.status === 'cancelled',
      tokens_used: 0,
      duration_ms: Date.now() - startedAt,
    })
    const finishRow = (row, status, startedAt, childId) => {
      if (!row || row.state !== 'running') return
      row.state = status === 'completed' ? 'done' : status === 'cancelled' ? 'cancelled' : 'failed'
      row.duration_ms = Date.now() - startedAt
      if (childId) row.agent_id = childId
      if (run.live === live) touch(session, run)
    }
    const spawnOne = async (request, signal) => {
      const opts = request.opts ?? {}
      run.seq = (run.seq ?? 0) + 1
      const seq = run.seq
      try {
        await live.slots.acquire(signal)
      } catch {
        return { error: { kind: 'cancelled' } }
      }
      const startedAt = Date.now()
      live.running += 1
      run.peak = Math.max(run.peak ?? 0, live.running)
      const id = `${run.id}:agent-${seq}`
      const row = { agent_id: id, label: opts.label ?? `${run.name || 'workflow'} #${seq}`, phase: opts.phase ?? run.currentPhase ?? null, model: opts.model ?? null, state: 'running', duration_ms: 0 }
      run.agents.push(row)
      while (run.agents.length > MAX_AGENT_ROWS) {
        const index = run.agents.findIndex(entry => entry.state !== 'running')
        run.agents.splice(index >= 0 ? index : 0, 1)
      }
      touch(session, run)
      let held
      try {
        const outcome = await spawnChild({
          parent,
          id,
          prompt: String(opts.prompt ?? ''),
          label: row.label,
          typeName: opts.agentType ?? undefined,
          model: opts.model ?? undefined,
          // A launch effort (`--effort`) is the default; the agent's own wins.
          effort: opts.effort ?? run.effort ?? undefined,
          capability: opts.capabilityMode ?? undefined,
          isolation: opts.isolationWorktree === true ? 'worktree' : null,
          keepOpen: opts.contract === true,
          signal,
          workflow: { run: run.id, name: run.name, phase: opts.phase ?? run.currentPhase ?? '' },
        })
        if (signal.aborted) {
          if (outcome.session) track(outcome.session.close({ status: 'cancelled' }))
          finishRow(row, 'cancelled', startedAt, outcome.childId)
          return { error: { kind: 'cancelled' } }
        }
        if (outcome.session) {
          held = {
            seq,
            session: outcome.session,
            close: verdict => outcome.session.close(verdict).then(status => {
              finishRow(row, status, startedAt, outcome.childId)
              return status
            }).finally(releaseSlot),
          }
          live.open.set(request.id, held)
          return { ok: result(outcome, seq, startedAt), open: true }
        }
        finishRow(row, outcome.status, startedAt, outcome.childId)
        return { ok: result(outcome, seq, startedAt) }
      } catch (cause) {
        finishRow(row, signal.aborted ? 'cancelled' : 'failed', startedAt)
        if (signal.aborted) return { error: { kind: 'cancelled' } }
        return { error: { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) } }
      } finally {
        if (!held) releaseSlot()
      }
    }
    const resumeHeld = async (request, signal) => {
      const held = live.open.get(request.agent)
      if (!held) return { error: { kind: 'failed', message: 'the workflow child to resume is no longer open' } }
      const startedAt = Date.now()
      try {
        const outcome = await held.session.resume(String(request.prompt ?? ''), signal)
        if (signal.aborted) {
          live.open.delete(request.agent)
          track(held.close({ status: 'cancelled' }))
          return { error: { kind: 'cancelled' } }
        }
        if (outcome.status === 'completed') return { ok: result({ ...outcome, childId: held.session.childId }, held.seq, startedAt), open: true }
        live.open.delete(request.agent)
        track(held.close({ status: outcome.status }))
        return { ok: result({ ...outcome, childId: held.session.childId }, held.seq, startedAt) }
      } catch (cause) {
        live.open.delete(request.agent)
        track(held.close({ status: 'failed', detail: cause instanceof Error ? cause.message : String(cause) }))
        if (signal.aborted) return { error: { kind: 'cancelled' } }
        return { error: { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) } }
      }
    }
    const engine = runEngine({
      enginePath,
      start,
      signal: controller.signal,
      onEvent: line => {
        if (line.type === 'started') {
          begun = true
          if (!resume) {
            const definition = String(line.meta?.name ?? 'workflow')
            run.definition = definition
            run.name = uniqueName(definition, list(session).map(other => other.name))
            run.phases = Array.isArray(line.meta?.phases) ? line.meta.phases.map(phase => ({ title: String(phase.title ?? ''), detail: phase.detail ?? null })) : []
            const objective = start.args && typeof start.args === 'object' && typeof start.args.objective === 'string' ? start.args.objective : undefined
            run.objective = launchObjective ?? objective ?? String(line.meta?.description ?? '')
            try {
              run.origin = line.origin && typeof line.origin === 'object' ? line.origin : null
              session.store.writeLaunch(run.id, { script: String(line.script ?? ''), args: start.args, definition, scriptPath: line.path ?? null, effort: run.effort ?? null, origin: run.origin })
            } catch (cause) {
              process.stderr.write(`rust-acp-workflow: could not save the script of run ${run.id}; it cannot be resumed: ${cause instanceof Error ? cause.message : cause}\n`)
            }
            session.runs.set(run.id, run)
          }
          run.status = 'active'
          run.activeSince = Date.now()
          run.pauseMessage = null
          run.resultSummary = null
          run.agentBudget = line.agentBudget
          run.agentsUsed = line.agentsUsed ?? 0
          touch(session, run)
          resolveFirst(line)
        } else if (line.type === 'phase') {
          run.currentPhase = String(line.title)
          touch(session, run)
        } else if (line.type === 'close') {
          const held = live.open.get(line.agent)
          if (held) {
            live.open.delete(line.agent)
            track(held.close({ status: line.status, detail: line.detail }))
          }
        }
      },
      onRequest: async request => {
        const signal = controller.signal
        if (signal.aborted) return { error: { kind: 'cancelled' } }
        if (request.kind === 'resume_agent') return track(resumeHeld(request, signal))
        if (request.kind !== 'spawn_agent') return { error: { kind: 'unsupported', message: `unknown host request ${request.kind}` } }
        if (request.kind === 'spawn_agent') run.agentsUsed = (run.agentsUsed ?? 0) + 1
        return track(spawnOne(request, signal))
      },
    })
    live.done = engine.then(final => ({ final }), error => ({ error })).then(async settled => {
      // Contract children the engine never closed are closed now, and a
      // stopped run's children are cancelled and drained (bounded).
      for (const [id, held] of live.open) {
        live.open.delete(id)
        track(held.close({ status: controller.signal.aborted ? 'cancelled' : 'failed', detail: 'the workflow run ended' }))
      }
      if (live.children.size > 0) {
        controller.abort(new Error('workflow run ended'))
        await Promise.race([
          Promise.allSettled([...live.children]),
          new Promise(resolve => later(resolve, CHILD_DRAIN_MS)?.unref?.()),
        ])
      }
      if (!begun) {
        if (run.live === live) run.live = undefined
        resolveFirst(settled.final ?? { type: 'rejected', code: settled.error?.code ?? 'workflow_engine_failed', error: settled.error?.detail ?? String(settled.error?.message ?? settled.error) })
        return
      }
      if (run.live !== live) return
      run.live = undefined
      conclude(session, run, live, settled)
    })
    return first
  }

  /** Apply an engine's end to its run (reference watcher mapping). */
  function conclude(session, run, live, { final, error }) {
    if (typeof final?.agentsUsed === 'number') run.agentsUsed = final.agentsUsed
    if (live.intent === 'pause') {
      run.status = 'user_paused'
    } else if (live.intent === 'stop') {
      run.status = 'cancelled'
    } else if (live.intent === 'dispose') {
      run.status = 'interrupted'
      run.pauseMessage = INTERRUPTED
    } else if (error) {
      run.status = 'failed'
      run.pauseMessage = error instanceof Error ? error.message : String(error)
    } else {
      switch (final.outcome) {
        case 'completed':
          run.status = 'complete'
          run.resultSummary = summarizeResult(final.result)
          break
        case 'paused':
          run.status = pauseStatus(final.kind)
          run.pauseMessage = String(final.message ?? '')
          break
        case 'budget_exceeded':
          run.status = 'budget_limited'
          run.pauseMessage = `${final.message} — finished work is kept; resume the run with a higher absolute agent budget to continue`
          break
        case 'cancelled':
          run.status = 'cancelled'
          break
        default:
          run.status = 'failed'
          run.pauseMessage = String(final.error ?? 'unknown error')
      }
    }
    settle(run)
    touch(session, run)
    queueNotice(session, run)
  }

  const controlError = detail => new WorkflowToolError('workflow_control_failed', detail)

  /** Pause or stop. `byModel` runs are not reported back to the model. */
  function control(session, key, op, { byModel }) {
    const run = find(session, key)
    if (!run) throw controlError(`no workflow run in this session matches '${key}'`)
    if (!accepts(run.status, op)) throw controlError(`run '${run.name}' is ${run.status} and cannot be ${op === 'pause' ? 'paused' : 'stopped'}`)
    if (run.live) {
      run.live.intent = op
      run.live.controller.abort(new Error(`workflow ${op === 'pause' ? 'paused' : 'stopped'}`))
    }
    run.status = op === 'pause' ? 'user_paused' : 'cancelled'
    settle(run)
    if (byModel) run.reportedEpoch = run.epoch
    touch(session, run)
    if (op === 'stop' && !byModel) queueNotice(session, run)
    return run
  }

  const resumeError = detail => new WorkflowToolError('workflow_resume_failed', detail)

  /** Checks shared by the tool and /workflow resume; throws the refusal. */
  function resumable(session, run, budget) {
    if (run.restored) throw resumeError(`run is not resumable (status: ${run.status}): ${RESTART_REFUSAL}; start a new run`)
    if (run.resuming || run.status === 'active' || !isResumable(run.status)) throw resumeError(`run is not resumable (status: ${run.resuming ? 'resuming' : run.status})`)
    if (run.status === 'budget_limited') {
      if ((run.agentsUsed ?? 0) >= MAX_AGENT_BUDGET) throw resumeError('run is not resumable (status: maximum agent budget reached; start a new run)')
      if (budget === undefined || budget <= run.agentBudget || (run.agentsUsed ?? 0) >= budget) {
        throw resumeError(`run is budget-limited at ${run.agentsUsed ?? 0} of ${run.agentBudget} agents; resume it with an agent_budget above ${run.agentsUsed ?? 0}`)
      }
    }
    if (activeCount(session) >= MAX_ACTIVE_RUNS) throw resumeError(ACTIVE_LIMIT)
  }

  /**
   * A run started from a plugin workflow resumes only while that plugin is
   * active (ticket 205): disabling or uninstalling it withdraws its
   * workflows, paused runs included. An updated plugin does not change the
   * run: it replays the script copied at launch, and the overview names the
   * version now installed.
   */
  async function pluginGate(session, run, origin) {
    const plugin = origin?.plugin
    if (!plugin?.name) return
    let reply
    try {
      reply = await catalog(session)
    } catch (cause) {
      throw resumeError(`cannot check plugin '${plugin.name}' before resuming '${run.name}': ${cause?.detail ?? (cause instanceof Error ? cause.message : String(cause))}`)
    }
    const states = Array.isArray(reply?.plugins) ? reply.plugins : []
    const state = states.find(item => item?.plugin?.name === plugin.name && item?.plugin?.scope === plugin.scope) ?? states.find(item => item?.plugin?.name === plugin.name)
    if (!state) {
      throw resumeError(`run '${run.name}' came from plugin '${plugin.name}', which is no longer installed (or no longer ships workflows); install and enable it again to resume. The run would replay the script it started with.`)
    }
    if (state.status !== 'active') {
      throw resumeError(`run '${run.name}' came from plugin '${plugin.name}', which is ${state.status} (${state.detail}); enable it again to resume. The run would replay the script it started with.`)
    }
    run.origin = { ...(run.origin ?? origin), installed: { version: state.plugin?.version ?? null, commit: state.plugin?.commit ?? null } }
  }

  async function resume(session, run, parent, { budget, call }) {
    resumable(session, run, budget)
    run.resuming = true
    try {
      if (run.live) {
        await Promise.race([run.live.done, new Promise(resolve => later(resolve, ENGINE_CANCEL_GRACE_MS + CHILD_DRAIN_MS)?.unref?.())])
      }
      let launch
      try {
        launch = session.store.readLaunch(run.id)
      } catch (cause) {
        throw resumeError(`no persisted script for '${run.name}'; cannot resume (${cause instanceof Error ? cause.message : cause})`)
      }
      await pluginGate(session, run, launch.origin)
      const prior = run.status
      const epoch = run.epoch
      run.epoch = (run.epoch ?? 0) + 1
      if (call) run.call = call
      const first = await startEngine(session, run, {
        op: 'run',
        source: { type: 'script', script: launch.script },
        cwd: session.cwd,
        grokHome: env.GROK_HOME ?? null,
        trusted: env.CODSH_WORKSPACE_TRUSTED === '1',
        args: launch.args,
        agentBudget: budget ?? run.agentBudget ?? null,
        scratchDir: scratchDir(session.id, run.id, env, session.cwd),
        journal: { path: session.store.journal(run.id), resume: true, pruneHostError: prior === 'failed' ? run.pauseMessage ?? null : null },
      }, parent, { resume: true })
      if (first.type !== 'started') {
        run.epoch = epoch
        throw new WorkflowToolError(first.code ?? 'workflow_resume_failed', first.error ?? 'the workflow could not resume')
      }
      return run
    } finally {
      run.resuming = false
    }
  }

  async function launch(session, parent, input, call) {
    if (activeCount(session) >= MAX_ACTIVE_RUNS) throw new WorkflowToolError('workflow_launch_failed', ACTIVE_LIMIT)
    session.launching += 1
    try {
      const id = newRunId()
      const run = {
        id,
        name: '',
        definition: '',
        objective: '',
        status: 'active',
        phases: [],
        currentPhase: null,
        agents: [],
        agentBudget: input.agentBudget ?? DEFAULT_AGENT_BUDGET,
        agentsUsed: 0,
        effort: input.effort ?? null,
        createdAt: Date.now(),
        activeSince: null,
        elapsedFloor: 0,
        resultSummary: null,
        pauseMessage: null,
        epoch: 1,
        reportedEpoch: 0,
        seq: 0,
        revision: 0,
        call,
      }
      const first = await startEngine(session, run, {
        op: 'run',
        source: engineSource(input.source),
        cwd: session.cwd,
        grokHome: env.GROK_HOME ?? null,
        trusted: env.CODSH_WORKSPACE_TRUSTED === '1',
        args: input.args,
        agentBudget: input.agentBudget ?? null,
        scratchDir: scratchDir(session.id, id, env, session.cwd),
        journal: { path: session.store.journal(id), resume: false },
      }, parent, { resume: false, objective: input.objective })
      if (first.type !== 'started') throw new WorkflowToolError(first.code ?? 'workflow_failed', first.error ?? 'the workflow was rejected')
      return run
    } finally {
      session.launching -= 1
    }
  }

  const noEngine = 'the Rhai workflow engine is not configured (CODSH_WORKFLOW_ENGINE is unset); workflows run only under codsh --rust'

  /** A one-line engine op (`catalog`, `save`) for this session's directory. */
  function engineOp(session, start) {
    const enginePath = deps.enginePath()
    if (!enginePath) return Promise.reject(new WorkflowToolError('workflow_not_available', noEngine))
    return runEngine({
      enginePath,
      start: { cwd: session.cwd, grokHome: env.GROK_HOME ?? null, trusted: env.CODSH_WORKSPACE_TRUSTED === '1', ...start },
      onRequest: async () => ({ error: { kind: 'unsupported', message: 'catalog operations start no agents' } }),
    })
  }

  /** The saved-workflow catalog (ticket 184): the engine scans, nothing runs. */
  const catalog = session => engineOp(session, { op: 'catalog' })

  /**
   * Reference `push_workflow_launch_reminder`: the model learns about a run
   * the user started with a slash command at its next step.
   */
  function remindLaunch(session, run, commandLine) {
    const line = truncateBytes(squashText(commandLine), LAUNCH_REMINDER_CAP)
    let body = `The user launched background workflow '${run.name}' (run id ${run.id}) with the slash command: ${line}\nThis was handled host-side; no tool call was involved.`
    const objective = squashText(run.objective)
    if (objective && objective !== squashText(commandLine) && !squashText(commandLine).endsWith(` ${objective}`)) {
      body += `\nObjective: ${truncateBytes(objective, LAUNCH_REMINDER_CAP)}`
    }
    body += `\nIt runs in the background: the final result arrives as a workflow completion reminder, and the user can watch it in /workflow runs. If it pauses, it can be resumed by calling the workflow tool with source: { type: "resume", resume_from_run_id: "${run.id}" }; to stop or pause it yourself, call the workflow tool with source: { type: "stop", run_id: "${run.id}" } or { type: "pause", run_id: "${run.id}" }. Keep run ids internal — the user knows runs by display name. No action needed unless the user asks.`
    try {
      session.agent?.inject(createUserMessage({
        content: [{ type: 'text', text: `<system-reminder>\n${body}\n</system-reminder>` }],
        source: { kind: 'plugin', plugin: NOTICE_PLUGIN, form: 'snapshot', sections: [{ name: 'workflow-launch', text: body }] },
      }))
    } catch (cause) {
      process.stderr.write(`rust-acp-workflow: launch reminder not delivered: ${cause instanceof Error ? cause.message : cause}\n`)
    }
  }

  /** `/workflow <name> [args]` and `/<name> [args]` (reference `launch_named_workflow`). */
  async function launchNamed(session, name, input) {
    const fail = detail => `Could not start workflow '${name}': ${detail}`
    if (deps.refusal) return fail(deps.refusal)
    if (!session?.agent) return fail('this session has no live agent')
    if (!deps.enginePath()) return fail(noEngine)
    let parsed
    try {
      parsed = parseNamedArgs(input)
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : String(cause))
    }
    let run
    try {
      run = await launch(session, session.agent, { source: { type: 'name', value: name }, args: parsed.args, agentBudget: parsed.agentBudget, effort: parsed.effort, objective: parsed.objective }, '')
    } catch (cause) {
      const detail = cause?.detail ?? (cause instanceof Error ? cause.message : String(cause))
      if (cause?.code === 'workflow_resolve_failed') return `Workflow '${name}' unavailable: ${detail}`
      return fail(detail)
    }
    const trimmed = String(input ?? '').trim()
    remindLaunch(session, run, trimmed === '' ? `/${name}` : `/${name} ${trimmed}`)
    return `Workflow '${run.name}' started in the background. Watch it in /workflow runs; the result lands here when it finishes.`
  }

  /** Display names bare `/workflow save` offers: own-name runs not yet in the project catalog. */
  async function savableNames(session, runs) {
    let project = new Set()
    try {
      const reply = await catalog(session)
      if (reply?.type === 'catalog') project = new Set(reply.entries.filter(entry => entry.scope === 'project').map(entry => entry.name))
    } catch {}
    return new Set(runs.filter(run => run.definition && run.name === run.definition && !project.has(run.definition)).map(run => run.name))
  }

  /** Reference `/workflow save <name>`: the run's immutable script into the project catalog. */
  async function saveRun(session, run) {
    let record
    try {
      record = session.store.readLaunch(run.id)
    } catch {
      return `No persisted script for '${run.name}'; nothing to save.`
    }
    const definition = String(record.definition || run.definition || '')
    if (run.name !== definition) {
      return `Save is disabled for run '${run.name}': it is a duplicate-run display handle, while the script is still named '${definition}'. Choose a new unique meta.name and save the script under that name instead.`
    }
    const scriptPath = join(session.store.dir(run.id), 'script.rhai')
    let reply
    try {
      reply = await engineOp(session, { op: 'save', name: definition, script: record.script })
    } catch (cause) {
      return `Could not save workflow '${definition}': ${cause?.detail ?? (cause instanceof Error ? cause.message : String(cause))}`
    }
    if (reply?.type === 'saved') return `Saved workflow '${definition}' to ${reply.path} — runnable by name from now on.`
    const reason = `Could not save workflow '${definition}': ${reply?.error ?? 'the workflow engine gave no answer'}`
    if (reply?.code === 'workflow_exists' || reply?.code === 'workflow_invalid_input') return `${reason}\nThe run's script stays at ${scriptPath}.`
    const personal = env.GROK_HOME ? join(env.GROK_HOME, 'workflows', `${definition}.rhai`) : `$GROK_HOME/workflows/${definition}.rhai`
    return `${reason}\nNo project workflow directory is writable here, so nothing was saved. The run's script stays at ${scriptPath}; to keep it as a personal workflow, copy it to ${personal}.`
  }

  /**
   * `/workflow ...` from the client: the reference replies, run ids kept
   * internal. `launch` is the workflow name of a client `/<name>` command,
   * whose whole text is then its arguments.
   */
  async function command(sessionId, text, { launch: launchName } = {}) {
    const session = sessions.get(sessionId)
    const runs = session ? list(session) : []
    if (typeof launchName === 'string' && launchName !== '') return launchNamed(session, launchName, text)
    const parsed = parseCommand(text)
    if (parsed.kind === 'overview') return formatOverview(runs)
    if (parsed.kind === 'launch') return launchNamed(session, parsed.name, parsed.args)
    const { op, name } = parsed
    if (name === '') return needsName(op, runs, op === 'save' && session ? await savableNames(session, runs) : undefined)
    const matches = matchRuns(runs, name, op)
    if (matches.length === 0) return `No workflow run matches '${name}'.`
    if (matches.length > 1) {
      return `Several runs could be '${op}' — pick one by name:\n${matches.map(run => `  ${run.name} (${run.status})`).join('\n')}\n(/workflow ${op} <name>)`
    }
    const [run] = matches
    if (op === 'save') return saveRun(session, run)
    if (op === 'pause') {
      if (!accepts(run.status, 'pause')) return `Run '${run.name}' is not active (status: ${run.status}).`
      control(session, run.id, 'pause', { byModel: false })
      return `Paused ${run.name}. /workflow resume ${run.name} to continue.`
    }
    if (op === 'stop') {
      if (!accepts(run.status, 'stop')) return `Run '${run.name}' cannot be stopped (status: ${run.status}); it has already finished or hit its agent budget.`
      control(session, run.id, 'stop', { byModel: false })
      return `Stopped ${run.name}.`
    }
    if (run.status === 'active') return `Run '${run.name}' is already running.`
    if (run.restored) return `Run '${run.name}' cannot be resumed (status: ${run.status}): ${RESTART_REFUSAL}. Start a new run instead.`
    if (!isResumable(run.status)) return `Run '${run.name}' cannot be resumed (status: ${run.status}). Start a new run instead.`
    if (run.status === 'budget_limited') {
      const used = run.agentsUsed ?? 0
      if (used >= MAX_AGENT_BUDGET) return `Run '${run.name}' exhausted the maximum agent budget (${used}/${run.agentBudget} agents) and cannot be resumed. Start a new run instead.`
      return `Run '${run.name}' exhausted its agent budget (${used}/${run.agentBudget} agents). Resuming keeps all finished work but needs a higher absolute cap — ask the agent to resume it with an agent budget above ${used}, e.g. "resume ${run.name} with an agent budget of ${Math.min(used + 64, MAX_AGENT_BUDGET)}".`
    }
    if (!session.agent) return `Could not resume '${run.name}': this session has no live agent.`
    try {
      await resume(session, run, session.agent, {})
    } catch (cause) {
      return `Could not resume '${run.name}': ${cause?.detail ?? (cause instanceof Error ? cause.message : String(cause))}`
    }
    return `Resumed ${run.name} from its journal.`
  }

  return {
    sessions,
    sessionFor,
    launch,
    resume,
    control,
    waitForeground,
    command,
    catalog,
    find,
    onCreated(agent) {
      if (deps.isChildAgent?.(agent)) return
      const session = sessionFor(agent)
      if (session.pending.length > 0) later(() => deliver(session), 0)
    },
    onDisposed(agent) {
      if (deps.isChildAgent?.(agent)) return
      const session = sessions.get(sessionIdOf(agent))
      if (!session || session.agent !== agent) return
      session.agent = undefined
      for (const run of list(session)) {
        if (!run.live || run.status !== 'active') continue
        run.live.intent = 'dispose'
        run.live.controller.abort(new Error('the session ended'))
        run.status = 'interrupted'
        run.pauseMessage = INTERRUPTED
        run.reportedEpoch = run.epoch
        settle(run)
        touch(session, run)
      }
    },
  }
}

/**
 * Register the tool. `deps` comes from the subagents plugin:
 *   isChildAgent(agent)  — whether an agent is a subagent (any depth).
 *   spawnChild(spec)     — start one dsh child and wait for it; resolves
 *                          { status, text, childId, session? } or throws a
 *                          refusal. With spec.keepOpen a child that
 *                          completed stays open as `session`
 *                          ({ resume(prompt, signal), close(verdict) }).
 *   refusal              — a policy refusal that blocks every run, or null.
 *   maxConcurrent        — the configured live-child cap per run.
 * Returns the run manager (also published at globalThis[REGISTRY] for the
 * control channel's /workflow requests).
 */
export function registerWorkflow(ctx, deps) {
  const { isChildAgent } = deps
  const runs = createWorkflowRuns({ ...deps, enginePath: () => process.env.CODSH_WORKFLOW_ENGINE })
  // A plain `-p` prompt ends with its turn, so it waits for its runs.
  const foreground = (deps.env ?? process.env).CODSH_WORKFLOW_FOREGROUND === '1'
  ctx.tools.register(defineTool({
    name: WORKFLOW_TOOL,
    description: foreground ? DESCRIPTION.replace(BACKGROUND_SENTENCE, FOREGROUND_SENTENCE) : DESCRIPTION,
    parameters: {
      source: {
        type: 'object',
        description: 'Exactly one workflow source, selected by `type`: {"type":"name","name":"<saved workflow>"}, {"type":"script","script":"<Rhai>"}, {"type":"script_path","script_path":"<path>"}, {"type":"resume","resume_from_run_id":"<run id or name>"}, {"type":"pause","run_id":"<run id or name>"} or {"type":"stop","run_id":"<run id or name>"}.',
        additionalProperties: true,
        properties: {
          type: { type: 'string', enum: ['name', 'script', 'script_path', 'resume', 'pause', 'stop'], required: true, description: 'Source kind.' },
          script: { type: 'string', description: 'Inline Rhai workflow script. It must start with a pure-literal `let meta = #{ name: ..., description: ... };` map.' },
          script_path: { type: 'string', description: 'Path to a .rhai workflow script on disk, relative to the session directory.' },
          name: { type: 'string', description: 'Name of a saved workflow from the listed catalog (project .grok/workflows in a trusted folder, then $GROK_HOME/workflows).' },
          resume_from_run_id: { type: 'string', description: 'Run to resume (run id or display name) — a paused, stopped, failed or budget-limited run of this process.' },
          run_id: { type: 'string', description: 'Run to pause or stop (run id or display name).' },
        },
      },
      agent_budget: {
        type: 'integer',
        description: 'Absolute cumulative cap on logical child-agent calls for this run. Every agent() and every parallel() item consumes one slot. Defaults to 128 and may be set from 1 through 1,024. A panel that would exceed the remaining budget is rejected before any of its children launch. On resume it replaces the run\'s cap; a budget-limited run needs a value above the agents it already used.',
      },
      args: {
        type: 'json',
        description: "JSON value bound to the script's `args` global. Use an object for named arguments. Fixed at launch: resume reuses the original args.",
      },
      validate_only: {
        type: 'boolean',
        description: 'Run a path-specific smoke check without launching: validate metadata, compile the full script, and execute the single path selected by the supplied args and canned host results. It does not exercise every branch or prove live tools and agent outputs work.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('workflow tool requires a calling agent')
      if (isChildAgent(parent)) throw new WorkflowToolError('workflow_depth_exceeded', DEPTH_MESSAGE)
      const input = normalizeInput(rawArgs)
      if (deps.refusal) throw new WorkflowToolError('workflow_not_available', deps.refusal)
      const session = runs.sessionFor(parent)
      const type = input.source.type
      if (type === 'pause' || type === 'stop') {
        const run = runs.control(session, input.source.value, type, { byModel: true })
        return `${type === 'pause' ? 'Paused' : 'Stopped'} workflow '${run.name}'; its child agents were cancelled. It keeps its journal, so it can be continued later with source: { type: "resume", resume_from_run_id: "${run.id}" }.`
      }
      const enginePath = process.env.CODSH_WORKFLOW_ENGINE
      if (!enginePath) {
        throw new WorkflowToolError('workflow_not_available', 'the Rhai workflow engine is not configured (CODSH_WORKFLOW_ENGINE is unset); workflows run only under codsh --rust')
      }
      exec.signal.throwIfAborted()
      const callId = typeof exec.callId === 'string' && exec.callId ? exec.callId : `workflow-${Date.now().toString(36)}`
      if (type === 'resume') {
        const run = runs.find(session, input.source.value)
        if (!run) throw new WorkflowToolError('workflow_resume_failed', `workflow run not found: ${input.source.value}`)
        await runs.resume(session, run, parent, { budget: input.agentBudget, call: callId })
        return foreground ? runs.waitForeground(session, run, exec.signal) : started(run.name)
      }
      if (input.validateOnly) {
        const final = await runEngine({
          enginePath,
          start: {
            op: 'validate',
            source: engineSource(input.source),
            cwd: session.cwd,
            grokHome: process.env.GROK_HOME ?? null,
            trusted: process.env.CODSH_WORKSPACE_TRUSTED === '1',
            args: input.args,
            agentBudget: input.agentBudget ?? null,
          },
          onRequest: async () => ({ error: { kind: 'unsupported', message: 'validate_only starts no agents' } }),
          signal: exec.signal,
        })
        if (final.type === 'validated') {
          return `Smoke check passed for workflow '${final.name}' (${final.phases} declared phases; canned-host path ${final.summary}). This did not launch the workflow and did not exercise every branch or live dependency. Offer a real run next.`
        }
        if (final.type === 'rejected') throw new WorkflowToolError(final.code ?? 'workflow_failed', final.error ?? 'the workflow was rejected')
        throw new WorkflowToolError('workflow_validation_failed', 'the smoke check was cancelled')
      }
      const run = await runs.launch(session, parent, input, callId)
      return foreground ? runs.waitForeground(session, run, exec.signal) : started(run.name)
    },
  }))
  // Ticket 184: the model sees the saved-workflow catalog (reference listing
  // under the skills in the system reminder) at the first step of a turn
  // whenever it changed for this session. Children never see it.
  const listed = new Map()
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || signal?.aborted || step !== 1 || !Array.isArray(decision?.messages)) return decision
    if (!agent || isChildAgent(agent) || deps.refusal || !process.env.CODSH_WORKFLOW_ENGINE) return decision
    let text
    let session
    try {
      session = runs.sessionFor(agent)
      const reply = await runs.catalog(session)
      if (reply?.type !== 'catalog') return decision
      text = typeof reply.listing === 'string' ? reply.listing : ''
    } catch {
      return decision
    }
    const previous = listed.get(session.id)
    listed.set(session.id, text)
    if (previous === text || (previous === undefined && text === '')) return decision
    const body = text || 'No saved workflows are available any more; the earlier workflow listing is out of date.'
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: `<system-reminder>\n${body}\n</system-reminder>` }],
        source: { kind: 'plugin', plugin: NOTICE_PLUGIN, form: 'snapshot', sections: [{ name: 'workflow-catalog', text: body }] },
      })],
    }
  })
  ctx.on('agent/created', ({ agent }) => runs.onCreated(agent))
  ctx.on('agent/disposed', ({ agent }) => runs.onDisposed(agent))
  globalThis[REGISTRY] = runs
  ctx.on('dispose', () => {
    if (globalThis[REGISTRY] === runs) delete globalThis[REGISTRY]
  })
  return runs
}

/** Per-run live-child cap: a FIFO of waiters, abortable. */
export class RunSlots {
  constructor(limit) {
    this.limit = limit
    this.used = 0
    this.waiting = []
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
    if (this.used < this.limit) {
      this.used += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason ?? new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(waiter)
    })
  }

  release() {
    const next = this.waiting.shift()
    if (next) next.grant()
    else this.used = Math.max(0, this.used - 1)
  }
}
