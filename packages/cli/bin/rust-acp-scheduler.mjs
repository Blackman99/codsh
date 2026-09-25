/**
 * Scheduled prompts for the Rust client (ticket 177): the model-facing
 * `scheduler_create`, `scheduler_delete` and `scheduler_list` tools and the
 * session-scoped scheduler behind them.
 *
 * The tool names, parameters, descriptions, outputs and error sentences
 * follow the reference (grok-build 1.0.34). A task runs its prompt on a
 * recurring interval (minimum 60 seconds, at most 50 tasks per session,
 * expiring 7 days after creation). Each fire is independent execution: a
 * real dsh background subagent (the `subagent` tool's general-purpose type,
 * admission, permission listener, board line and dsh job), owned by the
 * session that created the task. The fire never runs in the main
 * conversation. Its final status comes back to that session once, through
 * dsh's own tool-jobs completion notice (injected into a busy agent, or
 * waking an idle one within dsh's wake budget); `job_output` reads the full
 * status with the task's delete/update footer.
 *
 * Differences from the reference that this build states instead of hiding:
 * - Tasks are session-only. `durable: true` is refused (persistent
 *   scheduling and restart behavior are ticket 178). Tasks end with their
 *   session or the dsh process, and the client is told (`removed`).
 * - Each fire is a fresh child. The reference resumes the previous
 *   iteration's transcript for up to 10 iterations; here the previous
 *   iteration's final status (up to 600 characters) is given to the next
 *   fire instead, and a changed prompt drops it.
 * - Children never receive the scheduler tools, so a fire cannot schedule,
 *   update or delete tasks; its prompt carries no delete footer. The main
 *   agent gets the footer with the relayed status.
 * - Only the interactive Rust client enables the scheduler
 *   (CODSH_SCHEDULER=1). A plain turn ends before any fire, and editor ACP
 *   and the shared server do not offer these tools, so no task can silently
 *   die with a process that was never going to fire it.
 *
 * Lifecycle lines go to stderr as `\u241eschedule\u241e{json}` for the
 * client's tasks pane and status line.
 */
import { randomBytes } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const MARK = '\u241eschedule\u241e'
export const REGISTRY = Symbol.for('codsh.rust.scheduler')
export const SCHEDULER_TOOLS = ['scheduler_create', 'scheduler_delete', 'scheduler_list']
export const MIN_INTERVAL_SECS = 60
export const MAX_TASKS = 50
export const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
export const PRIOR_CHARS = 600
export const LIST_PROMPT_CHARS = 80
export const DETAIL_CHARS = 300
const MAX_TIMER_MS = 2 ** 31 - 1

export const CREATE_DESCRIPTION = 'Create a scheduled task that runs a prompt on a recurring interval, or update an existing one in place.\n\nUse this tool when a user asks you to loop, repeat, or schedule a prompt or a task.\n\nSet fire_immediately: true to also fire once on creation; by default the first run waits for the interval.\n\nTo change an existing task, pass its task_id: provided fields replace old values, omitted ones are unchanged, and the schedule keeps its phase. An unknown id errors.\n\nUsage notes:\n- Interval format: "5m" (minutes), "2h" (hours), "1d" (days), "60s" (seconds, min 60)\n- Maximum 50 scheduled tasks at once\n- Tasks auto-expire after 7 days\n- For one-time delayed work, run a background terminal command (e.g. `sleep 1800 && <command>`) instead; its completion notifies you'
export const DELETE_DESCRIPTION = 'Cancel a scheduled task by ID.\n\nReturns success: true if the task was found and removed, false if no task with that ID exists.'
export const LIST_DESCRIPTION = 'List all active scheduled tasks with their IDs, prompts, intervals, and next fire times.'

export const ONE_SHOT_MESSAGE = 'one-shot tasks are not supported; run a background terminal command instead (`sleep <secs> && <command>`, background: true) or do the work now'
export const DURABLE_MESSAGE = 'scheduler_durability_unavailable: durable tasks are not available in this build (tasks end with this session); omit durable for a session-only task'
export const CHILD_MESSAGE = 'scheduler_unavailable_in_subagent: scheduled tasks can only be created, listed or deleted by the main agent'

/** A tool error with the reference sentence. */
export class SchedulerError extends Error {}

/**
 * Seconds for an interval string: digits and one of s/m/h/d, raised to the
 * 60-second minimum. Throws the reference `invalid interval: ...` sentence.
 */
