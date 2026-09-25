/**
 * Background commands and completion wake for the Rust client (ticket 175).
 *
 * dsh owns every process here. A foreground `bash` call on the main agent is
 * started by dsh's own bash tool as a real `ctx.jobs` bash job (the call is
 * dispatched with `run_in_background: true`, so dsh keeps its sandbox,
 * escalation approval, workdir, and environment handling). This plugin then
 * waits in the foreground on that same job and ends the wait in one of five
 * ways:
 *
 * - the job finishes: the call returns the job's output as a normal
 *   foreground result, and the job is read, so dsh sends no completion notice;
 * - Ctrl+B (a control request from the client), a steered message, or a
 *   send-now: the job keeps running and the call returns its id;
 * - the auto-background budget or timeout (`[toolset.bash]`
 *   auto_background_on_timeout, default on): same as Ctrl+B;
 * - the timeout with auto-background off: the job is killed, as dsh's
 *   foreground timeout would;
 * - the turn is cancelled: the job is killed and the call reports aborted.
 *
 * A moved command's completion reaches the model once, through dsh's
 * tool-jobs notice (injected into a busy agent, or waking an idle one). A
 * notice that a cancel cleared from the inbox is put back, so it is never
 * lost; one for a job this plugin already answered in the foreground is
 * removed, so it is never duplicated.
 *
 * A workflow completion message (rust-acp-workflow, ticket 183) takes the
 * same path: it is announced when the model claims it and put back when a
 * cancel discards it.
 *
 * Monitors (ticket 176, rust-acp-monitor.mjs) register here as well: a
 * monitor is a dsh job of kind `monitor` on the same lifecycle channel, and
 * the tasks pane stops it through the same control request.
 *
 * Lifecycle lines go to stderr as `\u241ejob\u241e{json}` for the client's task
 * board, status line, and transcript. Jobs die with the dsh process and are
 * cancelled by dsh when their owner agent is disposed; nothing here revives
 * them.
 */
import { importFromDsh } from './rust-acp-dsh.mjs'
import { registerMonitor } from './rust-acp-monitor.mjs'
const { HarnessError, createUserMessage } = await importFromDsh('@deepseek-ai/dsh-llm')
const { TOOL_ABORTED } = await importFromDsh('@deepseek-ai/dsh-tools')

export const name = 'rust-acp-background'
export const inject = ['tools']

export const MARK = '\u241ejob\u241e'
export const REGISTRY = Symbol.for('codsh.rust.background')
export const DEFAULT_BUDGET_MS = 15000
const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_TIMEOUT_MS = 600000
const SETTLE_MS = 30000
const TAIL = 4000

/**
 * `[toolset.bash]` as the client resolved it (CODSH_BASH_POLICY).
 * `foreground` says whether a foreground call runs as a movable dsh job. Only
 * the interactive client sets it: without the variable (editor ACP, shared
 * server) and in a plain turn, foreground commands keep dsh's own path.
 */
export function parsePolicy(raw) {
  const policy = { foreground: false, autoBackground: true, budgetMs: DEFAULT_BUDGET_MS, timeoutMs: undefined }
  if (!raw) return policy
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return policy
  }
  if (value === null || typeof value !== 'object') return policy
  policy.foreground = value.foreground !== false
  if (typeof value.autoBackground === 'boolean') policy.autoBackground = value.autoBackground
  if (Number.isSafeInteger(value.budgetMs) && value.budgetMs >= 0) policy.budgetMs = value.budgetMs
  if (Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) policy.timeoutMs = value.timeoutMs
  return policy
}

/** A delegated (subagent) agent: dsh records a nonzero delegation depth. */
export function isChildAgent(agent) {
  const runtime = agent?.options?.subagentDepth
  const header = agent?.session?.header?.delegationDepth
  return (Number.isSafeInteger(runtime) && runtime > 0) || (Number.isSafeInteger(header) && header > 0)
}

const terminal = status => status === 'completed' || status === 'killed' || status === 'failed'

function tail(text, max = TAIL) {
  const value = String(text ?? '')
  return value.length > max ? `…${value.slice(value.length - max)}` : value
}

