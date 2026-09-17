/**
 * Ship graph rebuild: a pure join of map children, Plan `Ticket N:`
 * checkboxes, and sealed Track-N lines into the adjacent cache
 * `<spec>.ship.graph.json`. The sidecar is never identity.
 * @module codsh-bundle/src/ship-graph
 */

import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { essentialBlockedBy } from './ship-dag.ts'
import { parseMainTrack, parseShipStatus, parseTrackIds, type ShipStatus } from './plan.ts'
import { extractLocalDecisionAnswer, parseAnswerItems, shipGraphEnrichment } from './ship-answers.ts'
import { isConfirmedStatus } from './ship-snapshot.ts'
import { slugFromSpec } from './mission.ts'
import { displayWidth } from './theme.ts'
import type { Theme } from './theme.ts'

/** Versioned graph-cache schema; unknown versions are discarded, never migrated. */
export const SHIP_GRAPH_VERSION = 1

/** Claim token stored in JSON; renderers map to 待认领 / 已认领 / 已关闭. */
export type ShipClaim = 'unclaimed' | 'claimed' | 'closed'

/** Closed set of panorama node kinds. */
export type ShipGraphNodeKind = 'decision' | 'track' | 'landing'

/** Edges are blocked-by and hangs-off only. */
export type ShipGraphEdgeKind = 'blocked-by' | 'hangs-off'

/** wayfinder:* label / local Type: line, omitted when unknown. */
export type DecisionTicketType = 'research' | 'prototype' | 'grilling' | 'task'

/** Phase a captured human answer belongs to. */
export type ShipUserAnswerPhase = 'wayfinder' | 'grill' | 'spec' | 'tickets' | 'landing' | 'done'

/** One captured human question/answer for the Web panorama. */
export interface ShipUserAnswer {
  id: string
  phase: ShipUserAnswerPhase
  question: string
  answer?: string
  detail?: string
  source?: string
  ticketId?: string
}

/** One node in the rebuilt panorama cache. */
export interface ShipGraphNode {
  id: string
  kind: ShipGraphNodeKind
  title: string
  claim?: ShipClaim
  ticketType?: DecisionTicketType
}

/** One edge in the rebuilt panorama cache. */
export interface ShipGraphEdge {
  from: string
  to: string
  kind: ShipGraphEdgeKind
}

/** Lean envelope written beside the spec. */
export interface ShipGraph {
  version: typeof SHIP_GRAPH_VERSION
  specPath: string
  /** Current ledger status, not inferred from ticket completion. */
  status?: ShipStatus
  /** Verbatim original requirement; never Main Track masquerading as the ask. */
  originalRequirement?: string
  /** Main Track Idea, else Wayfinder Destination, else the original requirement. */
  objective?: string
  /** Human answers; additive and independent of TTY node identity. */
  answers?: ShipUserAnswer[]
  nodes: ShipGraphNode[]
  edges: ShipGraphEdge[]
}

/** Join refused to guess a cache; the runner must stop `/ship`. */
export interface ShipGraphJoinError {
  error: string
}

/** Missing, invalid, or unknown-version sidecar: discard and rebuild. */
export interface ShipGraphDiscard {
  discard: true
}

/** Injected inner-ring child. Scratch/tracker never mint this id. */
export interface DecisionChild {
  id: string
  title: string
  closed?: boolean
  claimed?: boolean
  assignee?: string
  ticketType?: DecisionTicketType
  /**
   * Native GitHub `blocked_by` keys. Presence — including an empty list —
   * wins over {@link DecisionChild.blockedByBody}; do not union.
   */
  blockedBy?: string[]
  /** Body `Blocked by:` fallback, used only when `blockedBy` is omitted. */
  blockedByBody?: string[]
  /** Explicit Question heading or metadata; research Resolution is not this. */
  question?: string
  /** Explicit User answer / User Answer heading or metadata. */
  userAnswer?: string
  /** Available raw question source text from the ticket. */
  questionSource?: string
}

/** Injected landing scratch, keyed by filename integer `n`. */
export interface LandingScratch {
  /** Filename prefix integer (`01-foo.md` → `1`). */
  n: number
  filename?: string
  title?: string
  claim?: 'claimed'
  /** `Ticket N:` recorded inside the file; mismatch with `n` is a join failure. */
  ticketN?: number
}