export function parseInterval(raw) {
  const text = String(raw ?? '').trim()
  const fail = detail => new SchedulerError(`invalid interval: ${detail}`)
  if (text === '') throw fail('interval cannot be empty')
  const chars = [...text]
  const suffix = chars.at(-1)
  const digits = chars.slice(0, -1).join('')
  if (!/^\+?\d+$/.test(digits)) throw fail(`invalid interval format: ${JSON.stringify(text)} (expected e.g. 5m, 2h, 1d)`)
  const value = BigInt(digits)
  if (value > 18446744073709551615n) throw fail(`invalid interval format: ${JSON.stringify(text)} (expected e.g. 5m, 2h, 1d)`)
  if (value === 0n) throw fail('interval value must be greater than 0')
  const unit = { s: 1n, m: 60n, h: 3600n, d: 86400n }[suffix]
  if (unit === undefined) throw fail(`invalid interval suffix: ${JSON.stringify(suffix)} (expected s, m, h, or d)`)
  const secs = value * unit
  // u64 overflow in the reference; past a safe millisecond count here.
  if (secs > 18446744073709551615n || secs * 1000n > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(`interval too large: ${JSON.stringify(text)}`)
  return Math.max(Number(secs), MIN_INTERVAL_SECS)
}

/** `every 5 minutes`, `every 1 hour`, `every 90 seconds`. */
export function intervalToHuman(secs) {
  const unit = (n, word) => `every ${n} ${word}${n === 1 ? '' : 's'}`
  if (secs % 86400 === 0) return unit(secs / 86400, 'day')
  if (secs % 3600 === 0) return unit(secs / 3600, 'hour')
  if (secs % 60 === 0) return unit(secs / 60, 'minute')
  return unit(secs, 'second')
}

export function truncateChars(text, max) {
  const chars = [...String(text ?? '')]
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

/** A uuid v7: 48-bit millisecond time, version, variant, random. */
export function uuidv7(ms = Date.now()) {
  const bytes = randomBytes(16)
  let time = BigInt(Math.max(0, Math.floor(ms)))
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn)
    time >>= 8n
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The delete/update sentence the main agent receives with a fire's status. */
export function scheduleFooter(id) {
  return `If this schedule is no longer relevant, run scheduler_delete("${id}"). If it is outdated, you can update it with scheduler_create(new_prompt, interval, "${id}").`
}

/**
 * The prompt one fire's child receives. The raw prompt is what the task
 * stores; the framing says it is a scheduled run whose status is relayed.
 */
export function framedPrompt({ id, human, prompt, prior }) {
  const previous = prior ? `\nYour previous iteration ended with:\n${truncateChars(prior, PRIOR_CHARS)}\n` : ''
  return `<system-reminder>\nScheduled task ${id} (${human}). Each iteration starts fresh; the previous iteration's final status, if any, is below.\nRun the task below. End with a short status: what changed or needs attention. The status is relayed to the main agent.\n${previous}</system-reminder>\n\n${prompt}`
}

/** `loop: <first line, 60 chars> (<every ...>)`, the fire's board label. */
export function fireLabel(prompt, human) {
  const first = String(prompt).split('\n')[0] ?? ''
  return `loop: ${truncateChars(first, 60)} (${human})`
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

const iso = ms => new Date(ms).toISOString()

/**
 * The scheduler without dsh wiring, so it can be tested with a fake clock.
 * deps:
 *   now()                 scheduler clock in ms
 *   setTimer(fn, ms)      schedule fn after `ms` scheduler milliseconds
 *   clearTimer(handle)
 *   realNow()             wall-clock ms, for the client's countdown
 *   emit(event)           one lifecycle line
 *   startFire(spec)       start one fire; resolves { jobId, done } where
 *                         done resolves { status, text }; rejects when
 *                         nothing started. spec: { owner, task, prompt,
 *                         label, shape(result) -> { output, detail } }
 *   uuid(now)             task id
 */
export function createScheduler(deps) {
  const { now, emit } = deps
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle))
  const realNow = deps.realNow ?? (() => Date.now())
  const uuid = deps.uuid ?? uuidv7
  /** owner session id -> Map(task id -> task) */
  const owners = new Map()

  const tasksOf = session => {
    let tasks = owners.get(session)
    if (!tasks) {
      tasks = new Map()
      owners.set(session, tasks)
    }
    return tasks
  }
  const nextFire = task => (task.lastFiredAt ?? task.createdAt) + task.intervalSecs * 1000
  const wakeAt = task => Math.min(nextFire(task), task.expiresAt)
  const human = task => intervalToHuman(task.intervalSecs)
  const timing = task => {
    const at = nextFire(task)
    return { nextFireAt: iso(at), wakeAtMs: realNow() + Math.max(0, wakeAt(task) - now()) }
  }
  const describe = task => ({
    id: task.id,
    session: task.session,
    prompt: task.prompt,
    human: human(task),
    intervalSecs: task.intervalSecs,
    expiresAt: iso(task.expiresAt),
    fires: task.fires,
    ...timing(task),
  })

  const disarm = task => {
    if (task.timer !== undefined) clearTimer(task.timer)
    task.timer = undefined
  }
  const arm = task => {
    disarm(task)
    const delay = Math.max(0, wakeAt(task) - now())
    task.timer = setTimer(() => {
      task.timer = undefined
      tick(task)
    }, delay)
  }

  const remove = (task, reason) => {
    disarm(task)
    const tasks = owners.get(task.session)
    if (!tasks || tasks.get(task.id) !== task) return false
    tasks.delete(task.id)
    if (tasks.size === 0) owners.delete(task.session)
    task.removed = reason
    emit({ event: 'removed', id: task.id, session: task.session, reason })
    return true
  }

  const live = task => owners.get(task.session)?.get(task.id) === task

  function tick(task) {
    if (!live(task)) return
    const at = now()
    if (at >= task.expiresAt) {
      // Expired tasks go without a last fire.
      remove(task, 'expired')
      return
    }
    if (at < nextFire(task)) {
      arm(task)
      return
    }
    // The cadence advances whether this fire runs or is skipped.
    task.lastFiredAt = at
    if (task.running) {
      emit({ event: 'skipped', id: task.id, session: task.session, reason: 'the previous iteration is still running', ...timing(task) })
      arm(task)
      return
    }
    fire(task)
    arm(task)
  }

  function fire(task) {
    task.running = true
    const number = task.fires + 1
    const prior = task.chainReset ? null : task.prior
    task.chainReset = false
    const humanText = human(task)
    const prompt = framedPrompt({ id: task.id, human: humanText, prompt: task.prompt, prior })
    const label = fireLabel(task.prompt, humanText)
    const shape = result => {
      const status = oneLine(result.text)
      return {
        output: `${String(result.text ?? '').replace(/\s+$/, '')}${result.text ? '\n\n' : ''}${scheduleFooter(task.id)}`,
        detail: `scheduled task ${task.id} fire ${number}${status ? `: ${truncateChars(status, DETAIL_CHARS)}` : ''}`,
      }
    }
    let started
    try {
      started = Promise.resolve(deps.startFire({ owner: task.owner, task: { id: task.id, prompt: task.prompt, human: humanText, fire: number }, prompt, label, shape, live: () => live(task) }))
    } catch (cause) {
      started = Promise.reject(cause)
    }
    started.then(({ jobId, subagent, done }) => {
      task.fires = number
      emit({ event: 'fired', id: task.id, session: task.session, fire: number, job: jobId ?? '', subagent: subagent ?? '', label, ...live(task) ? timing(task) : {} })
      Promise.resolve(done).then(result => {
        task.running = false
        const status = result?.status ?? 'failed'
        // The next fresh fire starts from this status; a failed one starts clean.
        task.prior = status === 'completed' ? String(result?.text ?? '') : null
        task.lastStatus = status
        emit({ event: 'result', id: task.id, session: task.session, fire: number, status, summary: truncateChars(oneLine(result?.text ?? ''), DETAIL_CHARS) })
      }, cause => {
        task.running = false
        task.prior = null
        task.lastStatus = 'failed'
        emit({ event: 'result', id: task.id, session: task.session, fire: number, status: 'failed', summary: truncateChars(oneLine(cause instanceof Error ? cause.message : cause), DETAIL_CHARS) })
      })
    }, cause => {
      // Nothing started: the chain restarts clean and the next tick retries.
      task.running = false
      task.prior = null
      task.lastStatus = 'failed'
      emit({ event: 'failed', id: task.id, session: task.session, fire: number, detail: truncateChars(oneLine(cause instanceof Error ? cause.message : cause), DETAIL_CHARS), ...live(task) ? timing(task) : {} })
    })
  }

  const blank = value => value === undefined || value === null
  const str = value => (blank(value) ? undefined : String(value))

  return {
    /** scheduler_create: create, or update in place with task_id. */
    create(args, owner, session) {
      const taskId = str(args?.task_id)
      const prompt = str(args?.prompt)
      const intervalSecs = blank(args?.interval) ? undefined : parseInterval(args.interval)
      if (taskId !== undefined) {
        if (prompt === undefined && intervalSecs === undefined) throw new SchedulerError('nothing to update: provide interval and/or prompt alongside task_id')
        const task = owners.get(session)?.get(taskId)
        if (!task) throw new SchedulerError(`no scheduled task with id ${taskId}; call scheduler_list to see active task ids`)
        if (intervalSecs !== undefined) {
          task.intervalSecs = intervalSecs
          // A shorter interval never fires on the update itself: the phase
          // restarts from now when the new next fire is already due.
          if (nextFire(task) <= now()) task.lastFiredAt = now()
        }
        if (prompt !== undefined && prompt !== task.prompt) {
          task.prompt = prompt
          task.chainReset = true
          task.prior = null
        }
        arm(task)
        emit({ event: 'created', updated: true, ...describe(task) })
        return { id: task.id, humanSchedule: human(task), updated: true }
      }
      if (args?.recurring === false) throw new SchedulerError(ONE_SHOT_MESSAGE)
      if (intervalSecs === undefined) throw new SchedulerError('interval is required when creating a task')
      if (prompt === undefined) throw new SchedulerError('prompt is required when creating a task')
      if (args?.durable === true) throw new SchedulerError(DURABLE_MESSAGE)
      const tasks = tasksOf(session)
      if (tasks.size >= MAX_TASKS) {
        if (tasks.size === 0) owners.delete(session)
        throw new SchedulerError(`maximum of ${MAX_TASKS} scheduled tasks reached`)
      }
      const at = now()
      const fireNow = args?.fire_immediately === true
      const task = {
        id: uuid(at),
        session,
        owner,
        prompt,
        intervalSecs,
        // fire_immediately anchors creation one interval back, so the first
        // fire is due now and the cadence continues from it.
        createdAt: fireNow ? at - intervalSecs * 1000 : at,
        lastFiredAt: undefined,
        expiresAt: at + EXPIRY_MS,
        fires: 0,
        running: false,
        prior: null,
        chainReset: false,
        lastStatus: undefined,
        timer: undefined,
      }
      tasks.set(task.id, task)
      emit({ event: 'created', updated: false, fireImmediately: fireNow, ...describe(task) })
      arm(task)
      return { id: task.id, humanSchedule: human(task), updated: false }
    },
    /** scheduler_delete. An in-flight fire keeps running to its end. */
    delete(id, session) {
      const task = owners.get(session)?.get(String(id))
      if (!task) return { success: false, message: `No scheduled task with ID ${id} found. Use scheduler_list to see active tasks.` }
      remove(task, 'deleted')
      return { success: true, message: `Scheduled task ${id} cancelled.` }
    },
    /** scheduler_list. */
    list(session) {
      const tasks = [...(owners.get(session)?.values() ?? [])]
      return {
        tasks: tasks.map(task => {
          const chars = [...task.prompt]
          return {
            id: task.id,
            prompt: chars.length > LIST_PROMPT_CHARS ? `${chars.slice(0, LIST_PROMPT_CHARS).join('')}...` : task.prompt,
            intervalHuman: human(task),
            nextFireAt: iso(nextFire(task)),
            createdAt: iso(task.createdAt),
            recurring: true,
          }
        }),
      }
    },
    /** The session closed: its tasks end with it. */
    dropSession(session, reason = 'session_closed') {
      for (const task of [...(owners.get(session)?.values() ?? [])]) remove(task, reason)
    },
    /** The dsh process is going away: every task ends. */
    shutdown() {
      for (const session of [...owners.keys()]) this.dropSession(session, 'shutdown')
    },
    count(session) {
      return owners.get(session)?.size ?? 0
    },
    get(session, id) {
      return owners.get(session)?.get(id)
    },
  }
}

/**
 * A clock whose time runs `scale` times faster than the wall clock
 * (CODSH_TEST_SCHEDULER_TIME_SCALE, tests only). Scale 1 is the real clock.
 */
export function scaledClock(scale, base = Date.now()) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    now: () => base + (Date.now() - base) * factor,
    setTimer: (fn, ms) => {
      // setTimeout caps near 24.8 days; a longer wait re-arms in chunks.
      const handle = { timer: undefined }
      const wait = remaining => {
        const real = remaining / factor
        const step = Math.min(real, MAX_TIMER_MS)
        handle.timer = setTimeout(() => {
          const left = real - step
          if (left > 0) wait(left * factor)
          else fn()
        }, step)
        handle.timer.unref?.()
      }
      wait(ms)
      return handle
    },
    clearTimer: handle => clearTimeout(handle?.timer),
  }
}

