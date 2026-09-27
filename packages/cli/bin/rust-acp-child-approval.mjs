/**
 * Subagent approvals in the main session (#220). Used by rust-acp-control.mjs.
 *
 * A child agent (a workflow researcher, a `task` subagent) asks through the
 * same `approval/request` waterfall as the top-level session. dsh-acp only
 * answers for the ACP sessions it owns, so before this a child's ask fell
 * through to `unavailable` and the call was refused ("permission mode ask").
 *
 * In the terminal UI (CODSH_INTERACTION=tui, control channel connected) this
 * router sends the request to the Rust client, which queues it behind the
 * main session's own permission prompt and shows who is asking: the
 * workflow or subagent, the tool, and the target. The Rust client answers
 * `allowed-once` or `rejected` (it records a remembered grant itself, the
 * same way it does for the main session). Every request settles exactly
 * once: an answer, the child's call being aborted (workflow cancel, Ctrl+C),
 * the root session going away, or the control channel closing.
 *
 * Reference (grok-build a28ee2b, xai-grok-pager acp_handler/permissions.rs):
 * a subagent's permission request joins the owning session's permission
 * queue, labelled `Subagent "<description>" (<type>)`. The reference cancels
 * the child's turn on a reject; codsh returns the refusal to the child as a
 * tool error, as a main-session reject does, and the child continues.
 *
 * Without a terminal (plain prompts, `agent stdio`, no control channel) no
 * one can answer: `next()` keeps the old refusal.
 */
import { randomUUID } from 'node:crypto'

export const CHILD_LINEAGE = Symbol.for('codsh.rust.subagent-lineage')

/** Outcomes the Rust client may send back. */
const OUTCOMES = new Set(['allowed-once', 'rejected'])

/** A delegated (subagent) agent: dsh records a nonzero delegation depth or a subagent origin. */
export function isChild(agent) {
  const runtime = agent?.options?.subagentDepth
  const header = agent?.session?.header
  return (Number.isSafeInteger(runtime) && runtime > 0)
    || (Number.isSafeInteger(header?.delegationDepth) && header.delegationDepth > 0)
    || (header?.origin === 'subagent' && typeof header?.parentSession === 'string')
}

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
}

/** Top-level session id of a child, following parentSession links. */
export function rootOf(agent, lookup) {
  let current = agent
  let id = sessionIdOf(agent)
  for (let guard = 0; guard < 64 && current; guard += 1) {
    const header = current.session?.header
    const parentId = header?.parentSession
    if (header?.origin !== 'subagent' || typeof parentId !== 'string' || parentId === '') return sessionIdOf(current) ?? id
    id = parentId
    current = lookup(parentId)
  }
  return id
}

function text(value, max = 200) {
  const out = typeof value === 'string' ? value : ''
  return out.length > max ? `${out.slice(0, max - 1)}…` : out
}

/**
 * @param {object} ctx - cordis context (`agents` via ctx.get, for the root walk).
 * @param {(message: object) => void} send - writes one control message.
 * @param {{ interactive: boolean, connected?: () => boolean, agents: Map<string, any>, lineage?: () => any }} options
 */
export function createChildApprovals(ctx, send, options) {
  const { interactive, agents } = options
  const connected = options.connected ?? (() => true)
  const lineage = options.lineage ?? (() => globalThis[CHILD_LINEAGE])
  const open = new Map()

  const lookup = (id) => {
    try {
      return ctx.get?.('agents')?.get?.(id)
    } catch {
      return undefined
    }
  }

  const settle = (id, outcome, closed) => {
    const entry = open.get(id)
    if (entry === undefined) return false
    open.delete(id)
    entry.signal?.removeEventListener?.('abort', entry.onAbort)
    if (closed !== undefined) send({ type: 'child_approval_closed', id, reason: closed })
    entry.resolve(outcome)
    return true
  }

  /** The `approval/request` handler: children of the interactive session only. */
  const request = (req, next) => {
    const agent = req?.agent
    if (agent === undefined || !isChild(agent)) return next()
    if (!interactive || !connected()) return next()
    let info
    try {
      info = lineage()?.describe?.(agent.id ?? sessionIdOf(agent))
    } catch {
      info = undefined
    }
    const root = typeof info?.root === 'string' && agents.has(info.root) ? info.root : rootOf(agent, lookup)
    // Only a child of a session this terminal owns is shown here.
    if (root === undefined || !agents.has(root)) return next()
    const signal = req.signal
    if (signal?.aborted) return 'cancelled'
    const id = `ca-${randomUUID()}`
    const message = {
      type: 'child_approval',
      id,
      sessionId: root,
      child: String(agent.id ?? sessionIdOf(agent) ?? ''),
      label: text(info?.label ?? agent.session?.header?.title),
      agentType: text(info?.type),
      ...info?.workflow ? { workflow: text(info.workflow), run: text(info.workflowRun) } : {},
      ...info?.phase ? { phase: text(info.phase) } : {},
      tool: String(req.toolName ?? ''),
      input: req.input !== null && typeof req.input === 'object' ? req.input : {},
    }
    return new Promise((resolve) => {
      const entry = { resolve, signal, root, child: message.child, onAbort: undefined }
      entry.onAbort = () => settle(id, 'cancelled', 'aborted')
      signal?.addEventListener?.('abort', entry.onAbort, { once: true })
      open.set(id, entry)
      send(message)
    })
  }

  return {
    request,
    /** Pending request ids (tests). */
    pending: () => [...open.keys()],
    /** A control message from the client; true when it was ours. */
    handle(message) {
      if (message?.type !== 'child_approval_answer') return false
      const outcome = OUTCOMES.has(message.outcome) ? message.outcome : 'rejected'
      if (!settle(message.id, outcome)) send({ type: 'child_approval_closed', id: message.id, reason: 'stale' })
      return true
    },
    /** A root session or a child went away: its requests are cancelled. */
    onDisposed(agent) {
      const id = sessionIdOf(agent)
      const agentId = agent?.id
      for (const [key, entry] of [...open]) {
        if (entry.root === id || entry.child === id || (agentId !== undefined && entry.child === agentId)) settle(key, 'cancelled', 'aborted')
      }
    },
    /** The control channel closed: no one can answer any more. */
    close() {
      for (const key of [...open.keys()]) settle(key, 'unavailable')
    },
  }
}
