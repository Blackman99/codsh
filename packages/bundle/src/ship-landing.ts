/** Per-ticket landing boundaries, distinct from the display-only plan. */
import { parsePlan, parseTrackIds } from './plan.ts'

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

/** Live Landing wave as the drain loop and land prepend see it. */
export interface LandingWaveView {
  tickets: readonly LandingTicket[]
  /** 已认领 (Claim written, checkbox still open). */
  claimed: ReadonlySet<string>
  /** Live landing children whose `done` has not settled. */
  inFlight: ReadonlySet<string>
  /** Landing children whose `done` settled and who still have a worktree. */
  finished: ReadonlySet<string>
  /** Worktree directories that still exist. */
  worktrees: ReadonlySet<string>
}

/** Short title after `Ticket N:`, without Blocked-by / Track metadata. */
export function landingTicketTitle(contract: string): string {
  return contract
    .replace(/^Ticket\s+\d+\s*:\s*/iu, '')
    .replace(/\s*\([^)]*(?:blocked\s+by|verification(?:\s+log)?)\s*:[^)]*\)/giu, '')
    .replace(/\s*\(\s*Track:\s*[^)]*\)/giu, '')
    .replace(/\s*[-—–]\s*(?:delivers|verification)\b.*$/iu, '')
    .trim() || contract.replace(/^Ticket\s+\d+\s*:\s*/iu, '').trim() || contract
}

/** `Track-N` cite for a Worktree commit body. */
export function landingTrackCite(contract: string): string {
  return (parseTrackIds(contract) ?? []).map(n => `Track-${String(n)}`).join(', ')
}

/**
 * Finished 已认领 landing children whose DAG blockers are already 已关闭.
 * Lowest `landing:N` first. A live earlier-N is not a barrier for an
 * independent later-N. A keep-commit that stayed `[ ]` (no worktree, not
 * 已关闭) does not unblock dependents.
 */
export function readySet(view: LandingWaveView): LandingTicket[] {
  const closed = new Set(view.tickets.filter(ticket => ticket.done).map(ticket => ticket.id))
  return view.tickets
    .filter(ticket => !ticket.done)
    .filter(ticket => view.claimed.has(ticket.id))
    .filter(ticket => view.finished.has(ticket.id))
    .filter(ticket => view.worktrees.has(ticket.id))
    .filter(ticket => !view.inFlight.has(ticket.id))
    .filter(ticket => ticket.blockers.every(id => closed.has(id)))
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
}

/** Land-phase HITL prepend: in-flight / Ready-set, never one Active Ticket. */
export function landingWavePrepend(view: LandingWaveView): string {
  const inflight = view.tickets
    .filter(ticket => view.inFlight.has(ticket.id))
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
  const ready = readySet(view)
  const line = (ticket: LandingTicket): string => `- Ticket ${ticket.id}: ${landingTicketTitle(ticket.contract)}`
  const lines = (rows: readonly LandingTicket[]): string[] => (rows.length === 0 ? ['- (none)'] : rows.map(line))
  return ['In-flight:', ...lines(inflight), 'Ready-set:', ...lines(ready)].join('\n')
}

/** Worktree commit subject `Ticket N: <title>`. */
export function worktreeCommitSubject(ticket: LandingTicket): string {
  return `Ticket ${ticket.id}: ${landingTicketTitle(ticket.contract)}`
}

/** Worktree commit message: subject plus Track-N body. */
export function worktreeCommitMessage(ticket: LandingTicket): string {
  const cite = landingTrackCite(ticket.contract)
  const subject = worktreeCommitSubject(ticket)
  return cite === '' ? subject : `${subject}\n\n${cite}`
}

/** `--no-ff` land merge message; kept even when proof is red. */
export function landMergeMessage(ticket: LandingTicket): string {
  return `ship: land Ticket ${ticket.id} — ${landingTicketTitle(ticket.contract)}`
}

/** Tick commit after a green parent proof. */
export function tickCommitMessage(ticket: LandingTicket): string {
  return `ship: tick Ticket ${ticket.id} — ${landingTicketTitle(ticket.contract)}`
}
