/** Per-ticket landing boundaries, distinct from the display-only plan. */
import { parsePlan } from './plan.ts'

export interface LandingTicket {
  /** Full approved plan line, including dependencies and Track metadata. */
  contract: string
  id: string
  done: boolean
  blockers: string[]
}

export interface LandingPlan {
  tickets: LandingTicket[]
  active: LandingTicket | undefined
  error?: string
}

/** Read ticket dependencies without dropping the approved plan metadata. */
export function landingPlan(markdown: string): LandingPlan {
  const rows = parsePlan(markdown, { rawTitles: true }).tickets
  const tickets = rows.map((row, index): LandingTicket => {
    const id = /^Ticket\s+(\d+)\s*:/iu.exec(row.title)?.[1] ?? `row-${index + 1}`
    const dependency = /\(Blocked by:\s*([^)]*)\)/iu.exec(row.title)?.[1]?.trim()
    const none = dependency === undefined || /^(?:none|nothing|n\/a|[-—])$/iu.test(dependency)
    return {
      contract: row.title,
      id,
      done: row.done,
      blockers: none ? [] : (dependency.match(/\d+/gu) ?? ['unknown']),
    }
  })
  const ids = new Set(tickets.map(ticket => ticket.id))
  const error = ids.size !== tickets.length ? 'Duplicate ticket IDs in the approved plan.'
    : tickets.some(ticket => ticket.blockers.some(id => !ids.has(id) || id === ticket.id))
      ? 'Unknown or self-referencing ticket dependency in the approved plan.'
      : tickets.some(ticket => ticket.done && ticket.blockers.some(id => !tickets.find(other => other.id === id)?.done))
        ? 'A checked ticket has an unfinished dependency.'
        : undefined
  const active = tickets.find(ticket => !ticket.done && ticket.blockers.every(id => tickets.find(other => other.id === id)?.done))
  return {
    tickets,
    active,
    ...(error !== undefined ? { error }
      : active === undefined && tickets.some(ticket => !ticket.done) ? { error: 'No unblocked ticket remains; resolve the dependency cycle.' } : {}),
  }
}

/** Progress can change checkboxes, never the ticket contract inside a turn. */
export function sameLandingPlan(before: LandingPlan, after: LandingPlan): boolean {
  return before.tickets.length === after.tickets.length
    && before.tickets.every((ticket, index) => ticket.contract === after.tickets[index]?.contract)
}
