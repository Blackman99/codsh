/** Browser-only projection of the Ship graph into ordered, nested sub-flows. */
import { Position, type Edge, type Node } from '@xyflow/react'
import { essentialBlockedBy } from './ship-dag.ts'
import type { ShipGraph, ShipGraphNode, ShipUserAnswer } from './ship-graph.ts'
import type { ShipStatus } from './plan.ts'

export const SHIP_FLOW_PHASES = [
  {
    id: 'wayfinder',
    title: 'Wayfinder',
    description: 'Name the destination and resolve open decisions.',
    steps: ['Define destination', 'Chart decision map', 'Resolve decisions'],
    kind: 'decision',
    empty:
      'No decision tickets. A confirmed clear route can continue without them.',
  },
  {
    id: 'grill',
    title: 'Grill',
    description: 'Explore the design until the question frontier is settled.',
    steps: [
      'Inspect the codebase',
      'Interview the frontier',
      'Confirm exhaustion',
    ],
    empty:
      'Interview steps are a workflow guide, not individual execution records.',
  },
  {
    id: 'spec',
    title: 'Spec · Gate 1',
    description: 'Synthesize the specification and seal the Main Track.',
    steps: ['Synthesize stories', 'Define acceptance', 'Confirm & seal'],
    kind: 'track',
    empty: 'No Main Track anchors have been recorded yet.',
  },
  {
    id: 'tickets',
    title: 'Tickets · Gate 2',
    description: 'Break the approved specification into deliverable tickets.',
    steps: [
      'Slice vertical tickets',
      'Link dependencies',
      'Baseline & confirm',
    ],
    empty:
      'Approved implementation tickets appear in Landing, without duplicating their identity.',
  },
  {
    id: 'landing',
    title: 'Landing',
    description: 'Implement unblocked tickets and merge verified changes.',
    steps: ['Dispatch worktrees', 'Red → green → verify', 'Merge & re-verify'],
    kind: 'landing',
    empty: 'No implementation tickets have been recorded yet.',
  },
  {
    id: 'done',
    title: 'Done',
    description: 'Prove acceptance and repository health before delivery.',
    steps: ['Prove acceptance', 'Check repo baseline', 'Merge back'],
    empty:
      'Closed tickets alone do not mean shipped. The ledger must record Status: shipped.',
  },
] as const

export const SHIP_FLOW_GEOMETRY = {
  width: 760,
  padding: 24,
  cardWidth: 200,
  columnGap: 56,
  stepY: 88,
  stepHeight: 48,
  ticketY: 196,
  ticketHeight: 96,
  ticketColumn: 220,
  clusterGap: 32,
  rowGap: 64,
  answerGap: 20,
  phaseGap: 96,
  collapsedHeight: 80,
  minAnswerWidth: 360,
  ticketDagWidth: 260,
  ticketDagGap: 96,
  ticketDagRowGap: 128,
  ticketDagMaxGap: 240,
  maxDagColumns: 4,
  relationLaneGap: 48,
  relationChannelGap: 22,
  relationStub: 18,
  relationOuter: 56,
} as const

export type FlowRelationRoute = {
  laneX?: number
  exitOffset?: number
  entryOffset?: number
  outside?: boolean
}

export function flowRelationWaypoints(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  data: FlowRelationRoute = {},
): { x: number; y: number }[] {
  if (Number.isFinite(data.laneX)) {
    const laneX = Number(data.laneX)
    const stub = SHIP_FLOW_GEOMETRY.relationStub
    const exitY = sourceY + (data.exitOffset ?? stub)
    const entryY = targetY - (data.entryOffset ?? stub)
    return [
      { x: sourceX, y: sourceY },
      { x: sourceX, y: exitY },
      { x: laneX, y: exitY },
      { x: laneX, y: entryY },
      { x: targetX, y: entryY },
      { x: targetX, y: targetY },
    ]
  }
  const midY = sourceY + (data.exitOffset ?? SHIP_FLOW_GEOMETRY.relationStub)
  return [
    { x: sourceX, y: sourceY },
    { x: sourceX, y: midY },
    { x: targetX, y: midY },
    { x: targetX, y: targetY },
  ]
}

export function flowRelationPath(points: readonly { x: number; y: number }[], radius = 8): string {
  if (points.length < 2) return ''
  const start = points[0]!
  let path = `M${start.x},${start.y}`
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    const next = points[index + 1]!
    const inX = Math.sign(current.x - previous.x)
    const inY = Math.sign(current.y - previous.y)
    const outX = Math.sign(next.x - current.x)
    const outY = Math.sign(next.y - current.y)
    const incoming = Math.hypot(current.x - previous.x, current.y - previous.y)
    const outgoing = Math.hypot(next.x - current.x, next.y - current.y)
    const corner = Math.min(radius, incoming / 2, outgoing / 2)
    path += ` L${current.x - inX * corner},${current.y - inY * corner}`
    path += ` Q${current.x},${current.y} ${current.x + outX * corner},${current.y + outY * corner}`
  }
  const end = points.at(-1)!
  return `${path} L${end.x},${end.y}`
}

function collinearOverlap(
  first: { x1: number; y1: number; x2: number; y2: number },
  second: { x1: number; y1: number; x2: number; y2: number },
): number {
  const vertical = Math.abs(first.x1 - first.x2) < 1 && Math.abs(second.x1 - second.x2) < 1
  const horizontal = Math.abs(first.y1 - first.y2) < 1 && Math.abs(second.y1 - second.y2) < 1
  if (vertical) {
    if (Math.abs(first.x1 - second.x1) > 1) return 0
    return Math.max(
      0,
      Math.min(Math.max(first.y1, first.y2), Math.max(second.y1, second.y2))
        - Math.max(Math.min(first.y1, first.y2), Math.min(second.y1, second.y2)),
    )
  }
  if (horizontal) {
    if (Math.abs(first.y1 - second.y1) > 1) return 0
    return Math.max(
      0,
      Math.min(Math.max(first.x1, first.x2), Math.max(second.x1, second.x2))
        - Math.max(Math.min(first.x1, first.x2), Math.min(second.x1, second.x2)),
    )
  }
  return 0
}