/** Canonical sources plus injected tracker/scratch state. */
export interface JoinSources {
  specPath: string
  markdown: string
  mapChildren?: readonly DecisionChild[]
  landingScratch?: readonly LandingScratch[]
  /**
   * Best-effort GitHub landing assignees. Scratch Claim wins a rebuild; a
   * drifted assignee must not invent 已认领, so this is never read for Claim.
   */
  landingAssignees?: Readonly<Record<number, string>>
  /** Unreadable map that is not a recorded no-map: join failure. */
  mapError?: string
  /** Named-map bodies used for Destination, never for plan-ticket guesses. */
  mapTexts?: readonly string[]
  /** Runner-owned answers restored into the live graph; not the canonical store. */
  answers?: readonly ShipUserAnswer[]
  /** Typed original before a spec exists, or a recovered freeze. */
  originalRequirement?: string
  /** Typed or recovered goal when the ledger has not refined one yet. */
  objective?: string
}

/** Ticket-node Claim buckets for the Panorama teaser. Track anchors are excluded. */
export interface TeaserCounts {
  unclaimed: number
  claimed: number
  closed: number
}

const VERSION = SHIP_GRAPH_VERSION

const PLAN_HEADING = /^#{1,6}\s+plan\s*$/iu
const HEADING = /^#{1,6}\s+/u
const TICKET = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/u
const TICKET_N = /^Ticket\s+(\d+)\s*:/iu
const TRACK_LINE = /^\s*(?:\*\*)?Track-(\d+)\.?(?:\*\*)?:?\s*(.*)$/iu
const SECTION_HEADING = /^(#{1,6})\s+(.*?)\s*$/u
const WAYFINDER_TITLE = /^wayfinder$/iu
const NONE_BLOCKED = /^(?:none|nothing|n\/a|[-—–])$/iu
const CLAIM_LINE = /^Claim:\s*claimed\b/imu
const TICKET_TYPE: ReadonlySet<string> = new Set(['research', 'prototype', 'grilling', 'task'])
const GITHUB_ISSUE = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/iu
const GITHUB_SHORTHAND = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/u
const MD_LINK = /\[([^\]]+)\]\(([^)]+)\)/gu
const KIND_RANK: Record<ShipGraphNodeKind, number> = { decision: 0, track: 1, landing: 2 }
const EDGE_RANK: Record<ShipGraphEdgeKind, number> = { 'blocked-by': 0, 'hangs-off': 1 }
const TEASER_HINT = 'click or Ctrl+G'
const HINT_COLUMNS = 80
const LANDING_KEY = /^landing:(\d+)$/u

export { essentialBlockedBy } from './ship-dag.ts'

/**
 * Worktree directory name from a graph key: `landing-N`, `decision-<n>`.
 * GitHub and local decisions both use the issue/filename integer.
 * @param graphKey - `landing:N`, `decision:github:owner/repo#n`, or `decision:local:NN`.
 */
