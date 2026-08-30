/** Pure layout and navigation for the transient fullscreen content reader. */

import { highlightCode, renderMarkdownRows } from './markdown.ts'
import { truncate } from './theme.ts'
import { wrapStyled } from './wrap.ts'
import type { Theme } from './theme.ts'

export interface ViewerSpec {
  title: string
  kind: 'answer' | 'code'
  text: string
}

export type ViewerMove =
  | { kind: 'line'; lines: number }
  | { kind: 'page'; direction: -1 | 1 }
  | { kind: 'home' }
  | { kind: 'end' }

export interface ViewerFrame {
  rows: string[]
  body: string[]
  offset: number
  maxOffset: number
}

/** One response target rendered and navigated without touching transcript state. */
export class FullscreenViewer {
  private offset = 0
  private layout: { columns: number; rows: { text: string; source: number; within: number }[] } | undefined

  constructor(private readonly spec: ViewerSpec) {}

  private physical(theme: Theme, columns: number): { text: string; source: number; within: number }[] {
    const width = Math.max(1, columns)
    const logical = this.spec.kind === 'answer'
      ? renderMarkdownRows(this.spec.text, theme, width)
      : this.spec.text.split(/\r\n|[\r\n]/u).map((line, source) => ({ text: highlightCode(line, theme.syntax), source }))
    const counts = new Map<number, number>()
    return logical.flatMap((line) => wrapStyled(line.text, width).map((text) => {
      const within = counts.get(line.source) ?? 0
      counts.set(line.source, within + 1)
      return { text, source: line.source, within }
    }))
  }

  private ensureLayout(theme: Theme, columns: number): { columns: number; rows: { text: string; source: number; within: number }[] } {
    const width = Math.max(1, columns)
    if (this.layout?.columns === width) return this.layout
    const previous = this.layout?.rows[this.offset]
    const physical = this.physical(theme, width)
    if (previous !== undefined) {
      const candidates = physical.flatMap((row, index) => row.source === previous.source ? [{ row, index }] : [])
      const anchored = candidates[Math.min(previous.within, Math.max(0, candidates.length - 1))]
      if (anchored !== undefined) this.offset = anchored.index
    }
    this.layout = { columns: width, rows: physical }
    return this.layout
  }

  frame(theme: Theme, columns: number, rows: number): ViewerFrame {
    const height = Math.max(1, rows)
    const width = Math.max(1, columns)
    if (height === 1) {
      this.offset = 0
      return { rows: [truncate(this.spec.title, width)], body: [], offset: 0, maxOffset: 0 }
    }
    const physical = this.ensureLayout(theme, width).rows
    const bodyHeight = Math.max(0, height - 2)
    const maxOffset = Math.max(0, physical.length - bodyHeight)
    this.offset = Math.min(maxOffset, Math.max(0, this.offset))
    const visible = physical.slice(this.offset, this.offset + bodyHeight).map(row => row.text)
    const body = [...visible, ...Array.from({ length: Math.max(0, bodyHeight - visible.length) }, () => '')]
    const first = physical.length === 0 ? 0 : this.offset + 1
    const last = Math.min(physical.length, this.offset + bodyHeight)
    const footer = truncate(`↑↓/wheel · PgUp/PgDn · Home/End · Esc closes · ${first}-${last}/${physical.length}`, width)
    return {
      rows: [theme.bold(truncate(this.spec.title, width)), ...body, theme.dim(footer)],
      body,
      offset: this.offset,
      maxOffset,
    }
  }

  move(move: ViewerMove, theme: Theme, columns: number, rows: number): void {
    const frame = this.frame(theme, columns, rows)
    const page = Math.max(1, rows - 2)
    if (move.kind === 'home') this.offset = 0
    else if (move.kind === 'end') this.offset = frame.maxOffset
    else if (move.kind === 'page') this.offset += move.direction * page
    else this.offset += move.lines
    this.offset = Math.min(frame.maxOffset, Math.max(0, this.offset))
  }
}