function toolText(value) {
  return JSON.stringify(value)
}

/**
 * Register the scheduler tools. deps:
 *   isChildAgent(agent)
 *   refusal                a policy error that refuses every call, or null
 *   startFire(spec)        see createScheduler
 */
export function registerScheduler(ctx, deps) {
  const { isChildAgent } = deps
  const rawScale = Number(process.env.CODSH_TEST_SCHEDULER_TIME_SCALE ?? '1')
  const clock = scaledClock(rawScale)
  const emit = event => {
    try {
      process.stderr.write(`${MARK}${JSON.stringify(event)}\n`)
    } catch {}
  }
  const scheduler = createScheduler({ ...clock, emit, startFire: deps.startFire })
  const sessionOf = agent => agent?.session?.id ?? agent?.id ?? ''
  const guard = exec => {
    if (deps.refusal) throw new Error(deps.refusal)
    const agent = exec.agent
    if (!agent) throw new Error('scheduler tools require a calling agent')
    if (isChildAgent(agent)) throw new Error(CHILD_MESSAGE)
    return agent
  }

  // A fire's child (or any subagent) never sees the scheduler tools, and a
  // call that still arrives is refused before dsh runs it.
  ctx.on('agent/created', ({ agent }) => {
    if (!isChildAgent(agent)) return
    const deny = SCHEDULER_TOOLS.filter(tool => {
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
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (SCHEDULER_TOOLS.includes(exec.name) && isChildAgent(exec.agent)) return { kind: 'deny', reason: CHILD_MESSAGE }
    return next()
  }, true)
  ctx.on('agent/disposed', ({ agent }) => {
    if (!isChildAgent(agent)) scheduler.dropSession(sessionOf(agent))
  })
  ctx.on('dispose', () => {
    scheduler.shutdown()
    if (globalThis[REGISTRY] === registry) delete globalThis[REGISTRY]
  })

  const text = { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] }
  ctx.tools.register(defineTool({
    name: 'scheduler_create',
    description: CREATE_DESCRIPTION,
    parameters: {
      task_id: { type: 'string', description: 'Id of an existing task to update in place: provided fields replace old values, omitted ones are unchanged, the schedule keeps its phase, and an unknown id errors. Omit to create a task.' },
      interval: { type: 'string', description: 'Interval between executions, e.g. "5m", "2h", "1d". Required to create; optional with task_id' },
      prompt: { type: 'string', description: 'The prompt text to execute on each scheduled fire. Required to create; optional with task_id' },
      durable: { type: 'boolean', description: 'Whether the task persists across sessions. Default: false. Create-only: ignored with task_id' },
      fire_immediately: { type: 'boolean', description: 'Whether to fire immediately on creation (true) or wait for the first interval (false). Default: false. Create-only: ignored with task_id' },
    },
    output: text,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = guard(exec)
      return toolText(scheduler.create(args ?? {}, agent, sessionOf(agent)))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'scheduler_delete',
    description: DELETE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'The task ID to cancel (from scheduler_create output)' },
    },
    output: text,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = guard(exec)
      return toolText(scheduler.delete(args.id, sessionOf(agent)))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'scheduler_list',
    description: LIST_DESCRIPTION,
    parameters: {},
    output: text,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = guard(exec)
      return toolText(scheduler.list(sessionOf(agent)))
    },
  }))

  /**
   * The tasks pane's delete (control channel): same effect as the tool. The
   * model is told once, at its next step or with the next message, so it
   * does not keep referring to a task that is gone.
   */
  const registry = {
    delete: (agent, id) => {
      const result = scheduler.delete(id, sessionOf(agent))
      if (result.success) {
        try {
          agent.inject(createUserMessage({
            content: [{ type: 'text', text: `scheduled task ${id} was deleted by the user from the tasks pane; it will not fire again.` }],
            source: { kind: 'plugin', plugin: 'rust-acp-scheduler', form: 'notice', summary: `scheduled task ${id} [deleted by the user]` },
          }))
        } catch {}
      }
      return result
    },
  }
  globalThis[REGISTRY] = registry
  return scheduler
}
