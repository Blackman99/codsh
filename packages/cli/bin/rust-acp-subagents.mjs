/**
 * Typed dsh subagents for the Rust client (ticket 172).
 *
 * The released `tool-subagent` row is disabled by the overlay and this plugin
 * registers the model-facing `subagent` tool in its place. Every child is a
 * real dsh child started through `ctx.subagents.start('spawn', ...)`, so the
 * dsh agent loop, persistence, hooks, and the global permission listener
 * (rust-acp-file-approval) apply to it exactly as they apply to the parent.
 *
 * The policy is resolved by the Rust client and passed as JSON in
 * CODSH_SUBAGENT_POLICY:
 *   { enabled, maxConcurrent, limitBehavior: 'queue'|'fail', maxDepth,
 *     types: [{ name, description, capability, model?, provider?, instructions?, tools? }] }
 * A missing variable keeps the built-in types with the reference defaults.
 * A malformed one refuses every spawn with the parse error.
 *
 * - subagent_type selects a type. Its capability mode becomes a dsh tool
 *   allow-list (tools.restrict), so a removed tool is absent from the child's
 *   schema and refused if it is still called. An unclassified tool is removed
 *   from every mode except `all`.
 * - A type model is preflighted with llm.resolveCallConfig before any child
 *   exists, so a missing route fails the call and starts nothing.
 * - maxDepth is dsh's own depth cap. At the last level the child's filter
 *   also removes subagent and subagent_fork.
 * - maxConcurrent counts running children of one root session. `queue` waits
 *   for a slot (abortable); `fail` refuses with the reference sentence.
 * - run_in_background starts the child as a dsh job. The model collects the
 *   result with job_output and can stop it with job_kill.
 *
 * Lifecycle lines go to stderr as `\u241esubagent\u241e{json}` so the Rust
 * client can keep one board. CODSH_SUBAGENT_CONTROL names a private directory
 * where the client drops `<n>.json` files ({"action":"cancel","id":callId}).
 */
export const name = 'rust-acp-subagents'
export const inject = ['tools', 'subagents']

import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const MARK = '\u241esubagent\u241e'
export const DEFAULT_MAX_CONCURRENT = 32
export const LIMIT_MESSAGE = limit =>
  `Concurrent subagent limit reached: ${limit} subagents are already running for this session. Do not retry; spawning succeeds again when a running subagent finishes.`

export const CAPABILITIES = ['read-only', 'read-write', 'execute', 'all']

/** Built-in types. The default is general-purpose. */
export const BUILTIN_TYPES = [
  {
    name: 'general-purpose',
    description: 'General-purpose agent for multi-step research and implementation. Has every tool the parent has.',
    capability: 'all',
  },
  {
    name: 'explore',
    description: 'Fast read-only exploration: reads, searches, and runs shell commands. Cannot edit or write files.',
    capability: 'execute',
    instructions: 'You are an exploration subagent. Investigate and report findings. Do not modify files.',
  },
  {
    name: 'plan',
    description: 'Planning agent: reads, searches, and runs shell commands, then returns a step-by-step plan. Cannot edit or write files.',
    capability: 'execute',
    instructions: 'You are a planning subagent. Investigate the code, then return a concrete step-by-step implementation plan. Do not modify files.',
  },
]

/**
 * Tool families by capability. Names are the dsh 0.1.5-rc.2 registered tools.
 * Spawn and messaging tools are delegation machinery and stay in every mode
 * (subject to the depth cap), matching the reference `Task` kind.
 */
const READ_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'todo_write',
  'skill', 'exit_plan_mode', 'job_output', 'job_list', 'job_kill', 'list_agents',
  'get_goal', 'list_subagent_models',
])
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const EXECUTE_TOOLS = new Set(['bash', 'pwsh', 'bash_persistent', 'pwsh_persistent', 'terminal'])
const TASK_TOOLS = new Set(['subagent', 'subagent_fork', 'send_message', 'interrupt_agent'])
export const SPAWN_TOOLS = ['subagent', 'subagent_fork']

/** Whether a capability mode keeps a tool. Unclassified tools survive only `all`. */
export function allowsTool(capability, tool) {
  if (capability === 'all') return true
  if (READ_TOOLS.has(tool) || TASK_TOOLS.has(tool)) return true
  if (WRITE_TOOLS.has(tool)) return capability === 'read-write'
  if (EXECUTE_TOOLS.has(tool)) return capability === 'execute'
  return false
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback
}

