/** Per-ticket landing boundaries, distinct from the display-only plan. */
import { parsePlan, parseTrackIds } from './plan.ts'
import { essentialBlockedBy } from './ship-dag.ts'

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
  const reduced = essentialLandingBlockers(tickets)
  for (const ticket of tickets) {
    ticket.blockers = reduced.get(ticket.id) ?? ticket.blockers
  }
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

/** Immediate landing waits; a numbered chain that restates a shared parent is dropped. */
export function essentialLandingBlockers(
  tickets: readonly Pick<LandingTicket, 'id' | 'blockers'>[],
): Map<string, string[]> {
  const edges = tickets.flatMap(ticket =>
    ticket.blockers
      .filter(id => id !== 'unknown')
      .map(id => ({ from: `landing:${ticket.id}`, to: `landing:${id}`, kind: 'blocked-by' as const })),
  )
  const map = new Map(tickets.map(ticket => [ticket.id, [] as string[]]))
  for (const edge of essentialBlockedBy(edges)) {
    if (edge.kind !== 'blocked-by') continue
    map.get(edge.from.slice('landing:'.length))?.push(edge.to.slice('landing:'.length))
  }
  for (const ticket of tickets) {
    if (ticket.blockers.includes('unknown')) {
      map.set(ticket.id, [...(map.get(ticket.id) ?? []), 'unknown'])
    }
  }
  return map
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

/**
 * Currently-已关闭 tickets, plus already-landed 已认领 whose DAG blockers
 * are already 已关闭. Named proofs only — not dual-layer final verification.
 */
export function sweepProofTargets(view: LandingWaveView): LandingTicket[] {
  const closed = new Set(view.tickets.filter(ticket => ticket.done).map(ticket => ticket.id))
  return view.tickets
    .filter(ticket => {
      if (ticket.done) return true
      if (!view.claimed.has(ticket.id)) return false
      if (view.worktrees.has(ticket.id) || view.inFlight.has(ticket.id)) return false
      return ticket.blockers.every(id => closed.has(id))
    })
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
}

/** Transitive DAG dependents of `roots`, including still-open tickets. */
export function cascadeDependents(
  tickets: readonly LandingTicket[],
  roots: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const ticket of tickets) {
      if (roots.has(ticket.id) || out.has(ticket.id)) continue
      if (!ticket.blockers.some(id => roots.has(id) || out.has(id))) continue
      out.add(ticket.id)
      changed = true
    }
  }
  return out
}

/**
 * Already-closed DAG dependents of tickets that failed this sweep.
 * Last proof of these tickets is not rewritten.
 */
export function cascadeClosedDependents(
  tickets: readonly LandingTicket[],
  failed: ReadonlySet<string>,
): string[] {
  const dependents = cascadeDependents(tickets, failed)
  return tickets
    .filter(ticket => ticket.done && dependents.has(ticket.id) && !failed.has(ticket.id))
    .map(ticket => ticket.id)
}

/**
 * Already-dispatched dependents of an unticked ancestor: same `landing-N`
 * names, worktree removed, Claim kept.
 */
export function dispatchedDependents(
  tickets: readonly LandingTicket[],
  failed: ReadonlySet<string>,
  dispatched: ReadonlySet<string>,
): string[] {
  const dependents = cascadeDependents(tickets, failed)
  return [...dependents].filter(id => dispatched.has(id) && !failed.has(id))
}

/** `## Blocker` body: every ticket that failed this sweep, as evidence. */
export function sweepBlockerBody(failed: readonly LandingTicket[]): string {
  return failed
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(ticket => `- Ticket ${ticket.id}: ${landingTicketTitle(ticket.contract)} (Proof: red)`)
    .join('\n')
}

/**
 * One ledger commit for a proof sweep. A green tick that also records a
 * Blocker is still this one message, not two commits.
 */
export function proofSweepCommitMessage(
  ticked: LandingTicket | undefined,
  failed: readonly LandingTicket[],
): string {
  const subject = ticked === undefined
    ? 'ship: proof sweep'
    : tickCommitMessage(ticked)
  if (failed.length === 0) return subject
  return `${subject}\n\n${sweepBlockerBody(failed)}`
}

/** Drop an unresolved `## Blocker` section; archived titles are left alone. */
export function stripBlockerSection(markdown: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => /^## Blocker\s*$/u.test(line))
  if (start < 0) return markdown
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index] ?? '')) {
      end = index
      break
    }
  }
  const next = [...lines.slice(0, start), ...lines.slice(end)]
  return next.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\n*$/u, '\n')
}

/** Write or replace `## Blocker`. Empty body strips the section. */
export function writeBlockerSection(markdown: string, body: string | undefined): string {
  const stripped = stripBlockerSection(markdown)
  if (body === undefined || body.trim() === '') return stripped
  const block = `## Blocker\n\n${body.trim()}\n`
  return `${stripped.replace(/\n*$/u, '\n')}\n${block}`
}