export function worktreeDirectory(graphKey: string): string | undefined {
  const landing = LANDING_KEY.exec(graphKey)
  if (landing?.[1] !== undefined) return `landing-${landing[1]}`
  const local = /^decision:local:(\d+)$/u.exec(graphKey)
  if (local?.[1] !== undefined) return `decision-${local[1]}`
  const github = /^decision:github:[^/]+\/[^#]+#(\d+)$/u.exec(graphKey)
  if (github?.[1] !== undefined) return `decision-${github[1]}`
  return undefined
}

/**
 * Parse a worktree directory back to kind and integer.
 * @param directory - `landing-N` or `decision-N`.
 */
export function worktreeDirectoryParts(
  directory: string,
): { kind: 'landing' | 'decision'; n: number } | undefined {
  const landing = /^landing-(\d+)$/u.exec(directory)
  if (landing?.[1] !== undefined) return { kind: 'landing', n: Number(landing[1]) }
  const decision = /^decision-(\d+)$/u.exec(directory)
  if (decision?.[1] !== undefined) return { kind: 'decision', n: Number(decision[1]) }
  return undefined
}

/**
 * Adjacent sidecar for a spec: `widget.md` → `widget.ship.graph.json`.
 * @param specPath - absolute spec path.
 */
export function graphPathFor(specPath: string): string {
  const absolute = resolve(specPath)
  const base = absolute.split(sep).pop() ?? absolute
  const stem = base.replace(/\.md$/iu, '')
  return join(dirname(absolute), `${stem}.ship.graph.json`)
}

/** True when a join refused to produce a cache. */
export function isShipGraphJoinError(value: unknown): value is ShipGraphJoinError {
  return value !== undefined && value !== null && typeof value === 'object' && 'error' in value
}

/** True when a sidecar must be discarded and rebuilt. */
export function isShipGraphDiscard(
  value: ShipGraph | ShipGraphJoinError | ShipGraphDiscard | undefined,
): value is ShipGraphDiscard {
  return value !== undefined && 'discard' in value && value.discard === true
}

/**
 * Parse a graph sidecar. Corrupt or unknown-version payloads are discarded,
 * never a join failure and never migrated.
 */
export function parseShipGraph(raw: string): ShipGraph | ShipGraphDiscard {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return { discard: true }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { discard: true }
  const record = value as Record<string, unknown>
  if (record.version !== VERSION) return { discard: true }
  if (typeof record.specPath !== 'string' || record.specPath.trim() === '') return { discard: true }
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) return { discard: true }
  const answers = parseAnswerItems(record.answers)
  return {
    version: VERSION,
    specPath: record.specPath,
    ...(typeof record.status === 'string' && parseShipStatus(`Status: ${record.status}`) === record.status
      ? { status: record.status as ShipStatus }
      : {}),
    ...(typeof record.originalRequirement === 'string' ? { originalRequirement: record.originalRequirement } : {}),
    ...(typeof record.objective === 'string' ? { objective: record.objective } : {}),
    ...(answers !== undefined && answers.length > 0 ? { answers } : {}),
    nodes: record.nodes as ShipGraphNode[],
    edges: record.edges as ShipGraphEdge[],
  }
}

/**
 * Read the graph sidecar beside a spec. Absent is undefined; unreadable or
 * corrupt is discard-and-rebuild, never a stop.
 */
export function readShipGraph(specPath: string): ShipGraph | ShipGraphDiscard | undefined {
  const path = graphPathFor(specPath)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    return { discard: true }
  }
  return parseShipGraph(raw)
}

/**
 * Atomically write the graph sidecar. The path is always derived from the
 * spec, never from markdown contents.
 */
export function writeShipGraph(graph: ShipGraph, specPath: string): void {
  const path = graphPathFor(specPath)
  const body = `${JSON.stringify(graph, null, 2)}\n`
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* leftover tmp is not the sidecar */ }
    throw error
  }
}

/**
 * Join canonical sources into one Ship graph. Scratch and tracker state
 * derive Claim and titles only — they never mint ids.
 */
export function joinShipGraph(input: JoinSources): ShipGraph | ShipGraphJoinError {
  void input.landingAssignees
  if (input.mapError !== undefined && input.mapError !== '') {
    return { error: input.mapError }
  }
  const specPath = basename(input.specPath)
  const nodes: ShipGraphNode[] = []
  const edges: ShipGraphEdge[] = []
  const ids = new Set<string>()

  const inner = joinDecisions(input.mapChildren ?? [], nodes, edges, ids)
  if (inner !== undefined) return inner

  const tracks = parseTrackAnchors(parseMainTrack(input.markdown) ?? '')
  for (const track of tracks) {
    nodes.push(track)
    ids.add(track.id)
  }
  const trackIds = new Set(tracks.map(track => track.id))
  const status = parseShipStatus(input.markdown)
  const trackSealed = isConfirmedStatus(status) && tracks.length > 0

  const outer = joinLandings(input, nodes, edges, ids, trackIds, trackSealed)
  if (outer !== undefined) return outer

  return {
    version: VERSION,
    specPath,
    ...(status === undefined ? {} : { status }),
    ...shipGraphEnrichment({
      markdown: input.markdown,
      ...(input.mapTexts === undefined ? {} : { mapTexts: input.mapTexts }),
      ...(input.mapChildren === undefined ? {} : { mapChildren: input.mapChildren }),
      ...(input.answers === undefined ? {} : { answers: input.answers }),
      ...(input.originalRequirement === undefined ? {} : { originalRequirement: input.originalRequirement }),
      ...(input.objective === undefined ? {} : { objective: input.objective }),
    }),
    nodes: sortNodes(nodes),
    edges: sortEdges(edges),
  }
}

/**
 * Read local wayfinder files, map-file children, and landing scratch, then
 * join. A GitHub map pointer is not a decision ticket and does not hide the
 * local inner ring. GitHub is never contacted; native `blocked_by` must be
 * injected by the caller.
 */
