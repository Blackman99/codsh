/**
 * The todo readout: the pinned row that keeps the agent's list in view after
 * the write that produced it has scrolled away, and the full list that row
 * expands into.
 *
 * One renderer serves all three places the list shows — the transcript card,
 * the pinned row, and `/todos` — so the glyphs and counts cannot drift apart.
 * Nothing is tracked here: every figure comes from the `todos` projection, so a
 * resumed session reports the list it left off with.
 * @module codsh-bundle/src/todos
 */

import type { TodoItem } from '@deepseek-ai/dsh-session'
import { truncate } from './theme.ts'
import type { Theme } from './theme.ts'

/** The list as the projection holds it: whole-value, latest write wins. */
export type TodoList = readonly TodoItem[]

/** How the full list may be shortened for a surface that cannot scroll. */
export interface TodoReportOptions {
  /** A trailing note for the header, e.g. the key that collapses the list. */
  hint?: string | undefined
  /** Most items to print; the rest are counted on one tail line. */
  limit?: number | undefined
}

/**
 * Mark for one lifecycle state, styled by what the state means.
 *
 * The three marks are codsh's own (`✔`/`▶`/`○`), not the reference agent's
 * squares: the transcript has used them since todos first rendered, and one
 * surface speaking two alphabets for the same list is worse than differing from
 * the reference on a glyph.
 * @param status - the item's lifecycle state.
 * @param theme - styling for the mark.
 * @returns the styled mark.
 */
function mark(status: TodoItem['status'], theme: Theme): string {
  if (status === 'completed') return theme.success('✔')
  if (status === 'in_progress') return theme.pending('▶')
  return theme.dim('○')
}

/**
 * Count each lifecycle state once, so callers never fold the list twice.
 * @param todos - the list to count.
 * @returns done, active, and open counts alongside the total.
 */
function tally(todos: TodoList): { done: number, active: number, open: number, total: number } {
  let done = 0
  let active = 0
  for (const todo of todos) {
    if (todo.status === 'completed') done += 1
    else if (todo.status === 'in_progress') active += 1
  }
  return { done, active, open: todos.length - done - active, total: todos.length }
}

/**
 * The header both the card and the expanded list carry.
 *
 * Progress leads because it is the figure a glance wants; the state breakdown
 * follows, and a state with nothing in it is dropped rather than shown as zero —
 * the same rule the status line follows.
 * @param todos - the list to summarize.
 * @param theme - styling for the segments.
 * @param hint - a trailing note, e.g. the key that collapses the list.
 * @returns the header line.
 */
function header(todos: TodoList, theme: Theme, hint: string | undefined): string {
  const { done, active, open, total } = tally(todos)
  const segments = [
    theme.dim(`${done}/${total}`),
    ...active === 0 ? [] : [theme.dim(`${active} in progress`)],
    ...open === 0 ? [] : [theme.dim(`${open} open`)],
    ...hint === undefined ? [] : [theme.dim(hint)],
  ]
  return `${theme.tool('todos')} ${segments.join(theme.dim(' · '))}`
}

/**
 * The item a person watching the run cares about: what is being worked now,
 * or, with nothing active, what comes next.
 * @param todos - the list to look through.
 * @returns the item, or undefined when every item is finished.
 */
function focus(todos: TodoList): TodoItem | undefined {
  return todos.find(todo => todo.status === 'in_progress')
    ?? todos.find(todo => todo.status === 'pending')
}

/**
 * Render the pinned row: one line naming the work in flight and the progress
 * around it.
 *
 * This row is the whole point of reading from a projection rather than from the
 * write event: the card that announced the list scrolls away, the row does not,
 * so the list stays answerable at a glance for the rest of the session.
 * @param todos - the current list.
 * @param theme - styling for the segments.
 * @param columns - display columns available; a longer row is cut, never wrapped.
 * @param hint - a trailing note, e.g. the key that expands the list.
 * @returns the row, or undefined when there is no list to report.
 */
export function todoRow(
  todos: TodoList,
  theme: Theme,
  columns: number,
  hint?: string,
): string | undefined {
  if (todos.length === 0) return undefined
  const { done, total } = tally(todos)
  const next = focus(todos)
  // Finished lists still report: `5/5` is the confirmation that the work the
  // list described actually landed, and it costs one row until the next write.
  const body = next === undefined
    ? `${theme.success('✔')} ${theme.dim('all done')}`
    : `${mark(next.status, theme)} ${next.status === 'in_progress' ? next.content : `next: ${next.content}`}`
  const segments = [
    theme.tool('todos'),
    theme.dim(`${done}/${total}`),
    body,
    ...hint === undefined ? [] : [theme.dim(hint)],
  ]
  return truncate(segments.join(theme.dim(' · ')), columns)
}

/**
 * Render the whole list: the header, then every item under it.
 *
 * A surface that cannot scroll passes `limit`, and the items past it are
 * counted rather than dropped in silence — a list that looks complete but is
 * not is worse than an honest tail.
 * @param todos - the current list.
 * @param theme - styling for the marks and text.
 * @param columns - display columns available; longer lines are cut.
 * @param options - header note and item cap.
 * @returns the lines, empty when there is no list.
 */
export function todoReport(
  todos: TodoList,
  theme: Theme,
  columns: number,
  options: TodoReportOptions = {},
): string[] {
  if (todos.length === 0) return []
  const { hint, limit } = options
  const shown = limit === undefined ? todos : todos.slice(0, Math.max(0, limit))
  const hidden = todos.length - shown.length
  return [
    truncate(header(todos, theme, hint), columns),
    ...shown.map(todo => truncate(
      `  ${mark(todo.status, theme)} ${todo.status === 'completed' ? theme.dim(todo.content) : todo.content}`,
      columns,
    )),
    ...hidden === 0 ? [] : [theme.dim(truncate(`  … +${hidden} more`, columns))],
  ]
}