function secondsLabel(ms) {
  if (ms % 1000 === 0) return String(ms / 1000)
  return (ms / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Timeout for one promotable call: the model's `timeoutMs`, else the
 * configured default, capped like dsh's executor caps a foreground run.
 */
export function resolveTimeout(requested, policy, shellConfig) {
  const fallback = policy.timeoutMs ?? shellConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cap = shellConfig?.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
  return Math.min(Number.isFinite(requested) && requested > 0 ? requested : fallback, cap)
}

/** How long the call blocks before auto-background moves it. */
export function foregroundWait(timeoutMs, policy) {
  if (!policy.autoBackground || policy.budgetMs === 0) return timeoutMs
  return Math.min(timeoutMs, policy.budgetMs)
}

/** Exit facts from a settled bash job's detail (`exit code: N` / `signal: X`). */
export function exitFacts(snapshot) {
  const detail = String(snapshot?.detail ?? '')
  const code = /^exit code: (-?\d+)$/.exec(detail)
  if (snapshot?.status === 'completed') return { exitCode: code ? Number(code[1]) : 0, signal: null }
  const signal = /^signal: (.+)$/.exec(detail)
  return { exitCode: null, signal: signal ? signal[1] : 'SIGTERM' }
}

/** The model- and transcript-facing text of a command moved to the background. */
export function movedText({ jobId, reason, command, description, waitMs, partial }) {
  const label = description && description.trim() !== '' ? description.trim() : command
  const sentence = reason === 'auto'
    ? `Command "${label}" has been automatically moved to background because it exceeded auto-background timeout limit of ${secondsLabel(waitMs)}s. Process is still running.`
    : reason === 'message'
      ? `Command "${command}" was moved to background because the user sent a new message. Process is still running.`
      : `User moved command "${command}" to background. Process is still running.`
  return [
    '[Command moved to background]',
    sentence,
    `Job id: ${jobId}. You are notified when it finishes. Read new output with job_output (job_id "${jobId}") and stop it with job_kill.`,
    '',
    'Partial output:',
    partial === '' ? '(no output yet)' : partial.replace(/\n+$/, ''),
  ].join('\n')
}

function noticeJobId(message) {
  const text = message?.content?.find?.(block => block?.type === 'text')?.text ?? ''
  return /^background job (\S+) /.exec(text)?.[1]
}

function isJobsNotice(message) {
  return message?.source?.kind === 'plugin' && message.source.plugin === 'tool-jobs'
}

/** A workflow completion message (ticket 183) shares the wake path. */
export const WORKFLOW_NOTICE_PLUGIN = 'rust-acp-workflow'
function isWorkflowNotice(message) {
  return message?.source?.kind === 'plugin' && message.source.plugin === WORKFLOW_NOTICE_PLUGIN && message.source.form === 'notice'
}

/**
 * The background state machine without dsh wiring, so it can be tested.
 * @param {object} deps - `jobs()` returns ctx.jobs, `shellConfig()` the bash
 *   executor config, `emit(event)` writes one lifecycle line, `policy`,
 *   `live(agent)` says whether the agent is still registered, `later(fn, ms)`.
 */
export function createBackground(deps) {
  const { emit, policy } = deps
  const later = deps.later ?? ((fn, ms) => setTimeout(fn, ms))
  /** Promotable calls waiting in the foreground, by call id. */
  const foregrounds = new Map()
  /** Jobs answered (or still answerable) in the foreground: their notice is a duplicate. */
  const foregroundJobs = new Set()
  /** Bash jobs the client was told about, by id. */
  const tracked = new Map()
  /** Text that replaces a moved call's `started background job` content. */
  const moved = new WeakMap()
  /** Notice ids this plugin removed on purpose; their discard is not a loss. */
  const suppressed = new Set()

  const sessionOf = agent => agent?.session?.id ?? ''

  const track = (jobId, agent, fields) => {
    tracked.set(jobId, { session: sessionOf(agent), agent })
    emit({ event: 'start', id: jobId, session: sessionOf(agent), ...fields })
  }

  async function settle(jobs, jobId, agent) {
    try {
      await jobs.wait(jobId, SETTLE_MS, agent)
    } catch {
      // A stopping job that never settles is reported by dsh's own teardown.
    }
  }

  async function promotable(exec, next, jobs) {
    const agent = exec.agent
    const original = exec.arguments
    const timeoutMs = resolveTimeout(original.timeoutMs, policy, deps.shellConfig?.())
    const waitMs = foregroundWait(timeoutMs, policy)
    exec.arguments = Object.freeze({ ...original, run_in_background: true })
    let started
    try {
      started = await next()
    } finally {
      exec.arguments = original
    }
    if (started?.isError || started?.value?.kind !== 'background') return started
    const jobId = started.value.jobId
    foregroundJobs.add(jobId)
    const control = new AbortController()
    const entry = {
      agent,
      jobId,
      reason: undefined,
      promote(reason) {
        if (entry.reason !== undefined) return false
        entry.reason = reason
        control.abort()
        return true
      },
    }
    const onAbort = () => control.abort()
    exec.signal.addEventListener('abort', onAbort, { once: true })
    if (exec.signal.aborted) control.abort()
    foregrounds.set(exec.callId, entry)
    try {
      await jobs.wait(jobId, waitMs, agent, control.signal)
    } catch {
      // Aborted: promoted or cancelled, decided below.
    } finally {
      foregrounds.delete(exec.callId)
      exec.signal.removeEventListener('abort', onAbort)
    }
    const foregroundValue = (read, snapshot, extra = {}) => ({
      kind: 'foreground',
      ...exitFacts(snapshot),
      timedOut: false,
      aborted: false,
      timeoutMs,
      stdout: { text: read.text, truncated: false },
      stderr: { text: '', truncated: false },
      ...extra,
    })
    const finish = (extra) => {
      const read = jobs.read(jobId, agent)
      // Keep the id fenced one tick longer: a settlement racing this read
      // may still be inserting its notice.
      later(() => foregroundJobs.delete(jobId), 0)
      if (read.snapshot.status === 'failed') throw new Error(read.snapshot.detail ?? `job ${jobId} failed`)
      return { isError: false, value: foregroundValue(read, read.snapshot, extra) }
    }
    if (terminal(jobs.get(jobId, agent).status)) return finish()
    // A move that raced the turn's cancel wins: the send-now path asks for
    // the move first and cancels after, so the command must survive.
    if (exec.signal.aborted && entry.reason === undefined) {
      jobs.kill(jobId, agent, 'turn cancelled')
      await settle(jobs, jobId, agent)
      // Read it so dsh sends no completion notice, then fail the call the
      // way dsh's own foreground bash does when its turn is cancelled.
      jobs.read(jobId, agent)
      later(() => foregroundJobs.delete(jobId), 0)
      const error = new HarnessError('tool call aborted', TOOL_ABORTED)
      error.name = 'AbortError'
      throw error
    }
    const reason = entry.reason ?? (policy.autoBackground ? 'auto' : undefined)
    if (reason === undefined) {
      jobs.kill(jobId, agent, 'timeout')
      await settle(jobs, jobId, agent)
      return finish({ timedOut: true })
    }
    // Moved: the job keeps running and its completion notice is wanted.
    foregroundJobs.delete(jobId)
    const partial = jobs.read(jobId, agent).text
    moved.set(exec, movedText({
      jobId,
      reason,
      command: original.command,
      description: original.description,
      waitMs,
      partial,
    }))
    track(jobId, agent, {
      label: original.command,
      callId: exec.callId,
      reason,
      output: tail(partial),
    })
    return { isError: false, value: { kind: 'background', jobId } }
  }

  return {
    foregrounds,
    foregroundJobs,
    tracked,
    moved,
    /** `tools/execute` around-dispatch. */
    async execute(exec, next) {
      const agent = exec.agent
      if (agent === undefined || exec.parent !== undefined || isChildAgent(agent)) return next()
      if (exec.name === 'job_output' && exec.arguments?.wait === true) {
        const job = String(exec.arguments.job_id ?? '')
        emit({ event: 'wait', session: sessionOf(agent), job, on: true })
        try {
          return await next()
        } finally {
          emit({ event: 'wait', session: sessionOf(agent), job, on: false })
        }
      }
      if (exec.name !== 'bash') return next()
      const args = exec.arguments ?? {}
      if (args.run_in_background === true) {
        const result = await next()
        if (!result?.isError && result?.value?.kind === 'background') {
          track(result.value.jobId, agent, { label: String(args.command ?? ''), callId: exec.callId, reason: 'explicit', output: '' })
        }
        return result
      }
      if (!policy.foreground) return next()
      const jobs = deps.jobs()
      if (jobs === undefined || !deps.canBackground?.(agent)) return next()
      const limit = jobs.maxConcurrentJobsPerOwner
      if (Number.isSafeInteger(limit)) {
        const active = jobs.list(agent).filter(job => job.ownerSession === sessionOf(agent) && !terminal(job.status)).length
        // At the owner's job limit a promotable start would fail. Run it
        // the plain foreground way instead of refusing the command.
        if (active >= limit) return next()
      }
      return promotable(exec, next, jobs)
    },
    /** `tools/post-execute`: a moved call reads as moved, not as a bare job id. */
    async postExecute(exec, result, next) {
      const decision = await next()
      const text = moved.get(exec)
      if (text === undefined) return decision
      moved.delete(exec)
      if (result.isError || decision.kind !== 'accept') return decision
      if (Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision
      return { ...decision, content: [{ type: 'text', text }] }
    },
    /** `tools/result`: output the model collected is what the task board shows. */
    onResult(exec, result) {
      if (exec.name !== 'job_output' || result?.isError) return
      const id = String(exec.arguments?.job_id ?? '')
      if (!tracked.has(id)) return
      const text = result.value?.text
      if (typeof text === 'string' && text !== '') emit({ event: 'output', id, session: sessionOf(exec.agent), text: tail(text) })
    },
    /** `jobs.onJobDone`. */
    onJobDone(snapshot) {
      const entry = tracked.get(snapshot.id)
      if (entry === undefined) return
      emit({
        event: 'end',
        id: snapshot.id,
        session: entry.session,
        status: snapshot.status,
        detail: snapshot.detail ?? '',
        elapsedMs: Math.max(0, (snapshot.finishedAt ?? Date.now()) - snapshot.startedAt),
      })
    },
    /** `agent/inbox/inserted`: drop a notice for a job answered in the foreground. */
    onInserted(agent, message) {
      if (!isJobsNotice(message)) return
      const id = noticeJobId(message)
      if (id === undefined || !foregroundJobs.has(id)) return
      suppressed.add(message.id)
      try {
        agent.inbox.remove(message.id)
      } catch {
        suppressed.delete(message.id)
      }
    },
    /** `agent/inbox/discarded`: a cancel cleared a notice the model never saw. */
    onDiscarded(agent, message) {
      if (!isJobsNotice(message) && !isWorkflowNotice(message)) return
      if (suppressed.delete(message.id)) return
      later(() => {
        if (!deps.live(agent)) return
        const copy = createUserMessage({ content: message.content, source: message.source })
        try {
          // Injected, not a follow-up: the user just stopped this turn, so
          // the notice waits for the next step instead of opening a turn.
          agent.inject(copy)
          emit({ event: 'requeued', session: sessionOf(agent), job: noticeJobId(message) ?? '', ...isWorkflowNotice(message) ? { what: String(message.source.summary ?? 'a workflow') } : {} })
        } catch {
          // A disposed agent has no inbox left; its jobs are gone with it.
        }
      }, 0)
    },
    /** `agent/inbox/claimed`: a completion reached the model. */
    onClaimed(agent, message) {
      if (isChildAgent(agent) || (!isJobsNotice(message) && !isWorkflowNotice(message))) return
      const text = message.content?.find?.(block => block?.type === 'text')?.text ?? ''
      emit({
        event: 'notice',
        session: sessionOf(agent),
        job: noticeJobId(message) ?? '',
        summary: String(message.source.summary ?? ''),
        text: tail(text, 600),
      })
    },
    /** `agent/status`: the client closes a wake turn at idle. */
    onStatus(agent, status) {
      if (isChildAgent(agent)) return
      if (status === 'idle') {
        // Let the ACP bridge flush the turn's last updates first. A run that
        // started meanwhile (a wake right after the turn) already said so; a
        // late idle would close its turn early.
        later(() => {
          if (agent.status !== undefined && agent.status !== 'idle') return
          emit({ event: 'status', session: sessionOf(agent), status: 'idle' })
        }, 25)
      } else {
        emit({ event: 'status', session: sessionOf(agent), status })
      }
    },
    onDisposed(agent) {
      if (isChildAgent(agent)) return
      emit({ event: 'disposed', session: sessionOf(agent) })
    },
    /** Ctrl+B, a steer, or a send-now: move this session's foreground commands. */
    promote(sessionId, reason) {
      let count = 0
      for (const entry of foregrounds.values()) {
        if (sessionOf(entry.agent) === sessionId && entry.promote(reason)) count += 1
      }
      return count
    },
    /** Stop a moved job (or a monitor) from the client's task pane. */
    kill(agent, jobId) {
      const monitors = deps.monitors?.()
      if (monitors?.has(jobId)) return monitors.kill(agent, jobId)
      const jobs = deps.jobs()
      if (jobs === undefined) throw new Error('dsh jobs are unavailable')
      if (!tracked.has(jobId)) throw new Error(`unknown background command ${jobId}`)
      const outcome = jobs.kill(jobId, agent, 'stopped from the codsh tasks pane')
      if (outcome === 'requested') {
        // dsh marks a killed job reported, so it sends no notice. Tell the
        // model once, at its next step or with the next message.
        const snapshot = jobs.get(jobId, agent)
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: `background job ${jobId} (bash: ${snapshot.label}) was stopped by the user from the tasks pane.` }],
          source: { kind: 'plugin', plugin: name, form: 'notice', summary: `bash ${snapshot.label} [stopped by the user]` },
        }))
      }
      return outcome
    },
  }
}

