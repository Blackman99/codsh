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
 *     workflowMaxConcurrent,
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
 * - isolation: "worktree" (ticket 174) runs the child in a new git worktree
 *   of the parent's repository (rust-worktree.mjs, type `subagent`). The
 *   child's session cwd is the worktree, so its tools and the permission
 *   listener see the worktree. Nothing is applied to the parent checkout:
 *   the result names the worktree and the explicit apply command. A worktree
 *   with no change is removed when the child ends; one with changes is kept,
 *   whatever the outcome (completed, failed, cancelled).
 *
 * - Scheduled prompts (ticket 177, rust-acp-scheduler.mjs) fire as
 *   background children of this plugin, so each fire gets the same type,
 *   admission, permission listener, board line and dsh job as a
 *   run_in_background call. The scheduler exists only in the interactive
 *   client (CODSH_SCHEDULER=1) and only while subagents are enabled.
 *
 * - Messages and continuation (ticket 173, rust-acp-subagent-messages.mjs).
 *   A settled `subagent` child stays live (at most MAX_RESIDENT_CHILDREN, the
 *   oldest released first) so `resume_from` can seed a new child with its
 *   transcript and model. With `activeAgentMessages` the flag-gated
 *   `send_subagent_message` tool reaches one owned child: a running child
 *   takes the message into its own dsh inbox (steer, queue, or interject);
 *   a queued one keeps it until it starts; a completed one wakes with it as
 *   its next turn, as a dsh job of the same child agent. A cancelled,
 *   workflow, scheduled, verifier, isolated, released, or unknown child is
 *   refused with the reference outcome; nothing survives a restart, so a
 *   stale id can never resume anything.
 *
 * Lifecycle lines go to stderr as `\u241esubagent\u241e{json}` so the Rust
 * client can keep one board. CODSH_SUBAGENT_CONTROL names a private directory
 * where the client drops `<n>.json` files ({"action":"cancel","id":callId}).
 */
export const name = 'rust-acp-subagents'
export const inject = ['tools', 'subagents']

import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { importFromDsh } from './rust-acp-dsh.mjs'
import { changedPaths, createWorktree, poolDir, removeWorktree, workAtRisk } from './rust-worktree.mjs'
import { DEFAULT_MAX_CONCURRENT_AGENTS, DEPTH_MESSAGE, WORKFLOW_TOOL, registerWorkflow } from './rust-acp-workflow.mjs'
import { registerScheduler } from './rust-acp-scheduler.mjs'
import {
  DSH_MESSAGE_TOOLS,
  INVALID_TARGET,
  MAX_ADMISSIONS,
  MAX_ADMISSIONS_PER_CHILD,
  MAX_ATTEMPT_OUTBOUND,
  MAX_RESIDENT_CHILDREN,
  MAX_SENDER_TARGET_IN_FLIGHT,
  MESSAGE_TOOL,
  MESSAGE_TOOL_DESCRIPTION,
  RESUME_ERRORS,
  RESUME_FROM_DESCRIPTION,
  disposition,
  outcomeText,
  parseDelivery,
  relayText,
  resumeSource,
  sizeOutcome,
  validTarget,
} from './rust-acp-subagent-messages.mjs'
const { createUserMessage } = await importFromDsh('@deepseek-ai/dsh-llm')
const { defineTool } = await importFromDsh('@deepseek-ai/dsh-tools')

export const MARK = '\u241esubagent\u241e'
/** rust-acp-goal (ticket 180) takes its completion verifiers from here. */
export const GOAL_VERIFIER = Symbol.for('codsh.rust.goal-verifier')
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
const TASK_TOOLS = new Set(['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', MESSAGE_TOOL])
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
    workflowMaxConcurrent: DEFAULT_MAX_CONCURRENT_AGENTS,
    activeAgentMessages: false,
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
      workflowMaxConcurrent: positiveInt(value.workflowMaxConcurrent, DEFAULT_MAX_CONCURRENT_AGENTS),
      activeAgentMessages: value.activeAgentMessages === true,
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
    // Workflows launch only from a top-level session (reference).
    if (tool === WORKFLOW_TOOL) return false
    if (lastLevel && SPAWN_TOOLS.includes(tool)) return false
    if (wanted && !wanted.has(tool)) return false
    return allowsTool(type.capability, tool)
  })
}

/**
 * Reference capability intersection: a requested mode narrows the type's
 * mode and never widens it. read-write with execute leaves read-only.
 */
export function intersectCapability(requested, ceiling) {
  if (!requested) return ceiling
  if (!ceiling) return requested
  if (requested === 'all') return ceiling
  if (ceiling === 'all') return requested
  if (requested === 'read-only' || ceiling === 'read-only') return 'read-only'
  if (requested === ceiling) return requested
  return 'read-only'
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

/** dsh's turn outcome in the subagent seam's vocabulary (in-process driver). */
function turnStopReason(reason) {
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    case 'blocked': return 'refusal'
    default: return 'error'
  }
}

/**
 * Send one more user message to a finished, still-published child and wait
 * for that turn (ticket 182: the workflow output-contract retry resumes the
 * same child with its whole context, as the reference resumes the child
 * session). Reads the turn's last non-empty assistant message and its stop
 * reason from the events after the boundary, like dsh's in-process driver.
 */
