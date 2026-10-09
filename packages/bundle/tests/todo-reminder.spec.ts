/**
 * The todo reminder: when the model has kept working with its list unchanged,
 * or lost the list to compaction, it is shown the list again — and otherwise
 * left alone. The Todo readout is only as current as the model's writes, so
 * these moments are the contract.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TODO_REMINDER_CALLS, TodoReminder, todoReminder, todoReminderCalls } from '../src/todo-reminder.ts'
import type { TodoList } from '../src/todos.ts'

/** Build a list from `status:content` shorthand. */
const list = (...items: string[]): TodoList => items.map((item) => {
  const [status = '', ...rest] = item.split(':')
  return { status: status as 'pending' | 'in_progress' | 'completed', content: rest.join(':') }
})

/** A log event of `type` carrying `data`. */
const event = (type: string, data: unknown = {}): SessionEvent =>
  ({ type, seq: 1, time: 0, data }) as unknown as SessionEvent

const open = list('completed:read the code', 'in_progress:write the fix', 'pending:run the tests')

/** Run `calls` tool calls through `reminder`, returning the call numbers that were reminded. */
function run(reminder: TodoReminder, session: object, todos: TodoList, calls: number, tool = 'bash'): number[] {
  const reminded: number[] = []
  for (let call = 1; call <= calls; call++) {
    if (reminder.observe(session, todos, tool) !== undefined) reminded.push(call)
  }
  return reminded
}

describe('TodoReminder', () => {
  it('reminds once the list has stood still for the set number of calls, then again after as many more', () => {
    const reminder = new TodoReminder(5)
    expect(run(reminder, {}, open, 12)).toEqual([5, 10])
  })

  it('tells the model the whole stretch since the list changed, not just the period', () => {
    const reminder = new TodoReminder(5)
    const session = {}
    const summaries: string[] = []
    for (let call = 1; call <= 15; call++) {
      const notice = reminder.observe(session, open, 'bash')
      if (notice !== undefined) summaries.push(notice.summary)
    }
    expect(summaries).toEqual([
      'todo list unchanged for 5 tool calls',
      'todo list unchanged for 10 tool calls',
      'todo list unchanged for 15 tool calls',
    ])
  })

  it('starts counting again after a write', () => {
    const reminder = new TodoReminder(5)
    const session = {}
    expect(run(reminder, session, open, 4)).toEqual([])
    reminder.follow(session, event('todo/write', { todos: open }))
    expect(run(reminder, session, open, 4)).toEqual([])
    expect(run(reminder, session, open, 1)).toEqual([1])
  })

  it('does not count the write itself', () => {
    const reminder = new TodoReminder(2)
    expect(run(reminder, {}, open, 5, 'todo_write')).toEqual([])
  })

  it('leaves a finished list and an absent one alone', () => {
    const reminder = new TodoReminder(2)
    expect(run(reminder, {}, list('completed:one', 'completed:two'), 6)).toEqual([])
    expect(run(reminder, {}, [], 6)).toEqual([])
  })

  it('forgets the count when the list finishes, so a later list starts fresh', () => {
    const reminder = new TodoReminder(3)
    const session = {}
    run(reminder, session, open, 2)
    run(reminder, session, list('completed:one'), 1)
    expect(run(reminder, session, open, 2)).toEqual([])
  })

  it('starts each turn from zero', () => {
    const reminder = new TodoReminder(3)
    const session = {}
    run(reminder, session, open, 2)
    reminder.follow(session, event('turn/start', { turn: 2 }))
    expect(run(reminder, session, open, 2)).toEqual([])
  })

  it('restates the list on the first call after a compaction', () => {
    const reminder = new TodoReminder(20)
    const session = {}
    run(reminder, session, open, 3)
    reminder.follow(session, event('compaction/end', {}))
    const notice = reminder.observe(session, open, 'read')
    expect(notice?.summary).toBe('todo list restated after compaction')
    expect(notice?.text).toContain('just compacted')
    // The compaction reminder spends the count, so the next is a full period away.
    expect(run(reminder, session, open, 19)).toEqual([])
  })

  it('does not restate a list a write already replaced after the compaction', () => {
    const reminder = new TodoReminder(20)
    const session = {}
    reminder.follow(session, event('compaction/end', {}))
    reminder.follow(session, event('todo/write', { todos: open }))
    expect(reminder.observe(session, open, 'read')).toBeUndefined()
  })

  it('holds while plan mode is on, and resumes when it ends', () => {
    const reminder = new TodoReminder(2)
    const session = {}
    reminder.follow(session, event('plan/mode', { active: true }))
    expect(run(reminder, session, open, 6)).toEqual([])
    reminder.follow(session, event('plan/mode', { active: false }))
    expect(run(reminder, session, open, 2)).toEqual([2])
  })

  it('keeps each session to its own count', () => {
    const reminder = new TodoReminder(3)
    const parent = {}
    const child = {}
    run(reminder, parent, open, 2)
    expect(run(reminder, child, open, 2)).toEqual([])
    expect(run(reminder, parent, open, 1)).toEqual([1])
  })

  it('is off at zero', () => {
    expect(run(new TodoReminder(0), {}, open, 50)).toEqual([])
  })
})

describe('todoReminderCalls', () => {
  it('defaults to twenty calls', () => {
    expect(TODO_REMINDER_CALLS).toBe(20)
    expect(todoReminderCalls({})).toBe(20)
    expect(todoReminderCalls({ CODSH_TODO_REMINDER: ' ' })).toBe(20)
  })

  it('takes a whole number from CODSH_TODO_REMINDER, and off or 0 turns it off', () => {
    expect(todoReminderCalls({ CODSH_TODO_REMINDER: '8' })).toBe(8)
    expect(todoReminderCalls({ CODSH_TODO_REMINDER: ' OFF ' })).toBe(0)
    expect(todoReminderCalls({ CODSH_TODO_REMINDER: '0' })).toBe(0)
  })

  it('keeps the default for a value it cannot read', () => {
    expect(todoReminderCalls({ CODSH_TODO_REMINDER: 'often' })).toBe(20)
    expect(todoReminderCalls({ CODSH_TODO_REMINDER: '-3' })).toBe(20)
    expect(todoReminderCalls({ CODSH_TODO_REMINDER: '2.5' })).toBe(20)
  })
})

describe('todoReminder', () => {
  it('quotes the whole list with each status, so the model can rewrite it', () => {
    const { text, summary } = todoReminder(open, { kind: 'stale', calls: 20 })
    expect(text.startsWith('<system-reminder>\n')).toBe(true)
    expect(text.endsWith('\n</system-reminder>')).toBe(true)
    expect(text).toContain('You have made 20 tool calls since your todo list last changed.')
    expect(text).toContain('- [completed] read the code\n- [in_progress] write the fix\n- [pending] run the tests')
    expect(text).toContain('call todo_write now with the whole list')
    expect(summary).toBe('todo list unchanged for 20 tool calls')
  })
})