export function apply(ctx) {
  const policy = parsePolicy(process.env.CODSH_BASH_POLICY)
  delete process.env.CODSH_BASH_POLICY
  const emit = (event) => {
    process.stderr.write(`${MARK}${JSON.stringify(event)}\n`)
  }
  let monitors
  const background = createBackground({
    emit,
    policy,
    monitors: () => monitors,
    jobs: () => ctx.get('jobs'),
    shellConfig: () => {
      const config = ctx.get('shell')?.config
      return config && typeof config === 'object' ? config : undefined
    },
    // Promotion needs a job to wait on and a bash tool that accepts
    // run_in_background; without either, the call stays plain foreground.
    canBackground: (agent) => {
      const properties = ctx.tools.get?.('bash', agent)?.parameters?.properties
      return properties !== undefined && properties !== null && Object.hasOwn(properties, 'run_in_background')
    },
    live: agent => ctx.get('agents')?.get?.(agent.id ?? agent.session?.id) === agent,
  })
  globalThis[REGISTRY] = background
  monitors = registerMonitor(ctx, {
    emit,
    isChildAgent,
    live: agent => ctx.get('agents')?.get?.(agent.id ?? agent.session?.id) === agent,
  })
  ctx.on('tools/execute', (exec, next) => background.execute(exec, next))
  ctx.on('tools/post-execute', (exec, result, next) => background.postExecute(exec, result, next))
  ctx.on('tools/result', (exec, result) => background.onResult(exec, result))
  ctx.on('agent/inbox/inserted', ({ agent, message }) => background.onInserted(agent, message))
  ctx.on('agent/inbox/discarded', ({ agent, message }) => background.onDiscarded(agent, message))
  ctx.on('agent/inbox/claimed', ({ agent, message }) => background.onClaimed(agent, message))
  ctx.on('agent/status', ({ agent, status }) => background.onStatus(agent, status))
  ctx.on('agent/disposed', ({ agent }) => background.onDisposed(agent))
  ctx.inject(['jobs'], (jobsCtx) => {
    jobsCtx.jobs.onJobDone(snapshot => background.onJobDone(snapshot))
  })
  ctx.on('dispose', () => {
    if (globalThis[REGISTRY] === background) delete globalThis[REGISTRY]
  })
}
