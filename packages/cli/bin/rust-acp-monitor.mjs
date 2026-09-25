/**
 * Monitors for the Rust client (ticket 176): the model-facing `monitor`
 * tool. A monitor runs a long-lived script; each stdout line is an event
 * that reaches the session that started it, and the script's exit ends the
 * watch.
 *
 * The tool's name, parameters, description, limits and model-facing texts
 * follow the reference (grok-build monitor tool at the pinned source,
 * crates/codegen/xai-grok-tools/src/implementations/grok_build/monitor):
 * - `timeout_ms` defaults to and is capped at 36,000,000 ms (10 h); above
 *   the cap `persistent` must be true. `persistent` runs the monitor for
 *   the session's lifetime.
 * - Output is polled every 200 ms. Lines are trimmed, empty lines skipped,
 *   a line longer than 500 bytes truncated, the lines of one poll batched
 *   into one event (at most 3000 bytes), and the partial-line buffer capped
 *   at 1 MiB.
 * - Events pass a token bucket (10 events, one more every 2 s). Suppressed
 *   events are counted and announced before the next allowed event; after
 *   30 s of continuous suppression the monitor stops with the reference's
 *   "[Monitor stopped -- ...]" event.
 * - An event is `<monitor-event description="…" task_id="…">` text. A
 *   natural exit sends no extra event: dsh's own completion notice reports
 *   it once.
 *
 * dsh runs everything. The script starts through dsh's bash executor
 * (`ctx.shell`) with the session's sandbox policy, working directory and
 * managed environment, the permission gate sees the call as a bash command
 * (rust-acp-file-approval), and it is registered as a real `ctx.jobs` job
 * (kind `monitor`), so `job_output`, `job_list` and `job_kill` work on it,
 * it stops when its session or the dsh process ends, and its end comes back
 * through dsh's tool-jobs completion notice.
 *
 * Delivery to the owning session, and only to it:
 * - a busy agent gets events at its next step boundary, as the reference
 *   surfaces events mid-turn, but only when a boundary is coming anyway (a
 *   tool call is running, or another message extends the turn): an event
 *   that lands while the model writes its answer is held, because dsh
 *   would otherwise run one more model step for it outside any budget;
 * - an idle agent is woken by the event (a follow-up turn), at most 3
 *   times in a row without a user message, the same budget dsh gives
 *   completion notices; past it, events wait for the next user message;
 * - held events, and any event left in the inbox after the turn's last
 *   step, are delivered as one wake (grouped per monitor) when the agent
 *   goes idle, within the same budget;
 * - after a cancel, events wait for the next user message: an event the
 *   cancel cleared from the inbox is put back, and nothing wakes.
 *
 * Where this build differs from the reference, it says so:
 * - A monitor stopped for too much output is also killed: the reference
 *   only stops streaming it. Its "[Monitor stopped -- ...]" event is the one
 *   notice; no completion notice follows.
 * - The script's stderr is part of its stream (`exec 2>&1`), as in the
 *   reference's terminal log, so a failing script's error line is an event.
 * - Subagents do not get the tool; only the interactive client turns it on
 *   (CODSH_MONITOR=1). A plain turn, editor ACP and the shared server do
 *   not offer it.
 *
 * Lifecycle lines go to stderr on the background channel
 * (`\u241ejob\u241e{json}`, `kind: "monitor"`) for the client's tasks pane,
 * status line and transcript.
 */
import { realpathSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const MONITOR_TOOL = 'monitor'
export const PLUGIN = 'rust-acp-monitor'
export const KIND = 'monitor'
export const DEFAULT_TIMEOUT_MS = 36_000_000
export const MAX_TIMEOUT_MS = 36_000_000
export const LINE_TRUNCATION_LIMIT = 500
export const BATCH_TRUNCATION_LIMIT = 3_000
export const BUFFER_CAP_BYTES = 1_048_576
export const DEBOUNCE_MS = 200
export const RATE_LIMIT_CAPACITY = 10
export const RATE_LIMIT_REFILL_MS = 2_000
export const AUTO_KILL_THRESHOLD_MS = 30_000
export const DEFAULT_WAKE_BUDGET = 3
/** Events waiting in one agent's inbox before the oldest are dropped (reference cap). */
export const MAX_PENDING_EVENTS = 50
/** Unread output kept for `job_output`; dsh spills the full stream itself. */
export const OUTPUT_KEEP_BYTES = 1_048_576
const KILL_TOOL = 'job_kill'
const TAIL = 4000
const CHILD_MESSAGE = 'monitor is only available to the main agent'
export const USER_KILLED_NOTICE = 'This task was killed by the user — do not restart it.'

export const DESCRIPTION = [
  'Start a background monitor that streams events from a long-running script. Each stdout line is an event - you can keep working and notifications arrive in the chat. Exit ends the watch.',
  '',
  '**Output volume**: Every stdout line is a main-agent wake. Print only `DONE`/`FAILED`/`CANCELLED`. No progress or CHANGE lines. Use `grep --line-buffered` in pipes (plain `grep` buffers and delays events by minutes).',
  '',
  '**Responsiveness**: Emit `FAILED` to notify immediately when any required item fails; never wait for unrelated work to finish. Include every tracked failure signal in this immediate failure condition.',
  '',
  `Set \`persistent: true\` for session-length watches (PR monitoring, log tails) -- the monitor runs until you call ${KILL_TOOL} or until the session ends. Otherwise it stops at \`timeout_ms\` (default 10h).`,
].join('\n')

export const PARAMETERS = {
  command: { type: 'string', required: true, description: 'Shell command or script. Each stdout line is an event; exit ends the watch.' },
  description: { type: 'string', required: true, description: 'Short human-readable description of what you are monitoring (shown in every notification).' },
  timeout_ms: { type: 'number', description: 'Kill the monitor after this deadline (ms). Default: 36000000 (10 hr). Max: 36000000 (10 hr).' },
  persistent: {
    oneOf: [{ type: 'boolean' }, { type: 'string' }, { type: 'number' }, { type: 'null' }],
    description: `Run for the lifetime of the session (no timeout). Stop with ${KILL_TOOL}.`,
  },
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const byteLength = text => encoder.encode(text).byteLength

/** The first `max` bytes of `text`, cut at a character boundary. */
export function truncateBytes(text, max) {
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= max) return text
  let end = max
  // A UTF-8 continuation byte is 10xxxxxx: step back to a lead byte.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return decoder.decode(bytes.subarray(0, end))
}

function tailBytes(text, max) {
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= max) return text
  let start = bytes.byteLength - max
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1
  return decoder.decode(bytes.subarray(start))
}

function tail(text, max = TAIL) {
  const value = String(text ?? '')
  return value.length > max ? `…${value.slice(value.length - max)}` : value
}

/** Reference `lenient_bool_from_json`. */
export function lenientBool(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (['true', 'yes', '1'].includes(text)) return true
    if (['false', 'no', '0'].includes(text)) return false
  }
  throw new Error(`expected a boolean (true/false, "true"/"false", "yes"/"no", "1"/"0", 1/0), got ${JSON.stringify(value)}`)
}

/**
 * Validate the model's input the way the reference does and resolve the
 * deadline. `timeoutMs` 0 means no deadline (persistent).
 */
export function resolveInput(args) {
  const input = args ?? {}
  const command = typeof input.command === 'string' ? input.command : ''
  if (command.trim() === '') throw new Error('invalid command: expected a non-empty string')
  if (typeof input.description !== 'string') throw new Error('invalid description: expected a string')
  const persistent = lenientBool(input.persistent)
  let requested = DEFAULT_TIMEOUT_MS
  if (input.timeout_ms !== undefined && input.timeout_ms !== null) {
    if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 0) throw new Error(`invalid timeout_ms: expected a whole number of milliseconds >= 0, got ${JSON.stringify(input.timeout_ms)}`)
    requested = input.timeout_ms
  }
  if (!persistent && requested > MAX_TIMEOUT_MS) throw new Error(`persistent must be true when timeout_ms exceeds ${MAX_TIMEOUT_MS}ms`)
  const timeoutMs = persistent ? 0 : requested
  return { command, description: input.description, timeoutMs, persistent: timeoutMs === 0 }
}

/** The tool result the model reads (reference wording). */
export function startedText(taskId, timeoutMs) {
  const head = timeoutMs === 0
    ? `Monitor started (task ${taskId}, persistent -- runs until ${KILL_TOOL} or session end).`
    : `Monitor started (task ${taskId}, timeout ${timeoutMs}ms).`
  return `${head}\nYou will be notified on each event. Keep working -- do not poll or sleep.\nEvents may arrive while you are waiting for the user -- an event is not their reply.`
}

