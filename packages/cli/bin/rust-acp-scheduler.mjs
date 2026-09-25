/**
 * Scheduled prompts for the Rust client (tickets 177 and 178): the
 * model-facing `scheduler_create`, `scheduler_delete` and `scheduler_list`
 * tools and the session-scoped scheduler behind them.
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
 * Saved loops and restart (ticket 178), following the reference actor
 * (scheduler/actor.rs at the pinned source): a session's tasks are saved
 * with that session, durable or not, and come back when the session is
 * resumed. On restore a task past its 7-day expiry is removed without a
 * fire; an overdue task fires once and its cadence restarts from that fire,
 * however many intervals were missed. `durable: true` additionally makes
 * the expiry wait until the task's absence is saved (a failed save leaves
 * it stopped instead of letting it come back later). A delete is only
 * reported after the absence is saved.
 *
 * What this build adds where the reference is silent, and states:
 * - One owner fires. dsh loads and fires a session's saved tasks only after
 *   the Rust client that holds the session's owner lock
 *   (`$DSH_HOME/session-owners/<id>.lock`) hands over its token on the
 *   control channel (`schedule_owner`). Every save and every fire re-reads
 *   the lock; a token that no longer matches stops the session's tasks
 *   without writing. The control socket closing (the client exited) stops
 *   every task at once. Without an owner, tasks live only in this process
 *   and say so (`saved: false`).
 * - A fire is recorded as in flight before it starts. A fire still marked
 *   in flight when the session is restored is reported as unknown (the
 *   process or session ended while it ran) and is not run again; nothing
 *   claims exactly-once execution.
 * - The permission mode a task was created under is kept; a fire under a
 *   different mode is shown as a permission change.
 * - With subagents disabled, saved tasks are listed as paused and never
 *   fire; the pane can still delete them.
 *
 * Differences from the reference that this build states instead of hiding:
 * - Each fire is a fresh child. The reference resumes the previous
 *   iteration's transcript for up to 10 iterations; here the previous
 *   iteration's final status (up to 600 characters) is given to the next
 *   fire instead, and a changed prompt drops it.
 * - Children never receive the scheduler tools, so a fire cannot schedule,
 *   update or delete tasks; its prompt carries no delete footer. The main
 *   agent gets the footer with the relayed status.
 * - Only the interactive Rust client enables the scheduler
 *   (CODSH_SCHEDULER=1). A plain turn, editor ACP and the shared server do
 *   not offer these tools and leave a session's saved tasks untouched.
 *
 * Lifecycle lines go to stderr as `\u241eschedule\u241e{json}` for the
 * client's tasks pane and status line.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { importFromDsh } from './rust-acp-dsh.mjs'
const { createUserMessage } = await importFromDsh('@deepseek-ai/dsh-llm')
const { defineTool } = await importFromDsh('@deepseek-ai/dsh-tools')

export const MARK = '\u241eschedule\u241e'
export const REGISTRY = Symbol.for('codsh.rust.scheduler')
export const SCHEDULER_TOOLS = ['scheduler_create', 'scheduler_delete', 'scheduler_list']
export const MIN_INTERVAL_SECS = 60
export const MAX_TASKS = 50
export const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
export const PRIOR_CHARS = 600
export const LIST_PROMPT_CHARS = 80
export const DETAIL_CHARS = 300
export const STORE_VERSION = 1
export const STORE_DIR = 'codsh-schedules'
const MAX_TIMER_MS = 2 ** 31 - 1

export const CREATE_DESCRIPTION = 'Create a scheduled task that runs a prompt on a recurring interval, or update an existing one in place.\n\nUse this tool when a user asks you to loop, repeat, or schedule a prompt or a task.\n\nSet fire_immediately: true to also fire once on creation; by default the first run waits for the interval.\n\nTo change an existing task, pass its task_id: provided fields replace old values, omitted ones are unchanged, and the schedule keeps its phase. An unknown id errors.\n\nUsage notes:\n- Interval format: "5m" (minutes), "2h" (hours), "1d" (days), "60s" (seconds, min 60)\n- Maximum 50 scheduled tasks at once\n- Tasks auto-expire after 7 days\n- For one-time delayed work, run a background terminal command (e.g. `sleep 1800 && <command>`) instead; its completion notifies you'
export const DELETE_DESCRIPTION = 'Cancel a scheduled task by ID.\n\nReturns success: true if the task was found and removed, false if no task with that ID exists.'
export const LIST_DESCRIPTION = 'List all active scheduled tasks with their IDs, prompts, intervals, and next fire times.'

export const ONE_SHOT_MESSAGE = 'one-shot tasks are not supported; run a background terminal command instead (`sleep <secs> && <command>`, background: true) or do the work now'
export const DURABLE_MESSAGE = 'scheduler_durability_unavailable: durable tasks need a saved session, and this dsh has no session owner to save them to; omit durable for a task that ends with this process'
export const OWNER_LOST = 'another codsh process now owns this session (its owner lock changed); this process stopped firing and saving its loops'
export const CLIENT_GONE = 'the codsh client that owned this session exited; its loops stopped here and stay saved for the next resume'
/** A fire that was in flight when its process or session ended. */
export const unknownOutcome = fire => `the dsh process or session ended while fire ${fire} ran; whether it finished and what it changed is unknown, and it was not run again`
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
export function framedPrompt({ id, human, prompt, prior, unknown }) {
  const previous = prior ? `\nYour previous iteration ended with:\n${truncateChars(prior, PRIOR_CHARS)}\n` : ''
  const lost = unknown ? `\nThe previous iteration (fire ${unknown.fire}) was interrupted: its dsh process or session ended while it ran, so whether it finished and what it changed is unknown. Check the current state before repeating any external action.\n` : ''
  return `<system-reminder>\nScheduled task ${id} (${human}). Each iteration starts fresh; the previous iteration's final status, if any, is below.\nRun the task below. End with a short status: what changed or needs attention. The status is relayed to the main agent.\n${previous}${lost}</system-reminder>\n\n${prompt}`
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

/** A session id that is safe as one file name (the client's rule). */
export function validSessionId(session) {
  return typeof session === 'string' && session !== '' && !session.includes('/') && !session.includes('\\') && !session.includes('..') && !session.includes('\0')
}

const finite = value => typeof value === 'number' && Number.isFinite(value)
const optionalText = value => value === null || value === undefined || typeof value === 'string'

/** One saved task, or null when the record is not one this build wrote. */
function readRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { id, prompt, intervalSecs, createdAt, expiresAt } = raw
  if (typeof id !== 'string' || id === '' || Buffer.byteLength(id) > 256) return null
  if (typeof prompt !== 'string' || prompt === '') return null
  if (!Number.isSafeInteger(intervalSecs) || intervalSecs < MIN_INTERVAL_SECS || intervalSecs * 1000 > Number.MAX_SAFE_INTEGER) return null
  if (!finite(createdAt) || !finite(expiresAt)) return null
  if (!(raw.lastFiredAt === null || raw.lastFiredAt === undefined || finite(raw.lastFiredAt))) return null
  if (!(raw.fires === undefined || (Number.isSafeInteger(raw.fires) && raw.fires >= 0))) return null
  if (!optionalText(raw.prior) || !optionalText(raw.mode)) return null
  const result = raw.lastResult
  if (!(result === null || result === undefined || (typeof result === 'object' && Number.isSafeInteger(result.fire) && typeof result.status === 'string' && optionalText(result.detail)))) return null
  const flight = raw.inFlight
  if (!(flight === null || flight === undefined || (typeof flight === 'object' && Number.isSafeInteger(flight.fire) && flight.fire > 0))) return null
  return {
    id,
    prompt,
    intervalSecs,
    durable: raw.durable === true,
    createdAt,
    lastFiredAt: finite(raw.lastFiredAt) ? raw.lastFiredAt : undefined,
    expiresAt,
    fires: raw.fires ?? 0,
    mode: raw.mode ?? '',
    prior: raw.prior ?? null,
    lastResult: result ? { fire: result.fire, status: result.status, detail: result.detail ?? '' } : null,
    inFlight: flight ? { fire: flight.fire, startedAt: finite(flight.startedAt) ? flight.startedAt : null } : null,
  }
}