function relationSegments(points: readonly { x: number; y: number }[]): { x1: number; y1: number; x2: number; y2: number }[] {
  return points.slice(0, -1).map((point, index) => {
    const next = points[index + 1]!
    return { x1: point.x, y1: point.y, x2: next.x, y2: next.y }
  })
}

/** Interior collinear run shared by two orthogonal relations. Handle stubs are ignored. */
export function relationRunOverlap(
  first: readonly { x: number; y: number }[],
  second: readonly { x: number; y: number }[],
): number {
  let longest = 0
  for (const a of relationSegments(first).slice(1, -1)) {
    for (const b of relationSegments(second).slice(1, -1)) {
      longest = Math.max(longest, collinearOverlap(a, b))
    }
  }
  return longest
}

function channelOffsets(
  count: number,
  geometry: typeof SHIP_FLOW_GEOMETRY,
  maxOffset = geometry.relationStub + 48,
): number[] {
  if (count <= 1) return [geometry.relationStub]
  const ceiling = Math.max(
    geometry.relationStub + 12 * (count - 1),
    Math.min(maxOffset, geometry.relationStub + geometry.relationChannelGap * (count - 1)),
  )
  const step = (ceiling - geometry.relationStub) / (count - 1)
  return Array.from(
    { length: count },
    (_, index) => geometry.relationStub + index * step,
  )
}

function ticketCenterX(node: ShipFlowNode): number {
  return node.position.x + Number(node.style?.width ?? 0) / 2
}

function ticketBottom(node: ShipFlowNode): number {
  return node.position.y + Number(node.style?.height ?? 0)
}

function rangesOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.min(a1, a2) < Math.max(b1, b2) - 1 && Math.min(b1, b2) < Math.max(a1, a2) - 1
}

type PendingRelation = {
  id: string
  source: string
  target: string
  kind: string
  animated: boolean
  sourceNode: ShipFlowNode
  targetNode: ShipFlowNode
  outside: boolean
}

function assignRelationRoutes(
  pending: readonly PendingRelation[],
  canvasWidth: number,
  geometry: typeof SHIP_FLOW_GEOMETRY,
): Map<string, FlowRelationRoute> {
  const routes = new Map<string, FlowRelationRoute>()
  const grouped = <K,>(items: readonly PendingRelation[], key: (item: PendingRelation) => K): PendingRelation[][] => {
    const buckets = new Map<K, PendingRelation[]>()
    for (const item of items) {
      const group = buckets.get(key(item)) ?? []
      group.push(item)
      buckets.set(key(item), group)
    }
    return [...buckets.values()]
  }
  const halfGap = (item: PendingRelation): number => {
    const gap = item.targetNode.position.y - ticketBottom(item.sourceNode)
    if (gap < geometry.relationStub * 2 + 24) return geometry.relationStub
    return Math.max(geometry.relationStub, (gap - 28) / 2)
  }
  const byExit = grouped(pending, item => item.sourceNode.id)
  for (const group of byExit) {
    group.sort((a, b) =>
      ticketCenterX(a.targetNode) - ticketCenterX(b.targetNode)
      || a.id.localeCompare(b.id),
    )
    const offsets = channelOffsets(
      group.length,
      geometry,
      Math.min(...group.map(halfGap)),
    )
    group.forEach((item, index) => {
      const offset = offsets[index]
      if (offset === undefined) return
      routes.set(item.id, { ...routes.get(item.id), exitOffset: offset })
    })
  }
  const byEntry = grouped(pending, item => item.targetNode.id)
  for (const group of byEntry) {
    group.sort((a, b) =>
      ticketCenterX(a.sourceNode) - ticketCenterX(b.sourceNode)
      || a.id.localeCompare(b.id),
    )
    const offsets = channelOffsets(
      group.length,
      geometry,
      Math.min(...group.map(halfGap)),
    )
    group.forEach((item, index) => {
      const offset = offsets[index]
      if (offset === undefined) return
      routes.set(item.id, { ...routes.get(item.id), entryOffset: offset })
    })
  }
  const usedExitY = new Map<number, number[]>()
  const usedEntryY = new Map<number, number[]>()
  const uniqueChannel = (
    used: Map<number, number[]>,
    key: number,
    preferred: number,
    step: number,
    min: number,
    max: number,
  ): number => {
    const taken = used.get(key) ?? []
    const candidates: number[] = [preferred]
    for (let hops = 1; hops <= 12; hops += 1) {
      candidates.push(preferred + hops * step, preferred - hops * step)
    }
    const usable = (limit: number): number | undefined =>
      candidates.find(value =>
        value >= min && value <= limit && taken.every(existing => Math.abs(existing - value) >= geometry.relationChannelGap - 1),
      )
    const offset = usable(max) ?? usable(Math.max(max, min + step * (taken.length + 1))) ?? preferred
    used.set(key, [...taken, offset])
    return Math.max(min, offset)
  }
  for (const item of pending.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const route = routes.get(item.id) ?? {}
    const bottom = ticketBottom(item.sourceNode)
    const top = item.targetNode.position.y
    const gap = top - bottom
    const max = Math.max(geometry.relationStub, gap - geometry.relationStub - 8)
    const exit = uniqueChannel(
      usedExitY,
      Math.round(bottom),
      route.exitOffset ?? geometry.relationStub,
      geometry.relationChannelGap,
      geometry.relationStub,
      max,
    )
    const entry = uniqueChannel(
      usedEntryY,
      Math.round(top),
      route.entryOffset ?? geometry.relationStub,
      geometry.relationChannelGap,
      geometry.relationStub,
      max,
    )
    routes.set(item.id, { ...route, exitOffset: exit, entryOffset: entry })
  }
  const left = pending.filter(item => item.outside && ticketCenterX(item.sourceNode) < canvasWidth / 2)
  const right = pending.filter(item => item.outside && ticketCenterX(item.sourceNode) >= canvasWidth / 2)
  const bySpan = (a: PendingRelation, b: PendingRelation): number =>
    ticketBottom(a.sourceNode) - ticketBottom(b.sourceNode)
    || ticketCenterX(a.sourceNode) - ticketCenterX(b.sourceNode)
    || a.id.localeCompare(b.id)
  left.sort(bySpan)
  right.sort(bySpan)
  left.forEach((item, index) => {
    routes.set(item.id, {
      ...routes.get(item.id),
      laneX: -geometry.relationOuter - index * geometry.relationLaneGap,
    })
  })
  right.forEach((item, index) => {
    routes.set(item.id, {
      ...routes.get(item.id),
      laneX: canvasWidth + geometry.relationOuter + index * geometry.relationLaneGap,
    })
  })
  const placed: { x: number; y1: number; y2: number }[] = []
  const inside = pending.filter(item => !item.outside)
    .slice()
    .sort((a, b) =>
      ticketCenterX(a.sourceNode) - ticketCenterX(b.sourceNode)
      || ticketCenterX(a.targetNode) - ticketCenterX(b.targetNode)
      || a.id.localeCompare(b.id),
    )
  for (const item of inside) {
    const route = routes.get(item.id) ?? {}
    const sourceX = ticketCenterX(item.sourceNode)
    const targetX = ticketCenterX(item.targetNode)
    const y1 = ticketBottom(item.sourceNode) + (route.exitOffset ?? geometry.relationStub)
    const y2 = item.targetNode.position.y - (route.entryOffset ?? geometry.relationStub)
    let x = Math.abs(sourceX - targetX) < 1 ? sourceX : (sourceX + targetX) / 2
    const step = sourceX <= targetX ? -16 : 16
    while (placed.some(lane => Math.abs(lane.x - x) < 16 && rangesOverlap(lane.y1, lane.y2, y1, y2))) {
      x += step
    }
    placed.push({ x, y1, y2 })
    routes.set(item.id, { ...route, laneX: x })
  }
  return routes
}

