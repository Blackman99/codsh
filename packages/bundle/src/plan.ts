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
  /** Track-N ids from `(Track: 1,3)`, when present. */
  trackIds?: number[]
  /** Raw checkbox body before chrome title stripping. */
  raw?: string
}

/** A spec's plan as the surface reports it. */
export interface Plan {
  tickets: PlanTicket[]
  /** Tickets already ticked. */
  done: number
  /** The ticket being worked now: the first that is not ticked. */
  current: PlanTicket | undefined
}

/** Phases a `/ship` spec's `Status:` line names. */
export type ShipStatus = 'interviewing' | 'confirmed' | 'planned' | 'landing' | 'shipped'

/** Metadata a `/ship` spec records in its header. */
export interface SpecMetadata {
  /** The dedicated feature branch (`ship/<slug>`). */
  branch?: string
  /** Base commit SHA before landing. */
  baseCommit?: string
  /** Original branch name from which the feature branch was cut. */
  originalBranch?: string
  /** Session goal id the ship runner created for this spec (`Goal-Id:`). */
  goalId?: string
}

/** A `## Plan` heading, at any depth, in any case. */
const PLAN_HEADING = /^#{1,6}\s+plan\s*$/iu

/** Any other heading, which ends the section. */
const HEADING = /^#{1,6}\s+/u

/** A task-list line: `- [ ] title` or `- [x] title`, dash or star. */
const TICKET = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/u

/** A spec's `Status:` phase line. */
const STATUS_LINE = /^Status:\s*(interviewing|confirmed|planned|landing|shipped)\b/imu

/** A spec's `Branch:` line. */
const BRANCH_LINE = /^Branch:\s*(\S+)/imu

/** A spec's `Base-Commit:` line. */
const BASE_COMMIT_LINE = /^Base-Commit:\s*(\S+)/imu

/** A spec's `Original-Branch:` line. */
const ORIGINAL_BRANCH_LINE = /^Original-Branch:\s*(\S+)/imu

/** A spec's `Goal-Id:` line — the session compass occupancy uses to recognize ours. */
const GOAL_ID_LINE = /^Goal-Id:\s*(\S+)/imu

/** A `## Main Track` heading, at any depth, in any case. */
const MAIN_TRACK_HEADING = /^#{1,6}\s+main\s+track\s*$/iu


/** `(Track: 1,3)` on a plan checkbox line. */
const TRACK_META = /\(\s*Track:\s*([^)]*)\)/iu

/**
 * Read Track-N ids from a plan checkbox body.
 * @param raw - the checkbox text after `- [ ]`.
 */
export function parseTrackIds(raw: string): number[] | undefined {
  const match = TRACK_META.exec(raw)
  if (match === null) return undefined
  const ids = (match[1] ?? '')
    .split(/[,\s]+/u)
    .map(part => Number(part))
    .filter(n => Number.isInteger(n) && n > 0)
  return ids.length === 0 ? undefined : ids
}

/**
 * Format the active (first unticked) ticket as a land-only task pack.
 * Later tickets are omitted so the executor cannot replan the whole plan.
 */
export function activeTicketBrief(
  plan: Plan,
  opts: { requirements?: ReadonlyArray<{ id: string; track?: number[]; text: string }> } = {},
): string | undefined {
  const ticket = plan.current
  if (ticket === undefined) return undefined
  const index = plan.tickets.indexOf(ticket)
  const lines = [
    '## Active Ticket',
    '',
    'This turn implements ONLY the ticket below. Do not start later tickets. Re-read the sealed Mission Contract for invariants; do not rewrite immutable sections.',
    '',
    `- index: ${String(index + 1)}/${String(plan.tickets.length)}`,
    `- title: ${ticket.title}`,
    `- done: ${String(plan.done)}/${String(plan.tickets.length)}`,
  ]
  if (ticket.trackIds !== undefined && ticket.trackIds.length > 0) {
    lines.push(`- Track: ${ticket.trackIds.join(',')}`)
    const reqs = opts.requirements ?? []
    const mapped = reqs.filter(req => req.track?.some(n => ticket.trackIds!.includes(n)))
    if (mapped.length > 0) {
      lines.push('- supports:')
      for (const req of mapped) {
        lines.push(`  - ${req.id}: ${req.text}`)
      }
    }
  }
  if (ticket.raw !== undefined && ticket.raw !== ticket.title) {
    lines.push(`- raw: ${ticket.raw}`)
  }
  return lines.join('\n')
}

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
    const trackIds = parseTrackIds(rawTitle)
    // Strip trailing ticket metadata (e.g. "(Blocked by: ...) (Track: 1,3) — Delivers ...
    // (Verification: ...)") so the TUI displays a concise, readable ticket title without overflow.
    const title = rawTitle
      .replace(/\s*\([^)]*(?:blocked\s+by|verification(?:\s+log)?)\s*:[^)]*\)/giu, '')
      .replace(/\s*\(\s*Track:\s*[^)]*\)/giu, '')
      .replace(/\s*[-—–]\s*(?:delivers|verification)\b.*$/iu, '')
      .replace(/\s*\([^)]*(?:blocked\s+by|verification(?:\s+log)?)\s*:[^)]*\)/giu, '')
      .replace(/\s*\(\s*Track:\s*[^)]*\)/giu, '')
      .trim() || rawTitle
    tickets.push({
      title,
      done: (ticket[1] ?? ' ').toLowerCase() === 'x',
      ...(trackIds === undefined ? {} : { trackIds }),
      raw: rawTitle,
    })
  }
  const done = tickets.filter(ticket => ticket.done).length
  return { tickets, done, current: tickets.find(ticket => !ticket.done) }
}