/** Parse CODSH_SUBAGENT_POLICY. Returns { policy } or { error }. */
export function readPolicy(raw) {
  const base = {
    enabled: true,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    limitBehavior: 'queue',
    maxDepth: 1,
    types: BUILTIN_TYPES.map(type => ({ ...type })),
  }
  if (raw === undefined || String(raw).trim() === '') return { policy: base }
  let value
  try {
    value = JSON.parse(String(raw))
  } catch (error) {
    return { error: `CODSH_SUBAGENT_POLICY is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'CODSH_SUBAGENT_POLICY must be a JSON object' }
  }
  if (value.enabled === false) return { policy: { ...base, enabled: false, types: [] } }
  // A client-side refusal (for example an unknown Agent(type) filter) keeps
  // the tool and refuses every spawn with the client's sentence.
  if (typeof value.error === 'string' && value.error) return { error: value.error }
  const types = []
  const seen = new Set()
  for (const entry of Array.isArray(value.types) ? value.types : []) {
    if (typeof entry !== 'object' || entry === null || typeof entry.name !== 'string' || entry.name.trim() === '') {
      return { error: 'CODSH_SUBAGENT_POLICY types need a non-empty name' }
    }
    const capability = entry.capability ?? 'all'
    if (!CAPABILITIES.includes(capability)) {
      return { error: `subagent type "${entry.name}" has invalid capability "${capability}"; use one of ${CAPABILITIES.join(', ')}` }
    }
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    types.push({
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : '',
      capability,
      ...typeof entry.model === 'string' && entry.model ? { model: entry.model } : {},
      ...typeof entry.provider === 'string' && entry.provider ? { provider: entry.provider } : {},
      ...typeof entry.instructions === 'string' && entry.instructions ? { instructions: entry.instructions } : {},
      ...Array.isArray(entry.tools) ? { tools: entry.tools.filter(tool => typeof tool === 'string' && tool) } : {},
    })
  }
  return {
    policy: {
      enabled: value.enabled !== false,
      maxConcurrent: positiveInt(value.maxConcurrent, DEFAULT_MAX_CONCURRENT),
      limitBehavior: value.limitBehavior === 'fail' ? 'fail' : 'queue',
      maxDepth: positiveInt(value.maxDepth, 1),
      types: Array.isArray(value.types) ? types : base.types,
    },
  }
}

/**
 * The child's allow-list: the tools the parent can see, filtered by the type.
 * A type `tools` list narrows further (names or dsh aliases). At the last depth
 * level the spawn tools are removed so the child is not offered a tool that
 * dsh would refuse.
 */
export function childAllowList(parentTools, type, lastLevel) {
  const wanted = type.tools ? new Set(type.tools.map(canonicalTool)) : null
  return parentTools.filter(tool => {
    if (tool === 'run_code') return false
    if (lastLevel && SPAWN_TOOLS.includes(tool)) return false
    if (wanted && !wanted.has(tool)) return false
    return allowsTool(type.capability, tool)
  })
}

const TOOL_ALIASES = new Map([
  ['read_file', 'read'], ['search_replace', 'edit'], ['strreplace', 'edit'], ['run_terminal_cmd', 'bash'],
  ['list_dir', 'glob'], ['websearch', 'web_search'], ['webfetch', 'web_fetch'], ['agent', 'subagent'], ['task', 'subagent'],
])

function canonicalTool(name) {
  const text = String(name).trim()
  return TOOL_ALIASES.get(text.toLowerCase()) ?? text.toLowerCase()
}

/** Reference-shaped stop text for a settled child. */
export function stopReasonError(stopReason) {
  switch (stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(stopReason)})`
  }
}

function outputText(output) {
  return (Array.isArray(output) ? output : [])
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function emit(event) {
  try {
    process.stderr.write(`${MARK}${JSON.stringify(event)}\n`)
  } catch {}
}

function agentDepth(agent) {
  const runtime = agent?.options?.subagentDepth
  const header = agent?.session?.header?.delegationDepth
  return Math.max(Number.isSafeInteger(runtime) ? runtime : 0, Number.isSafeInteger(header) ? header : 0)
}

/** Root (top-level) session id of an agent, following parentSession links. */
function rootSessionOf(ctx, agent) {
  let current = agent
  let id = agent?.id
  const agents = ctx.get('agents')
  for (let guard = 0; guard < 64 && current; guard += 1) {
    const parentId = current.session?.header?.parentSession
    if (current.session?.header?.origin !== 'subagent' || !parentId) return current.id ?? id
    id = parentId
    current = agents?.get(parentId)
  }
  return id
}

/** Per-root admission: count running children, queue or fail at the limit. */
export class Admission {
  constructor(limit, behavior) {
    this.limit = limit
    this.behavior = behavior
    this.running = new Map()
    this.waiting = new Map()
  }

  count(root) {
    return this.running.get(root) ?? 0
  }

  /** Try to take a slot now. Returns true on success. */
  tryAcquire(root) {
    if (this.count(root) >= this.limit) return false
    this.running.set(root, this.count(root) + 1)
    return true
  }

  /** Wait for a slot. Rejects with the signal reason when aborted first. */
  acquire(root, signal, onQueued) {
    if (this.tryAcquire(root)) return Promise.resolve()
    if (this.behavior === 'fail') return Promise.reject(new Error(LIMIT_MESSAGE(this.limit)))
    onQueued?.()
    return new Promise((resolve, reject) => {
      const queue = this.waiting.get(root) ?? []
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      const onAbort = () => {
        const list = this.waiting.get(root) ?? []
        const index = list.indexOf(waiter)
        if (index >= 0) list.splice(index, 1)
        reject(signal.reason instanceof Error ? signal.reason : new Error('subagent run was cancelled while queued'))
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      queue.push(waiter)
      this.waiting.set(root, queue)
    })
  }

  /** Release one slot. A queued waiter takes it before the count drops. */
  release(root) {
    const queue = this.waiting.get(root) ?? []
    const next = queue.shift()
    if (next) {
      next.grant()
      return
    }
    const count = this.count(root) - 1
    if (count <= 0) this.running.delete(root)
    else this.running.set(root, count)
  }
}

function describeTypes(types) {
  return types.map(type => `- ${type.name}: ${type.description || '(no description)'} [${type.capability}]`).join('\n')
}

export function apply(ctx) {
  const { policy, error } = readPolicy(process.env.CODSH_SUBAGENT_POLICY)
  if (policy && !policy.enabled) {
    // Disabled: no spawn tool reaches any agent, and a call that still
    // arrives is refused before dsh runs it.
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (SPAWN_TOOLS.includes(exec.name)) return { kind: 'deny', reason: 'subagents are disabled for this session' }
      return next()
    }, true)
    ctx.on('agent/created', ({ agent }) => {
      const deny = SPAWN_TOOLS.filter(tool => {
        try {
          return Boolean(ctx.tools.get(tool))
        } catch {
          return false
        }
      })
      if (deny.length > 0) {
        try {
          agent.ctx.tools.restrict({ deny })
        } catch {}
      }
    })
    return
  }
  const types = policy?.types ?? []
  const admission = new Admission(policy?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, policy?.limitBehavior ?? 'queue')
  /** callId -> record */
  const records = new Map()
  /** child agent id -> record */
  const byChild = new Map()
  let seq = 0

  const cancelRecord = (record, reason) => {
    if (record.status !== 'running' && record.status !== 'queued') return false
    record.cancelRequested = true
    record.controller.abort(new Error(reason))
    return true
  }

  const controlDir = process.env.CODSH_SUBAGENT_CONTROL
  if (controlDir) {
    const timer = setInterval(() => {
      let names
      try {
        if (!statSync(controlDir).isDirectory()) return
        names = readdirSync(controlDir).filter(name => name.endsWith('.json')).sort()
      } catch {
        return
      }
      for (const file of names) {
        const path = join(controlDir, file)
        let command
        try {
          command = JSON.parse(readFileSync(path, 'utf8'))
        } catch {
          command = null
        }
        try {
          rmSync(path, { force: true })
        } catch {}
        if (!command || command.action !== 'cancel' || typeof command.id !== 'string') continue
        const record = records.get(command.id)
        if (!record) {
          emit({ event: 'refused', id: command.id, detail: 'no such subagent in this session' })
          continue
        }
        if (!cancelRecord(record, 'subagent cancelled by the user')) {
          emit({ event: 'refused', id: command.id, detail: `subagent already ${record.status}` })
        }
      }
    }, 150)
    timer.unref?.()
    ctx.on('dispose', () => clearInterval(timer))
  }

  // Child activity for the board: the tool a running child just called.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    if (agent?.session?.header?.origin === 'subagent') {
      const record = byChild.get(agent.id)
      if (record && record.status === 'running') emit({ event: 'activity', id: record.id, tool: exec.name })
    }
    return next()
  })

  const typeNames = types.map(type => type.name)
  const defaultType = typeNames.includes('general-purpose') ? 'general-purpose' : typeNames[0]

  ctx.tools.register(defineTool({
    name: 'subagent',
    description: `Delegate a self-contained task to a subagent: a separate dsh agent with its own context. It does not see this conversation, so give it a complete prompt. Choose subagent_type to limit what it may do. By default this call waits and returns the subagent's final answer. Set run_in_background: true to get a job id at once; collect the result with job_output and stop it with job_kill.\nAvailable types:\n${describeTypes(types)}`,
    parameters: {
      description: { type: 'string', required: true, description: 'A short (3-5 word) description of the task, for display.' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the subagent.' },
      subagent_type: {
        type: 'string',
        description: `Which subagent type to run. One of: ${typeNames.join(', ') || '(none)'}. Defaults to ${defaultType ?? '(none)'}.`,
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run as a background job and return its id. Defaults to false.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (error) throw new Error(`subagent policy refused: ${error}`)
      const parent = exec.agent
      if (!parent) throw new Error('subagent tool requires a calling agent')
      const typeName = typeof args.subagent_type === 'string' && args.subagent_type.trim() ? args.subagent_type.trim() : defaultType
      const type = types.find(candidate => candidate.name === typeName)
      if (!type) {
        throw new Error(`unknown or disabled subagent type "${typeName}"; available: ${typeNames.join(', ') || '(none)'}`)
      }
      const depth = agentDepth(parent) + 1
      if (depth > policy.maxDepth) {
        throw new Error(`subagent depth ${depth} exceeds maxDepth ${policy.maxDepth}; this agent cannot spawn subagents`)
      }
      const lastLevel = depth >= policy.maxDepth
      const parentTools = [...ctx.tools.view(parent).visible.keys()]
      const allow = childAllowList(parentTools, type, lastLevel)
      const parentOptions = parent.options ?? {}
      const provider = type.provider ?? parentOptions.provider
      const model = type.model ?? parentOptions.model
      if (type.model) {
        const llm = ctx.get('llm')
        if (!llm) throw new Error('cannot resolve the subagent model because the llm service is unavailable')
        try {
          await llm.resolveCallConfig({ provider, model }, exec.signal)
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause)
          emit({ event: 'refused', id: exec.callId, type: type.name, label: args.description, detail: `no available model ${provider}/${model}` })
          throw new Error(`subagent type "${type.name}" model ${provider}/${model} is not available: ${detail}`)
        }
      }
      exec.signal.throwIfAborted()
      const background = args.run_in_background === true
      const id = typeof exec.callId === 'string' && exec.callId ? exec.callId : `subagent-${++seq}`
      const root = rootSessionOf(ctx, parent)
      const controller = new AbortController()
      const record = {
        id,
        status: 'queued',
        controller,
        cancelRequested: false,
        type: type.name,
      }
      records.set(id, record)
      const prompt = type.instructions
        ? `<system-reminder>\n${type.instructions}\n</system-reminder>\n\n${args.prompt}`
        : String(args.prompt)
      const request = {
        label: String(args.description ?? type.name),
        prompt: [{ type: 'text', text: prompt }],
        parent,
        maxDepth: policy.maxDepth,
        ...type.model ? { agentOptions: { provider, model } } : {},
        ...type.capability === 'all' && !type.tools && !lastLevel ? {} : { toolFilter: { allow } },
      }
      const base = {
        id,
        type: type.name,
        label: request.label,
        model: `${provider ?? ''}/${model ?? ''}`,
        background,
        parentSession: parent.id,
        depth,
        tools: type.capability === 'all' && !type.tools && !lastLevel ? null : allow,
      }
      const run = async signal => {
        await admission.acquire(root, signal, () => {
          emit({ ...base, event: 'queued', running: admission.count(root), limit: admission.limit })
        })
        let started
        const startedAt = Date.now()
        try {
          record.status = 'running'
          started = await ctx.subagents.start('spawn', { ...request, signal })
          const child = started.localAgent
          if (child?.id) {
            record.childId = child.id
            byChild.set(child.id, record)
          }
          emit({ ...base, event: 'start', child: record.childId ?? started.id })
          const result = await started.result
          return { result, startedAt }
        } catch (cause) {
          if (signal.aborted) return { result: { stopReason: 'aborted', output: [] }, startedAt }
          throw cause
        } finally {
          admission.release(root)
          if (started) {
            try {
              await started.dispose()
            } catch {}
          }
        }
      }
      const finish = (outcome, startedAt, failure) => {
        const elapsedMs = Date.now() - (startedAt ?? Date.now())
        let status
        let detail = ''
        if (failure !== undefined) {
          status = controller.signal.aborted ? 'cancelled' : 'failed'
          detail = failure instanceof Error ? failure.message : String(failure)
        } else if (outcome.stopReason === 'completed') {
          status = 'completed'
          detail = outputText(outcome.output).slice(0, 400)
        } else if (outcome.stopReason === 'aborted') {
          status = 'cancelled'
          detail = stopReasonError('aborted')
        } else {
          status = 'failed'
          detail = [stopReasonError(outcome.stopReason), outcome.diagnostic].filter(Boolean).join(': ')
        }
        record.status = status
        if (record.childId) byChild.delete(record.childId)
        emit({ ...base, event: 'end', status, detail, elapsedMs, child: record.childId })
        return status
      }
      if (background) {
        const jobs = ctx.get('jobs')
        if (!jobs) throw new Error('background subagents need the dsh jobs service')
        if (policy.limitBehavior === 'fail' && admission.count(root) >= admission.limit) {
          records.delete(id)
          emit({ ...base, event: 'refused', detail: LIMIT_MESSAGE(admission.limit) })
          throw new Error(LIMIT_MESSAGE(admission.limit))
        }
        const jobId = jobs.start({
          kind: 'subagent',
          label: request.label,
          owner: parent,
          run: () => ({
            cancel: reason => {
              record.cancelRequested = true
              controller.abort(new Error(String(reason ?? 'background subagent job killed')))
            },
            done: run(controller.signal).then(({ result, startedAt }) => {
              const status = finish(result, startedAt)
              if (status === 'completed') return { status: 'completed', output: outputText(result.output) }
              if (status === 'cancelled') return { status: 'killed' }
              return { status: 'failed', detail: [stopReasonError(result.stopReason), result.diagnostic].filter(Boolean).join('\nDiagnostic: ') }
            }, failure => {
              const status = finish(undefined, undefined, failure)
              return status === 'cancelled' ? { status: 'killed' } : { status: 'failed', detail: String(failure instanceof Error ? failure.message : failure) }
            }),
          }),
        })
        record.jobId = jobId
        emit({ ...base, event: 'job', job: jobId })
        return `started background subagent job ${jobId} (${type.name}). Collect the result with job_output and stop it with job_kill.`
      }
      const onParentAbort = () => controller.abort(exec.signal.reason ?? new Error('parent turn cancelled'))
      if (exec.signal.aborted) onParentAbort()
      else exec.signal.addEventListener('abort', onParentAbort, { once: true })
      try {
        let settled
        try {
          settled = await run(controller.signal)
        } catch (failure) {
          finish(undefined, undefined, failure)
          throw failure
        }
        const { result, startedAt } = settled
        const status = finish(result, startedAt)
        if (status === 'completed') return outputText(result.output)
        const headline = record.cancelRequested && !exec.signal.aborted
          ? 'subagent run was cancelled by the user'
          : stopReasonError(result.stopReason) ?? 'subagent run was cancelled'
        const partial = outputText(result.output)
        throw new Error(`${headline}${result.diagnostic ? `\nDiagnostic: ${result.diagnostic}` : ''}${partial ? `\nPartial output before the run ended:\n${partial}` : ''}`)
      } finally {
        exec.signal.removeEventListener('abort', onParentAbort)
      }
    },
  }))
}