/**
 * Saved tasks, one JSON file per session under `dir`. A save writes a
 * temporary file, syncs it and renames it over the old one, so a crash
 * leaves the previous or the next version, never half of one. An empty
 * session removes its file. `load` throws on a file it cannot read as a
 * whole; the caller leaves such a file alone.
 */
export function createStore(dir) {
  const path = session => {
    if (!validSessionId(session)) throw new Error(`invalid session id ${JSON.stringify(session)}`)
    return join(dir, `${session}.json`)
  }
  return {
    path,
    load(session) {
      let body
      try {
        body = readFileSync(path(session), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
      const parsed = JSON.parse(body)
      if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.tasks)) throw new Error('not a saved-loops file this build wrote')
      if (parsed.session !== undefined && parsed.session !== session) throw new Error(`the file belongs to session ${String(parsed.session)}`)
      if (parsed.tasks.length > MAX_TASKS) throw new Error(`more than ${MAX_TASKS} saved loops`)
      return parsed.tasks.map((raw, index) => {
        const task = readRecord(raw)
        if (!task) throw new Error(`saved loop ${index + 1} is not valid`)
        return task
      })
    },
    save(session, records) {
      const target = path(session)
      if (records.length === 0) {
        rmSync(target, { force: true })
        return
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const staging = `${target}.${process.pid}.tmp`
      // A leftover staging file (a crash mid-save) is replaced, never
      // followed: 'wx' refuses to open through an existing name.
      rmSync(staging, { force: true })
      const fd = openSync(staging, 'wx', 0o600)
      try {
        writeSync(fd, `${JSON.stringify({ version: STORE_VERSION, session, tasks: records }, null, 2)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(staging, target)
    },
  }
}

/**
 * Whether the session's owner lock (written by the Rust client, see
 * rust/src/session_owner.rs) still carries `token`. A missing, unreadable
 * or replaced lock is not held.
 */
export function ownerLockHeld(dshHome, session, token) {
  if (!dshHome || !validSessionId(session) || typeof token !== 'string' || token === '') return false
  try {
    const body = JSON.parse(readFileSync(join(dshHome, 'session-owners', `${session}.lock`), 'utf8'))
    return body?.token === token && (body.sessionId === undefined || body.sessionId === session)
  } catch {
    return false
  }
}

/** The permission mode in the policy file dsh reads, `unreadable`, or ''. */
export function permissionMode(path = process.env.CODSH_PERMISSION_POLICY) {
  if (!path) return ''
  try {
    const mode = JSON.parse(readFileSync(path, 'utf8'))?.mode
    return typeof mode === 'string' ? mode : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

const errorText = cause => oneLine(cause instanceof Error ? cause.message : cause)

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
 *   store                 createStore(dir), or null: nothing is saved
 *   ownerHeld(session, token)  the owner lock still carries token
 *   mode()                the permission mode fires run under now
 *   paused                a reason every task stays stopped (no fires)
 */
export function createScheduler(deps) {
  const { now, emit } = deps
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle))
  const realNow = deps.realNow ?? (() => Date.now())
  const uuid = deps.uuid ?? uuidv7
  const store = deps.store ?? null
  const ownerHeld = deps.ownerHeld ?? (() => false)
  const mode = deps.mode ?? (() => '')
  const paused = deps.paused ?? ''
  /** owner session id -> Map(task id -> task) */
  const owners = new Map()
  /**
   * session id -> { token, owner, damaged, saveError, stopped } once a
   * client handed over the session's owner lock. Only such a session is
   * saved and restored.
   */
  const saved = new Map()

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
  const persisting = session => {
    const state = saved.get(session)
    return state && !state.stopped && !state.damaged ? state : null
  }
  /** Why this task is not saved, or '' when it is. */
  const saveNote = task => {
    const state = saved.get(task.session)
    if (!store) return 'this dsh has no Home to save loops in'
    if (!state) return 'no codsh client owns this session, so this loop ends with this process'
    if (state.damaged) return `the saved-loops file could not be read (${state.damaged}) and is left as is`
    if (state.saveError) return `the last save failed (${state.saveError})`
    return ''
  }
  const permission = task => {
    const current = mode()
    return task.mode && current && current !== task.mode ? { created: task.mode, now: current } : null
  }
  const flags = task => {
    const note = saveNote(task)
    return {
      durable: task.durable,
      saved: note === '',
      saveNote: note,
      restored: task.restored,
      paused: task.paused,
      permission: permission(task),
      lastResult: task.lastResult,
    }
  }
  const describe = task => ({
    id: task.id,
    session: task.session,
    prompt: task.prompt,
    human: human(task),
    intervalSecs: task.intervalSecs,
    expiresAt: iso(task.expiresAt),
    fires: task.fires,
    ...flags(task),
    ...timing(task),
  })
  const record = task => ({
    id: task.id,
    prompt: task.prompt,
    intervalSecs: task.intervalSecs,
    durable: task.durable,
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt ?? null,
    expiresAt: task.expiresAt,
    fires: task.fires,
    mode: task.mode,
    prior: task.prior,
    lastResult: task.lastResult,
    inFlight: task.inFlight,
  })
  const state = task => emit({ event: 'state', id: task.id, session: task.session, ...flags(task), ...task.timer === undefined ? {} : timing(task) })

  const disarm = task => {
    if (task.timer !== undefined) clearTimer(task.timer)
    task.timer = undefined
  }
  const arm = task => {
    disarm(task)
    if (task.paused) return
    const delay = Math.max(0, wakeAt(task) - now())
    task.timer = setTimer(() => {
      task.timer = undefined
      tick(task)
    }, delay)
  }

  /** Stop a session's tasks without saving anything: the owner is gone. */
  const stopSession = (session, reason) => {
    const current = saved.get(session)
    if (current) current.stopped = true
    for (const task of owners.get(session)?.values() ?? []) {
      disarm(task)
      if (task.paused === reason) continue
      task.paused = reason
      state(task)
    }
  }

  /**
   * Save the session's live tasks (minus `without`). Returns '' or the
   * error text. Not a saved session: nothing to do. An owner lock that
   * moved to another process stops the session instead of writing.
   */
  const persist = (session, without) => {
    const current = persisting(session)
    if (!current) return ''
    if (!ownerHeld(session, current.token)) {
      stopSession(session, OWNER_LOST)
      return OWNER_LOST
    }
    const records = [...(owners.get(session)?.values() ?? [])].filter(task => task !== without).map(record)
    const before = current.saveError
    try {
      store.save(session, records)
      current.saveError = ''
    } catch (cause) {
      current.saveError = errorText(cause) || 'save failed'
    }
    if (before !== current.saveError) {
      for (const task of owners.get(session)?.values() ?? []) if (task !== without) state(task)
    }
    return current.saveError
  }

  const remove = (task, reason) => {
    disarm(task)
    const tasks = owners.get(task.session)
    if (!tasks || tasks.get(task.id) !== task) return false
    const wasSaved = saveNote(task) === ''
    tasks.delete(task.id)
    if (tasks.size === 0) owners.delete(task.session)
    task.removed = reason
    emit({ event: 'removed', id: task.id, session: task.session, reason, saved: wasSaved })
    return true
  }

  const live = task => owners.get(task.session)?.get(task.id) === task

  /** The owner still holds the lock, or this session is not saved at all. */
  const mayFire = task => {
    const current = saved.get(task.session)
    if (!current) return true
    if (current.stopped) return false
    if (ownerHeld(task.session, current.token)) return true
    stopSession(task.session, OWNER_LOST)
    return false
  }

  function tick(task) {
    if (!live(task) || task.paused) return
    if (!mayFire(task)) return
    const at = now()
    if (at >= task.expiresAt) {
      // Expired tasks go without a last fire. A durable task's absence must
      // be saved first; otherwise it stays stopped rather than coming back.
      const error = persist(task.session, task)
      if (error === OWNER_LOST) return
      if (error && task.durable) {
        task.paused = `expired, but its removal could not be saved (${error}); it stays stopped and is removed on a later resume`
        state(task)
        return
      }
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
      persist(task.session)
      emit({ event: 'skipped', id: task.id, session: task.session, reason: 'the previous iteration is still running', ...timing(task) })
      if (live(task)) arm(task)
      return
    }
    // Recorded before it starts: a crash from here on leaves this fire
    // unknown on the next restore, never silently run twice.
    task.inFlight = { fire: task.fires + 1, startedAt: at }
    if (persist(task.session) === OWNER_LOST) {
      task.inFlight = null
      return
    }
    fire(task)
    if (live(task)) arm(task)
  }

  function fire(task) {
    task.running = true
    const number = task.fires + 1
    const prior = task.chainReset ? null : task.prior
    const unknown = !task.chainReset && task.lastResult?.status === 'unknown' ? task.lastResult : null
    task.chainReset = false
    const humanText = human(task)
    const prompt = framedPrompt({ id: task.id, human: humanText, prompt: task.prompt, prior, unknown })
    const label = fireLabel(task.prompt, humanText)
    const shape = result => {
      const status = oneLine(result.text)
      return {
        output: `${String(result.text ?? '').replace(/\s+$/, '')}${result.text ? '\n\n' : ''}${scheduleFooter(task.id)}`,
        detail: `scheduled task ${task.id} fire ${number}${status ? `: ${truncateChars(status, DETAIL_CHARS)}` : ''}`,
      }
    }
    const settle = (status, summary, text) => {
      task.running = false
      task.inFlight = null
      // The next fresh fire starts from this status; a failed one starts clean.
      task.prior = status === 'completed' ? String(text ?? '') : null
      task.lastStatus = status
      task.lastResult = { fire: number, status, detail: summary }
      if (live(task)) persist(task.session)
    }
    let started
    try {
      started = Promise.resolve(deps.startFire({ owner: task.owner, task: { id: task.id, prompt: task.prompt, human: humanText, fire: number }, prompt, label, shape, live: () => live(task) }))
    } catch (cause) {
      started = Promise.reject(cause)
    }
    started.then(({ jobId, subagent, done }) => {
      task.fires = number
      emit({ event: 'fired', id: task.id, session: task.session, fire: number, job: jobId ?? '', subagent: subagent ?? '', label, ...flags(task), ...live(task) ? timing(task) : {} })
      Promise.resolve(done).then(result => {
        const status = result?.status ?? 'failed'
        const summary = truncateChars(oneLine(result?.text ?? ''), DETAIL_CHARS)
        settle(status, summary, result?.text)
        emit({ event: 'result', id: task.id, session: task.session, fire: number, status, summary })
      }, cause => {
        const summary = truncateChars(errorText(cause), DETAIL_CHARS)
        settle('failed', summary, '')
        emit({ event: 'result', id: task.id, session: task.session, fire: number, status: 'failed', summary })
      })
    }, cause => {
      // Nothing started: the chain restarts clean and the next tick retries.
      const detail = truncateChars(errorText(cause), DETAIL_CHARS)
      task.running = false
      task.inFlight = null
      task.prior = null
      task.lastStatus = 'failed'
      task.lastResult = { fire: number, status: 'not started', detail }
      if (live(task)) persist(task.session)
      emit({ event: 'failed', id: task.id, session: task.session, fire: number, detail, ...live(task) ? timing(task) : {} })
    })
  }

  const blank = value => value === undefined || value === null
  const str = value => (blank(value) ? undefined : String(value))

  return {
    /** scheduler_create: create, or update in place with task_id. */
    create(args, owner, session) {
      if (paused) throw new SchedulerError(paused)
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
        persist(session)
        arm(task)
        emit({ event: 'created', updated: true, ...describe(task) })
        return { id: task.id, humanSchedule: human(task), updated: true }
      }
      if (args?.recurring === false) throw new SchedulerError(ONE_SHOT_MESSAGE)
      if (intervalSecs === undefined) throw new SchedulerError('interval is required when creating a task')
      if (prompt === undefined) throw new SchedulerError('prompt is required when creating a task')
      const durable = args?.durable === true
      if (durable && !persisting(session)) throw new SchedulerError(DURABLE_MESSAGE)
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
        durable,
        // fire_immediately anchors creation one interval back, so the first
        // fire is due now and the cadence continues from it.
        createdAt: fireNow ? at - intervalSecs * 1000 : at,
        lastFiredAt: undefined,
        expiresAt: at + EXPIRY_MS,
        fires: 0,
        mode: mode(),
        running: false,
        prior: null,
        chainReset: false,
        lastStatus: undefined,
        lastResult: null,
        inFlight: null,
        restored: false,
        paused: '',
        timer: undefined,
      }
      tasks.set(task.id, task)
      const error = persist(session)
      if (error && durable) {
        tasks.delete(task.id)
        if (tasks.size === 0) owners.delete(session)
        throw new SchedulerError(`failed to persist scheduler resources: ${error}`)
      }
      emit({ event: 'created', updated: false, fireImmediately: fireNow, ...describe(task) })
      arm(task)
      return { id: task.id, humanSchedule: human(task), updated: false }
    },
    /**
     * scheduler_delete. An in-flight fire keeps running to its end. A saved
     * task is only reported deleted once its absence is saved.
     */
    delete(id, session) {
      const task = owners.get(session)?.get(String(id))
      if (!task) return { success: false, message: `No scheduled task with ID ${id} found. Use scheduler_list to see active tasks.` }
      if (persisting(session)) {
        const error = persist(session, task)
        if (error) throw new SchedulerError(error === OWNER_LOST ? `scheduler_owner_lost: ${OWNER_LOST}` : `failed to persist scheduler resources: ${error}`)
      }
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
    /**
     * A client holding the session's owner lock handed over its token: the
     * session is saved from now on and its saved tasks come back. Returns
     * { restored } or { error }. Handing over the same token again changes
     * nothing, so a reconnect never duplicates a task.
     */
    attach(session, owner, token) {
      if (!store) return { error: 'this dsh has no Home to save loops in' }
      if (!validSessionId(session)) return { error: 'invalid session id' }
      if (!ownerHeld(session, token)) return { error: 'the session owner lock does not carry this token' }
      const previous = saved.get(session)
      if (previous && previous.token === token && !previous.stopped) return { restored: 0 }
      const current = { token, owner, damaged: '', saveError: '', stopped: false }
      saved.set(session, current)
      let records = []
      try {
        records = store.load(session)
      } catch (cause) {
        current.damaged = errorText(cause) || 'unreadable'
        emit({ event: 'restore', session, restored: 0, error: current.damaged, path: store.path(session) })
        for (const task of owners.get(session)?.values() ?? []) state(task)
        return { error: current.damaged }
      }
      const tasks = tasksOf(session)
      const restored = []
      for (const entry of records) {
        if (tasks.has(entry.id)) continue
        const task = {
          ...entry,
          session,
          owner,
          running: false,
          chainReset: false,
          lastStatus: entry.lastResult?.status,
          restored: true,
          paused: paused,
          timer: undefined,
        }
        if (task.inFlight) {
          // The process or session that ran it is gone; its effects are
          // unknown and the fire is not run again.
          task.lastResult = { fire: task.inFlight.fire, status: 'unknown', detail: unknownOutcome(task.inFlight.fire) }
          task.fires = Math.max(task.fires, task.inFlight.fire)
          task.prior = null
          task.inFlight = null
        }
        tasks.set(task.id, task)
        restored.push(task)
      }
      if (tasks.size === 0) owners.delete(session)
      // Tasks created before the owner arrived are saved with the rest.
      for (const task of owners.get(session)?.values() ?? []) {
        task.owner = task.owner ?? owner
        if (task.paused === OWNER_LOST || task.paused === CLIENT_GONE) task.paused = paused
      }
      persist(session)
      emit({ event: 'restore', session, restored: restored.length, path: store.path(session) })
      for (const task of restored) emit({ event: 'created', updated: false, ...describe(task) })
      for (const task of owners.get(session)?.values() ?? []) {
        if (!restored.includes(task)) state(task)
        arm(task)
      }
      return { restored: restored.length }
    },
    /** The owning client is gone: nothing fires or saves from here on. */
    stopAll(reason = CLIENT_GONE) {
      for (const session of [...owners.keys()]) stopSession(session, reason)
      for (const current of saved.values()) current.stopped = true
    },
    /** The session closed: its tasks end with it here (saved ones stay saved). */
    dropSession(session, reason = 'session_closed') {
      for (const task of [...(owners.get(session)?.values() ?? [])]) remove(task, reason)
      saved.delete(session)
    },
    /** The dsh process is going away: every task ends here. */
    shutdown() {
      for (const session of [...new Set([...owners.keys(), ...saved.keys()])]) this.dropSession(session, 'shutdown')
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
 * (CODSH_TEST_SCHEDULER_TIME_SCALE, tests only), counted from `base`
 * (CODSH_TEST_SCHEDULER_EPOCH, so two processes of one test agree on the
 * time) and moved forward by `offset` ms (CODSH_TEST_SCHEDULER_OFFSET_MS,
 * a simulated downtime before a restart). Scale 1, no offset is the real
 * clock.
 */
export function scaledClock(scale, base = Date.now(), offset = 0) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  const origin = Number.isFinite(base) ? base : Date.now()
  const shift = Number.isFinite(offset) ? offset : 0
  return {
    now: () => origin + (Date.now() - origin) * factor + shift,
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
 *   paused                 set when subagents are off: no tools and no
 *                          fires; saved tasks are listed as paused and the
 *                          tasks pane can still delete them
 */
export function registerScheduler(ctx, deps) {
  const { isChildAgent } = deps
  const env = name => {
    const raw = process.env[name]
    return raw === undefined || raw === '' ? undefined : Number(raw)
  }
  const clock = scaledClock(env('CODSH_TEST_SCHEDULER_TIME_SCALE') ?? 1, env('CODSH_TEST_SCHEDULER_EPOCH'), env('CODSH_TEST_SCHEDULER_OFFSET_MS') ?? 0)
  const emit = event => {
    try {
      process.stderr.write(`${MARK}${JSON.stringify(event)}\n`)
    } catch {}
  }
  const dshHome = process.env.DSH_HOME || ''
  const scheduler = createScheduler({
    ...clock,
    emit,
    startFire: deps.startFire ?? (() => Promise.reject(new Error(deps.paused || 'no fires in this dsh'))),
    store: dshHome ? createStore(join(dshHome, STORE_DIR)) : null,
    ownerHeld: (session, token) => ownerLockHeld(dshHome, session, token),
    mode: () => permissionMode(),
    paused: deps.paused ?? '',
  })
  const sessionOf = agent => agent?.session?.id ?? agent?.id ?? ''
  const guard = exec => {
    if (deps.refusal) throw new Error(deps.refusal)
    const agent = exec.agent
    if (!agent) throw new Error('scheduler tools require a calling agent')
    if (isChildAgent(agent)) throw new Error(CHILD_MESSAGE)
    return agent
  }

  ctx.on('agent/disposed', ({ agent }) => {
    if (!isChildAgent(agent)) scheduler.dropSession(sessionOf(agent))
  })
  ctx.on('dispose', () => {
    scheduler.shutdown()
    if (globalThis[REGISTRY] === registry) delete globalThis[REGISTRY]
  })

  if (!deps.paused) {
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
  }

  /**
   * The control channel's side: the tasks pane's delete (same effect as the
   * tool; the model is told once, at its next step or with the next
   * message, so it does not keep referring to a task that is gone), the
   * owner handover, and the owning client going away.
   */
  const registry = {
    delete: (agent, id) => {
      let result
      try {
        result = scheduler.delete(id, sessionOf(agent))
      } catch (error) {
        return { success: false, message: String(error?.message ?? error) }
      }
      if (result.success && !deps.paused) {
        try {
          agent.inject(createUserMessage({
            content: [{ type: 'text', text: `scheduled task ${id} was deleted by the user from the tasks pane; it will not fire again.` }],
            source: { kind: 'plugin', plugin: 'rust-acp-scheduler', form: 'notice', summary: `scheduled task ${id} [deleted by the user]` },
          }))
        } catch {}
      }
      return result
    },
    attach: (agent, token) => (isChildAgent(agent) ? { error: 'not a main session' } : scheduler.attach(sessionOf(agent), agent, token)),
    stopAll: reason => scheduler.stopAll(reason),
  }
  globalThis[REGISTRY] = registry
  return scheduler
}