export function collectJoinSources(
  cwd: string,
  specPath: string,
  markdown: string,
  extras: {
    mapChildren?: readonly DecisionChild[]
    mapError?: string
    answers?: readonly ShipUserAnswer[]
    originalRequirement?: string
    objective?: string
  } = {},
): JoinSources | ShipGraphJoinError {
  const slug = slugFromSpec(markdown, specPath)
  const wayfinderDir = join(cwd, '.scratch', slug, 'wayfinder')
  const issuesDir = join(cwd, '.scratch', slug, 'issues')
  const wayfinderBody = parseWayfinder(markdown) ?? markdown
  const mapTexts = readMapTexts(cwd, slug, specPath, wayfinderBody)
  let mapChildren = extras.mapChildren
  if (mapChildren === undefined) {
    const local = readLocalDecisions(wayfinderDir)
    if (isShipGraphJoinError(local)) return local
    const exclude = mapDecisionIds(wayfinderBody)
    mapChildren = mergeDecisionChildren(
      local,
      githubChildrenFromMapFiles(cwd, slug, specPath, wayfinderBody, exclude),
      githubChildrenFromText(wayfinderBody, exclude),
    )
  }
  const scratch = readLandingScratch(issuesDir)
  if (isShipGraphJoinError(scratch)) return scratch
  return {
    specPath,
    markdown,
    mapChildren,
    landingScratch: scratch,
    ...(mapTexts.length === 0 ? {} : { mapTexts }),
    ...(extras.mapError === undefined ? {} : { mapError: extras.mapError }),
    ...(extras.answers === undefined ? {} : { answers: extras.answers }),
    ...(extras.originalRequirement === undefined ? {} : { originalRequirement: extras.originalRequirement }),
    ...(extras.objective === undefined ? {} : { objective: extras.objective }),
  }
}

/** Ticket-node Claim buckets; Track anchors are not counted. */
export function teaserCounts(graph: ShipGraph): TeaserCounts {
  const counts: TeaserCounts = { unclaimed: 0, claimed: 0, closed: 0 }
  for (const node of graph.nodes) {
    if (node.kind === 'track' || node.claim === undefined) continue
    counts[node.claim] += 1
  }
  return counts
}

/**
 * One-line Panorama teaser. Drops `click or Ctrl+G` first (at 80 columns,
 * or whenever the hint will not fit) and never drops a bucket word or the
 * loopback URL. `in-flight` appears only when greater than zero.
 */
export function panoramaTeaser(
  counts: TeaserCounts,
  theme: Theme,
  columns: number,
  inFlight = 0,
  url?: string,
): string {
  const buckets = `待认领 ${String(counts.unclaimed)} · 已认领 ${String(counts.claimed)} · 已关闭 ${String(counts.closed)}`
  const flight = inFlight > 0 ? ` · in-flight ${String(inFlight)}` : ''
  const link = url !== undefined && url !== '' ? ` · ${url}` : ''
  const body = `  ${buckets}${flight}${link}`
  const trail = theme.dim(` · ${TEASER_HINT}`)
  const withHint = `${body}${trail}`
  if (columns > HINT_COLUMNS && displayWidth(withHint) <= columns) return withHint
  return body
}

function joinDecisions(
  children: readonly DecisionChild[],
  nodes: ShipGraphNode[],
  edges: ShipGraphEdge[],
  ids: Set<string>,
): ShipGraphJoinError | undefined {
  for (const child of children) {
    if (ids.has(child.id)) {
      return { error: `Duplicate decision key ${child.id}. Stopped; restore the map rather than guessing.` }
    }
    ids.add(child.id)
    const node: ShipGraphNode = {
      id: child.id,
      kind: 'decision',
      title: child.title,
      claim: decisionClaim(child),
    }
    if (child.ticketType !== undefined && TICKET_TYPE.has(child.ticketType)) {
      node.ticketType = child.ticketType
    }
    nodes.push(node)
  }
  for (const child of children) {
    const refs = child.blockedBy !== undefined ? child.blockedBy : (child.blockedByBody ?? [])
    for (const ref of refs) {
      const to = resolveDecisionRef(ref, children)
      if (to === undefined || to === child.id || !ids.has(to)) continue
      edges.push({ from: child.id, to, kind: 'blocked-by' })
    }
  }
  return undefined
}