export type FlowPhase = (typeof SHIP_FLOW_PHASES)[number]
export type FlowPhaseId = FlowPhase['id']
export type PhaseState = 'current' | 'passed' | 'upcoming' | 'unknown'
export type FlowNodeData = Record<string, unknown> & {
  title: string
  phase: FlowPhaseId
  level: number
  description?: string
  state?: PhaseState
  active?: boolean
  collapsed?: boolean
  count?: number
  closed?: number
  empty?: string
  ticket?: ShipGraphNode
  text?: string
  answer?: ShipUserAnswer
}
export type ShipFlowNode = Node<FlowNodeData, 'phase' | 'step' | 'ticket' | 'context' | 'answer'>

function sized(width: number, height: number): Pick<ShipFlowNode, 'width' | 'height' | 'style'> {
  return { width, height, style: { width, height } }
}

function handle(
  type: 'source' | 'target',
  position: Position,
  width: number,
  height: number,
  id?: string,
  y?: number,
): NonNullable<ShipFlowNode['handles']>[number] {
  const x = position === Position.Right ? width : position === Position.Left ? 0 : width / 2
  const handleY = y ?? (position === Position.Bottom ? height : position === Position.Top ? 0 : height / 2)
  return { type, position, x, y: handleY, width: 8, height: 8, ...(id === undefined ? {} : { id }) }
}

const STATUS_PHASE: Record<ShipStatus, FlowPhaseId> = {
  wayfinding: 'wayfinder',
  grilling: 'grill',
  interviewing: 'spec',
  confirmed: 'tickets',
  planned: 'landing',
  landing: 'landing',
  shipped: 'done',
}
export const FLOW_CLAIM = {
  unclaimed: 'Unclaimed',
  claimed: 'Claimed',
  closed: 'Closed',
} as const
export const FLOW_PHASE_STATE: Record<PhaseState, string> = {
  current: 'Current phase',
  passed: 'Passed',
  upcoming: 'Upcoming',
  unknown: 'Not recorded',
}

/** Browser tab and page heading: the typed `/ship` idea, else the product name. */
export function webPanoramaTitle(graph: Pick<ShipGraph, 'originalRequirement'>): string {
  const idea = graph.originalRequirement?.replace(/\s+/gu, ' ').trim() ?? ''
  return idea === '' ? 'Ship Flow' : idea
}

/** Track anchors never inherit a ticket claim; absent claims remain unknown. */
export function ticketFlowState(
  ticket: ShipGraphNode,
): 'anchor' | 'unknown' | NonNullable<ShipGraphNode['claim']> {
  return ticket.kind === 'track' ? 'anchor' : (ticket.claim ?? 'unknown')
}

export const WEB_PANORAMA_TRACK_STUB =
  'This Track anchor is not a ticket and has no proof.'
export const WEB_PANORAMA_TICKET_BRIEF_STUB = 'Brief (stub)'
export const WEB_PANORAMA_TICKET_EVIDENCE_STUB = 'Evidence (stub)'

export function currentFlowPhase(graph: ShipGraph): FlowPhaseId | undefined {
  return graph.status === undefined ? undefined : STATUS_PHASE[graph.status]
}

/** Dependency ranks order prerequisites first; cycles stay visible in a final row. */
function ticketRanks(
  tickets: readonly ShipGraphNode[],
  graph: ShipGraph,
): ShipGraphNode[][] {
  const pending = new Map(tickets.map((ticket) => [ticket.id, ticket]))
  const blocked = essentialBlockedBy(graph.edges)
  const rows: ShipGraphNode[][] = []
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(
      (ticket) =>
        !blocked.some(
          (edge) =>
            edge.kind === 'blocked-by' &&
            edge.from === ticket.id &&
            pending.has(edge.to),
        ),
    )
    if (ready.length === 0) {
      rows.push([...pending.values()].sort(byGraphKey))
      break
    }
    rows.push(ready.sort(byGraphKey))
    for (const ticket of ready) pending.delete(ticket.id)
  }
  return rows
}

