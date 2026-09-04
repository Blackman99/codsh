/**
 * The plan a `/ship` spec carries, read from the file that holds it.
 *
 * The spec file is the workflow's memory: its `## Plan` section is one
 * checkbox per ticket, and a ralph round ticks the one it finished. So the
 * answer to "how far in" is on disk, not in the conversation — the round
 * number the workflow reports is a budget counter, and says nothing about how
 * much of the work is left.
 * @module codsh-bundle/src/plan
 */

import { truncate } from './theme.ts'
import type { Theme } from './theme.ts'

/** One ticket in a spec's plan. */
export interface PlanTicket {
  /** The ticket's line, without its checkbox. */
  title: string
  /** Whether the round that owned it ticked it. */
  done: boolean
}

/** A spec's plan as the surface reports it. */
export interface Plan {
  tickets: PlanTicket[]
  /** Tickets already ticked. */
  done: number
  /** The ticket being worked now: the first that is not ticked. */
  current: PlanTicket | undefined
}

/** A `## Plan` heading, at any depth, in any case. */
const PLAN_HEADING = /^#{1,6}\s+plan\s*$/iu

/** Any other heading, which ends the section. */
const HEADING = /^#{1,6}\s+/u

/** A task-list line: `- [ ] title` or `- [x] title`, dash or star. */
const TICKET = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/u

/**
 * Read the tickets out of a spec's `## Plan` section.
 *
 * Only that section: a spec's acceptance criteria are a numbered list and its
 * other sections may hold checkboxes of their own, and counting those would
 * report progress against work the plan never claimed.
 * @param markdown - the spec file's contents.
 * @returns the plan, empty when the file has no plan section.
 */
export function parsePlan(markdown: string): Plan {
  const tickets: PlanTicket[] = []
  let inside = false
  for (const line of markdown.split(/\r\n|[\r\n]/u)) {
    if (PLAN_HEADING.test(line)) {
      inside = true
      continue
    }
    if (inside && HEADING.test(line)) break
    if (!inside) continue
    const ticket = TICKET.exec(line)
    if (ticket === null) continue
    const rawTitle = (ticket[2] ?? '').trim()
    if (rawTitle === '') continue
    // Strip trailing ticket metadata (e.g. "(Blocked by: ...) — Delivers ...")
    // so the TUI displays a concise, readable ticket title without overflow.
    const title = rawTitle
      .replace(/\s*\([^)]*blocked\s+by:[^)]*\)/iu, '')
      .replace(/\s*[-—–]\s*delivers\b.*$/iu, '')
      .trim() || rawTitle
    tickets.push({ title, done: (ticket[1] ?? ' ').toLowerCase() === 'x' })
  }
  const done = tickets.filter(ticket => ticket.done).length
  return { tickets, done, current: tickets.find(ticket => !ticket.done) }
}

/**
 * The plan as one line for the working indicator: how far in, and on what.
 *
 * The count answers how much is left without arithmetic, and the title answers
 * what is happening now — the two questions a long autonomous run leaves a
 * person with, neither of which a round number answers.
 * @param plan - the plan read from the spec.
 * @param theme - styling for the figure.
 * @param columns - display columns the whole line may use.
 * @returns the segment, or undefined when there is no plan to report.
 */
export function planRow(plan: Plan, theme: Theme, columns: number): string | undefined {
  if (plan.tickets.length === 0) return undefined
  const count = `${String(plan.done)}/${String(plan.tickets.length)}`
  if (plan.current === undefined) return theme.success(`${count} tickets`)
  // The title is what gets cut when the width runs out: the count is the part
  // that is useless when partial.
  return truncate(`${count} · ${plan.current.title}`, Math.max(8, columns))
}

/**
 * The plan as the pinned readout shows it when it is closed.
 * @param plan - the plan read from the spec.
 * @param theme - styling for the figure and the hint.
 * @param columns - display columns available.
 * @param hint - a trailing note, e.g. the key that opens the list.
 * @returns the row, or `undefined` when there is no plan to report.
 */
export function planSummary(
  plan: Plan,
  theme: Theme,
  columns: number,
  hint?: string,
): string | undefined {
  if (plan.tickets.length === 0) return undefined
  const count = `${String(plan.done)}/${String(plan.tickets.length)}`
  const trail = hint === undefined ? '' : theme.dim(` · ${hint}`)
  const current = plan.current === undefined
    ? theme.success('every ticket landed')
    : plan.current.title
  return truncate(`  ${theme.tool('◇')} plan ${theme.dim(count)} · ${current}${trail}`, columns)
}

/**
 * The plan's tickets, one per row.
 *
 * The same three marks the todo list uses, because a person reading the panel
 * is reading one alphabet: a ticket that landed, the one being landed, and the
 * ones waiting.
 * @param plan - the plan read from the spec.
 * @param theme - styling for the marks.
 * @param columns - display columns available.
 * @param limit - most tickets to print; the rest are counted on one line.
 * @param hint - a trailing note on the header, e.g. the key that closes the list.
 * @returns the rows, a header first.
 */
export function planReport(plan: Plan, theme: Theme, columns: number, limit?: number, hint?: string): string[] {
  if (plan.tickets.length === 0) return []
  const shown = limit === undefined ? plan.tickets : plan.tickets.slice(0, Math.max(0, limit))
  const hidden = plan.tickets.length - shown.length
  const count = `${String(plan.done)}/${String(plan.tickets.length)}`
  const trail = hint === undefined ? '' : theme.dim(` · ${hint}`)
  return [
    truncate(`  ${theme.tool('◇')} plan ${theme.dim(count)}${trail}`, columns),
    ...shown.map((ticket) => {
      const current = ticket === plan.current
      const mark = ticket.done ? theme.success('✔') : current ? theme.pending('▶') : theme.dim('○')
      const title = ticket.done ? theme.dim(ticket.title) : ticket.title
      return truncate(`    ${mark} ${title}`, columns)
    }),
    ...hidden === 0 ? [] : [theme.dim(truncate(`    … +${String(hidden)} more`, columns))],
  ]
}