function joinLandings(
  input: JoinSources,
  nodes: ShipGraphNode[],
  edges: ShipGraphEdge[],
  ids: Set<string>,
  trackIds: Set<string>,
  trackSealed: boolean,
): ShipGraphJoinError | undefined {
  const indexed = indexScratch(input.landingScratch ?? [])
  if (isShipGraphJoinError(indexed)) return indexed
  const parsed: { n: number; raw: string; done: boolean }[] = []
  const landingIds = new Set<number>()
  for (const row of planCheckboxRows(input.markdown)) {
    const match = TICKET_N.exec(row.raw)
    if (match === null) {
      return { error: 'Plan checkbox is not Ticket N:. Stopped; restore the approved plan rather than guessing.' }
    }
    const n = Number(match[1])
    if (!Number.isInteger(n) || n <= 0) {
      return { error: 'Plan checkbox is not Ticket N:. Stopped; restore the approved plan rather than guessing.' }
    }
    if (landingIds.has(n)) {
      return { error: `Duplicate Ticket ${String(n)} in the approved plan. Stopped; restore the plan rather than guessing.` }
    }
    landingIds.add(n)
    parsed.push({ n, raw: row.raw, done: row.done })
  }
  for (const row of parsed) {
    const scratch = indexed.get(row.n)
    const id = `landing:${String(row.n)}`
    ids.add(id)
    nodes.push({
      id,
      kind: 'landing',
      title: landingTitle(row.raw),
      claim: landingClaim(row.done, scratch),
    })
  }
  const blocked: ShipGraphEdge[] = []
  const hangs: ShipGraphEdge[] = []
  for (const row of parsed) {
    const id = `landing:${String(row.n)}`
    for (const blocker of parseBlockedBy(row.raw)) {
      const to = `landing:${String(blocker)}`
      if (to === id || !ids.has(to)) continue
      blocked.push({ from: id, to, kind: 'blocked-by' })
    }
    for (const track of parseTrackIds(row.raw) ?? []) {
      const to = `track:${String(track)}`
      if (trackSealed && !trackIds.has(to)) {
        return { error: `Landing Ticket ${String(row.n)} hangs off Track-${String(track)}, which is not in the sealed Main Track. Stopped.` }
      }
      if (!trackIds.has(to)) continue
      hangs.push({ from: id, to, kind: 'hangs-off' })
    }
  }
  edges.push(...essentialBlockedBy(blocked), ...hangs)
  return undefined
}

function filenameInteger(file: LandingScratch): number {
  const parsed = /^(\d+)/u.exec(file.filename ?? '')
  return parsed === null ? file.n : Number(parsed[1])
}

function indexScratch(
  files: readonly LandingScratch[],
): Map<number, LandingScratch> | ShipGraphJoinError {
  const indexed = new Map<number, LandingScratch>()
  for (const file of files) {
    const fromName = filenameInteger(file)
    if (file.ticketN !== undefined && file.ticketN !== fromName) {
      return {
        error: `Ticket ${String(file.ticketN)} does not match scratch filename integer ${String(fromName)}. Stopped; restore the plan and scratch rather than guessing.`,
      }
    }
    if (indexed.has(fromName)) {
      return { error: `Two scratch files share NN=${String(fromName)}. Stopped; restore scratch rather than guessing.` }
    }
    indexed.set(fromName, { ...file, n: fromName })
  }
  return indexed
}

function decisionClaim(child: DecisionChild): ShipClaim {
  if (child.closed === true) return 'closed'
  if (child.claimed === true || (child.assignee !== undefined && child.assignee !== '')) return 'claimed'
  return 'unclaimed'
}

function landingClaim(done: boolean, scratch: LandingScratch | undefined): ShipClaim {
  if (done) return 'closed'
  if (scratch?.claim === 'claimed') return 'claimed'
  return 'unclaimed'
}

function landingTitle(raw: string): string {
  return raw
    .replace(TICKET_N, '')
    .replace(/\s*\([^)]*(?:blocked\s+by|verification(?:\s+log)?)\s*:[^)]*\)/giu, '')
    .replace(/\s*\(\s*Track:\s*[^)]*\)/giu, '')
    .replace(/\s*[-—–]\s*(?:delivers|verification)\b.*$/iu, '')
    .trim() || raw.replace(TICKET_N, '').trim() || raw
}