function byGraphKey(a: ShipGraphNode, b: ShipGraphNode): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true })
}

function wrapRanks(
  ranks: readonly ShipGraphNode[][],
  maxColumns: number,
): ShipGraphNode[][] {
  return ranks.flatMap((row) =>
    row.length <= maxColumns
      ? [row]
      : Array.from({ length: Math.ceil(row.length / maxColumns) }, (_, i) =>
        row.slice(i * maxColumns, (i + 1) * maxColumns),
      ),
  )
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** CJK and other wide glyphs occupy two Latin units when wrapping. */
function textUnits(text: string): number {
  let units = 0
  for (const char of text) units += (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1
  return units
}

/** Bound card height; long source text remains scrollable rather than truncated. */
function contentHeight(text: string, minimum = 104, unitsPerLine = 75): number {
  const lines = text.split('\n').reduce(
    (count, line) => count + Math.max(1, Math.ceil(textUnits(line) / unitsPerLine)),
    0,
  )
  return Math.min(360, Math.max(minimum, 56 + lines * 22))
}

function answerCharsPerLine(width: number): number {
  return Math.max(20, Math.min(75, Math.floor((width - 36) / 7.5)))
}

function answerCardHeight(answer: ShipUserAnswer, width: number): number {
  return Math.min(
    360,
    contentHeight(
      `${answer.question}\n${answer.detail ?? ''}\n${answer.answer || 'No user answer recorded.'}`,
      128,
      answerCharsPerLine(width),
    ) + 48,
  )
}

/** Answers that share a parent fan out as siblings; a lone ticket owns the phase answers. */
function answerGroups(
  phaseAnswers: readonly ShipUserAnswer[],
  tickets: readonly ShipGraphNode[],
): { parent?: ShipGraphNode; answers: ShipUserAnswer[] }[] {
  if (phaseAnswers.length === 0) return []
  const only = tickets.length === 1 ? tickets[0] : undefined
  if (only !== undefined) return [{ parent: only, answers: [...phaseAnswers] }]
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]))
  const attached = new Map<string, ShipUserAnswer[]>()
  const unlinked: ShipUserAnswer[] = []
  for (const answer of phaseAnswers) {
    const parent = answer.ticketId === undefined ? undefined : ticketById.get(answer.ticketId)
    if (parent === undefined) {
      unlinked.push(answer)
      continue
    }
    const group = attached.get(parent.id) ?? []
    group.push(answer)
    attached.set(parent.id, group)
  }
  return [
    ...tickets.flatMap((ticket) => {
      const answers = attached.get(ticket.id)
      return answers === undefined ? [] : [{ parent: ticket, answers }]
    }),
    ...(unlinked.length === 0 ? [] : [{ answers: unlinked }]),
  ]
}

type PlacedAnswer = {
  answer: ShipUserAnswer
  parent?: ShipGraphNode
  x: number
  y: number
  width: number
  height: number
}

/** Full-width stacked answers, used when a phase has no ticket to sit beside. */
function placeAnswers(
  groups: readonly { parent?: ShipGraphNode; answers: readonly ShipUserAnswer[] }[],
  startY: number,
  geometry: typeof SHIP_FLOW_GEOMETRY,
  width: number = geometry.width,
): { placed: PlacedAnswer[]; bottom: number } {
  const placed: PlacedAnswer[] = []
  const inner = width - geometry.padding * 2
  let y = startY
  for (const group of groups) {
    for (const answer of group.answers) {
      const height = answerCardHeight(answer, inner)
      placed.push({
        answer,
        ...(group.parent === undefined ? {} : { parent: group.parent }),
        x: geometry.padding,
        y,
        width: inner,
        height,
      })
      y += height + geometry.answerGap
    }
  }
  return { placed, bottom: placed.length === 0 ? startY : y - geometry.answerGap }
}

type PlacedTicket = {
  ticket: ShipGraphNode
  x: number
  y: number
  width: number
}

function clusterWidthFor(answerWidth: number, geometry: typeof SHIP_FLOW_GEOMETRY): number {
  return geometry.ticketColumn + geometry.clusterGap + answerWidth
}

function answersByParent(
  groups: readonly { parent?: ShipGraphNode; answers: readonly ShipUserAnswer[] }[],
): { byParent: Map<string, readonly ShipUserAnswer[]>; unlinked: ShipUserAnswer[] } {
  const byParent = new Map<string, readonly ShipUserAnswer[]>()
  const unlinked: ShipUserAnswer[] = []
  for (const group of groups) {
    if (group.parent === undefined) unlinked.push(...group.answers)
    else byParent.set(group.parent.id, group.answers)
  }
  return { byParent, unlinked }
}

function clusterExtent(
  ticket: ShipGraphNode,
  byParent: ReadonlyMap<string, readonly ShipUserAnswer[]>,
  answerWidth: number,
  geometry: typeof SHIP_FLOW_GEOMETRY,
): number {
  return (byParent.get(ticket.id) ?? []).length === 0
    ? geometry.ticketColumn
    : clusterWidthFor(answerWidth, geometry)
}

function rankColumnWidth(
  row: readonly ShipGraphNode[],
  byParent: ReadonlyMap<string, readonly ShipUserAnswer[]>,
  answerWidth: number,
  geometry: typeof SHIP_FLOW_GEOMETRY,
): number {
  return row.length > 1
    ? clusterWidthFor(answerWidth, geometry)
    : clusterExtent(row[0]!, byParent, answerWidth, geometry)
}

function neededClusterWidth(
  ranked: readonly ShipGraphNode[][],
  groups: readonly { parent?: ShipGraphNode; answers: readonly ShipUserAnswer[] }[],
  geometry: typeof SHIP_FLOW_GEOMETRY,
): number {
  const { byParent } = answersByParent(groups)
  return Math.max(
    geometry.width,
    ...ranked.map((row) =>
      geometry.padding * 2
      + row.length * rankColumnWidth(row, byParent, geometry.minAnswerWidth, geometry)
      + Math.max(0, row.length - 1) * geometry.columnGap,
    ),
  )
}

