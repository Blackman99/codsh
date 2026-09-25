/**
 * `/goal` for the Rust client (ticket 180): work toward one objective across
 * automatic rounds until an independent check confirms it.
 *
 * Nothing here runs a model loop of its own. dsh already ships the pieces and
 * this plugin composes them:
 *
 * - `@deepseek-ai/dsh-goal` (`ctx.goals`) owns the durable goal: objective,
 *   phase (active, paused, blocked, complete), round count and round cap.
 * - `@deepseek-ai/dsh-goal-round-driver` queues one `<goal_round>` follow-up
 *   whenever the agent is idle with an active, armed goal, and yields to
 *   human input.
 * - `@deepseek-ai/dsh-tool-goal` gives the model `get_goal`, `create_goal`
 *   and `update_goal`.
 *
 * This plugin adds what the reference has and dsh does not:
 *
 * - Human commands. The client sends `/goal <objective> [--budget N]`,
 *   `status`, `pause`, `resume` and `clear` over the control channel
 *   (rust-acp-control hands them to `command()` below).
 * - A token budget per goal, separate from the workflow agent-count budget.
 *   Every model response of the goal's session and of its subagents counts
 *   (input plus output tokens as the provider reports them) while the goal
 *   is active. At turn end, and again before the driver's next round enters
 *   its step, a goal at or over its budget is stopped (`budget-limited`).
 * - A completion gate. `update_goal` with `complete` is the model's claim,
 *   not the result. Before dsh applies it, independent verifier subagents
 *   (read and execute tools, no writes) inspect the workspace and each ends
 *   with `VERDICT: ACHIEVED` or `VERDICT: NOT_ACHIEVED`. Only a majority of
 *   ACHIEVED (a tie passes, as in the reference panel) lets the call through.
 *   Otherwise the call is refused with the gaps and the goal stays active.
 *   A verifier that fails or gives no verdict counts as NOT_ACHIEVED (the
 *   reference fails open here; codsh fails closed). Without subagents there
 *   is no verifier, so the goal stops as `verification-unavailable` instead
 *   of trusting the claim. After `maxVerifications` rejected attempts the
 *   goal stops as `verification-limit`.
 * - Completion is also refused while a background job of the session is
 *   still running; the model has to collect or stop it first.
 * - State for the client. Lines go to stderr as `\u241egoal\u241e{json}`:
 *   `state` (goal view, tokens, budget, verification, stop reason, whether a
 *   human turn has the agent) and `round` (a goal round started, so the
 *   client can label the turn dsh opened on its own).
 *
 * The client resolves the policy (`goal.enabled`/GROK_GOAL,
 * `goal.verifier_count`/GROK_GOAL_VERIFIER_N,
 * `goal.classifier_max_runs`/GROK_GOAL_CLASSIFIER_MAX) and passes it as JSON
 * in CODSH_GOAL_POLICY. Without it the defaults apply. With goal mode off the
 * goal tools are removed and refused, and every command is refused.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'rust-acp-goal'
export const inject = ['agents', 'goals', 'tools']

export const MARK = '\u241egoal\u241e'
/** rust-acp-control finds this plugin here. */
export const REGISTRY = Symbol.for('codsh.rust.goal')
/** rust-acp-subagents publishes the verifier spawner here. */
export const VERIFIER = Symbol.for('codsh.rust.goal-verifier')

export const GOAL_TOOLS = ['get_goal', 'create_goal', 'update_goal']
export const DEFAULT_VERIFIER_COUNT = 3
export const MIN_VERIFIER_COUNT = 1
export const MAX_VERIFIER_COUNT = 5
export const DEFAULT_MAX_VERIFICATIONS = 10
export const USAGE = 'Usage: /goal <objective>\nSet an objective to work toward until it is complete.'
export const DISABLED = 'Goal mode is off for this session (goal.enabled = false or GROK_GOAL=0).'

export const budgetReached = (used, budget) =>
  `Goal token budget reached (${used} of ${budget} tokens) — goal stopped. Use /goal clear, then /goal <objective> to start a new one.`
export const verificationLimit = attempts =>
  `Goal verification rejected completion ${attempts} times — goal stopped. Use /goal resume to try again, or /goal clear.`