function parseBlockedBy(raw: string): number[] {
  const match = /\(\s*Blocked by:\s*([^)]*)\)/iu.exec(raw)
  if (match === null) return []
  const body = (match[1] ?? '').trim()
  if (body === '' || NONE_BLOCKED.test(body)) return []
  return (body.match(/\d+/gu) ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0)
}

function parseTrackAnchors(body: string): ShipGraphNode[] {
  const nodes: ShipGraphNode[] = []
  const seen = new Set<string>()
  for (const line of body.split(/\r\n|[\r\n]/u)) {
    const match = TRACK_LINE.exec(line)
    if (match === null) continue
    const n = Number(match[1])
    if (!Number.isInteger(n) || n <= 0) continue
    const id = `track:${String(n)}`
    if (seen.has(id)) continue
    seen.add(id)
    nodes.push({ id, kind: 'track', title: (match[2] ?? '').trim() })
  }
  return nodes
}

function planCheckboxRows(markdown: string): { raw: string; done: boolean }[] {
  const rows: { raw: string; done: boolean }[] = []
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
    const raw = (ticket[2] ?? '').trim()
    if (raw === '') continue
    rows.push({ raw, done: (ticket[1] ?? ' ').toLowerCase() === 'x' })
  }
  return rows
}

function resolveDecisionRef(ref: string, children: readonly DecisionChild[]): string | undefined {
  const trimmed = ref.trim()
  if (trimmed === '' || NONE_BLOCKED.test(trimmed)) return undefined
  if (trimmed.startsWith('decision:')) return trimmed
  const github = GITHUB_ISSUE.exec(trimmed) ?? GITHUB_SHORTHAND.exec(trimmed)
  if (github !== null) {
    return `decision:github:${github[1]}/${github[2]}#${github[3]}`
  }
  const hash = /^#(\d+)$/u.exec(trimmed)
  if (hash !== null) {
    const suffix = `#${hash[1]}`
    return children.find(child => child.id.endsWith(suffix))?.id
  }
  const ticket = /^(?:Ticket\s+)?(\d+)$/iu.exec(trimmed)
  if (ticket !== null) return `decision:local:${String(Number(ticket[1]))}`
  return undefined
}