function neededDagWidth(
  ranked: readonly ShipGraphNode[][],
  geometry: typeof SHIP_FLOW_GEOMETRY,
): number {
  const widest = ranked.reduce((max, row) => Math.max(max, row.length), 0)
  if (widest <= 1) return geometry.width
  const columns = Math.min(widest, geometry.maxDagColumns)
  return Math.max(
    geometry.width,
    geometry.padding * 2
      + columns * geometry.ticketDagWidth
      + Math.max(0, columns - 1) * geometry.ticketDagGap,
  )
}

function barycenter(
  ticket: ShipGraphNode,
  placed: readonly PlacedTicket[],
  graph: ShipGraph,
  fallback: number,
): number {
  const parents = essentialBlockedBy(graph.edges)
    .filter(edge => edge.kind === 'blocked-by' && edge.from === ticket.id)
    .flatMap(edge => {
      const parent = placed.find(item => item.ticket.id === edge.to)
      return parent === undefined ? [] : [parent.x]
    })
  return parents.length === 0 ? fallback : median(parents)
}

function layoutDag(
  ranked: readonly ShipGraphNode[][],
  startY: number,
  geometry: typeof SHIP_FLOW_GEOMETRY,
  width: number,
  graph: ShipGraph,
): { tickets: PlacedTicket[]; placed: PlacedAnswer[]; bottom: number; width: number } {
  const inner = width - geometry.padding * 2
  const tickets: PlacedTicket[] = []
  let y = startY
  for (const row of ranked) {
    const columns = Math.max(1, row.length)
    const available = columns === 1
      ? 0
      : (inner - columns * geometry.ticketDagWidth) / (columns - 1)
    const gap = columns === 1
      ? 0
      : Math.min(
        available,
        Math.max(geometry.ticketDagGap, geometry.ticketDagMaxGap, inner * 0.34),
      )
    const total = columns * geometry.ticketDagWidth + Math.max(0, columns - 1) * gap
    const origin = geometry.padding + Math.max(0, (inner - total) / 2)
    const fallbacks = row.map((_, column) => origin + column * (geometry.ticketDagWidth + gap))
    const desired = row.map((ticket, column) =>
      barycenter(ticket, tickets, graph, fallbacks[column]!),
    )
    const sorted = desired
      .map((x, index) => ({ index, x }))
      .sort((a, b) => a.x - b.x || a.index - b.index)
    const placedX = new Array<number>(row.length)
    let cursor = origin
    for (const [order, item] of sorted.entries()) {
      const maxX = origin + total - geometry.ticketDagWidth
        - (sorted.length - 1 - order) * (geometry.ticketDagWidth + gap)
      const x = Math.min(maxX, Math.max(cursor, item.x))
      placedX[item.index] = x
      cursor = x + geometry.ticketDagWidth + gap
    }
    for (const [column, ticket] of row.entries()) {
      tickets.push({
        ticket,
        x: placedX[column]!,
        y,
        width: geometry.ticketDagWidth,
      })
    }
    y += geometry.ticketHeight + geometry.ticketDagRowGap
  }
  return {
    tickets,
    placed: [],
    bottom: ranked.length === 0 ? startY : y - geometry.ticketDagRowGap,
    width,
  }
}

/** Ticket on the left, its answers stacked on the right; sibling ranks stay side by side. */
function layoutClusters(
  ranked: readonly ShipGraphNode[][],
  groups: readonly { parent?: ShipGraphNode; answers: readonly ShipUserAnswer[] }[],
  startY: number,
  geometry: typeof SHIP_FLOW_GEOMETRY,
  width: number,
): { tickets: PlacedTicket[]; placed: PlacedAnswer[]; bottom: number; width: number } {
  const { byParent, unlinked } = answersByParent(groups)
  const inner = width - geometry.padding * 2
  const placedTickets: PlacedTicket[] = []
  const placed: PlacedAnswer[] = []
  let y = startY
  for (const row of ranked) {
    const gaps = Math.max(0, row.length - 1) * geometry.columnGap
    const answerWidth = row.length > 1
      ? Math.max(
        geometry.minAnswerWidth,
        (inner - gaps) / row.length - geometry.ticketColumn - geometry.clusterGap,
      )
      : (byParent.get(row[0]!.id) ?? []).length === 0
        ? geometry.minAnswerWidth
        : Math.max(
          geometry.minAnswerWidth,
          inner - geometry.ticketColumn - geometry.clusterGap,
        )
    const column = rankColumnWidth(row, byParent, answerWidth, geometry)
    const total = row.length * column + gaps
    let x = geometry.padding + Math.max(0, (inner - total) / 2)
    let rankBottom = y + geometry.ticketHeight
    for (const ticket of row) {
      const answers = byParent.get(ticket.id) ?? []
      placedTickets.push({ ticket, x, y, width: geometry.ticketColumn })
      let answerY = y
      for (const [index, answer] of answers.entries()) {
        const height = answerCardHeight(answer, answerWidth)
        placed.push({
          answer,
          parent: ticket,
          x: x + geometry.ticketColumn + geometry.clusterGap,
          y: answerY,
          width: answerWidth,
          height,
        })
        answerY += height + (index === answers.length - 1 ? 0 : geometry.answerGap)
      }
      rankBottom = Math.max(rankBottom, answers.length === 0 ? y + geometry.ticketHeight : answerY)
      x += column + geometry.columnGap
    }
    y = rankBottom + geometry.rowGap
  }
  if (unlinked.length > 0) {
    const stacked = placeAnswers(
      [{ answers: unlinked }],
      ranked.length === 0 ? startY : y,
      geometry,
      width,
    )
    placed.push(...stacked.placed)
    return { tickets: placedTickets, placed, bottom: stacked.bottom, width }
  }
  return {
    tickets: placedTickets,
    placed,
    bottom: ranked.length === 0 ? startY : y - geometry.rowGap,
    width,
  }
}