function truncateLine(line) {
  return byteLength(line) > LINE_TRUNCATION_LIMIT ? `${truncateBytes(line, LINE_TRUNCATION_LIMIT)}...(truncated)` : line
}

/** Reference `LineProcessor`: complete, trimmed, non-empty lines. */
export class LineProcessor {
  buffer = ''

  push(chunk) {
    this.buffer += chunk
    if (byteLength(this.buffer) > BUFFER_CAP_BYTES) this.buffer = tailBytes(this.buffer, BUFFER_CAP_BYTES)
    const lines = []
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const text = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (text !== '') lines.push(truncateLine(text))
    }
    return lines
  }

  flush() {
    const text = this.buffer.trim()
    this.buffer = ''
    return text === '' ? undefined : truncateLine(text)
  }
}

export function batchLines(lines) {
  const joined = lines.join('\n')
  return byteLength(joined) > BATCH_TRUNCATION_LIMIT ? `${truncateBytes(joined, BATCH_TRUNCATION_LIMIT)}\n...(truncated)` : joined
}

export function sanitizeDescription(description) {
  return String(description).replaceAll('"', "'").replace(/[\r\n]/g, ' ')
}

export function wrapEvent(description, text, taskId) {
  return `<monitor-event description="${sanitizeDescription(description)}" task_id="${taskId}">\n${text}\n</monitor-event>`
}

/**
 * Several events taken back from the inbox, as one wake (reference
 * `format_monitor_events`): grouped per monitor, in first-seen order.
 */
export function formatEvents(events) {
  if (events.length === 0) return undefined
  if (events.length === 1) return wrapEvent(events[0].description, events[0].text, events[0].taskId)
  const groups = []
  for (const event of events) {
    let group = groups.find(entry => entry.taskId === event.taskId)
    if (group === undefined) {
      group = { taskId: event.taskId, description: event.description, texts: [] }
      groups.push(group)
    }
    group.texts.push(event.text)
  }
  let text = `${events.length} monitor events from ${groups.length} ${groups.length === 1 ? 'monitor' : 'monitors'} (use job_list to identify each monitor):`
  for (const group of groups) {
    const description = sanitizeDescription(group.description) || 'event'
    text += `\n\n<monitor description="${description}" task_id="${group.taskId}">`
    group.texts.forEach((inner, index) => { text += `\n[${index + 1}] ${inner}` })
    text += '\n</monitor>'
  }
  return text
}

/**
 * Reference token bucket plus suppression tracker. `now()` is milliseconds.
 */
export class RateLimiter {
  constructor(now, { capacity = RATE_LIMIT_CAPACITY, refillMs = RATE_LIMIT_REFILL_MS, autoKillMs = AUTO_KILL_THRESHOLD_MS } = {}) {
    this.now = now
    this.capacity = capacity
    this.refillMs = refillMs
    this.autoKillMs = autoKillMs
    this.tokens = capacity
    this.lastRefill = now()
    this.suppressed = 0
    this.lastSuppression = undefined
    this.suppressionStart = undefined
    this.killed = false
  }

  consume() {
    const now = this.now()
    const refills = Math.floor((now - this.lastRefill) / this.refillMs)
    if (refills > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refills)
      this.lastRefill += refills * this.refillMs
    }
    if (this.tokens > 0) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /** `{ kind: 'allowed', notice? } | { kind: 'suppressed' } | { kind: 'kill', message }` */
  process() {
    if (this.killed) return { kind: 'suppressed' }
    const available = this.consume()
    const now = this.now()
    if (available) {
      let notice
      if (this.suppressed > 0) {
        notice = `[${this.suppressed} events suppressed -- output rate too high. Consider using ${KILL_TOOL} to restart this monitor with a more selective filter.]`
        this.suppressed = 0
        if (this.lastSuppression !== undefined && now - this.lastSuppression > this.refillMs * 3) this.suppressionStart = undefined
      }
      return { kind: 'allowed', notice }
    }
    this.suppressed += 1
    this.lastSuppression = now
    if (this.suppressionStart === undefined) this.suppressionStart = now
    const elapsed = now - this.suppressionStart
    if (elapsed > this.autoKillMs) {
      this.killed = true
      return {
        kind: 'kill',
        message: `[Monitor stopped -- your script produced too much output (${this.suppressed} events suppressed over ${Math.floor(elapsed / 1000)}s). Write a new monitor command that filters more aggressively -- pipe through grep --line-buffered, awk, or a wrapper script that only emits the specific events you need.]`,
      }
    }
    return { kind: 'suppressed' }
  }
}

