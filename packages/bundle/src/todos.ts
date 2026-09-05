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

import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { displayWidth, truncate } from './theme.ts'
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
 *
 * The collapsed row keeps `▶` off accent and pending — those roles belong to
 * the input and the expanded current item — so a glance at the one-line chrome
 * does not steal the focus colour.
 * @param status - the item's lifecycle state.
 * @param theme - styling for the mark.
 * @param collapsed - the pinned one-line row, which always names the focus item.
 * @returns the styled mark.
 */
function mark(status: TodoItem['status'], theme: Theme, collapsed = false): string {
  if (status === 'completed') return theme.success('✔')
  if (status === 'in_progress' || collapsed) return collapsed ? theme.bold('▶') : theme.pending('▶')
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
 * Progress leads because it is the figure a glance wants. The transcript card
 * then names the states that have items; the chrome header that carries a hint
 * stays `todos k/n · hint` so the expanded panel matches the collapsed count.
 * @param todos - the list to summarize.
 * @param theme - styling for the segments.
 * @param hint - a trailing note, e.g. the key that collapses the list.
 * @returns the header line.
 */
function header(todos: TodoList, theme: Theme, hint: string | undefined): string {
  const { done, active, open, total } = tally(todos)
  const count = theme.dim(`${done}/${total}`)
  if (hint !== undefined) {
    return `${theme.tool('todos')} ${count}${theme.dim(` · ${hint}`)}`
  }
  const segments = [
    count,
    ...active === 0 ? [] : [theme.dim(`${active} in progress`)],
    ...open === 0 ? [] : [theme.dim(`${open} open`)],
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
 * Fit `count · body · hint` into one row, shrinking a title before the hint.
 *
 * At 80 columns the key must stay readable; a long title is the part a glance
 * can still recognise when cut. The hint drops only when even a two-column
 * title would not leave room for it. A finished-list phrase is not cut to
 * keep the key — the spec keeps `all done ✔` whole and drops the hint first.
 * @param count - the `todos k/n` prefix, already styled.
 * @param body - the focus title, or the finished-list phrase.
 * @param hint - the trailing key, already styled, when one was given.
 * @param columns - display columns the whole row may use.
 * @param theme - the separator.
 * @param shrinkBody - whether the body may be cut to keep the hint.
 * @returns one row, never wrapped.
 */
function fitRow(
  count: string,
  body: string,
  hint: string | undefined,
  columns: number,
  theme: Theme,
  shrinkBody: boolean,
): string {
  const sep = theme.dim(' · ')
  // Hint and its separator are one muted span so a PTY wait can match
  // ` · Ctrl+T` as raw bytes, the way the old `opens the list` phrase did.
  const trail = hint === undefined ? undefined : theme.dim(` · ${hint}`)
  const withHint = trail === undefined ? undefined : `${count}${sep}${body}${trail}`
  if (withHint !== undefined && displayWidth(withHint) <= columns) return withHint
  if (shrinkBody && trail !== undefined) {
    const prefix = `${count}${sep}`
    const budget = columns - displayWidth(prefix) - displayWidth(trail)
    if (budget >= 2) return `${prefix}${truncate(body, budget)}${trail}`
  }
  const withoutHint = `${count}${sep}${body}`
  if (displayWidth(withoutHint) <= columns) return withoutHint
  const prefix = `${count}${sep}`
  const budget = columns - displayWidth(prefix)
  if (budget >= 2) return `${prefix}${truncate(body, budget)}`
  return truncate(withoutHint, columns)
}

/**
 * Render the pinned row: always one line — count, the work in focus, the key.
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
  const count = `${theme.tool('todos')} ${theme.dim(`${done}/${total}`)}`
  // Finished lists still report: `n/n` is the confirmation that the work the
  // list described actually landed, and it costs one row until the next write.
  const body = next === undefined
    ? `${theme.dim('all done')} ${theme.success('✔')}`
    : `${mark(next.status, theme, true)} ${next.content}`
  return fitRow(count, body, hint, columns, theme, next !== undefined)
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