function sortNodes(nodes: ShipGraphNode[]): ShipGraphNode[] {
  return [...nodes].sort((a, b) => {
    const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
    return kind !== 0 ? kind : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

function sortEdges(edges: ShipGraphEdge[]): ShipGraphEdge[] {
  const seen = new Set<string>()
  const unique: ShipGraphEdge[] = []
  for (const edge of edges) {
    const key = `${edge.kind}\0${edge.from}\0${edge.to}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(edge)
  }
  return unique.sort((a, b) => {
    const kind = EDGE_RANK[a.kind] - EDGE_RANK[b.kind]
    if (kind !== 0) return kind
    if (a.from !== b.from) return a.from < b.from ? -1 : 1
    return a.to < b.to ? -1 : a.to > b.to ? 1 : 0
  })
}

function parseWayfinder(markdown: string): string | undefined {
  const body: string[] = []
  let rank: number | undefined
  let fence: string | undefined
  for (const line of markdown.split(/\r\n|[\r\n]/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence !== undefined) {
      if (rank !== undefined) body.push(line)
      if (marker?.[1] !== undefined && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2]?.trim() === '') fence = undefined
      continue
    }
    if (marker?.[1] !== undefined) {
      fence = marker[1]
      if (rank !== undefined) body.push(line)
      continue
    }
    const heading = SECTION_HEADING.exec(line)
    if (heading !== null) {
      const depth = heading[1]?.length ?? 0
      const name = heading[2] ?? ''
      if (rank === undefined) {
        if (WAYFINDER_TITLE.test(name)) {
          rank = depth
          continue
        }
      } else if (depth <= rank) {
        break
      }
    }
    if (rank !== undefined) body.push(line)
  }
  if (rank === undefined) return undefined
  const text = body.join('\n').trim()
  return text === '' ? undefined : text
}

/** Named-map locators: Canonical map lines and links titled Map / wayfinder:map. */
function mapDecisionIds(body: string): Set<string> {
  const ids = new Set<string>()
  const addFrom = (text: string): void => {
    for (const id of githubIdsIn(text)) ids.add(id)
  }
  for (const line of body.split(/\r\n|[\r\n]/u)) {
    if (/canonical map\b/iu.test(line) || /wayfinder:map/iu.test(line)) addFrom(line)
  }
  for (const match of markdownLinks(body)) {
    const title = (match[1] ?? '').trim()
    if (/^(?:map|wayfinder:map)$/iu.test(title)) addFrom(match[2] ?? '')
  }
  return ids
}

function githubChildrenFromMapFiles(
  cwd: string,
  slug: string,
  specPath: string,
  wayfinderBody: string,
  exclude: ReadonlySet<string>,
): DecisionChild[] {
  const children: DecisionChild[] = []
  const seen = new Set<string>()
  for (const path of mapMarkdownPaths(cwd, slug, specPath, wayfinderBody)) {
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const fileExclude = new Set([...exclude, ...mapDecisionIds(text)])
    for (const child of githubChildrenFromText(text, fileExclude)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      children.push(child)
    }
  }
  return children
}

function readMapTexts(cwd: string, slug: string, specPath: string, wayfinderBody: string): string[] {
  const texts: string[] = []
  for (const path of mapMarkdownPaths(cwd, slug, specPath, wayfinderBody)) {
    try {
      texts.push(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
  }
  return texts
}

function mapMarkdownPaths(cwd: string, slug: string, specPath: string, wayfinderBody: string): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  const spec = resolve(specPath)
  const add = (path: string): void => {
    const absolute = resolve(path)
    if (absolute === spec || seen.has(absolute)) return
    if (isLocalDecisionFilename(basename(absolute))) return
    seen.add(absolute)
    paths.push(absolute)
  }
  for (const match of markdownLinks(wayfinderBody)) {
    const href = (match[2] ?? '').trim()
    if (href === '' || /^https?:/iu.test(href)) continue
    const file = href.replace(/[?#].*$/u, '')
    if (!file.toLowerCase().endsWith('.md')) continue
    add(resolve(dirname(specPath), file))
  }
  add(join(cwd, '.scratch', slug, 'wayfinder', 'map.md'))
  return paths
}

function githubChildrenFromText(body: string, exclude: ReadonlySet<string> = new Set()): DecisionChild[] {
  const children: DecisionChild[] = []
  const seen = new Set<string>()
  const add = (id: string, title: string): void => {
    if (exclude.has(id) || seen.has(id)) return
    seen.add(id)
    children.push({ id, title: title.trim() || id })
  }
  for (const match of markdownLinks(body)) {
    const href = match[2] ?? ''
    const github = href.match(GITHUB_ISSUE)
    if (github === null) continue
    add(githubDecisionId(github[1] ?? '', github[2] ?? '', github[3] ?? ''), (match[1] ?? '').trim())
  }
  for (const match of body.matchAll(githubIssueGlobal())) {
    add(
      githubDecisionId(match[1] ?? '', match[2] ?? '', match[3] ?? ''),
      `${match[1]}/${match[2]}#${match[3]}`,
    )
  }
  for (const match of body.matchAll(githubShorthandGlobal())) {
    add(
      githubDecisionId(match[1] ?? '', match[2] ?? '', match[3] ?? ''),
      `${match[1]}/${match[2]}#${match[3]}`,
    )
  }
  return children
}

function githubIdsIn(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(githubIssueGlobal())) {
    ids.push(githubDecisionId(match[1] ?? '', match[2] ?? '', match[3] ?? ''))
  }
  for (const match of text.matchAll(githubShorthandGlobal())) {
    ids.push(githubDecisionId(match[1] ?? '', match[2] ?? '', match[3] ?? ''))
  }
  return ids
}

function markdownLinks(body: string): IterableIterator<RegExpExecArray> {
  return body.matchAll(new RegExp(MD_LINK.source, 'gu'))
}

function githubIssueGlobal(): RegExp {
  return new RegExp(GITHUB_ISSUE.source, 'giu')
}

function githubShorthandGlobal(): RegExp {
  return new RegExp(GITHUB_SHORTHAND.source, 'gu')
}

function githubDecisionId(owner: string, repo: string, n: string): string {
  return `decision:github:${owner}/${repo}#${n}`
}

function mergeDecisionChildren(...groups: readonly (readonly DecisionChild[] | undefined)[]): DecisionChild[] {
  const children: DecisionChild[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    if (group === undefined) continue
    for (const child of group) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      children.push(child)
    }
  }
  return children
}