/** Split a bash read delta: stdout, then dsh's marked `[stderr]` section. */
export function splitDelta(delta) {
  const text = String(delta ?? '')
  if (text.startsWith('[stderr]\n')) return { out: '', err: text.slice(9) }
  const index = text.lastIndexOf('\n[stderr]\n')
  if (index === -1) return { out: text, err: '' }
  return { out: text.slice(0, index + 1), err: text.slice(index + 10) }
}

/** The job detail for a settled monitor (reference `[monitor ended: …]`). */
export function endDetail(proc, stop, timeoutMs) {
  if (proc.sandbox?.runnerFailed) return `monitor ended: the sandbox runner failed under ${proc.sandbox.mode} mode -- the command did not run`
  const denied = proc.sandbox?.denied ? `; sandbox: file access denied under ${proc.sandbox.mode} mode` : ''
  if (stop?.why === 'timeout') return `monitor ended: timed out after ${timeoutMs}ms${denied}`
  if (stop?.why === 'rate') return `monitor ended: stopped for too much output${denied}`
  if (stop?.why === 'user') return `monitor ended: stopped by the user from the tasks pane${denied}`
  if (proc.status === 'killed') {
    const how = proc.signal ? `killed by signal ${proc.signal}` : 'killed'
    return `monitor ended: ${how}${stop?.reason ? ` (${stop.reason})` : ''}${denied}`
  }
  return `monitor ended: exited (code ${proc.exitCode ?? 0})${denied}`
}

/** The one-line account of delivered events (transcript and replay). */
export function summaryOf(events) {
  const first = events[0]
  const line = String(first.text).split('\n')[0].slice(0, 120)
  const more = events.length > 1 ? ` (+${events.length - 1} more)` : ''
  return `${first.description}: ${line}${more}`
}

const isMonitorMessage = message => message?.source?.kind === 'plugin' && message.source.plugin === PLUGIN && message.source.form === 'notice'

/**
 * The monitor state machine without dsh wiring, so it can be tested.
 * deps:
 *   jobs()                  ctx.jobs
 *   shell()                 ctx.shell (resolve/start)
 *   env(exec)               managed DSH_* environment for the call
 *   policy(exec)            resolved sandbox policy, or undefined
 *   emit(event)             one lifecycle line
 *   live(agent)             the agent is still registered
 *   now()                   ms clock for the rate limiter
 *   every(fn, ms) / cancelEvery(handle)
 *   later(fn, ms) / cancelLater(handle)
 *   wakeBudget              consecutive wakes without a user message
 *   isChildAgent(agent)
 */