export const verificationUnavailable = why =>
  `Goal verification is unavailable (${why}), so the completion claim was not accepted — goal stopped. Enable subagents and use /goal resume, or /goal clear.`

const RUNNING_JOB = new Set(['running', 'stopping'])
const CLAIM_LIMIT = 4000

function positiveInt(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

/** Parse CODSH_GOAL_POLICY. A missing or broken value keeps the defaults. */
export function readPolicy(raw) {
  const policy = {
    enabled: true,
    verifierCount: DEFAULT_VERIFIER_COUNT,
    maxVerifications: DEFAULT_MAX_VERIFICATIONS,
    maxRounds: undefined,
  }
  if (raw === undefined || String(raw).trim() === '') return policy
  let value
  try {
    value = JSON.parse(String(raw))
  } catch {
    return policy
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return policy
  if (value.enabled === false) policy.enabled = false
  const count = positiveInt(value.verifierCount)
  if (count !== undefined) policy.verifierCount = Math.min(MAX_VERIFIER_COUNT, Math.max(MIN_VERIFIER_COUNT, count))
  const max = positiveInt(value.maxVerifications)
  if (max !== undefined) policy.maxVerifications = max
  const rounds = positiveInt(value.maxRounds)
  if (rounds !== undefined) policy.maxRounds = rounds
  return policy
}

/** Tokens one provider usage record reports. */
export function usageTokens(usage) {
  if (usage === null || typeof usage !== 'object') return 0
  const total = Number(usage.totalTokens)
  if (Number.isFinite(total) && total > 0) return Math.round(total)
  const parts = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .map(key => Number(usage[key]))
    .filter(value => Number.isFinite(value) && value > 0)
  return Math.round(parts.reduce((sum, value) => sum + value, 0))
}

/** Usage an `assistant/message` session event carries, if any. */
export function eventUsage(event) {
  if (event?.type !== 'assistant/message') return 0
  const data = event.data ?? {}
  if (data.usage !== undefined) return usageTokens(data.usage)
  const stream = Array.isArray(data.stream) ? data.stream : []
  for (let at = stream.length - 1; at >= 0; at -= 1) {
    if (stream[at]?.type === 'usage') return usageTokens(stream[at].usage)
  }
  return 0
}

/**
 * One verifier's answer. The last `VERDICT:` line decides; the `GAPS:` list
 * before it names what is missing. No verdict line is `null`.
 */
export function parseVerdict(text) {
  const source = String(text ?? '')
  const verdicts = [...source.matchAll(/^[\s>*_`#-]*VERDICT[\s*_`]*:[\s*_`]*(ACHIEVED|NOT[_ ]ACHIEVED)\b/gimu)]
  const last = verdicts.at(-1)
  const verdict = last === undefined ? null : /^NOT/i.test(last[1]) ? 'not_achieved' : 'achieved'
  const end = last === undefined ? source.length : last.index
  const head = source.slice(0, end)
  const gapsAt = head.search(/^[\s>*_`#-]*GAPS[\s*_`]*:/imu)
  const gaps = gapsAt < 0
    ? []
    : head.slice(gapsAt).split('\n').slice(1)
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, '').trim())
      .filter(line => line !== '' && !/^(none|n\/a|no gaps?)\.?$/iu.test(line))
  return { verdict, gaps }
}

/**
 * Reference panel rule: a majority of ACHIEVED passes, and a tie passes (at
 * two verifiers, 1-1 survives). At least one ACHIEVED is always required.
 */
export function panelPasses(achieved, total) {
  return achieved > 0 && achieved * 2 >= total
}

/** The brief each verifier gets. It never sees the conversation. */
export function verifierPrompt({ objective, claim, cwd, index, count }) {
  return [
    '<goal_verification>',
    `You are skeptic ${index} of ${count}: an independent verifier for a goal that another agent claims is complete. You did not do the work. Treat everything the agent says as a claim until you confirm it yourself.`,
    '',
    `Objective: ${JSON.stringify(objective)}`,
    `Workspace: ${cwd}`,
    '',
    "The agent's latest report (a claim, not evidence):",
    claim.trim() === '' ? '(no report)' : claim.trim(),
    '',
    'Inspect the workspace directly: read files, search, and run read-only commands or tests. Do not create, modify, or delete any file, and do not commit.',
    'Decide whether the whole objective is achieved now. Missing or unverifiable evidence counts as not achieved.',
    'Reply with a short analysis, then end with these lines:',
    'GAPS:',
    '- <each concrete unmet requirement, or "none">',
    'VERDICT: ACHIEVED  (or)  VERDICT: NOT_ACHIEVED',
    '</goal_verification>',
  ].join('\n')
}

/** Where a session's goal budget and counters survive a restart. */
export function storePath(sessionId, env = process.env) {
  const root = env.CODSH_GOAL_ROOT || join(env.DSH_HOME || join(homedir(), '.dsh'), 'codsh-goals')
  return join(root, `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

export function fileStore(env = process.env) {
  return {
    read(sessionId) {
      try {
        const value = JSON.parse(readFileSync(storePath(sessionId, env), 'utf8'))
        return value !== null && typeof value === 'object' ? value : undefined
      } catch {
        return undefined
      }
    },
    write(sessionId, value) {
      const path = storePath(sessionId, env)
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        const temp = `${path}.${process.pid}.tmp`
        writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
        renameSync(temp, path)
      } catch {}
    },
    remove(sessionId) {
      try {
        rmSync(storePath(sessionId, env), { force: true })
      } catch {}
    },
  }
}

function textOf(content) {
  return (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function message(error) {
  return String(error?.message ?? error)
}

function isChild(agent) {
  const header = agent?.session?.header
  const depth = Math.max(Number(agent?.options?.subagentDepth) || 0, Number(header?.delegationDepth) || 0)
  return header?.origin === 'subagent' || depth > 0
}

function ref(goal) {
  return { id: goal.id, revision: goal.revision }
}

function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The goal state machine without dsh wiring, so it can be tested.
 * deps: { goals, agents, policy, emit(event), store, jobs(), verifier(),
 *         now(), cwd(agent) }
 */
export function createGoal(deps) {
  const policy = deps.policy
  const now = deps.now ?? (() => Date.now())
  /** session id -> tracked budget and verification state of its goal */
  const tracks = new Map()
  /** session id -> live top-level agent */
  const roots = new Map()
  /** session id -> why the next pause happens (set just before it) */
  const pauseCauses = new Map()
  /** session ids whose agent is running a goal round right now */
  const inRound = new Set()

  /** Stop the goal round in flight: its goal was cleared or replaced. */
  const stopRound = (agent) => {
    if (!inRound.has(sessionOf(agent)) || agent.status !== 'running') return
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch {}
  }

  const sessionOf = agent => agent?.session?.id ?? agent?.id ?? ''

  const view = (agent) => {
    try {
      return deps.goals.get(agent)
    } catch {
      return undefined
    }
  }

  const persist = (sessionId, track) => {
    deps.store.write(sessionId, {
      goalId: track.goalId,
      budget: track.budget,
      used: track.used,
      attempts: track.attempts,
      lastVerdict: track.lastVerdict,
      stop: track.stop,
    })
  }

  const fresh = (goalId, budget) => ({
    goalId,
    budget: budget ?? null,
    used: 0,
    attempts: 0,
    verifying: false,
    lastVerdict: null,
    stop: null,
    takeover: false,
  })

  /** The track for the session's current goal, loading a saved one once. */
  const trackFor = (agent, goal = view(agent)) => {
    const sessionId = sessionOf(agent)
    if (goal === undefined) return undefined
    let track = tracks.get(sessionId)
    if (track?.goalId === goal.id) return track
    const saved = deps.store.read(sessionId)
    track = fresh(goal.id, null)
    if (saved?.goalId === goal.id) {
      track.budget = positiveInt(saved.budget) ?? null
      track.used = Math.max(0, Number(saved.used) || 0)
      track.attempts = Math.max(0, Number(saved.attempts) || 0)
      track.lastVerdict = saved.lastVerdict ?? null
      track.stop = saved.stop ?? null
    }
    tracks.set(sessionId, track)
    return track
  }

  const snapshot = (agent) => {
    const goal = view(agent)
    const track = goal === undefined ? undefined : trackFor(agent, goal)
    return {
      event: 'state',
      session: sessionOf(agent),
      enabled: policy.enabled,
      goal: goal === undefined
        ? null
        : {
            id: goal.id,
            revision: goal.revision,
            objective: goal.objective,
            phase: goal.phase,
            activation: goal.activation,
            rounds: goal.roundsStarted,
            maxRounds: goal.maxGoalRounds,
            createdAt: goal.createdAt,
            ...goal.blockedReason ? { blocked: { code: goal.blockedReason.code, message: goal.blockedReason.message } } : {},
          },
      tokens: track?.used ?? 0,
      budget: track?.budget ?? null,
      attempts: track?.attempts ?? 0,
      maxVerifications: policy.maxVerifications,
      verifiers: policy.verifierCount,
      verifying: track?.verifying ?? false,
      lastVerdict: track?.lastVerdict ?? null,
      stop: track?.stop ?? null,
      takeover: track?.takeover ?? false,
    }
  }

  const publish = (agent) => {
    if (agent === undefined || isChild(agent)) return
    try {
      deps.emit(snapshot(agent))
    } catch {}
  }

  const notice = (agent, text) => {
    try {
      deps.emit({ event: 'notice', session: sessionOf(agent), text })
    } catch {}
  }

  /** Stop an active goal at or over its budget. Returns whether it stopped. */
  const enforceBudget = (agent) => {
    const goal = view(agent)
    if (goal === undefined || goal.phase !== 'active') return false
    const track = trackFor(agent, goal)
    if (track?.budget === null || track?.budget === undefined || track.used < track.budget) return false
    try {
      deps.goals.block(agent, ref(goal), { code: 'budget-limited', message: budgetReached(track.used, track.budget) })
    } catch {
      return false
    }
    return true
  }

  /** The top-level agent a (possibly child) session's tokens belong to. */
  const rootOf = (agent) => {
    let current = agent
    for (let guard = 0; guard < 64 && current !== undefined; guard += 1) {
      if (!isChild(current)) return current
      const parentId = current.session?.header?.parentSession
      if (typeof parentId !== 'string' || parentId === '') return undefined
      current = roots.get(parentId) ?? deps.agents.get(parentId)
    }
    return undefined
  }

  const describeStop = (goal, track) => {
    if (goal.phase === 'complete') return track?.stop?.message ?? 'Goal complete.'
    if (goal.phase === 'blocked') return goal.blockedReason?.message ?? 'Goal stopped.'
    if (goal.phase === 'paused') return track?.stop?.message ?? 'Goal paused.'
    return undefined
  }

  const statusText = (agent) => {
    const goal = view(agent)
    if (goal === undefined) return 'No goal is currently set. Use /goal <objective> to start one.'
    const track = trackFor(agent, goal)
    const phase = goal.phase === 'blocked' && goal.blockedReason?.code === 'budget-limited' ? 'budget-limited' : goal.phase
    const lines = [
      `Goal: ${goal.objective}`,
      `Status: ${phase}${goal.phase === 'active' ? (goal.activation === 'armed' ? '' : ' (disarmed after resume; /goal resume continues)') : ''} | Round ${goal.roundsStarted} of ${goal.maxGoalRounds}`,
      `Goal tokens used: ${track.used}${track.budget === null ? ' (no budget)' : ` of ${track.budget}`}`,
      `Verification: ${track.attempts} of ${policy.maxVerifications} attempts, ${policy.verifierCount} verifier${policy.verifierCount === 1 ? '' : 's'} each${track.verifying ? ' · verifying now' : ''}`,
    ]
    if (track.lastVerdict !== null) {
      const verdict = track.lastVerdict
      lines.push(`Last verdict: ${verdict.passed ? 'achieved' : 'not achieved'} (${verdict.achieved} of ${verdict.total} verifiers)${verdict.gaps?.length ? ` · gaps: ${verdict.gaps.slice(0, 3).join('; ')}` : ''}`)
    }
    const stop = describeStop(goal, track)
    if (stop !== undefined) lines.push(`Stop reason: ${stop}`)
    if (typeof goal.createdAt === 'number') lines.push(`Elapsed: ${elapsed(now() - goal.createdAt)}`)
    return lines.join('\n')
  }

  const runningJobs = (agent) => {
    try {
      const list = deps.jobs()?.list?.(agent) ?? []
      return list.filter(job => RUNNING_JOB.has(job?.status))
    } catch {
      return []
    }
  }

  const latestClaim = (agent) => {
    let events = []
    try {
      events = agent.session.snapshotEvents()
    } catch {
      return ''
    }
    for (let at = events.length - 1; at >= 0; at -= 1) {
      const event = events[at]
      if (event?.type !== 'assistant/message') continue
      const text = textOf(event.data?.message?.content).trim()
      if (text !== '') return text.length > CLAIM_LIMIT ? `${text.slice(0, CLAIM_LIMIT)}…` : text
    }
    return ''
  }

  /** Run the panel. Returns { passed, achieved, total, gaps, failures }. */
  const verify = async (agent, goal, track, signal) => {
    const spawner = deps.verifier()
    if (spawner === undefined || typeof spawner.spawn !== 'function') {
      return { unavailable: spawner?.unavailable ?? 'subagents are disabled for this session' }
    }
    const count = policy.verifierCount
    const claim = latestClaim(agent)
    const cwd = deps.cwd(agent)
    const attempt = track.attempts
    const runs = Array.from({ length: count }, (_, at) => spawner.spawn({
      parent: agent,
      id: `goal-verify-${String(goal.id).slice(-8)}-${attempt}-${at + 1}`,
      label: `goal verifier ${at + 1}/${count}`,
      prompt: verifierPrompt({ objective: goal.objective, claim, cwd, index: at + 1, count }),
      capability: 'execute',
      signal,
    }))
    const settled = await Promise.allSettled(runs)
    let achieved = 0
    const gaps = []
    const failures = []
    for (const [at, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        failures.push(`verifier ${at + 1} failed: ${message(outcome.reason)}`)
        continue
      }
      const value = outcome.value ?? {}
      if (value.status !== 'completed') {
        failures.push(`verifier ${at + 1} ${value.status ?? 'failed'}: ${String(value.text ?? '').split('\n')[0].slice(0, 200)}`)
        continue
      }
      const parsed = parseVerdict(value.text)
      if (parsed.verdict === 'achieved') achieved += 1
      else if (parsed.verdict === null) failures.push(`verifier ${at + 1} gave no verdict`)
      for (const gap of parsed.verdict === 'not_achieved' ? parsed.gaps : []) {
        if (!gaps.includes(gap)) gaps.push(gap)
      }
    }
    return { passed: panelPasses(achieved, count), achieved, total: count, gaps, failures }
  }

  /**
   * tools/pre-execute for the goal tools. Returns a deny reason, or
   * undefined to let dsh run the call.
   */
  const gate = async (exec) => {
    if (!GOAL_TOOLS.includes(exec?.name)) return undefined
    if (!policy.enabled) return DISABLED
    if (exec.name !== 'update_goal') return undefined
    const agent = exec.agent
    if (agent === undefined || isChild(agent)) return undefined
    const args = exec.arguments ?? {}
    const goal = view(agent)
    if (goal === undefined || goal.id !== args.goal_id || goal.revision !== args.revision) return undefined
    if (args.action === 'resume' && goal.phase === 'blocked' && goal.blockedReason?.code === 'budget-limited') {
      return 'Goal is budget-limited. Use /goal clear, then /goal <objective>.'
    }
    // dsh lets the model pause only on a direct human request.
    if (args.action === 'pause') pauseCauses.set(sessionOf(agent), 'model')
    if (args.action !== 'complete' || goal.phase === 'complete') return undefined
    const track = trackFor(agent, goal)
    const jobs = runningJobs(agent)
    if (jobs.length > 0) {
      const ids = jobs.map(job => job.id).join(', ')
      return `Goal completion refused: ${jobs.length} background job${jobs.length === 1 ? ' is' : 's are'} still running (${ids}). Wait for ${jobs.length === 1 ? 'it' : 'them'} with job_output or stop ${jobs.length === 1 ? 'it' : 'them'} with job_kill, check the result, then mark the goal complete. The goal stays active.`
    }
    if (track.verifying) return 'Goal completion is already being verified. The goal stays active.'
    track.attempts += 1
    track.verifying = true
    persist(sessionOf(agent), track)
    publish(agent)
    let outcome
    try {
      outcome = await verify(agent, goal, track, exec.signal)
    } catch (error) {
      outcome = { passed: false, achieved: 0, total: policy.verifierCount, gaps: [], failures: [message(error)] }
    } finally {
      track.verifying = false
    }
    const sessionId = sessionOf(agent)
    const latest = view(agent)
    const current = latest !== undefined && latest.id === goal.id && latest.revision === goal.revision
    if (outcome.unavailable !== undefined) {
      track.attempts -= 1
      persist(sessionId, track)
      if (current && latest.phase === 'active') {
        try {
          deps.goals.block(agent, ref(latest), { code: 'verification-unavailable', message: verificationUnavailable(outcome.unavailable) })
        } catch {}
      }
      publish(agent)
      return `Goal completion was not accepted: independent verification is unavailable (${outcome.unavailable}). The goal was stopped for the user to decide.`
    }
    if (exec.signal?.aborted) {
      persist(sessionId, track)
      publish(agent)
      return 'Goal completion was not verified: the turn was cancelled during verification. The goal stays as it is.'
    }
    track.lastVerdict = {
      passed: outcome.passed,
      achieved: outcome.achieved,
      total: outcome.total,
      gaps: outcome.gaps.slice(0, 8),
      failures: outcome.failures.slice(0, 5),
      attempt: track.attempts,
    }
    persist(sessionId, track)
    if (!current) {
      publish(agent)
      return 'Goal completion was not applied: the goal changed while it was being verified. Read the goal again with get_goal.'
    }
    if (outcome.passed) {
      track.stop = { kind: 'complete', message: `Goal complete — verified by ${outcome.achieved} of ${outcome.total} independent verifier${outcome.total === 1 ? '' : 's'}.` }
      persist(sessionId, track)
      publish(agent)
      return undefined
    }
    const reasons = [...outcome.gaps, ...outcome.failures]
    const detail = reasons.length === 0 ? '- (the verifiers named no specific gap)' : reasons.map(line => `- ${line}`).join('\n')
    notice(agent, `Goal verification: not achieved (${outcome.achieved} of ${outcome.total} verifiers) · attempt ${track.attempts} of ${policy.maxVerifications}`)
    if (track.attempts >= policy.maxVerifications && latest.phase === 'active') {
      try {
        deps.goals.block(agent, ref(latest), { code: 'verification-limit', message: verificationLimit(track.attempts) })
      } catch {}
      publish(agent)
      return `Goal completion was not accepted: independent verification found the objective not achieved (${outcome.achieved} of ${outcome.total} verifiers agreed it is done). Gaps:\n${detail}\nThis was verification attempt ${track.attempts} of ${policy.maxVerifications}, so the goal has been stopped for the user to review.`
    }
    publish(agent)
    return `Goal completion was not accepted: independent verification found the objective not achieved (${outcome.achieved} of ${outcome.total} verifiers agreed it is done). Gaps:\n${detail}\nKeep working on the objective; the goal stays active (verification attempt ${track.attempts} of ${policy.maxVerifications}).`
  }

  /** A human command from the client. Returns { ok, message }. */
  const command = (agent, request) => {
    const action = String(request?.action ?? 'status')
    if (!policy.enabled) return { ok: false, message: DISABLED }
    if (agent === undefined) return { ok: false, message: '/goal needs a live dsh session' }
    const sessionId = sessionOf(agent)
    const goal = view(agent)
    try {
      if (action === 'status') return { ok: true, message: statusText(agent) }
      if (action === 'set') {
        const objective = typeof request.objective === 'string' ? request.objective.trim() : ''
        if (objective === '') return { ok: false, message: USAGE }
        const budget = request.budget === undefined || request.budget === null ? undefined : positiveInt(request.budget)
        if (request.budget !== undefined && request.budget !== null && budget === undefined) {
          return { ok: false, message: 'The goal token budget must be a positive whole number.' }
        }
        // The reference replaces the current goal.
        if (goal !== undefined && goal.phase !== 'complete') {
          deps.goals.clear(agent, ref(goal))
          stopRound(agent)
        }
        const created = deps.goals.create(agent, { objective, ...policy.maxRounds ? { maxGoalRounds: policy.maxRounds } : {} })
        const track = fresh(created.id, budget)
        tracks.set(sessionId, track)
        persist(sessionId, track)
        publish(agent)
        return { ok: true, message: budget === undefined ? `Goal set: ${objective}` : `Goal set (token budget ${budget}): ${objective}` }
      }
      if (action === 'pause') {
        if (goal === undefined) return { ok: false, message: 'No goal is currently set.' }
        if (goal.phase === 'active') {
          pauseCauses.set(sessionId, 'user')
          try {
            deps.goals.pause(agent, ref(goal))
          } finally {
            pauseCauses.delete(sessionId)
          }
          return { ok: true, message: 'Goal paused. Use /goal resume to continue.' }
        }
        if (goal.phase === 'paused') return { ok: false, message: 'Goal is already paused.' }
        if (goal.phase === 'complete') return { ok: false, message: 'Goal is already complete.' }
        if (goal.blockedReason?.code === 'budget-limited') return { ok: false, message: 'Goal is budget-limited.' }
        return { ok: false, message: 'Goal is not active.' }
      }
      if (action === 'resume') {
        if (goal === undefined) return { ok: false, message: 'No goal set. Use /goal <objective> to start one.' }
        if (goal.phase === 'complete') return { ok: false, message: 'Goal is already complete. Use /goal <objective> to start a new one.' }
        if (goal.phase === 'blocked' && goal.blockedReason?.code === 'budget-limited') {
          return { ok: false, message: 'Goal is budget-limited. Use /goal clear, then /goal <objective>.' }
        }
        if (goal.phase === 'active' && goal.activation === 'armed') return { ok: false, message: 'Goal is already active.' }
        const track = trackFor(agent, goal)
        if (goal.phase === 'blocked' && goal.blockedReason?.code === 'verification-limit') track.attempts = 0
        track.stop = null
        deps.goals.resume(agent, ref(goal))
        persist(sessionId, track)
        publish(agent)
        return { ok: true, message: 'Goal resumed.' }
      }
      if (action === 'clear') {
        if (goal === undefined) return { ok: false, message: 'No goal is currently set.' }
        deps.goals.clear(agent, ref(goal))
        stopRound(agent)
        return { ok: true, message: 'Goal cleared.' }
      }
      return { ok: false, message: USAGE }
    } catch (error) {
      publish(agent)
      return { ok: false, message: message(error) }
    }
  }

  return {
    tracks,
    roots,
    command,
    gate,
    enforceBudget,
    statusText,
    snapshot,
    onCreated(agent) {
      if (isChild(agent)) return
      roots.set(sessionOf(agent), agent)
      if (view(agent) !== undefined) publish(agent)
    },
    onDisposed(agent) {
      const sessionId = sessionOf(agent)
      if (roots.get(sessionId) === agent) roots.delete(sessionId)
    },
    onStatus(agent, status) {
      if (isChild(agent)) return
      const track = tracks.get(sessionOf(agent))
      if (status !== 'idle') return
      inRound.delete(sessionOf(agent))
      pauseCauses.delete(sessionOf(agent))
      const stopped = enforceBudget(agent)
      if (track !== undefined && track.takeover) {
        track.takeover = false
        if (!stopped) publish(agent)
      }
    },
    /** Round fence: a goal round over budget never enters its step. */
    onPreStep(agent, messages) {
      if (isChild(agent)) return
      if (!messages.some(item => item?.source?.kind === 'goal' && item.source.round > 0)) return
      enforceBudget(agent)
    },
    onGoalChanged(agent, change) {
      if (agent === undefined || isChild(agent)) return
      const sessionId = sessionOf(agent)
      const operation = change?.operation
      if (operation === 'clear') {
        tracks.delete(sessionId)
        deps.store.remove(sessionId)
        publish(agent)
        return
      }
      const goal = view(agent)
      if (goal === undefined) {
        publish(agent)
        return
      }
      let track = trackFor(agent, goal)
      if (operation === 'create' && track.goalId !== goal.id) track = trackFor(agent, goal)
      if (operation === 'pause') {
        const cause = pauseCauses.get(sessionId) ?? 'interrupted'
        pauseCauses.delete(sessionId)
        track.stop = {
          kind: 'paused',
          message: cause === 'user'
            ? 'Goal paused by /goal pause. Use /goal resume to continue.'
            : cause === 'model'
              ? 'Goal paused by the model at your request. Use /goal resume to continue.'
              : 'Goal paused: the goal round was interrupted. Use /goal resume to continue.',
        }
      } else if (operation === 'block') {
        track.stop = { kind: goal.blockedReason?.code ?? 'blocked', message: goal.blockedReason?.message ?? 'Goal stopped.' }
      } else if (operation === 'resume' || operation === 'create') {
        track.stop = null
      } else if (operation === 'complete' && track.stop?.kind !== 'complete') {
        track.stop = { kind: 'complete', message: 'Goal complete.' }
      }
      persist(sessionId, track)
      publish(agent)
      if (operation === 'block' || operation === 'complete' || (operation === 'pause' && track.stop?.kind === 'paused')) {
        notice(agent, track.stop.message)
      }
    },
    onActivation(sessionId) {
      const agent = roots.get(sessionId)
      if (agent !== undefined) publish(agent)
    },
    onSessionEvent(session, event) {
      const agent = roots.get(session?.id) ?? deps.agents.get(session?.id)
      if (agent === undefined) return
      if (event?.type === 'user/message' && !isChild(agent)) {
        const source = event.data?.source ?? event.data?.message?.source
        if (source?.kind === 'goal' && source.round > 0) {
          inRound.add(sessionOf(agent))
          const goal = view(agent)
          try {
            deps.emit({ event: 'round', session: sessionOf(agent), round: source.round, maxRounds: goal?.maxGoalRounds ?? null, objective: goal?.objective ?? '' })
          } catch {}
          publish(agent)
          return
        }
        if (source?.kind === 'user') {
          const goal = view(agent)
          if (goal?.phase === 'active') {
            const track = trackFor(agent, goal)
            track.takeover = true
            publish(agent)
          }
        }
        return
      }
      const tokens = eventUsage(event)
      if (tokens <= 0) return
      const root = rootOf(agent)
      if (root === undefined) return
      const goal = view(root)
      if (goal === undefined || goal.phase !== 'active') return
      const track = trackFor(root, goal)
      track.used += tokens
      persist(sessionOf(root), track)
      publish(root)
    },
  }
}

export function apply(ctx) {
  const policy = readPolicy(process.env.CODSH_GOAL_POLICY)
  delete process.env.CODSH_GOAL_POLICY
  const emit = (event) => {
    process.stderr.write(`${MARK}${JSON.stringify(event)}\n`)
  }
  const goal = createGoal({
    goals: ctx.goals,
    agents: ctx.agents,
    policy,
    emit,
    store: fileStore(),
    jobs: () => ctx.get('jobs'),
    verifier: () => globalThis[VERIFIER],
    cwd: agent => agent?.session?.header?.cwd ?? process.cwd(),
  })
  globalThis[REGISTRY] = goal
  if (!policy.enabled) {
    // Goal mode off: the model never sees the goal tools, and a call that
    // still arrives is refused before dsh runs it.
    ctx.on('agent/created', ({ agent }) => {
      const deny = GOAL_TOOLS.filter(tool => {
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
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = await goal.gate(exec)
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  }, true)
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    goal.onPreStep(agent, messages ?? [])
    return next()
  }, true)
  ctx.on('agent/created', ({ agent }) => goal.onCreated(agent))
  ctx.on('agent/disposed', ({ agent }) => goal.onDisposed(agent))
  ctx.on('agent/status', ({ agent, status }) => goal.onStatus(agent, status))
  ctx.on('goal/changed', ({ agent, change }) => goal.onGoalChanged(agent, change))
  ctx.on('goal/activation-changed', ({ sessionId }) => goal.onActivation(sessionId))
  ctx.on('session/event', (session, event) => goal.onSessionEvent(session, event))
  ctx.on('dispose', () => {
    if (globalThis[REGISTRY] === goal) delete globalThis[REGISTRY]
  })
}