/** Ranked cards when the phase has no answers; ranked clusters when a ticket owns decisions. */
function layoutPhaseContent(
  ranked: readonly ShipGraphNode[][],
  groups: readonly { parent?: ShipGraphNode; answers: readonly ShipUserAnswer[] }[],
  geometry: typeof SHIP_FLOW_GEOMETRY,
  width: number = geometry.width,
  graph?: ShipGraph,
): { tickets: PlacedTicket[]; placed: PlacedAnswer[]; bottom: number; width: number } {
  const startY = geometry.ticketY
  if (groups.some(group => group.parent !== undefined)) {
    return layoutClusters(ranked, groups, startY, geometry, width)
  }
  const unlinked = groups.find(group => group.parent === undefined)?.answers ?? []
  if (unlinked.length === 0 && graph !== undefined) {
    return layoutDag(ranked, startY, geometry, width, graph)
  }
  const tickets: PlacedTicket[] = []
  ranked.forEach((row, rank) => {
    row.forEach((ticket, column) => {
      tickets.push({
        ticket,
        x: (width - row.length * geometry.cardWidth - (row.length - 1) * geometry.columnGap) / 2
          + column * (geometry.cardWidth + geometry.columnGap),
        y: startY + rank * (geometry.ticketHeight + geometry.rowGap),
        width: geometry.cardWidth,
      })
    })
  })
  const ticketBottom = ranked.length > 0
    ? startY + ranked.length * geometry.ticketHeight + (ranked.length - 1) * geometry.rowGap
    : startY
  const { placed, bottom } = placeAnswers(
    unlinked.length === 0 ? [] : [{ answers: unlinked }],
    ranked.length > 0 ? ticketBottom + geometry.rowGap : startY,
    geometry,
    width,
  )
  return { tickets, placed, bottom: placed.length > 0 ? bottom : ticketBottom, width }
}

/** Short confirmations cannot identify a translated question by answer alone. */
function distinctiveAnswer(value: string): boolean {
  const text = value.trim().replace(/\s*[(\uff08][^()\uff08\uff09]*[)\uff09]/gu, '').trim()
  return text.length >= 8
    && !/^(?:yes|no|ok(?:ay)?|sure|confirm|confirmed|continue|proceed|skip|cancel|\u662f|\u5426|\u597d\u7684|\u786e\u8ba4|\u7ee7\u7eed|\u8df3\u8fc7|\u53d6\u6d88)(?:[\s.!\u3002\uff01,\uff0c]|$)/iu.test(text)
}

/** Reconcile a ticket's historical copy with one captured human response, without changing the store. */
function reconcileDecisionAnswers(
  linked: readonly ShipUserAnswer[],
  unlinked: readonly ShipUserAnswer[],
): { linked: ShipUserAnswer[]; unlinked: ShipUserAnswer[] } {
  const sameResponse = (a: ShipUserAnswer, b: ShipUserAnswer): boolean =>
    a.phase === b.phase && (a.answer ?? '').trim() === (b.answer ?? '').trim()
  const localCopy = (answer: ShipUserAnswer): boolean =>
    answer.phase === 'wayfinder' && answer.id === answer.ticketId && answer.id.startsWith('decision:local:')
  const matched = new Set<ShipUserAnswer>()
  const reconciled = linked.map(copy => {
    if (copy.ticketId === undefined) return copy
    const responses = unlinked.filter(answer => answer.ticketId === undefined && sameResponse(copy, answer))
    const exact = responses.filter(answer => copy.question === answer.question)
    const candidates = exact.length > 0 ? exact : responses.filter(answer =>
      localCopy(copy) && distinctiveAnswer(answer.answer ?? ''),
    )
    if (candidates.length !== 1) return copy
    const captured = candidates[0]!
    if (matched.has(captured)) return copy
    const copies = linked.filter(answer => sameResponse(answer, captured)
      && (exact.length > 0 ? answer.question === captured.question : localCopy(answer)))
    if (copies.length !== 1) return copy
    matched.add(captured)
    return { ...captured, id: copy.id, ticketId: copy.ticketId }
  })
  return { linked: reconciled, unlinked: unlinked.filter(answer => !matched.has(answer)) }
}

/** Context and answer nodes are view-only, never ticket identities or claims. */
export function flowAnswers(graph: ShipGraph): ShipUserAnswer[] {
  const answers = graph.answers ?? []
  const tickets = new Map(
    graph.nodes.filter(node => node.kind === 'decision').map(node => [node.id, node]),
  )
  const linked: ShipUserAnswer[] = []
  for (const answer of answers) {
    if (answer.ticketId !== undefined && tickets.has(answer.ticketId)) linked.push(answer)
  }
  const unlinked = answers.filter(answer => answer.ticketId === undefined || !tickets.has(answer.ticketId))
  const reconciled = reconcileDecisionAnswers(linked, unlinked)
  const covered = new Set(linked.map(answer => answer.ticketId))
  const synthesized = [...tickets.values()]
    .filter(ticket => ticket.ticketType !== 'research' && !covered.has(ticket.id))
    .map(ticket => ({
      id: `unrecorded:${ticket.id}`,
      phase: 'wayfinder' as const,
      question: ticket.title,
      ticketId: ticket.id,
    }))
  const used = new Set<string>()
  return [...reconciled.linked, ...reconciled.unlinked, ...synthesized].map(answer => {
    let id = answer.id
    let occurrence = 1
    while (used.has(id)) id = `${answer.id}:occurrence:${++occurrence}`
    used.add(id)
    return id === answer.id ? answer : { ...answer, id }
  })
}