export function createMonitors(deps) {
  const { emit } = deps
  const now = deps.now ?? (() => Date.now())
  const every = deps.every ?? ((fn, ms) => { const handle = setInterval(fn, ms); handle.unref?.(); return handle })
  const cancelEvery = deps.cancelEvery ?? (handle => clearInterval(handle))
  const later = deps.later ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle })
  const cancelLater = deps.cancelLater ?? (handle => clearTimeout(handle))
  const wakeBudget = deps.wakeBudget ?? DEFAULT_WAKE_BUDGET
  const isChildAgent = deps.isChildAgent ?? (() => false)
  const pollMs = deps.pollMs ?? DEBOUNCE_MS
  /** Monitors by job id. */
  const monitors = new Map()
  /** Wakes spent per agent since its last user message. */
  const spent = new WeakMap()
  /** Message id -> events it carries ({ taskId, description, text }). */
  const carried = new Map()
  /** Ids this module removed from an inbox on purpose. */
  const removing = new Set()
  /** Tool calls running per agent: a step boundary follows each of them. */
  const executing = new WeakMap()
  /** Events that arrived while the model was answering, per agent. */
  const held = new Map()
  /** Sessions whose last turn the user cancelled. */
  const cancelled = new Set()

  const sessionOf = agent => agent?.session?.id ?? ''

  function note(agent, message, events) {
    carried.set(message.id, { agent, events })
  }

  /**
   * Route events to their owner. An idle owner is woken within its budget
   * (past it the events wait in the inbox for the next user message). A
   * busy owner gets them at its next step only when one is coming anyway
   * (a tool call is running); while the model is answering they are held,
   * because an inbox message would extend a turn that is about to end, a
   * model request the wake budget never sees. Held events go out after the
   * next tool call, with another message that extends the turn, or as one
   * wake when the owner goes idle.
   */
  function send(agent, events) {
    if (!deps.live(agent)) return
    if (agent.status === 'idle') {
      const used = spent.get(agent) ?? 0
      if (used < wakeBudget) {
        spent.set(agent, used + 1)
        post(agent, events, true)
      } else {
        post(agent, events, false)
      }
      return
    }
    if ((executing.get(agent) ?? 0) > 0) {
      post(agent, events, false)
      return
    }
    hold(agent, events)
  }

  /** One event message: a follow-up turn (wake) or next-step input. */
  function post(agent, events, wake) {
    const message = createUserMessage({
      content: [{ type: 'text', text: formatEvents(events) }],
      source: {
        kind: 'plugin',
        plugin: PLUGIN,
        form: 'notice',
        summary: summaryOf(events),
      },
    })
    note(agent, message, events)
    try {
      if (wake) {
        agent.followup(message)
      } else {
        agent.inject(message)
        trim(agent)
      }
    } catch {
      carried.delete(message.id)
    }
  }

  function hold(agent, events) {
    const list = held.get(agent) ?? []
    list.push(...events)
    const over = list.length - MAX_PENDING_EVENTS
    if (over > 0) {
      list.splice(0, over)
      emit({ event: 'hint', session: sessionOf(agent), text: `dropped the ${over} oldest undelivered monitor event(s): more than ${MAX_PENDING_EVENTS} were waiting` })
    }
    held.set(agent, list)
  }

  /** A step boundary is coming: held events join it. */
  function release(agent) {
    const list = held.get(agent)
    if (list === undefined || list.length === 0) return
    held.delete(agent)
    if (deps.live(agent)) post(agent, list, false)
  }

  /** Keep at most MAX_PENDING_EVENTS undelivered event messages per agent. */
  function trim(agent) {
    const waiting = [...carried].filter(([, entry]) => entry.agent === agent).map(([id]) => id)
    let dropped = 0
    for (const id of waiting.slice(0, Math.max(0, waiting.length - MAX_PENDING_EVENTS))) {
      removing.add(id)
      let removed = false
      try {
        removed = agent.inbox.remove(id)
      } catch {}
      if (!removed) removing.delete(id)
      carried.delete(id)
      dropped += 1
    }
    if (dropped > 0) emit({ event: 'hint', session: sessionOf(agent), text: `dropped the ${dropped} oldest undelivered monitor event(s): more than ${MAX_PENDING_EVENTS} were waiting` })
  }

  function event(record, text) {
    if (record.halted) return
    const outcome = record.limiter.process()
    if (outcome.kind === 'suppressed') {
      record.suppressed += 1
      return
    }
    if (outcome.kind === 'kill') {
      record.halted = true
      deliver(record, outcome.message)
      emit({ event: 'hint', session: record.session, id: record.id, text: `monitor "${record.description}" stopped: its script produced too much output` })
      record.stop = { why: 'rate' }
      try {
        // A kill marks the job reported: the stop event above is its one notice.
        deps.jobs().kill(record.id, record.agent, 'monitor output rate too high')
      } catch {
        record.proc?.kill()
      }
      return
    }
    if (outcome.notice) deliver(record, outcome.notice)
    deliver(record, text)
  }

  function deliver(record, text) {
    record.events += 1
    emit({ event: 'output', id: record.id, session: record.session, text: tail(`${text}\n`) })
    send(record.agent, [{ taskId: record.id, description: record.description, text }])
  }

  function keep(record, text) {
    if (text === '') return
    record.unread += text
    if (byteLength(record.unread) > OUTPUT_KEEP_BYTES) {
      record.unread = tailBytes(record.unread, OUTPUT_KEEP_BYTES)
      record.dropped = true
    }
  }

  function poll(record) {
    let read
    try {
      read = record.proc.readOutput()
    } catch {
      return
    }
    const { out, err } = splitDelta(read.delta)
    keep(record, read.delta)
    if (read.lossy) {
      const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter(path => path !== undefined)
      keep(record, `${read.delta.endsWith('\n') || read.delta === '' ? '' : '\n'}[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]\n`)
    }
    // stderr is merged into stdout; what is left here is dsh's own note
    // (a provider or sandbox failure), which is an event like any line.
    const lines = record.lines.push(out + err)
    if (lines.length > 0) event(record, batchLines(lines))
  }

  function finish(record) {
    if (record.finished) return
    record.finished = true
    cancelEvery(record.poller)
    if (record.deadline !== undefined) cancelLater(record.deadline)
    poll(record)
    const rest = record.lines.flush()
    if (rest !== undefined) event(record, rest)
  }

  return {
    monitors,
    carried,
    spent,
    /** The `monitor` tool. */
    start(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('monitor requires a calling agent')
      if (isChildAgent(agent)) throw new Error(CHILD_MESSAGE)
      const input = resolveInput(args)
      const jobs = deps.jobs()
      const shell = deps.shell()
      if (jobs === undefined) throw new Error('background jobs are unavailable in this dsh')
      if (shell === undefined) throw new Error('the dsh bash executor is unavailable')
      const policy = deps.policy(exec)
      const workdir = policy?.workspaceRoot ?? cwdOf(agent)
      const request = {
        // stderr joins the event stream, as in the reference's terminal log.
        command: `exec 2>&1; ${input.command}`,
        ...workdir !== undefined ? { workdir } : {},
        env: { PYTHONUNBUFFERED: '1' },
        dshEnv: deps.env(exec),
        ...policy !== undefined ? { sandboxPolicy: policy } : {},
      }
      const record = {
        id: '',
        agent,
        session: sessionOf(agent),
        description: input.description,
        command: input.command,
        timeoutMs: input.timeoutMs,
        persistent: input.persistent,
        startedAt: now(),
        limiter: new RateLimiter(now, deps.rates),
        lines: new LineProcessor(),
        unread: '',
        dropped: false,
        events: 0,
        suppressed: 0,
        halted: false,
        finished: false,
        stop: undefined,
        proc: undefined,
        poller: undefined,
        deadline: undefined,
      }
      const id = jobs.start({
        kind: KIND,
        label: `[monitor] ${input.description}`,
        owner: agent,
        run: () => {
          const proc = shell.start(shell.resolve(request))
          record.proc = proc
          return {
            cancel: (reason) => {
              if (record.stop === undefined) record.stop = { why: 'kill', reason }
              proc.kill()
            },
            done: proc.done.then(() => {
              finish(record)
              const detail = endDetail(proc, record.stop, record.timeoutMs)
              if (proc.sandbox?.runnerFailed) return { status: 'failed', detail }
              return { status: proc.status === 'killed' ? 'killed' : 'completed', detail }
            }),
            readOutput: () => {
              const text = `${record.dropped ? '[earlier output was dropped; the newest output follows]\n' : ''}${record.unread}`
              record.unread = ''
              record.dropped = false
              return text
            },
          }
        },
      })
      record.id = id
      monitors.set(id, record)
      record.poller = every(() => {
        if (!record.finished) poll(record)
      }, pollMs)
      if (input.timeoutMs > 0) {
        record.deadline = later(() => {
          if (record.finished) return
          record.stop = { why: 'timeout' }
          // Not a job kill: the timeout's end is reported like an exit.
          record.proc?.kill()
        }, input.timeoutMs)
      }
      emit({
        event: 'start',
        id,
        session: record.session,
        kind: KIND,
        label: input.description,
        reason: 'monitor',
        persistent: input.persistent,
        timeoutMs: input.timeoutMs,
        output: '',
      })
      return { taskId: id, timeoutMs: input.timeoutMs, persistent: input.persistent }
    },
    /** `jobs.onJobDone`: the tasks pane row ends. */
    onJobDone(snapshot) {
      const record = monitors.get(snapshot.id)
      if (record === undefined) return
      finish(record)
      emit({
        event: 'end',
        id: snapshot.id,
        session: record.session,
        kind: KIND,
        status: snapshot.status,
        detail: snapshot.detail ?? '',
        elapsedMs: Math.max(0, (snapshot.finishedAt ?? Date.now()) - snapshot.startedAt),
      })
    },
    /** Stop a monitor from the client's tasks pane. */
    kill(agent, jobId) {
      const record = monitors.get(jobId)
      if (record === undefined || record.session !== sessionOf(agent)) throw new Error(`unknown monitor ${jobId}`)
      const jobs = deps.jobs()
      if (jobs === undefined) throw new Error('dsh jobs are unavailable')
      if (record.stop === undefined) record.stop = { why: 'user' }
      const outcome = jobs.kill(jobId, agent, 'stopped from the codsh tasks pane')
      if (outcome === 'requested') {
        // dsh marks a killed job reported and sends no notice. Tell the
        // model once, at its next step or with the next message.
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: `Monitor "${jobId}" (${record.description}) was stopped by the user from the tasks pane.\n${USER_KILLED_NOTICE}` }],
          source: { kind: 'plugin', plugin: 'rust-acp-background', form: 'notice', summary: `monitor ${record.description} [stopped by the user]` },
        }))
      }
      return outcome
    },
    has: jobId => monitors.has(jobId),
    held,
    /** `tools/pre-execute`: a tool call of this agent started. */
    toolStarted(agent) {
      executing.set(agent, (executing.get(agent) ?? 0) + 1)
    },
    /** The tool call finished: its result opens another step. */
    toolEnded(agent) {
      const count = (executing.get(agent) ?? 1) - 1
      if (count > 0) executing.set(agent, count)
      else executing.delete(agent)
      release(agent)
    },
    /**
     * `agent/inbox/inserted`: another message for a running agent's next
     * step extends the turn anyway, so held events go with it.
     */
    onInserted(agent, message) {
      if (isMonitorMessage(message) || agent?.status === 'idle') return
      if (!(agent?.inbox?.nextStep ?? []).some(item => item.id === message?.id)) return
      release(agent)
    },
    /** `turn/end`: remember whether the user cancelled the turn. */
    onTurnEnd(sessionId, reason) {
      if (typeof sessionId !== 'string') return
      if (reason?.kind === 'aborted') cancelled.add(sessionId)
      else cancelled.delete(sessionId)
    },
    /** `agent/inbox/claimed`: an event reached the model; a user message resets the budget. */
    onClaimed(agent, message) {
      if (message?.source?.kind === 'user') {
        spent.delete(agent)
        cancelled.delete(sessionOf(agent))
      }
      const entry = carried.get(message?.id)
      if (entry === undefined) return
      carried.delete(message.id)
      const first = entry.events[0]
      emit({
        event: 'monitor',
        session: sessionOf(agent),
        id: first.taskId,
        count: entry.events.length,
        summary: summaryOf(entry.events),
        text: tail(entry.events.map(item => item.text).join('\n'), 600),
      })
    },
    /** `agent/inbox/discarded`: a cancel cleared an event the model never saw. */
    onDiscarded(agent, message) {
      if (!isMonitorMessage(message)) return
      if (removing.delete(message.id)) return
      const entry = carried.get(message.id)
      carried.delete(message.id)
      if (entry === undefined) return
      later(() => {
        if (!deps.live(agent)) return
        const copy = createUserMessage({ content: message.content, source: message.source })
        try {
          // The user just stopped this turn: wait for the next step, no wake.
          agent.inject(copy)
          note(agent, copy, entry.events)
          emit({ event: 'requeued', session: sessionOf(agent), job: entry.events[0].taskId, what: `monitor "${entry.events[0].description}" event` })
        } catch {}
      }, 0)
    },
    /**
     * `agent/status` idle: held events, and events injected after the
     * turn's last step, go out as one wake within the budget. After a
     * cancel or past the budget they wait for the next user message.
     */
    onIdle(agent) {
      if (isChildAgent(agent)) return
      later(() => {
        if (!deps.live(agent) || (agent.status !== undefined && agent.status !== 'idle')) return
        const waiting = held.get(agent) ?? []
        held.delete(agent)
        const stranded = (agent.inbox?.nextStep ?? []).filter(message => isMonitorMessage(message) && carried.has(message.id))
        const count = waiting.length + stranded.reduce((sum, message) => sum + carried.get(message.id).events.length, 0)
        if (count === 0) return
        const stopped = cancelled.has(sessionOf(agent))
        if (stopped || (spent.get(agent) ?? 0) >= wakeBudget) {
          if (waiting.length > 0) post(agent, waiting, false)
          const why = stopped ? 'the turn was cancelled' : `monitor wake limit of ${wakeBudget} reached`
          emit({ event: 'hint', session: sessionOf(agent), text: `${count} monitor event(s) wait for your next message (${why})` })
          return
        }
        const events = []
        for (const message of stranded) {
          removing.add(message.id)
          let removed = false
          try {
            removed = agent.inbox.remove(message.id)
          } catch {}
          if (!removed) {
            removing.delete(message.id)
            continue
          }
          events.push(...carried.get(message.id).events)
          carried.delete(message.id)
        }
        events.push(...waiting)
        if (events.length > 0) send(agent, events)
      }, 30)
    },
    /** The session is gone: drop its bookkeeping (dsh stops its jobs). */
    onDisposed(agent) {
      held.delete(agent)
      cancelled.delete(sessionOf(agent))
      for (const [id, entry] of carried) {
        if (entry.agent === agent) carried.delete(id)
      }
      for (const [id, record] of monitors) {
        if (record.agent === agent && record.finished) monitors.delete(id)
      }
    },
  }
}

