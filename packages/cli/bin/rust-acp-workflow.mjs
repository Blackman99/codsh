/**
 * The model-facing `workflow` tool for the Rust client (ticket 181).
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
 * - The run is foreground: the tool call waits for the outcome. There is no
 *   background run, /workflow view, pause, resume or stop (later tickets);
 *   those sources are refused. Cancelling the turn cancels the run.
 * - Registered names (built-in, project, user or plugin catalogs) are not
 *   available; pass an inline `script` or a `script_path`.
 * - `output_schema`, `resume_from`, scratch files and `git_diff_since` are
 *   refused by the engine with an explicit error.
 *
 * The engine is a separate process with Rhai operation and size limits. It
 * is not a security sandbox.
 */
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { createInterface } from 'node:readline'
import { defineTool } from '@deepseek-ai/dsh-tools'

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

export function concurrencyCap(parallelism = safeParallelism()) {
  const clamp = Math.max(2, Number.isSafeInteger(parallelism) ? parallelism : DEFAULT_MAX_CONCURRENT_AGENTS)
  return Math.min(DEFAULT_MAX_CONCURRENT_AGENTS, clamp)
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

/** Sources this build cannot run, with the reason the model sees. */
export function unsupportedSource(source) {
  switch (source.type) {
    case 'name':
      return new WorkflowToolError('workflow_unsupported', `registered workflow names are not available in this build (no built-in, project .grok/workflows, user or plugin catalog is loaded), so "${source.value}" cannot be resolved; pass the script inline as source.type "script" or a file as source.type "script_path"`)
    case 'resume':
      return new WorkflowToolError('workflow_unsupported', 'resuming a workflow run is not available in this build: runs execute in the foreground of one tool call and are not journaled; launch the script again as a new run')
    case 'pause':
    case 'stop':
      return new WorkflowToolError('workflow_unsupported', `${source.type} is not available in this build: a run executes in the foreground of its tool call, and cancelling that turn cancels the run and its child agents`)
    default:
      return undefined
  }
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
  for (const key of ['SystemRoot', 'WINDIR', 'LANG', 'LC_ALL']) {
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
      if (message.type === 'outcome' || message.type === 'validated' || message.type === 'rejected') {
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

const DESCRIPTION = `Run a workflow: a Rhai script that orchestrates subagents. Provide exactly one \`source\`: an inline \`script\` or a \`script_path\` (a .rhai file named after its meta.name, inside this project or $GROK_HOME/workflows). Optionally pass \`args\` (bound to the script's \`args\`) and \`agent_budget\`, an absolute cap on cumulative child-agent calls: every agent() and parallel() item consumes one slot; default 128, at most 1024. The host also caps live children per run (32, clamped to the machine) — larger parallel() panels are queued and still act as a barrier. This call waits for the run to finish and returns its result; cancelling the turn cancels the run and its children. Registered workflow names, resume, pause and stop are not available in this build. \`validate_only: true\` runs a path-specific smoke check (metadata, compile, one canned-host path) without starting agents.

Script format: the first statement must be a pure-literal \`let meta = #{ name: "kebab-name", description: "..." };\` (optional when_to_use and phases: [#{ title, detail }]). Host functions:
- agent(prompt) / agent(prompt, #{ label, phase, model, effort, agent_type, capability_mode, isolation_worktree }) runs one subagent to completion and returns #{ agent_id, success, output, cancelled, tokens_used, duration_ms }; output is the child's final text (or its error when success is false). effort is one of none, minimal, low, medium, high, xhigh, max and must be offered by the model; capability_mode (read-only, read-write, execute, all) can only narrow the agent type.
- parallel([#{ prompt, ...same options }, ...]) runs a panel concurrently and returns results in order; a child the host refuses becomes ().
- phase(title), log(message), budget() -> #{ total, spent, reserved, remaining }, complete(value), pause(kind, message), json_encode(value), fingerprint(text).
The last expression (or complete(value)) is the result. There is no filesystem, network, clock or process access in the script; agents do the work. Children cannot start workflows.`

/**
 * Register the tool. `deps` comes from the subagents plugin:
 *   isChildAgent(agent)  — whether an agent is a subagent (any depth).
 *   spawnChild(spec)     — start one dsh child and wait for it; resolves
 *                          { status, text, cancelled } or throws a refusal.
 *   refusal              — a policy refusal that blocks every run, or null.
 */
export function registerWorkflow(ctx, deps) {
  const { isChildAgent, spawnChild, emit = () => {} } = deps
  ctx.tools.register(defineTool({
    name: WORKFLOW_TOOL,
    description: DESCRIPTION,
    parameters: {
      source: {
        type: 'object',
        description: 'Exactly one workflow source, selected by `type`: {"type":"script","script":"<Rhai>"} or {"type":"script_path","script_path":"<path>"}. The reference `name`, `resume`, `pause` and `stop` types are refused in this build.',
        additionalProperties: true,
        properties: {
          type: { type: 'string', enum: ['name', 'script', 'script_path', 'resume', 'pause', 'stop'], required: true, description: 'Source kind.' },
          script: { type: 'string', description: 'Inline Rhai workflow script. It must start with a pure-literal `let meta = #{ name: ..., description: ... };` map.' },
          script_path: { type: 'string', description: 'Path to a .rhai workflow script on disk, relative to the session directory.' },
          name: { type: 'string', description: 'Name of a registered workflow (not available in this build).' },
          resume_from_run_id: { type: 'string', description: 'Run to resume (not available in this build).' },
          run_id: { type: 'string', description: 'Run to pause or stop (not available in this build).' },
        },
      },
      agent_budget: {
        type: 'integer',
        description: 'Absolute cumulative cap on logical child-agent calls for this run. Every agent() and every parallel() item consumes one slot. Defaults to 128 and may be set from 1 through 1,024. A panel that would exceed the remaining budget is rejected before any of its children launch.',
      },
      args: {
        type: 'json',
        description: "JSON value bound to the script's `args` global. Use an object for named arguments.",
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
      const refused = unsupportedSource(input.source)
      if (refused) throw refused
      if (deps.refusal) throw new WorkflowToolError('workflow_not_available', deps.refusal)
      const enginePath = process.env.CODSH_WORKFLOW_ENGINE
      if (!enginePath) {
        throw new WorkflowToolError('workflow_not_available', 'the Rhai workflow engine is not configured (CODSH_WORKFLOW_ENGINE is unset); workflows run only under codsh --rust')
      }
      exec.signal.throwIfAborted()
      const callId = typeof exec.callId === 'string' && exec.callId ? exec.callId : `workflow-${Date.now().toString(36)}`
      const cwd = parent.session?.header?.cwd ?? process.cwd()
      const start = {
        op: input.validateOnly ? 'validate' : 'run',
        source: input.source.type === 'script'
          ? { type: 'script', script: input.source.value }
          : { type: 'script_path', script_path: input.source.value },
        cwd,
        grokHome: process.env.GROK_HOME ?? null,
        trusted: process.env.CODSH_WORKSPACE_TRUSTED === '1',
        args: input.args,
        agentBudget: input.agentBudget ?? null,
      }
      const run = {
        id: callId,
        name: '',
        phase: '',
        phases: [],
        logs: [],
        started: 0,
        running: 0,
        children: new Set(),
        controller: new AbortController(),
      }
      const slots = new RunSlots(concurrencyCap())
      const status = state => emit({ event: 'workflow', id: callId, name: run.name, status: state, phase: run.phase, agents: run.started, running: run.running })
      const onParentAbort = () => run.controller.abort(exec.signal.reason ?? new Error('parent turn cancelled'))
      exec.signal.addEventListener('abort', onParentAbort, { once: true })
      let final
      try {
        final = await runEngine({
          enginePath,
          start,
          signal: run.controller.signal,
          onEvent: line => {
            if (line.type === 'started') {
              run.name = String(line.meta?.name ?? '')
              run.budget = line.agentBudget
              status('running')
            } else if (line.type === 'phase') {
              run.phase = String(line.title)
              run.phases.push(run.phase)
              status('running')
            } else if (line.type === 'log') {
              run.logs.push(String(line.message))
              if (run.logs.length > MAX_LOG_LINES) run.logs.shift()
            }
          },
          onRequest: async request => {
            if (request.kind !== 'spawn_agent') return { error: { kind: 'unsupported', message: `unknown host request ${request.kind}` } }
            const signal = run.controller.signal
            if (signal.aborted) return { error: { kind: 'cancelled' } }
            const opts = request.opts ?? {}
            const seq = ++run.started
            const startedAt = Date.now()
            const task = (async () => {
              try {
                await slots.acquire(signal)
              } catch {
                return { error: { kind: 'cancelled' } }
              }
              run.running += 1
              status('running')
              try {
                const outcome = await spawnChild({
                  parent,
                  id: `${callId}:agent-${seq}`,
                  prompt: String(opts.prompt ?? ''),
                  label: opts.label ?? `${run.name || 'workflow'} #${seq}`,
                  typeName: opts.agentType ?? undefined,
                  model: opts.model ?? undefined,
                  effort: opts.effort ?? undefined,
                  capability: opts.capabilityMode ?? undefined,
                  isolation: opts.isolationWorktree === true ? 'worktree' : null,
                  signal,
                  workflow: { run: callId, name: run.name, phase: opts.phase ?? run.phase ?? '' },
                })
                if (signal.aborted) return { error: { kind: 'cancelled' } }
                return {
                  ok: {
                    agent_id: outcome.childId ?? `${callId}:agent-${seq}`,
                    success: outcome.status === 'completed',
                    output: clipOutput(outcome.text ?? ''),
                    cancelled: outcome.status === 'cancelled',
                    tokens_used: 0,
                    duration_ms: Date.now() - startedAt,
                  },
                }
              } catch (cause) {
                if (signal.aborted) return { error: { kind: 'cancelled' } }
                return { error: { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) } }
              } finally {
                run.running -= 1
                slots.release()
                status('running')
              }
            })()
            run.children.add(task)
            task.finally(() => run.children.delete(task))
            return task
          },
        })
      } finally {
        exec.signal.removeEventListener('abort', onParentAbort)
        // A cancelled run's children are aborted with it; wait (bounded) for
        // them to settle so none outlives this call.
        if (run.children.size > 0) {
          run.controller.abort(new Error('workflow run ended'))
          await Promise.race([
            Promise.allSettled([...run.children]),
            new Promise(resolve => setTimeout(resolve, CHILD_DRAIN_MS).unref?.()),
          ])
        }
      }
      if (final.type === 'rejected') {
        status('failed')
        throw new WorkflowToolError(final.code ?? 'workflow_failed', final.error ?? 'the workflow was rejected')
      }
      if (final.type === 'validated') {
        return `Smoke check passed for workflow '${final.name}' (${final.phases} declared phases; canned-host path ${final.summary}). This did not launch the workflow and did not exercise every branch or live dependency. Offer a real run next.`
      }
      const name = run.name || 'workflow'
      const agents = `${final.agentsUsed ?? run.started} agent call${(final.agentsUsed ?? run.started) === 1 ? '' : 's'} of budget ${final.agentBudget ?? run.budget ?? DEFAULT_AGENT_BUDGET}`
      const trail = [
        run.phases.length > 0 ? `Phases: ${run.phases.join(' → ')}` : '',
        run.logs.length > 0 ? `Log:\n${run.logs.map(line => `- ${line}`).join('\n')}` : '',
      ].filter(Boolean).join('\n')
      const withTrail = text => (trail ? `${text}\n${trail}` : text)
      switch (final.outcome) {
        case 'completed':
          status('completed')
          return withTrail(`Workflow '${name}' completed (${agents}).`) + `\nResult:\n${summarizeResult(final.result)}`
        case 'paused':
          status('paused')
          return withTrail(`Workflow '${name}' paused (${final.kind}): ${final.message}\nThis build cannot resume a paused run; after the user responds, launch the script again as a new run.`)
        case 'budget_exceeded':
          status('failed')
          throw new Error(withTrail(`Workflow '${name}' stopped: ${final.message} (${agents}). Resume is not available in this build; raise agent_budget (at most ${MAX_AGENT_BUDGET}) and start a new run.`))
        case 'cancelled':
          status('cancelled')
          throw new Error(withTrail(`Workflow '${name}' was cancelled${final.killed ? ' (the engine did not stop in time and was killed)' : ''}; its child agents were cancelled.`))
        default:
          status('failed')
          throw new Error(withTrail(`Workflow '${name}' failed: ${final.error ?? 'unknown error'}`))
      }
    },
  }))
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