export async function continueChild(child, prompt, signal, message, afterFollowup) {
  const boundary = child.session.snapshotEvents().length
  let cancelled = false
  const onAbort = () => {
    cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal?.aborted) onAbort()
    else {
      child.followup(message ?? createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      afterFollowup?.()
      await child.whenIdle()
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  let output = []
  let end
  for (const event of child.session.snapshotEvents(boundary)) {
    if (event.type === 'assistant/message' && event.data?.message?.content?.length > 0) output = event.data.message.content
    if (event.type === 'turn/end') end = event
  }
  const recorded = end ? turnStopReason(end.data?.reason) : 'error'
  return { output, stopReason: cancelled && recorded !== 'completed' ? 'aborted' : recorded }
}

/** A subagent result names the id that send_subagent_message and resume_from take. */
export function withSubagentId(text, id) {
  return `${text}${text ? '\n\n' : ''}[subagent_id: ${id}]`
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

/** Whether an agent is a subagent at any depth (its session came from a spawn). */
export function isChildAgent(agent) {
  return agent?.session?.header?.origin === 'subagent' || agentDepth(agent) > 0
}

/** Registered global tool names among `names` (restrict() rejects others). */
function registered(ctx, names) {
  return names.filter(tool => {
    try {
      return Boolean(ctx.tools.get(tool))
    } catch {
      return false
    }
  })
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

const bindGet = (target, key) => {
  const value = Reflect.get(target, key, target)
  return typeof value === 'function' ? value.bind(target) : value
}

/**
 * The parent as dsh's spawn sees it, with the session header cwd moved into
 * the worktree. dsh builds the child session from the parent header, so the
 * child starts (and persists) with the worktree cwd. Everything else,
 * including methods, is the real parent.
 */
export function parentInWorktree(parent, cwd) {
  const header = Object.freeze({ ...parent.session.header, cwd })
  const session = new Proxy(parent.session, { get: (target, key) => (key === 'header' ? header : bindGet(target, key)) })
  return new Proxy(parent, { get: (target, key) => (key === 'session' ? session : bindGet(target, key)) })
}

/**
 * The parent as the fork provider sees it for `resume_from` (ticket 173):
 * the provider seeds the new child with the balanced completed-turn prefix
 * of `parent.session.snapshotEvents()`, and that one read returns the
 * source child's log. Depth, lineage, cwd, and policy stay the real
 * parent's, so the resumed child is a sibling of its source.
 */
export function parentWithTranscriptOf(parent, source) {
  let used = false
  const session = new Proxy(parent.session, {
    get: (target, key) => {
      if (key !== 'snapshotEvents') return bindGet(target, key)
      return (...args) => {
        if (!used && args.length === 0) {
          used = true
          return source.session.snapshotEvents()
        }
        return target.snapshotEvents(...args)
      }
    },
  })
  return new Proxy(parent, { get: (target, key) => (key === 'session' ? session : bindGet(target, key)) })
}

/** Remove an isolated worktree that holds no change; describe one that does. */
export function settleWorktree(worktree) {
  let changed
  try {
    changed = changedPaths(worktree)
  } catch (cause) {
    return { kept: true, changed: null, note: `worktree ${worktree.path} was kept (its changes could not be read: ${cause instanceof Error ? cause.message : cause})` }
  }
  if (changed.length === 0 && workAtRisk(worktree).filter(reason => !reason.startsWith('commit ')).length === 0) {
    try {
      removeWorktree({ id: worktree.id, dropSnapshot: true })
      return { kept: false, changed: [], note: `The subagent changed no file; its worktree ${worktree.path} was removed.` }
    } catch (cause) {
      return { kept: true, changed: [], note: `The subagent changed no file; its worktree ${worktree.path} was kept (${cause instanceof Error ? cause.message : cause}).` }
    }
  }
  const list = changed.slice(0, 20).map(path => `  ${path}`).join('\n')
  return {
    kept: true,
    changed,
    note: `Worktree isolation: the subagent's changes stay in ${worktree.path} (branch ${worktree.branch}, ${changed.length} changed file(s) since its base). Nothing was applied to ${worktree.sourceRoot}.\n${list}${changed.length > 20 ? `\n  ... ${changed.length - 20} more` : ''}\nThe user applies them with /worktree apply ${worktree.id} (or codsh --rust worktree apply ${worktree.id}) and removes the worktree with /worktree rm ${worktree.id}.`,
  }
}

function describeTypes(types) {
  return types.map(type => `- ${type.name}: ${type.description || '(no description)'} [${type.capability}]`).join('\n')
}

export function apply(ctx) {
  const { policy, error } = readPolicy(process.env.CODSH_SUBAGENT_POLICY)
  if (policy && !policy.enabled) {
    // Disabled: no spawn tool reaches any agent, and a call that still
    // arrives is refused before dsh runs it. A goal has no verifier either.
    publishVerifier(ctx, { unavailable: 'subagents are disabled for this session' })
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (SPAWN_TOOLS.includes(exec.name) || exec.name === WORKFLOW_TOOL) return { kind: 'deny', reason: 'subagents are disabled for this session' }
      return next()
    }, true)
    ctx.on('agent/created', ({ agent }) => {
      const deny = registered(ctx, [...SPAWN_TOOLS, WORKFLOW_TOOL])
      if (deny.length > 0) {
        try {
          agent.ctx.tools.restrict({ deny })
        } catch {}
      }
    })
    // Nothing can fire a scheduled prompt here. A resumed session's saved
    // loops are listed as paused (and can be deleted), never run or lost.
    if (process.env.CODSH_SCHEDULER === '1') {
      registerScheduler(ctx, { isChildAgent: agent => isChildAgent(agent), refusal: null, paused: 'paused: subagents are off in this session, so the loop cannot fire; it stays saved' })
    }
    return
  }
  const types = policy?.types ?? []
  const admission = new Admission(policy?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, policy?.limitBehavior ?? 'queue')
  /** callId -> record */
  const records = new Map()
  /** child agent id -> record while it runs (board activity) */
  const byChild = new Map()
  /** child agent id -> record, for the child's whole life in this process (ticket 173) */
  const lineage = new Map()
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

  // Child sessions never receive the workflow tool, and a call that still
  // arrives from one is refused before dsh runs it.
  ctx.on('agent/created', ({ agent }) => {
    if (!isChildAgent(agent)) return
    const deny = registered(ctx, [WORKFLOW_TOOL])
    if (deny.length > 0) {
      try {
        agent.ctx.tools.restrict({ deny })
      } catch {}
    }
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === WORKFLOW_TOOL && isChildAgent(exec.agent)) return { kind: 'deny', reason: `workflow_depth_exceeded: ${DEPTH_MESSAGE}` }
    return next()
  }, true)

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

  /**
   * Resolve one child without starting it: type, depth, capability, tool
   * allow-list, model/effort preflight and isolation. Throws the refusal.
   * spec: { parent, id, typeName?, prompt, label?, model?, effort?,
   *         capability?, isolation?, background?, signal, workflow? }
   */
  async function planChild(spec) {
    if (error) throw new Error(`subagent policy refused: ${error}`)
    const parent = spec.parent
    const typeName = typeof spec.typeName === 'string' && spec.typeName.trim() ? spec.typeName.trim() : defaultType
    const type = types.find(candidate => candidate.name === typeName)
    if (!type) {
      throw new Error(`unknown or disabled subagent type "${typeName}"; available: ${typeNames.join(', ') || '(none)'}`)
    }
    const depth = agentDepth(parent) + 1
    if (depth > policy.maxDepth) {
      throw new Error(`subagent depth ${depth} exceeds maxDepth ${policy.maxDepth}; this agent cannot spawn subagents`)
    }
    const lastLevel = depth >= policy.maxDepth
    // A requested capability mode only narrows the type (reference intersection).
    const capability = spec.capability ? intersectCapability(spec.capability, type.capability) : type.capability
    const shaped = { ...type, capability }
    const parentTools = [...ctx.tools.view(parent).visible.keys()]
    // Workflow agents, verifiers, and scheduled fires are harness children:
    // they never get the messaging tool (reference curated toolsets).
    const allow = childAllowList(parentTools, shaped, lastLevel).filter(tool => !(spec.noMessaging && tool === MESSAGE_TOOL))
    const parentOptions = parent.options ?? {}
    // resume_from pins the source's route; a model override is ignored.
    const pinned = spec.resume?.options
    const provider = pinned ? pinned.provider : type.provider ?? parentOptions.provider
    const model = pinned ? pinned.model : spec.model ?? type.model ?? parentOptions.model
    const effort = pinned ? pinned.reasoningEffort : spec.effort
    const routed = Boolean(pinned || spec.model || type.model || effort)
    if (routed) {
      const llm = ctx.get('llm')
      if (!llm) throw new Error('cannot resolve the subagent model because the llm service is unavailable')
      try {
        await llm.resolveCallConfig({ provider, model, ...effort ? { reasoningEffort: effort } : {} }, spec.signal)
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        emit({ event: 'refused', id: spec.id, type: type.name, label: spec.label, detail: `no available model ${provider}/${model}${effort ? ` with effort ${effort}` : ''}` })
        if (pinned) throw new Error(RESUME_ERRORS.model(spec.resume.id, `${provider}/${model}`, detail))
        if (effort && /reasoning effort/i.test(detail)) throw new Error(`workflow agent effort "${effort}" is not available for model ${provider}/${model}: ${detail}`)
        throw new Error(`subagent type "${type.name}" model ${provider}/${model} is not available: ${detail}`)
      }
    }
    const isolation = spec.isolation === undefined || spec.isolation === null || spec.isolation === '' ? null : String(spec.isolation)
    if (isolation !== null && isolation !== 'worktree') throw new Error(`unknown isolation "${isolation}"; the only isolation is "worktree"`)
    if (isolation) {
      try {
        poolDir()
      } catch (cause) {
        throw new Error(`worktree isolation is unavailable: ${cause instanceof Error ? cause.message : cause}`)
      }
    }
    const unrestricted = capability === 'all' && !type.tools && !lastLevel && !(spec.noMessaging && parentTools.includes(MESSAGE_TOOL))
    const prompt = type.instructions
      ? `<system-reminder>\n${type.instructions}\n</system-reminder>\n\n${spec.prompt}`
      : String(spec.prompt)
    const request = {
      label: String(spec.label ?? type.name),
      prompt: [{ type: 'text', text: prompt }],
      parent,
      maxDepth: policy.maxDepth,
      ...routed ? { agentOptions: { provider, model, ...effort ? { reasoningEffort: effort } : {} } } : {},
      ...unrestricted ? {} : { toolFilter: { allow } },
    }
    const base = {
      id: spec.id,
      type: type.name,
      label: request.label,
      model: `${provider ?? ''}/${model ?? ''}`,
      background: spec.background === true,
      parentSession: parent.id,
      depth,
      tools: unrestricted ? null : allow,
      ...isolation ? { isolation } : {},
      ...spec.resume ? { resumedFrom: spec.resume.id } : {},
      ...spec.workflow ? { workflow: spec.workflow.name, workflowRun: spec.workflow.run, ...spec.workflow.phase ? { phase: spec.workflow.phase } : {} } : {},
    }
    return { type, request, base, isolation }
  }

  /**
   * One planned child: a board record plus `run(signal)` (admission, worktree,
   * dsh spawn, dispose) and `finish(...)` (status, board end, worktree
   * settlement). `admit` is { acquire(signal, onQueued), release(), count(),
   * limit }.
   */
  function childRun(plan, admit, { keepOpen = false, retain = false, origin = 'tool', seedFrom } = {}) {
    const { request, base, isolation, type } = plan
    const id = base.id
    const parent = request.parent
    const controller = new AbortController()
    // Ticket 173: the record is also the message target. `attempt` counts
    // this child's runs (a wake is a new attempt of the same child agent).
    const record = {
      id,
      status: 'queued',
      controller,
      cancelRequested: false,
      type: type.name,
      label: request.label,
      origin,
      parentSession: parent.id,
      parentAgent: parent,
      root: rootSessionOf(ctx, parent),
      base,
      attempt: 1,
      parked: [],
      pending: new Set(),
      finalizing: false,
      isolated: Boolean(isolation),
      pins: 0,
    }
    records.set(id, record)
    const run = async signal => {
      await admit.acquire(signal, () => {
        emit({ ...base, event: 'queued', running: admit.count(), limit: admit.limit })
      })
      let started
      const startedAt = Date.now()
      try {
        record.status = 'running'
        let spawnRequest = request
        if (seedFrom) {
          // resume_from: the fork provider seeds this child with the source's
          // completed turns. The source stays pinned (never released) until
          // the seed is read.
          spawnRequest = { ...spawnRequest, parent: parentWithTranscriptOf(parent, seedFrom.child) }
        }
        if (isolation) {
          // Created after admission so a queued child holds no directory.
          try {
            record.worktree = createWorktree({
              source: parent.session.header.cwd,
              label: `${String(request.label).slice(0, 24)} ${id.slice(-8)}`,
              type: 'subagent',
              parentSessionId: parent.id,
              ownerPid: process.pid,
            })
          } catch (cause) {
            throw new Error(`worktree isolation failed, so the subagent did not start: ${cause instanceof Error ? cause.message : cause}`)
          }
          base.worktree = record.worktree.path
          base.branch = record.worktree.branch
          spawnRequest = { ...spawnRequest, parent: parentInWorktree(spawnRequest.parent, record.worktree.sessionCwd) }
        }
        if (seedFrom) seedFrom.pins += 1
        try {
          started = await ctx.subagents.start(seedFrom ? 'fork' : 'spawn', { ...spawnRequest, signal })
        } finally {
          if (seedFrom) seedFrom.pins -= 1
        }
        const child = started.localAgent
        if (child?.id) {
          record.childId = child.id
          record.child = child
          byChild.set(child.id, record)
          lineage.set(child.id, record)
        }
        emit({ ...base, event: 'start', child: record.childId ?? started.id })
        // Messages that arrived while this child waited for a slot.
        if (record.child) deliverParked(record)
        const result = await started.result
        record.finalizing = true
        if (keepOpen && result.stopReason === 'completed' && !signal.aborted) {
          // Held for a follow-up turn; the holder disposes it (ticket 182).
          const held = started
          started = undefined
          return { result, startedAt, held }
        }
        if (retain && record.child && !isolation) {
          // Kept live for a message (wake) or resume_from; released oldest
          // first, or with its parent session.
          record.held = started
          started = undefined
        }
        return { result, startedAt }
      } catch (cause) {
        if (signal.aborted) return { result: { stopReason: 'aborted', output: [] }, startedAt }
        throw cause
      } finally {
        admit.release()
        if (started) {
          try {
            await started.dispose()
          } catch {}
        }
      }
    }
    const finish = (outcome, startedAt, failure, override) => {
      const elapsedMs = Date.now() - (startedAt ?? Date.now())
      let status
      let detail = ''
      if (override) {
        status = override.status
        detail = override.detail ?? ''
      } else if (failure !== undefined) {
        status = record.controller.signal.aborted ? 'cancelled' : 'failed'
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
      settleMessages(record)
      if (record.worktree) {
        record.settled = settleWorktree(record.worktree)
        if (!record.settled.kept) delete base.worktree
      }
      emit({ ...base, event: 'end', status, detail, elapsedMs, child: record.childId, ...record.attempt > 1 ? { attempt: record.attempt } : {}, ...record.settled ? { worktreeKept: record.settled.kept, changedFiles: record.settled.changed?.length ?? null } : {} })
      return status
    }
    record.finish = finish
    const withWorktree = text => (record.settled ? `${text}${text ? '\n\n' : ''}${record.settled.note}` : text)
    return { record, controller, run, finish, withWorktree }
  }

  /**
   * A finished child kept open for one more turn (the workflow output
   * contract, ticket 182). `resume(prompt, signal)` runs that turn;
   * `close({ status, detail })` disposes the child and ends its board row
   * with the holder's verdict. Cancelling the child's own controller
   * (/tasks) or `signal` cancels a running follow-up turn.
   */
  function holdSession(child, held, startedAt) {
    const { record, controller, finish, withWorktree } = child
    let closed
    const close = async (verdict = {}) => {
      if (closed) return closed
      closed = (async () => {
        try {
          await held.dispose()
        } catch {}
        const aborted = controller.signal.aborted
        const status = verdict.status === 'completed' && !aborted ? 'completed' : verdict.status === 'cancelled' || aborted ? 'cancelled' : 'failed'
        finish(undefined, startedAt, undefined, { status, detail: String(verdict.detail ?? '').slice(0, 400) })
        return status
      })()
      return closed
    }
    return {
      childId: record.childId,
      async resume(prompt, signal) {
        if (closed) throw new Error('the subagent was already closed')
        const both = new AbortController()
        const relay = () => both.abort()
        for (const source of [signal, controller.signal]) {
          if (source?.aborted) both.abort()
          else source?.addEventListener('abort', relay, { once: true })
        }
        try {
          const result = await continueChild(held.localAgent, prompt, both.signal)
          if (result.stopReason === 'completed') return { status: 'completed', text: outputText(result.output) }
          const status = result.stopReason === 'aborted' ? 'cancelled' : 'failed'
          const headline = record.cancelRequested ? 'subagent run was cancelled by the user' : stopReasonError(result.stopReason)
          const partial = outputText(result.output)
          await close({ status, detail: headline })
          return { status, text: withWorktree(`${headline}${partial ? `\nPartial output before the run ended:\n${partial}` : ''}`) }
        } finally {
          for (const source of [signal, controller.signal]) source?.removeEventListener('abort', relay)
        }
      },
      close,
      withWorktree,
    }
  }

  /** Wait for a foreground child; `signal` is the caller's (parent turn or run). */
  async function runForeground(child, signal) {
    const { record, controller, run, finish, withWorktree } = child
    const onParentAbort = () => controller.abort(signal.reason ?? new Error('parent turn cancelled'))
    if (signal.aborted) onParentAbort()
    else signal.addEventListener('abort', onParentAbort, { once: true })
    try {
      let settled
      try {
        settled = await run(controller.signal)
      } catch (failure) {
        const status = finish(undefined, undefined, failure)
        const text = withWorktree(failure instanceof Error ? failure.message : String(failure))
        return { status, text, failure, record }
      }
      const { result, startedAt, held } = settled
      if (held) return { status: 'completed', text: outputText(result.output), record, session: holdSession(child, held, startedAt) }
      const status = finish(result, startedAt)
      if (status === 'completed') return { status, text: withWorktree(outputText(result.output)), record }
      const headline = record.cancelRequested && !signal.aborted
        ? 'subagent run was cancelled by the user'
        : stopReasonError(result.stopReason) ?? 'subagent run was cancelled'
      const partial = outputText(result.output)
      return {
        status,
        text: withWorktree(`${headline}${result.diagnostic ? `\nDiagnostic: ${result.diagnostic}` : ''}${partial ? `\nPartial output before the run ended:\n${partial}` : ''}`),
        record,
      }
    } finally {
      signal.removeEventListener('abort', onParentAbort)
    }
  }

  const sessionAdmit = root => ({
    acquire: (signal, onQueued) => admission.acquire(root, signal, onQueued),
    release: () => admission.release(root),
    count: () => admission.count(root),
    limit: admission.limit,
  })


  // ---- Messages and continuation (ticket 173) ----------------------------
  const activeMessages = policy?.activeAgentMessages === true && !error
  /** Settled children kept live, oldest first. */
  const resident = []
  /** Accepted messages not yet claimed by the target's dsh driver: id -> entry. */
  const pendingMessages = new Map()
  /** child agent id -> abort controllers of its blocking job_output waits. */
  const waits = new Map()

  const liveStatus = status => status === 'running' || status === 'queued'

  function track(record, message, senderKey) {
    record.pending.add(message.id)
    pendingMessages.set(message.id, { record, senderKey })
  }

  function forget(record, messageId) {
    record.pending.delete(messageId)
    pendingMessages.delete(messageId)
  }

  // dsh claims a message when its driver takes it into a turn.
  ctx.on('agent/inbox/claimed', ({ message }) => {
    const entry = message?.id === undefined ? undefined : pendingMessages.get(message.id)
    if (entry) forget(entry.record, message.id)
  })

  /** Put one accepted message into the child's own dsh inbox. */
  function place(record, message, delivery) {
    const child = record.child
    if (delivery === 'queue') {
      child.followup(message)
      return
    }
    if (delivery === 'interject') {
      // Ahead of pending steers, and a blocking background wait ends now
      // (only the wait: the job keeps running).
      try {
        child.inbox.prepend('next-step', message)
      } catch {
        child.steer(message)
      }
      for (const wait of waits.get(child.id) ?? []) wait.abort(new Error('interjected message'))
      return
    }
    child.steer(message)
  }

  function deliverParked(record) {
    for (const { message, delivery } of record.parked.splice(0)) {
      try {
        place(record, message, delivery)
      } catch {
        forget(record, message.id)
      }
    }
  }

  /** A run ended: nothing parked or unclaimed survives it; keep the child live if held. */
  function settleMessages(record) {
    for (const { message } of record.parked.splice(0)) forget(record, message.id)
    for (const id of [...record.pending]) {
      // A cancelled run cleared its inbox; a completed one claimed everything.
      forget(record, id)
    }
    record.finalizing = false
    if (!record.held) return
    record.wakeEligible = record.status !== 'cancelled' && !record.cancelRequested
    const index = resident.indexOf(record)
    if (index >= 0) resident.splice(index, 1)
    resident.push(record)
    while (resident.filter(item => !liveStatus(item.status)).length > MAX_RESIDENT_CHILDREN) {
      const victim = resident.find(item => !liveStatus(item.status) && item.pins === 0)
      if (!victim) break
      releaseHeld(victim, 'released')
    }
  }

  function releaseHeld(record, reason) {
    const held = record.held
    const index = resident.indexOf(record)
    if (index >= 0) resident.splice(index, 1)
    if (!held) return
    record.held = undefined
    record.released = reason
    record.wakeEligible = false
    if (liveStatus(record.status)) record.controller.abort(new Error(`subagent ${reason}`))
    held.dispose().catch(() => {})
  }

  // A parent session that goes away takes its live children with it.
  ctx.on('agent/disposed', ({ agent }) => {
    for (const record of records.values()) {
      if (record.parentSession === agent?.id && record.held) releaseHeld(record, 'released with its parent session')
    }
  })
  ctx.on('dispose', () => {
    for (const record of [...resident]) releaseHeld(record, 'released at shutdown')
  })

  /** Whether `sender` (a top-level session) owns `record` through the child lineage. */
  function ownedBy(record, sender) {
    let current = record
    for (let guard = 0; guard < 64 && current; guard += 1) {
      if (current.parentSession === sender.id) return true
      current = lineage.get(current.parentSession)
    }
    return false
  }

  /** The record a known id names: a subagent_id (call id) or a child agent id. */
  function lookup(id) {
    return records.get(id) ?? lineage.get(id)
  }

  const rejected = outcome => ({ outcome })

  /**
   * Route one message. Returns the reference outcome, plus the resolved
   * target record when the sender owns it (for the transcript row).
   */
  function sendMessage(sender, targetId, text, delivery) {
    const senderRecord = lineage.get(sender.id)
    if (isChildAgent(sender) && (!senderRecord || senderRecord.origin !== 'tool')) return rejected('unsupported')
    let target
    if (targetId === 'parent') {
      // Only a subagent has a parent it may message, and only an active
      // parent subagent (a top-level session is never a target).
      target = senderRecord ? lineage.get(senderRecord.parentSession) : undefined
      if (!target || target.released) return rejected('not_found_or_not_owned')
    } else {
      target = lookup(targetId)
      if (!target || target.released || target === senderRecord) return rejected('not_found_or_not_owned')
      if (senderRecord ? target.root !== senderRecord.root : !ownedBy(target, sender)) return rejected('not_found_or_not_owned')
    }
    const size = sizeOutcome(text)
    if (size) return { ...size, target }
    const refuse = outcome => ({ outcome, target })
    // Workflow agents, scheduled fires, and verifiers belong to their harness.
    if (target.origin !== 'tool') return refuse('not_active_or_finalizing')
    if (targetId === 'parent' && (target.status !== 'running' || target.finalizing)) return refuse('not_active_or_finalizing')
    if (target.status === 'cancelled') return refuse('not_active_or_finalizing')
    if (target.pending.size >= MAX_ADMISSIONS_PER_CHILD) return { outcome: 'saturated', max_in_flight: MAX_ADMISSIONS_PER_CHILD, target }
    if (pendingMessages.size >= MAX_ADMISSIONS) return { outcome: 'saturated', max_in_flight: MAX_ADMISSIONS, target }
    let senderKey
    if (senderRecord) {
      senderKey = `${senderRecord.id}#${senderRecord.attempt}`
      if (senderRecord.outboundAttempt !== senderRecord.attempt) {
        senderRecord.outboundAttempt = senderRecord.attempt
        senderRecord.outbound = 0
      }
      if (senderRecord.outbound >= MAX_ATTEMPT_OUTBOUND) return { outcome: 'quota_exceeded', kind: 'AttemptOutbound', limit: MAX_ATTEMPT_OUTBOUND, target }
      let inFlight = 0
      for (const entry of pendingMessages.values()) if (entry.senderKey === senderKey && entry.record === target) inFlight += 1
      if (inFlight >= MAX_SENDER_TARGET_IN_FLIGHT) return { outcome: 'quota_exceeded', kind: 'SenderTargetInFlight', limit: MAX_SENDER_TARGET_IN_FLIGHT, target }
    }
    const from = senderRecord ? `Subagent ${senderRecord.id}` : 'Your parent agent'
    const message = createUserMessage({
      content: [{ type: 'text', text: relayText(from, text) }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: sender.id },
    })
    const accept = extra => {
      if (senderRecord) senderRecord.outbound += 1
      return { outcome: 'accepted', message_id: message.id, target, ...extra }
    }
    if (target.status === 'queued' || (target.status === 'running' && !target.child)) {
      // Not started yet (waiting for a slot, or dsh is still publishing the
      // child): it takes the message when it starts.
      track(target, message, senderKey)
      target.parked.push({ message, delivery })
      return accept()
    }
    if (target.status === 'running') {
      const child = target.child
      if (target.finalizing || !child || child.status !== 'running') return refuse('not_active_or_finalizing')
      track(target, message, senderKey)
      try {
        place(target, message, delivery)
      } catch {
        forget(target, message.id)
        return refuse('channel_closed')
      }
      return accept()
    }
    // Completed or failed: an eligible child wakes with the message as its
    // next turn. One that ran isolated, or was released, cannot.
    if (!target.held || !target.wakeEligible) return refuse('not_active_or_finalizing')
    const jobs = ctx.get('jobs')
    if (!jobs) return refuse('unsupported')
    if (policy.limitBehavior === 'fail' && admission.count(target.root) >= admission.limit) return refuse('not_active_or_finalizing')
    track(target, message, senderKey)
    let jobId
    try {
      jobId = wake(target, message, jobs)
    } catch {
      forget(target, message.id)
      return refuse('channel_closed')
    }
    return accept({ job: jobId })
  }

  /** A new background attempt of the same child agent, as a dsh job owned by its parent. */
  function wake(target, message, jobs) {
    const controller = new AbortController()
    target.attempt += 1
    target.status = 'queued'
    target.cancelRequested = false
    target.controller = controller
    target.wakeEligible = false
    target.base.background = true
    emit({ ...target.base, event: 'resume', attempt: target.attempt, child: target.childId })
    const jobId = jobs.start({
      kind: 'subagent',
      label: target.label,
      owner: target.parentAgent,
      run: () => ({
        cancel: reason => {
          target.cancelRequested = true
          controller.abort(new Error(String(reason ?? 'background subagent job killed')))
        },
        done: runWake(target, message, controller),
      }),
    })
    target.jobId = jobId
    emit({ ...target.base, event: 'job', job: jobId })
    return jobId
  }

  async function runWake(target, message, controller) {
    const admit = sessionAdmit(target.root)
    let startedAt
    let result
    try {
      await admit.acquire(controller.signal, () => {
        emit({ ...target.base, event: 'queued', running: admit.count(), limit: admit.limit })
      })
    } catch (failure) {
      const status = target.finish(undefined, undefined, failure)
      return status === 'cancelled' ? { status: 'killed' } : { status: 'failed', detail: failure instanceof Error ? failure.message : String(failure) }
    }
    try {
      startedAt = Date.now()
      target.status = 'running'
      target.finalizing = false
      byChild.set(target.childId, target)
      emit({ ...target.base, event: 'start', child: target.childId, attempt: target.attempt })
      result = await continueChild(target.child, '', controller.signal, message, () => deliverParked(target))
      target.finalizing = true
    } catch (failure) {
      const status = target.finish(undefined, startedAt, failure)
      return status === 'cancelled' ? { status: 'killed' } : { status: 'failed', detail: failure instanceof Error ? failure.message : String(failure) }
    } finally {
      admit.release()
    }
    const status = target.finish(result, startedAt)
    if (status === 'completed') return { status: 'completed', output: withSubagentId(outputText(result.output), target.id) }
    if (status === 'cancelled') return { status: 'killed' }
    return { status: 'failed', detail: [stopReasonError(result.stopReason), result.diagnostic].filter(Boolean).join('\nDiagnostic: ') }
  }

  if (activeMessages) {
    // An interject ends a subagent's blocking job_output wait early. The
    // wait's error becomes a plain note; the job keeps running.
    ctx.on('tools/execute', async (exec, next) => {
      const agent = exec.agent
      if (exec.name !== 'job_output' || exec.arguments?.wait !== true || !agent || !lineage.has(agent.id)) return next()
      const wait = new AbortController()
      const original = exec.signal
      const relay = () => wait.abort(original.reason)
      if (original.aborted) relay()
      else original.addEventListener('abort', relay, { once: true })
      const set = waits.get(agent.id) ?? new Set()
      set.add(wait)
      waits.set(agent.id, set)
      exec.signal = wait.signal
      let result
      try {
        result = await next()
      } finally {
        exec.signal = original
        original.removeEventListener('abort', relay)
        set.delete(wait)
        if (set.size === 0) waits.delete(agent.id)
      }
      if (result?.isError && wait.signal.aborted && !original.aborted) {
        const note = 'The wait ended early because an interjected message arrived. The job is still running; read it again with job_output.'
        return { ...result, content: [{ type: 'text', text: note }], error: { ...result.error, message: note } }
      }
      return result
    })

    ctx.tools.register(defineTool({
      name: MESSAGE_TOOL,
      description: MESSAGE_TOOL_DESCRIPTION,
      parameters: {
        subagent_id: { type: 'string', required: true, description: '`parent` or the durable agent ID of the target subagent.' },
        text: { type: 'string', required: true, description: 'The message to deliver.' },
        delivery: {
          type: 'string',
          enum: ['steer', 'queue', 'interject'],
          description: 'How the message lands on an active subagent: steer (default), queue, or interject.',
        },
        queue: { type: 'boolean', description: 'Legacy form of delivery "queue"; delivery wins when both are set.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, result) => [{ type: 'text', text: result }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sender = exec.agent
        if (!sender) throw new Error(`${MESSAGE_TOOL} requires a calling agent`)
        const targetId = validTarget(args.subagent_id)
        if (!targetId) throw new Error(INVALID_TARGET)
        const delivery = parseDelivery(args)
        const text = typeof args.text === 'string' ? args.text : ''
        const row = { event: 'message', id: exec.callId, target: targetId, delivery, text: text.slice(0, 4000) }
        emit({ ...row, state: 'sending' })
        const outcome = sendMessage(sender, targetId, text, delivery)
        const shown = outcome.target
        const reason = outcomeText(outcome)
        emit({
          ...row,
          state: disposition(outcome),
          outcome: outcome.outcome,
          reason,
          ...shown ? { subagent: shown.id, type: shown.type, label: shown.label, parent: targetId === 'parent' } : {},
          ...outcome.job ? { job: outcome.job } : {},
        })
        if (outcome.job) {
          return `${reason}\nThe subagent had completed, so it resumed with this message as its next turn in background job ${outcome.job}. Collect its answer with job_output and stop it with job_kill.`
        }
        return reason
      },
    }))

    // One messaging path: dsh's send_message and interrupt_agent reach only
    // continuable children, which this client never starts.
    ctx.on('agent/created', ({ agent }) => {
      const deny = registered(ctx, DSH_MESSAGE_TOOLS)
      if (deny.length > 0) {
        try {
          agent.ctx.tools.restrict({ deny })
        } catch {}
      }
    })
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (DSH_MESSAGE_TOOLS.includes(exec.name)) return { kind: 'deny', reason: `use ${MESSAGE_TOOL} to message a subagent in this client` }
      return next()
    }, true)
  }

  ctx.tools.register(defineTool({
    name: 'subagent',
    description: `Delegate a self-contained task to a subagent: a separate dsh agent with its own context. It does not see this conversation, so give it a complete prompt. Choose subagent_type to limit what it may do. By default this call waits and returns the subagent's final answer. Set run_in_background: true to get a job id at once; collect the result with job_output and stop it with job_kill. Every result names the subagent_id; pass it as resume_from to continue that subagent's conversation in a new subagent${activeMessages ? `, or to ${MESSAGE_TOOL} to message it` : ''}.\nAvailable types:\n${describeTypes(types)}`,
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
      isolation: {
        type: 'string',
        enum: ['worktree'],
        description: 'Set to "worktree" to run the subagent in a new git worktree of this repository. Its edits stay there and are not applied to this checkout; the result names the worktree so the user can review and apply it.',
      },
      resume_from: {
        type: 'string',
        description: `${RESUME_FROM_DESCRIPTION} The new subagent inherits its transcript and model; the source must have finished, belong to this session, and use the same subagent_type.`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('subagent tool requires a calling agent')
      const background = args.run_in_background === true
      const id = typeof exec.callId === 'string' && exec.callId ? exec.callId : `subagent-${++seq}`
      const resumeId = resumeSource(args.resume_from)
      let source
      if (resumeId !== undefined) {
        // Ticket 173: only a finished child of this session, still live in
        // this process, with the same type. Nothing is read from disk, so a
        // restart or a released child cannot be resumed.
        source = lookup(resumeId)
        const senderRecord = lineage.get(parent.id)
        const owned = source && !source.released && source.origin === 'tool'
          && (senderRecord ? source.root === senderRecord.root && source !== senderRecord : ownedBy(source, parent))
        if (!owned) throw new Error(RESUME_ERRORS.missing(resumeId))
        if (liveStatus(source.status)) throw new Error(RESUME_ERRORS.running(resumeId))
        if (source.isolated) throw new Error(RESUME_ERRORS.isolated(resumeId))
        if (!source.held) throw new Error(RESUME_ERRORS.missing(resumeId))
        const requested = typeof args.subagent_type === 'string' && args.subagent_type.trim() ? args.subagent_type.trim() : source.type
        if (requested !== source.type) throw new Error(RESUME_ERRORS.type(requested, source.type))
      }
      const plan = await planChild({
        parent,
        id: exec.callId,
        typeName: source ? source.type : args.subagent_type,
        prompt: args.prompt,
        label: args.description,
        isolation: args.isolation,
        background,
        signal: exec.signal,
        ...source ? { resume: { id: source.id, options: source.child.options ?? {} } } : {},
      })
      plan.base.id = id
      exec.signal.throwIfAborted()
      if (source && (!source.held || liveStatus(source.status))) throw new Error(RESUME_ERRORS.missing(resumeId))
      const root = rootSessionOf(ctx, parent)
      const child = childRun(plan, sessionAdmit(root), { retain: true, origin: 'tool', ...source ? { seedFrom: source } : {} })
      const { record, controller, run, finish, withWorktree } = child
      const { base, request, type } = plan
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
              if (status === 'completed') return { status: 'completed', output: withSubagentId(withWorktree(outputText(result.output)), id) }
              if (status === 'cancelled') return record.settled ? { status: 'killed', detail: record.settled.note } : { status: 'killed' }
              return { status: 'failed', detail: withWorktree([stopReasonError(result.stopReason), result.diagnostic].filter(Boolean).join('\nDiagnostic: ')) }
            }, failure => {
              const status = finish(undefined, undefined, failure)
              return status === 'cancelled' ? (record.settled ? { status: 'killed', detail: record.settled.note } : { status: 'killed' }) : { status: 'failed', detail: withWorktree(String(failure instanceof Error ? failure.message : failure)) }
            }),
          }),
        })
        record.jobId = jobId
        emit({ ...base, event: 'job', job: jobId })
        return `started background subagent job ${jobId} (${type.name}). Collect the result with job_output and stop it with job_kill. Its subagent_id is ${id}.`
      }
      const settled = await runForeground(child, exec.signal)
      if (settled.failure !== undefined) {
        if (record.settled) throw new Error(settled.text)
        throw settled.failure
      }
      if (settled.status === 'completed') return withSubagentId(settled.text, id)
      throw new Error(settled.text)
    },
  }))

  // Workflows (ticket 181): each agent() call is a child of the calling
  // session, admitted by the run's own live-child cap.
  registerWorkflow(ctx, {
    isChildAgent: agent => isChildAgent(agent),
    emit,
    refusal: error ? `subagent policy refused: ${error}` : null,
    maxConcurrent: policy?.workflowMaxConcurrent,
    spawnChild: async spec => {
      const plan = await planChild({ ...spec, noMessaging: true })
      const child = childRun(plan, {
        acquire: () => Promise.resolve(),
        release: () => {},
        count: () => 0,
        limit: 0,
      }, { keepOpen: spec.keepOpen === true, origin: 'workflow' })
      const settled = await runForeground(child, spec.signal)
      if (settled.failure !== undefined && settled.status === 'failed' && !settled.record.childId && !settled.record.worktree) {
        // Nothing started (for example worktree creation failed): a host error.
        throw settled.failure
      }
      return { status: settled.status, text: settled.text, childId: settled.record.childId, session: settled.session }
    },
  })

  // Scheduled prompts (ticket 177): each fire is a background child owned
  // by the session that created the task. Its completion reaches that
  // session through dsh's tool-jobs notice, like any background subagent.
  if (process.env.CODSH_SCHEDULER === '1') {
    registerScheduler(ctx, {
      isChildAgent: agent => isChildAgent(agent),
      refusal: error ? `subagent policy refused: ${error}` : null,
      startFire: async ({ owner, task, prompt, label, shape, live }) => {
        const jobs = ctx.get('jobs')
        if (!jobs) throw new Error('scheduled fires need the dsh jobs service')
        const id = `loop-${task.id.slice(-12)}-${task.fire}`
        const plan = await planChild({ parent: owner, id, prompt, label, background: true, signal: new AbortController().signal, noMessaging: true })
        plan.base.id = id
        plan.base.schedule = task.id
        if (live && !live()) throw new Error('the task was deleted before this fire started')
        const root = rootSessionOf(ctx, owner)
        if (policy.limitBehavior === 'fail' && admission.count(root) >= admission.limit) {
          emit({ ...plan.base, event: 'refused', detail: LIMIT_MESSAGE(admission.limit) })
          throw new Error(LIMIT_MESSAGE(admission.limit))
        }
        const { record, controller, run, finish } = childRun(plan, sessionAdmit(root), { origin: 'schedule' })
        let settle = () => {}
        const done = new Promise(resolve => {
          settle = resolve
        })
        const failed = detail => {
          settle({ status: 'failed', text: detail })
          return { status: 'failed', detail }
        }
        let jobId
        try {
          jobId = jobs.start({
            kind: 'subagent',
            label: plan.request.label,
            owner,
            run: () => ({
              cancel: reason => {
                record.cancelRequested = true
                controller.abort(new Error(String(reason ?? 'scheduled fire killed')))
              },
              done: run(controller.signal).then(({ result, startedAt }) => {
                const status = finish(result, startedAt)
                if (status === 'completed') {
                  const text = outputText(result.output)
                  settle({ status, text })
                  const shaped = shape({ status, text })
                  return { status: 'completed', output: shaped.output, detail: shaped.detail }
                }
                if (status === 'cancelled') {
                  settle({ status: 'cancelled', text: '' })
                  return { status: 'killed' }
                }
                return failed([stopReasonError(result.stopReason), result.diagnostic].filter(Boolean).join('\nDiagnostic: '))
              }, failure => {
                const status = finish(undefined, undefined, failure)
                if (status === 'cancelled') {
                  settle({ status: 'cancelled', text: '' })
                  return { status: 'killed' }
                }
                return failed(String(failure instanceof Error ? failure.message : failure))
              }),
            }),
          })
        } catch (cause) {
          records.delete(id)
          throw cause
        }
        record.jobId = jobId
        emit({ ...plan.base, event: 'job', job: jobId })
        return { jobId, subagent: id, done }
      },
    })
  }
  // Goal completion verifiers (ticket 180): real dsh children of the goal's
  // agent, shown on the board like any other child. The goal plugin asks for
  // `execute` capability, so a verifier can read and run checks, never write.
  publishVerifier(ctx, error ? { unavailable: `subagent policy refused: ${error}` } : {
    spawn: async spec => {
      const plan = await planChild({ ...spec, noMessaging: true })
      const child = childRun(plan, { acquire: () => Promise.resolve(), release: () => {}, count: () => 0, limit: 0 }, { origin: 'verifier' })
      const settled = await runForeground(child, spec.signal)
      return { status: settled.status, text: settled.text, childId: settled.record.childId }
    },
  })
}

function publishVerifier(ctx, verifier) {
  globalThis[GOAL_VERIFIER] = verifier
  ctx.on('dispose', () => {
    if (globalThis[GOAL_VERIFIER] === verifier) delete globalThis[GOAL_VERIFIER]
  })
}