function cwdOf(agent) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return undefined
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/**
 * Register the `monitor` tool (only with CODSH_MONITOR=1). Returns the
 * monitors, or undefined when the tool is off.
 */
export function registerMonitor(ctx, deps) {
  const enabled = process.env.CODSH_MONITOR === '1'
  delete process.env.CODSH_MONITOR
  if (!enabled) return undefined
  const scale = Number(process.env.CODSH_TEST_MONITOR_TIME_SCALE ?? '')
  // Tests compress the reference timings (poll, refill, auto-stop) together.
  const scaled = Number.isFinite(scale) && scale > 0 && scale !== 1
  const rates = scaled
    ? { capacity: RATE_LIMIT_CAPACITY, refillMs: RATE_LIMIT_REFILL_MS / scale, autoKillMs: AUTO_KILL_THRESHOLD_MS / scale }
    : undefined
  const monitors = createMonitors({
    emit: deps.emit,
    isChildAgent: deps.isChildAgent,
    live: deps.live,
    rates,
    pollMs: scaled ? Math.max(5, DEBOUNCE_MS / scale) : DEBOUNCE_MS,
    jobs: () => ctx.get('jobs'),
    shell: () => ctx.get('shell'),
    env: (exec) => {
      try {
        return ctx.get('shellEnv')?.collect?.(exec)
      } catch {
        return undefined
      }
    },
    policy: (exec) => ctx.get('sandboxPolicy')?.resolve?.(exec.agent === undefined ? {} : { session: exec.agent.session }),
  })
  ctx.on('agent/created', ({ agent }) => {
    if (!deps.isChildAgent(agent)) return
    try {
      if (ctx.tools.get(MONITOR_TOOL)) agent.ctx.tools.restrict({ deny: [MONITOR_TOOL] })
    } catch {}
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    if (exec.name === MONITOR_TOOL && deps.isChildAgent(agent)) return { kind: 'deny', reason: CHILD_MESSAGE }
    if (agent === undefined || deps.isChildAgent(agent)) return next()
    // While a tool runs, a step boundary is coming: events may join it.
    monitors.toolStarted(agent)
    try {
      return await next()
    } finally {
      monitors.toolEnded(agent)
    }
  }, true)
  ctx.tools.register(defineTool({
    name: MONITOR_TOOL,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          timeoutMs: { type: 'number', required: true },
          persistent: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: startedText(value.taskId, value.timeoutMs) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return monitors.start(args, exec)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `[monitor] ${args.description}`,
      kind: 'execute',
      rawInput: args.command,
    }),
  }))
  ctx.inject(['jobs'], (jobsCtx) => {
    jobsCtx.jobs.onJobDone(snapshot => monitors.onJobDone(snapshot))
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => monitors.onClaimed(agent, message))
  ctx.on('agent/inbox/discarded', ({ agent, message }) => monitors.onDiscarded(agent, message))
  ctx.on('agent/inbox/inserted', ({ agent, message }) => monitors.onInserted(agent, message))
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end') monitors.onTurnEnd(session?.id, event.data?.reason)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') monitors.onIdle(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => monitors.onDisposed(agent))
  return monitors
}