/** Local decision identity for NN-slug.md and decision-NN-slug.md. */
export function localDecisionNumber(name: string): number | undefined {
  const match = /^(?:decision-)?(\d+)-.+\.md$/iu.exec(name)
  return match === null ? undefined : Number(match[1])
}

function isLocalDecisionFilename(name: string): boolean {
  return localDecisionNumber(name) !== undefined
}

/** Local ticket fields may be plain lines or Markdown list labels. */
function localDecisionField(text: string, field: 'Status' | 'Type' | 'Blocked by'): string | undefined {
  return decisionFieldPattern(field).exec(text)?.[1]?.trim()
}

function decisionFieldPattern(field: string): RegExp {
  return new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*)?${field}(?:\\*\\*)?[ \\t]*:[ \\t]*(?:\\*\\*)?([^\\r\\n]*)$`, 'imu')
}

/** Replace the existing Status field instead of introducing a conflicting one. */
export function claimLocalDecision(text: string): string {
  const status = localDecisionField(text, 'Status')?.toLowerCase()
  if (status !== undefined && /^(?:claimed|resolved|closed)\b/u.test(status)) return text
  return status === undefined
    ? `Status: claimed\n${text}`
    : text.replace(decisionFieldPattern('Status'), 'Status: claimed')
}

function readLocalDecisions(dir: string): DecisionChild[] | ShipGraphJoinError {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const children: DecisionChild[] = []
  const seen = new Set<number>()
  for (const name of names) {
    const n = localDecisionNumber(name)
    if (n === undefined) continue
    if (seen.has(n)) {
      return { error: `Duplicate decision key decision:local:${String(n)}. Stopped; restore the map rather than guessing.` }
    }
    seen.add(n)
    let text = ''
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    const title = localTitle(text, name)
    const type = /^(?:wayfinder:)?(research|prototype|grilling|task)\b/iu.exec(localDecisionField(text, 'Type') ?? '')?.[1]?.toLowerCase()
    const status = /^(claimed|resolved|closed)\b/iu.exec(localDecisionField(text, 'Status') ?? '')?.[1]?.toLowerCase()
    const blocked = parseDecisionBlockedBody(text)
    const extracted = extractLocalDecisionAnswer(text)
    children.push({
      id: `decision:local:${String(n)}`,
      title,
      ...(status === 'resolved' || status === 'closed' ? { closed: true } : {}),
      ...(status === 'claimed' ? { claimed: true } : {}),
      ...(type !== undefined && TICKET_TYPE.has(type) ? { ticketType: type as DecisionTicketType } : {}),
      ...(blocked.length === 0 ? {} : { blockedByBody: blocked }),
      ...(extracted.question === undefined ? {} : { question: extracted.question }),
      ...(extracted.userAnswer === undefined ? {} : { userAnswer: extracted.userAnswer }),
      ...(extracted.source === undefined ? {} : { questionSource: extracted.source }),
    })
  }
  return children
}

function readLandingScratch(dir: string): LandingScratch[] | ShipGraphJoinError {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files: LandingScratch[] = []
  const seen = new Set<number>()
  for (const name of names) {
    const parsed = /^(\d+)-.+\.md$/iu.exec(name)
    if (parsed === null) continue
    const n = Number(parsed[1])
    if (seen.has(n)) {
      return { error: `Two scratch files share NN=${String(n)}. Stopped; restore scratch rather than guessing.` }
    }
    seen.add(n)
    let text = ''
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    const ticketN = TICKET_N.exec(text.trim())?.[1]
    files.push({
      n,
      filename: name,
      ...(CLAIM_LINE.test(text) ? { claim: 'claimed' } : {}),
      ...(ticketN === undefined ? {} : { ticketN: Number(ticketN) }),
    })
  }
  return files
}

function localTitle(text: string, filename: string): string {
  const heading = /^#\s+(.+)$/mu.exec(text)
  if (heading?.[1] !== undefined) return heading[1].trim()
  return filename.replace(/^(?:decision-)?\d+-/iu, '').replace(/\.md$/iu, '').replace(/-/gu, ' ')
}

function parseDecisionBlockedBody(text: string): string[] {
  const body = localDecisionField(text, 'Blocked by') ?? ''
  if (body === '' || NONE_BLOCKED.test(body)) return []
  return body.split(/[,]+/u).map(part => part.trim()).filter(part => part !== '')
}
