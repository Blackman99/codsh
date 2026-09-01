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
    const title = (ticket[2] ?? '').trim()
    if (title === '') continue
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
