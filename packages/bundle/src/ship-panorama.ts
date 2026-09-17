/**
 * Panorama overlay paint: the pinned TTY fullscreen of one Ship graph.
 * Inner ring then outer ring; Claim on the ticket row; Track-N as a suffix.
 * The graph store stays in {@link ./ship-graph.ts}.
 * @module codsh-bundle/src/ship-panorama
 */

import { teaserCounts, type ShipClaim, type ShipGraph, type ShipGraphNode } from './ship-graph.ts'
import { truncate } from './theme.ts'
import { wrapStyled } from './wrap.ts'
import type { Theme } from './theme.ts'
import type { ViewerMove } from './viewer.ts'

/** Claim JSON token → the word painted on a ticket row. */
export const CLAIM_WORD: Readonly<Record<ShipClaim, string>> = {
  unclaimed: '待认领',
  claimed: '已认领',
  closed: '已关闭',
}

/** Body line kept when the inner ring has no decision tickets. */
export const EMPTY_INNER_RING = 'inner ring is empty'

/** One painted overlay frame, matching {@link import('./viewer.ts').ViewerFrame}. */
export interface OverlayFrame {
  rows: string[]
  body: string[]
  offset: number
  maxOffset: number
}

/**
 * Logical overlay rows for one graph at `columns` display columns.
 *
 * Inner (decision) then outer (landing). Track anchors are a landing suffix,
 * never a third ring or a grouping header. Ticket names wrap; they are never
 * ellipsized to keep chrome. `Blocked by: <name>` is always the next row.
 */
export function panoramaOverlayLines(graph: ShipGraph, theme: Theme, columns: number): string[] {
  const width = Math.max(1, columns)
  const inner = graph.nodes.filter(node => node.kind === 'decision')
  const outer = graph.nodes.filter(node => node.kind === 'landing')
  const lines: string[] = []
  if (inner.length === 0) lines.push(theme.dim(EMPTY_INNER_RING))
  else {
    for (const node of inner) lines.push(...ticketRows(node, graph, theme, width))
  }
  for (const node of outer) lines.push(...ticketRows(node, graph, theme, width))
  return lines
}

/** Fullscreen overlay: whole-screen scroll, not an 8-row Queue window. */
export class PanoramaOverlay {
  private offset = 0
  private layout: { columns: number; rows: string[] } | undefined

  constructor(private graph: ShipGraph) {}

  /** Replace the bound graph; keep the scroll offset if it still fits. */
  bind(graph: ShipGraph): void {
    this.graph = graph
    this.layout = undefined
  }

  frame(theme: Theme, columns: number, rows: number, url?: string): OverlayFrame {
    const height = Math.max(1, rows)
    const width = Math.max(1, columns)
    const counts = teaserCounts(this.graph)
    const link = url !== undefined && url !== '' ? ` · ${url}` : ''
    const titleText = `panorama · 待认领 ${String(counts.unclaimed)} · 已认领 ${String(counts.claimed)} · 已关闭 ${String(counts.closed)}${link}`
    if (height === 1) {
      this.offset = 0
      return { rows: [truncate(titleText, width)], body: [], offset: 0, maxOffset: 0 }
    }
    const physical = this.ensureLayout(theme, width)
    const bodyHeight = Math.max(0, height - 2)
    const maxOffset = Math.max(0, physical.length - bodyHeight)
    this.offset = Math.min(maxOffset, Math.max(0, this.offset))
    const visible = physical.slice(this.offset, this.offset + bodyHeight)
    const body = [...visible, ...Array.from({ length: Math.max(0, bodyHeight - visible.length) }, () => '')]
    const first = physical.length === 0 ? 0 : this.offset + 1
    const last = Math.min(physical.length, this.offset + bodyHeight)
    const footer = truncate(
      `Esc teaser · ↑↓/wheel · PgUp/PgDn · Home/End · ${String(first)}-${String(last)}/${String(physical.length)}`,
      width,
    )
    return {
      rows: [theme.bold(truncate(titleText, width)), ...body, theme.dim(footer)],
      body,
      offset: this.offset,
      maxOffset,
    }
  }

  move(move: ViewerMove, theme: Theme, columns: number, rows: number, url?: string): void {
    const frame = this.frame(theme, columns, rows, url)
    const page = Math.max(1, rows - 2)
    if (move.kind === 'home') this.offset = 0
    else if (move.kind === 'end') this.offset = frame.maxOffset
    else if (move.kind === 'page') this.offset += move.direction * page
    else this.offset += move.lines
    this.offset = Math.min(frame.maxOffset, Math.max(0, this.offset))
  }

  private ensureLayout(theme: Theme, columns: number): string[] {
    if (this.layout?.columns === columns) return this.layout.rows
    const rows = panoramaOverlayLines(this.graph, theme, columns)
    this.layout = { columns, rows }
    return rows
  }
}

function ticketRows(node: ShipGraphNode, graph: ShipGraph, theme: Theme, columns: number): string[] {
  const claim = CLAIM_WORD[node.claim ?? 'unclaimed']
  const tracks = node.kind === 'landing' ? trackSuffix(node.id, graph) : ''
  const head = `${claim} ${node.title}${tracks}`
  const rows = wrapStyled(head, columns)
  const blocked = blockedNames(node.id, graph)
  if (blocked.length > 0) {
    rows.push(...wrapStyled(theme.dim(`Blocked by: ${blocked.join(' · ')}`), columns))
  }
  return rows
}

function trackSuffix(id: string, graph: ShipGraph): string {
  const tracks = graph.edges
    .filter(edge => edge.kind === 'hangs-off' && edge.from === id)
    .flatMap((edge) => {
      const match = /^track:(\d+)$/u.exec(edge.to)
      return match === null ? [] : [Number(match[1])]
    })
    .filter(n => Number.isInteger(n) && n > 0)
  const unique = [...new Set(tracks)].sort((a, b) => a - b)
  if (unique.length === 0) return ''
  return ` · ${unique.map(n => `Track-${String(n)}`).join(' ')}`
}

function blockedNames(id: string, graph: ShipGraph): string[] {
  const names: string[] = []
  for (const edge of graph.edges) {
    if (edge.kind !== 'blocked-by' || edge.from !== id) continue
    const title = graph.nodes.find(node => node.id === edge.to)?.title
    if (title !== undefined && title !== '') names.push(title)
  }
  return names
}