/**
 * Read metadata from a spec's header lines (Branch, Base-Commit, Original-Branch, Goal-Id).
 * @param markdown - the spec file's contents.
 * @returns the parsed metadata fields.
 */
export function parseSpecMetadata(markdown: string): SpecMetadata {
  const branch = BRANCH_LINE.exec(markdown)?.[1]
  const baseCommit = BASE_COMMIT_LINE.exec(markdown)?.[1]
  const originalBranch = ORIGINAL_BRANCH_LINE.exec(markdown)?.[1]
  const goalId = GOAL_ID_LINE.exec(markdown)?.[1]
  return {
    ...(branch !== undefined ? { branch } : {}),
    ...(baseCommit !== undefined ? { baseCommit } : {}),
    ...(originalBranch !== undefined ? { originalBranch } : {}),
    ...(goalId !== undefined ? { goalId } : {}),
  }
}

/**
 * Read the compact Main Track section from a spec.
 *
 * The section is the sealed compass (idea, Track-N decisions, Out of Scope),
 * not plan tickets. Checkboxes that happen to sit under it must not become
 * chrome work items — only `## Plan` is the ticket list.
 * @param markdown - the spec file's contents.
 * @returns the section body, or undefined when the file has no Main Track.
 */
export function parseMainTrack(markdown: string): string | undefined {
  const body: string[] = []
  let inside = false
  for (const line of markdown.split(/\r\n|[\r\n]/u)) {
    if (MAIN_TRACK_HEADING.test(line)) {
      inside = true
      continue
    }
    if (inside && HEADING.test(line)) break
    if (inside) body.push(line)
  }
  if (!inside) return undefined
  const text = body.join('\n').trim()
  return text === '' ? undefined : text
}

/**
 * Read the workflow phase from a spec's `Status:` line.
 *
 * The line is the durable phase ledger `/ship` keeps on disk: interviewing,
 * confirmed, planned, landing, or shipped. Anything else is not a phase the
 * MetaBar chip knows how to name.
 * @param markdown - the spec file's contents.
 * @returns the phase, or undefined when the file has no Status line.
 */
export function parseShipStatus(markdown: string): ShipStatus | undefined {
  const match = STATUS_LINE.exec(markdown)
  const value = match?.[1]?.toLowerCase()
  switch (value) {
    case 'interviewing':
    case 'confirmed':
    case 'planned':
    case 'landing':
    case 'shipped':
      return value
    default:
      return undefined
  }
}

/**
 * Whether a spec's plan is still work to pin in the chrome.
 *
 * A plan is worth a row while its tickets are being landed. Once the spec's
 * `Status:` says shipped the tickets are history — the row that tracked them
 * would only say "every ticket landed" for the rest of the session — so the
 * chrome gives the row back, the way the done chip already clears itself.
 * @param markdown - the spec file's contents.
 * @param plan - the plan parsed from it.
 * @returns true while there are tickets and the spec has not shipped.
 */
export function planInFlight(markdown: string, plan: Plan): boolean {
  return plan.tickets.length > 0 && parseShipStatus(markdown) !== 'shipped'
}

/**
 * Whether two plans name the same tickets in the same state.
 *
 * Chrome re-reads the spec on a timer; a render that changes nothing would
 * flicker the readout for no reason.
 */
export function plansEqual(a: Plan | undefined, b: Plan | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a.done !== b.done || a.tickets.length !== b.tickets.length) return false
  if (a.current?.title !== b.current?.title || a.current?.done !== b.current?.done) return false
  return a.tickets.every((ticket, at) =>
    ticket.title === b.tickets[at]?.title && ticket.done === b.tickets[at]?.done)
}

/** One spec file the surface might treat as the live `/ship` ledger. */
export interface ShipSpecFile {
  /** Absolute path, used only to distinguish session writes from on-disk history. */
  path: string
  /** File contents. */
  markdown: string
  /** True when this session watched the agent write the file. */
  sessionWrite?: boolean
}

/**
 * The spec chrome should follow: the first unfinished Status, else a shipped
 * spec this session wrote (so `ship · done` can clear).
 *
 * On-disk shipped specs are history — a fresh `/ship` must not adopt them
 * and wipe the grill chip.
 */
export function pickLiveShip(files: readonly ShipSpecFile[]): { markdown: string; plan: Plan } | undefined {
  let shipped: { markdown: string; plan: Plan } | undefined
  for (const file of files) {
    const status = parseShipStatus(file.markdown)
    if (status === undefined) continue
    const plan = parsePlan(file.markdown)
    if (status === 'shipped') {
      if (file.sessionWrite === true) shipped ??= { markdown: file.markdown, plan }
      continue
    }
    return { markdown: file.markdown, plan }
  }
  return shipped
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
 * The working-line progress fragment: a Ralph round, or the plan when no round
 * is in flight.
 *
 * The chrome already pins the plan as its own row. Repeating `done/total ·
 * current ticket` on the working line while a round runs stacks two identical
 * progress rows — the overlap a `/ship` Ralph loop showed. The round owns this
 * line; the plan stays in chrome.
 * @param plan - the plan read from the spec, if one is pinned.
 * @param round - the workflow round's label, if a round is running.
 * @param theme - styling for a plan fragment.
 * @param columns - display columns the plan fragment may use.
 * @returns the fragment, or undefined when neither is known.
 */
export function workingLineProgress(
  plan: Plan | undefined,
  round: string | undefined,
  theme: Theme,
  columns: number,
): string | undefined {
  if (round !== undefined && round !== '') return round
  return plan === undefined ? undefined : planRow(plan, theme, columns)
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
