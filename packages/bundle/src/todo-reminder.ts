/**
 * The todo reminder: a nudge, attached after a tool result, when the agent has
 * kept working while its todo list stood still.
 *
 * The Todo readout shows the list exactly as last written, so it is only as
 * current as the model's writes. Logged sessions show the model writing a
 * list, then running dozens to hundreds of tool calls without another write,
 * and a compaction summary does not carry the list at all — after one, the
 * model may never write it again. The readout then pins an item finished long
 * ago while the agent works on the next. The reminder puts the list in front
 * of the model at those two moments, the way the reference agent's own todo
 * reminder does, and leaves the model to decide whether it is stale.
 *
 * Pure state, like the readout: the runner feeds it session events and tool
 * completions, and attaches whatever it returns.
 * @module codsh-bundle/src/todo-reminder
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoList } from './todos.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The runner's nudge to bring a stale todo list up to date. */
    'todo-reminder': {
      kind: 'todo-reminder'
    } & ContextFormed
  }
}

/** Tool calls an agent may make with an open list unchanged before it is reminded. */
export const TODO_REMINDER_CALLS = 20

/** The variable that sets that count for one launch, or turns the reminder off. */
export const TODO_REMINDER_ENV = 'CODSH_TODO_REMINDER'

/**
 * The count a session runs with: `CODSH_TODO_REMINDER` when it is a whole
 * number (`0` or `off` turns the reminder off), else the default. A value that
 * is neither keeps the default rather than silently disabling a nudge the
 * person did not ask to lose.
 * @param env - the environment to read.
 * @returns tool calls between reminders; zero means none.
 */
export function todoReminderCalls(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TODO_REMINDER_ENV]?.trim().toLowerCase()
  if (raw === 'off') return 0
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : TODO_REMINDER_CALLS
}

/** The tool whose call is itself the update. */
const TODO_TOOL = 'todo_write'

/** Why a reminder is due now. */
export type TodoReminderReason =
  | { kind: 'stale', calls: number }
  | { kind: 'compacted' }

/** What the runner attaches: the model-facing text and the log's one-line account. */
export interface TodoReminderNotice {
  text: string
  summary: string
}

/** One session's count since its list last changed. */
interface Watch {
  /** Calls since the list last changed: the figure the model is told. */
  total: number
  /** Calls since the last reminder: what makes the next one due. */
  calls: number
  /** A compaction dropped the list from the model's context since the last write. */
  compacted: boolean
}

/**
 * Per-session staleness of the todo list, keyed by the Session object so a
 * child's list and count are its own.
 */
export class TodoReminder {
  private readonly watches = new WeakMap<object, Watch>()
  private readonly planning = new WeakSet<object>()

  /**
   * @param every - tool calls between reminders; zero or less turns them off.
   */
  constructor(private readonly every: number = TODO_REMINDER_CALLS) {}

  /**
   * Fold one event from a session's log.
   *
   * A write restarts the count, and so does a new turn — the `todos`
   * projection starts each turn empty. A compaction owes the model its list
   * back. Plan mode holds the reminder: the planning prompt forbids todo_write
   * until a plan is approved.
   * @param session - the session the event was appended to.
   * @param event - the event.
   */
  follow(session: object, event: SessionEvent): void {
    if (event.type === 'todo/write' || event.type === 'turn/start') this.watches.delete(session)
    else if (event.type === 'compaction/end') this.watch(session).compacted = true
    else if (event.type === 'plan/mode') {
      if (event.data.active) this.planning.add(session)
      else this.planning.delete(session)
    }
  }

  /**
   * Count one finished tool call and say whether the model should see its list.
   * @param session - the calling agent's session.
   * @param todos - that session's list as the projection holds it now.
   * @param tool - the tool that ran.
   * @returns the reminder due after this call, if any.
   */
  observe(session: object, todos: TodoList, tool: string): TodoReminderNotice | undefined {
    if (this.every <= 0 || tool === TODO_TOOL || this.planning.has(session)) return undefined
    // A finished or absent list has nothing to fall behind.
    if (!todos.some(todo => todo.status !== 'completed')) {
      this.watches.delete(session)
      return undefined
    }
    const watch = this.watch(session)
    watch.total += 1
    watch.calls += 1
    if (!watch.compacted && watch.calls < this.every) return undefined
    // The whole stretch, not the period: 60 calls is harder to shrug off than a fresh-looking 20.
    const reason: TodoReminderReason = watch.compacted ? { kind: 'compacted' } : { kind: 'stale', calls: watch.total }
    watch.calls = 0
    watch.compacted = false
    return todoReminder(todos, reason)
  }

  /** The session's watch, opened on first use. */
  private watch(session: object): Watch {
    let watch = this.watches.get(session)
    if (watch === undefined) {
      watch = { total: 0, calls: 0, compacted: false }
      this.watches.set(session, watch)
    }
    return watch
  }
}

/**
 * The reminder text: why it came, the list verbatim, and what to do with it.
 *
 * The list is quoted whole because todo_write replaces the whole list, and a
 * model that lost it to compaction cannot rewrite what it cannot see.
 * @param todos - the list as the readout shows it.
 * @param reason - what made the reminder due.
 * @returns the text and the one-line account.
 */
export function todoReminder(todos: TodoList, reason: TodoReminderReason): TodoReminderNotice {
  const opening = reason.kind === 'compacted'
    ? 'The conversation was just compacted, and the summary does not carry your todo list.'
    : `You have made ${String(reason.calls)} tool calls since your todo list last changed.`
  const items = todos.map(todo => `- [${todo.status}] ${todo.content}`)
  const text = [
    '<system-reminder>',
    `${opening} The user follows your progress through this list, which currently reads:`,
    '',
    ...items,
    '',
    'If it no longer matches your work, call todo_write now with the whole list: mark finished items completed, mark the item you are working on in_progress, and add or drop items if the plan changed. If it is still accurate, carry on. Never mention this reminder to the user.',
    '</system-reminder>',
  ].join('\n')
  const summary = reason.kind === 'compacted'
    ? 'todo list restated after compaction'
    : `todo list unchanged for ${String(reason.calls)} tool calls`
  return { text, summary }
}