/** Phase/step nodes are view-only; graph keys and relation semantics stay unchanged. */
export function webPanoramaLayout(
  graph: ShipGraph,
  collapsed: ReadonlySet<string> = new Set(),
): { nodes: ShipFlowNode[]; edges: Edge[] } {
  const nodes: ShipFlowNode[] = []
  const edges: Edge[] = []
  const parents = new Map<string, string>()
  const geometry = SHIP_FLOW_GEOMETRY
  const activeTickets = new Set<string>()
  const active = SHIP_FLOW_PHASES.findIndex(
    (phase) => phase.id === currentFlowPhase(graph),
  )
  let y = 0
  const context = [
    { id: 'context:requirement', title: 'Original requirement', text: graph.originalRequirement, empty: 'The original requirement has not been recorded yet.' },
    { id: 'context:objective', title: 'Ship goal', text: graph.objective, empty: 'The Ship goal has not been recorded yet.' },
  ]
  const answers = flowAnswers(graph)
  const canvasWidth = Math.max(
    geometry.width,
    ...SHIP_FLOW_PHASES.map((phase) => {
      const tickets = graph.nodes.filter((node) => 'kind' in phase && node.kind === phase.kind)
      const ranks = ticketRanks(tickets, graph)
      const groups = answerGroups(
        answers.filter((answer) => answer.phase === phase.id),
        ranks.flat(),
      )
      if (groups.some((group) => group.parent !== undefined)) {
        return neededClusterWidth(
          wrapRanks(ranks, geometry.maxDagColumns),
          groups,
          geometry,
        )
      }
      return groups.some((group) => group.parent === undefined)
        ? geometry.width
        : neededDagWidth(wrapRanks(ranks, geometry.maxDagColumns), geometry)
    }),
  )
  for (const [index, item] of context.entries()) {
    const height = contentHeight(item.text ?? item.empty)
    nodes.push({
      id: item.id,
      type: 'context',
      position: { x: 0, y },
      ...sized(canvasWidth, height),
      handles: [
        handle('target', Position.Top, canvasWidth, height),
        handle('source', Position.Bottom, canvasWidth, height),
      ],
      data: { title: item.title, phase: 'wayfinder', level: 0, ...(item.text === undefined ? {} : { text: item.text }), empty: item.empty },
    })
    edges.push({
      id: `context:${index}`,
      source: item.id,
      target: index === 0 ? 'context:objective' : 'phase:wayfinder',
      type: 'smoothstep',
      className: 'phase-edge',
      animated: index === 1 && active === 0,
      label: index === 0 ? 'Guides the goal' : 'Guides the workflow',
      markerEnd: { type: 'arrowclosed' },
    })
    y += height + geometry.phaseGap
  }
  SHIP_FLOW_PHASES.forEach((phase, index) => {
    const id = `phase:${phase.id}`
    const tickets = graph.nodes.filter(
      (node) => 'kind' in phase && node.kind === phase.kind,
    )
    const rows = wrapRanks(ticketRanks(tickets, graph), geometry.maxDagColumns)
    const folded = collapsed.has(phase.id)
    const phaseAnswers = answers.filter(answer => answer.phase === phase.id)
    const groups = answerGroups(phaseAnswers, rows.flat())
    const current = index === active && graph.status !== 'shipped'
    const content = layoutPhaseContent(rows, groups, geometry, canvasWidth, graph)
    const empty = content.tickets.length === 0 && content.placed.length === 0
    const height = folded
      ? geometry.collapsedHeight
      : empty
        ? geometry.ticketY
        : content.bottom + geometry.padding
    nodes.push({
      id,
      type: 'phase',
      position: { x: 0, y },
      origin: [0, 0],
      ...sized(canvasWidth, height),
      handles: [
        handle('target', Position.Top, canvasWidth, height),
        handle('source', Position.Bottom, canvasWidth, height),
      ],
      data: {
        title: phase.title,
        phase: phase.id,
        level: index + 1,
        description: phase.description,
        state:
          active < 0
            ? 'unknown'
            : index < active || graph.status === 'shipped'
              ? 'passed'
              : index === active
                ? 'current'
                : 'upcoming',
        active: current,
        collapsed: folded,
        count: tickets.length,
        closed: tickets.filter((ticket) => ticket.claim === 'closed').length,
        empty: tickets.length === 0 ? phase.empty : '',
      },
    })
    if (index > 0)
      edges.push({
        id: `sequence:${index}`,
        source: `phase:${SHIP_FLOW_PHASES[index - 1]!.id}`,
        target: id,
        type: 'smoothstep',
        className: 'phase-edge',
        animated: current,
        label: 'Next phase',
        markerEnd: { type: 'arrowclosed' },
        zIndex: 0,
      })
    phase.steps.forEach((title, step) => {
      const stepId = `${id}:step:${step}`
      nodes.push({
        id: stepId,
        type: 'step',
        parentId: id,
        extent: 'parent',
        hidden: folded,
        position: { x: geometry.padding + step * (geometry.cardWidth + geometry.columnGap), y: geometry.stepY },
        ...sized(geometry.cardWidth, geometry.stepHeight),
        handles: [
          handle('target', Position.Left, geometry.cardWidth, geometry.stepHeight),
          handle('source', Position.Right, geometry.cardWidth, geometry.stepHeight),
        ],
        data: { title, phase: phase.id, level: step + 1 },
      })
      if (step > 0)
        edges.push({
          id: `${stepId}:next`,
          source: `${id}:step:${step - 1}`,
          target: stepId,
          hidden: folded,
          type: 'smoothstep',
          className: 'step-edge',
          animated: current && !folded,
          markerEnd: { type: 'arrowclosed' },
        })
    })
    for (const item of content.tickets) {
      parents.set(item.ticket.id, id)
      const activeTicket = current && ticketFlowState(item.ticket) === 'claimed'
      if (activeTicket) activeTickets.add(item.ticket.id)
      nodes.push({
        id: item.ticket.id,
        type: 'ticket',
        parentId: id,
        extent: 'parent',
        hidden: folded,
        position: { x: item.x, y: item.y },
        ...sized(item.width, geometry.ticketHeight),
        handles: [
          handle('target', Position.Top, item.width, geometry.ticketHeight, 'relation-in'),
          handle('source', Position.Right, item.width, geometry.ticketHeight, 'answer-out'),
          handle('source', Position.Bottom, item.width, geometry.ticketHeight, 'relation-out'),
        ],
        data: {
          title: item.ticket.title,
          phase: phase.id,
          level: index + 1,
          ticket: item.ticket,
          active: activeTicket,
        },
      })
    }
    content.placed.forEach((item, answerIndex) => {
      const answerId = `answer:${item.answer.id}`
      nodes.push({
        id: answerId,
        type: 'answer',
        parentId: id,
        extent: 'parent',
        hidden: folded,
        position: { x: item.x, y: item.y },
        ...sized(item.width, item.height),
        handles: [
          handle('target', Position.Top, item.width, item.height),
          handle('target', Position.Left, item.width, item.height, 'answer-in', geometry.ticketHeight / 2),
          handle('source', Position.Bottom, item.width, item.height),
        ],
        data: { title: item.answer.question, phase: phase.id, level: index + 1, answer: item.answer },
      })
      const parentTicket = item.parent === undefined
        ? undefined
        : nodes.find((node) => node.id === item.parent!.id)
      const above = content.placed.slice(0, answerIndex).findLast(
        (candidate) => candidate.x === item.x && candidate.parent?.id === item.parent?.id,
      )
      const previousUnlinked = item.parent === undefined
        ? content.placed.slice(0, answerIndex).findLast(candidate => candidate.parent === undefined)
        : undefined
      const columnLeaves = item.parent === undefined && previousUnlinked === undefined
        ? content.tickets.map((ticket) => {
          const leaf = content.placed.findLast(candidate => candidate.parent?.id === ticket.ticket.id)
          return leaf === undefined ? ticket.ticket.id : `answer:${leaf.answer.id}`
        })
        : []
      const fromTicket = above === undefined && parentTicket !== undefined
      const sources = fromTicket
        ? [parentTicket.id]
        : above !== undefined
          ? [`answer:${above.answer.id}`]
          : previousUnlinked !== undefined
            ? [`answer:${previousUnlinked.answer.id}`]
            : columnLeaves.length > 0
              ? columnLeaves
              : [`${id}:step:2`]
      for (const [sourceIndex, source] of sources.entries()) {
        const fromParent = fromTicket && source === parentTicket?.id
        const fromBareTicket = content.tickets.some(ticket => ticket.ticket.id === source)
        edges.push({
          id: sources.length === 1 ? `${answerId}:source` : `${answerId}:source:${sourceIndex}`,
          source,
          target: answerId,
          hidden: folded,
          type: fromParent ? 'straight' : 'smoothstep',
          className: 'answer-edge',
          markerEnd: { type: 'arrowclosed' },
          ...(fromParent ? { sourceHandle: 'answer-out', targetHandle: 'answer-in' } : {}),
          ...(fromBareTicket && !fromParent ? { sourceHandle: 'relation-out' } : {}),
        })
      }
    })
    y += height + geometry.phaseGap
  })
  const visible = (id: string): string => {
    const parent = parents.get(id)!
    return collapsed.has(parent.slice('phase:'.length)) ? parent : id
  }
  const relations = new Map<string, PendingRelation>()
  for (const edge of essentialBlockedBy(graph.edges)) {
    if (!parents.has(edge.from) || !parents.has(edge.to)) continue
    // Cache relations point at the prerequisite/anchor; flow arrows point forward.
    const source = visible(edge.to),
      target = visible(edge.from)
    if (source === target) continue
    const id = `relation:${edge.kind}:${source}:${target}`
    const prerequisite = graph.nodes.find(node => node.id === edge.to)!
    const animated = activeTickets.has(edge.from) &&
      (edge.kind === 'hangs-off' || ticketFlowState(prerequisite) === 'closed')
    const existing = relations.get(id)
    if (existing) {
      existing.animated ||= animated
      continue
    }
    // Route cross-phase, reverse, and skipped-rank edges outside. Adjacent
    // tickets in one column keep the arrow in the lane even when answers
    // stretch the cluster.
    const sourceNode = nodes.find(node => node.id === source)!
    const targetNode = nodes.find(node => node.id === target)!
    const samePhase = (node: ShipFlowNode): boolean =>
      node.type === 'ticket' && node.parentId === sourceNode.parentId && node.id !== source && node.id !== target
    const skipped = sourceNode.position.x === targetNode.position.x && nodes.some(node =>
      samePhase(node) &&
      node.position.x === sourceNode.position.x &&
      node.position.y > sourceNode.position.y &&
      node.position.y < targetNode.position.y,
    )
    const crossed = Math.abs(targetNode.position.x - sourceNode.position.x) > 1 && nodes.some(node =>
      samePhase(node) &&
      node.position.y > Math.min(sourceNode.position.y, targetNode.position.y) &&
      node.position.y < Math.max(sourceNode.position.y, targetNode.position.y),
    )
    const outside = parents.get(edge.to) !== parents.get(edge.from) ||
      targetNode.position.y <= sourceNode.position.y ||
      skipped ||
      crossed
    relations.set(id, {
      id, source, target, kind: edge.kind, animated, sourceNode, targetNode, outside,
    })
  }
  const routes = assignRelationRoutes([...relations.values()], canvasWidth, geometry)
  for (const item of relations.values()) {
    const data = routes.get(item.id)
    const relation: Edge = {
      id: item.id,
      source: item.source,
      target: item.target,
      type: 'relation',
      ...(item.source.startsWith('phase:') ? {} : { sourceHandle: 'relation-out' }),
      ...(item.target.startsWith('phase:') ? {} : { targetHandle: 'relation-in' }),
      ...(data === undefined && !item.outside ? {} : {
        data: { ...data, ...(item.outside ? { outside: true } : {}) },
      }),
      ...(item.outside
        ? { label: item.kind === 'blocked-by' ? 'Prerequisite' : 'Track → ticket' }
        : {}),
      className: item.kind,
      animated: item.animated,
      markerEnd: { type: 'arrowclosed' },
      zIndex: 0,
    }
    edges.push(relation)
  }
  return { nodes, edges }
}
