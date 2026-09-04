/**
 * Full-screen /ship approval gate: confirm · edit · abort.
 *
 * Shared vocabulary with Selector and FrontierCard: take is confirm (`y` /
 * Enter), edit is `e`, abort is `n` / Esc — the only surface that paints abort.
 */

import { displayWidth, truncate } from './theme.ts'
import type { Key } from './keys.ts'
import type { Theme } from './theme.ts'

/** Which /ship gate the card is deciding. */
export type GateKind = 'spec' | 'tickets'

/** What one gate card is deciding. */
export interface GateModalSpec {
  kind: GateKind
  title: string
  bodyLines: string[]
  recommended?: 'confirm'
}

/** How the person closed the gate. */
export type GateAction = 'confirm' | 'edit' | 'abort'

/** Which footer action holds keyboard focus. */
export type GateFocus = 'confirm' | 'edit' | 'abort'

/** Body scroll request. */
export type GateMove =
  | { kind: 'line'; lines: number }
  | { kind: 'page'; direction: -1 | 1 }
  | { kind: 'home' }
  | { kind: 'end' }

/** One painted frame of the gate. */
export interface GateFrame {
  rows: string[]
  body: string[]
  offset: number
  maxOffset: number
  focus: GateFocus
}

const FOCUS_ORDER: GateFocus[] = ['confirm', 'edit', 'abort']

/** Gate number for the MetaBar chip: spec → 1, tickets → 2. */
export function gateChip(kind: GateKind): 1 | 2 {
  return kind === 'spec' ? 1 : 2
}

/** @deprecated prefer gateChip */
export const gateNumber = gateChip

/**
 * Default title painted on the gate frame.
 * @param kind - which gate.
 */
export function gateTitle(kind: GateKind): string {
  return kind === 'spec'
    ? 'ship · gate 1/2 — confirm spec'
    : 'ship · gate 2/2 — approve tickets'
}

/**
 * Style the title so the `gate N/2` chip warns and the rest stays muted.
 * @param title - the full title string.
 * @param theme - palette.
 */
function styleTitle(title: string, theme: Theme): string {
  const match = /^(.*?)(gate\s*[12]\s*\/\s*2)(.*)$/iu.exec(title)
  if (match === null) return theme.muted(title)
  return `${theme.muted(match[1] ?? '')}${theme.warn(match[2] ?? '')}${theme.muted(match[3] ?? '')}`
}

/**
 * Paint one body line: muted bullet markers, bold for a bare section title.
 * @param line - raw body line.
 * @param theme - palette.
 */
function styleBodyLine(line: string, theme: Theme): string {
  const bullet = /^(\s*)([✔✓·•\-*]|\d+[.)])(\s+)(.*)$/u.exec(line)
  if (bullet !== null) {
    return `${bullet[1] ?? ''}${theme.muted(bullet[2] ?? '')}${bullet[3] ?? ''}${bullet[4] ?? ''}`
  }
  if (line.trim() !== '' && !/^\s/.test(line)) return theme.bold(line)
  return line
}

/** Strip SGR so padding uses display width. */
function plainWidth(text: string): number {
  return displayWidth(text.replace(/\u001B\[[0-9;]*m/gu, ''))
}

/** One /ship approval gate rendered into the alternate-buffer viewer slot. */
export class GateModal {
  private offset = 0
  private focus: GateFocus = 'confirm'

  constructor(private readonly spec: GateModalSpec) {}

  /** Which footer action is focused. */
  get focused(): GateFocus {
    return this.focus
  }

  /**
   * Paint the full-screen card into `rows` lines.
   * @param theme - palette.
   * @param columns - terminal content columns.
   * @param rows - terminal rows.
   */
  frame(theme: Theme, columns: number, rows: number): GateFrame {
    const height = Math.max(1, rows)
    const width = Math.max(1, columns)
    const recommended = this.spec.recommended === 'confirm'
    // top · body… · sep · actions · [recommended] · bottom
    const chrome = 4 + (recommended ? 1 : 0)
    if (height <= chrome) {
      this.offset = 0
      return {
        rows: [truncate(this.spec.title, width)],
        body: [],
        offset: 0,
        maxOffset: 0,
        focus: this.focus,
      }
    }
    const inner = Math.max(1, width - 4)
    const bodyHeight = height - chrome
    const physical = this.spec.bodyLines.map(line => truncate(styleBodyLine(line, theme), inner))
    const maxOffset = Math.max(0, physical.length - bodyHeight)
    this.offset = Math.min(maxOffset, Math.max(0, this.offset))
    const visible = physical.slice(this.offset, this.offset + bodyHeight)
    const body = [
      ...visible,
      ...Array.from({ length: Math.max(0, bodyHeight - visible.length) }, () => ''),
    ]
    const rule = '─'.repeat(Math.max(0, width - 2))
    const titlePlain = truncate(this.spec.title, Math.max(1, width - 4))
    const title = styleTitle(titlePlain, theme)
    const titlePad = Math.max(0, Math.max(1, width - 4) - displayWidth(titlePlain))
    const top = `${theme.muted('┌')} ${title}${' '.repeat(titlePad)} ${theme.muted('┐')}`
    const mid = theme.muted(`├${rule}┤`)
    const bottom = theme.muted(`└${rule}┘`)
    const bodyRows = body.map((line) => {
      const pad = Math.max(0, inner - plainWidth(line))
      return `${theme.muted('│')} ${line}${' '.repeat(pad)} ${theme.muted('│')}`
    })
    const actions = this.actionRow(theme, inner)
    const actionPad = Math.max(0, inner - plainWidth(actions))
    const actionLine = `${theme.muted('│')} ${actions}${' '.repeat(actionPad)} ${theme.muted('│')}`
    const out: string[] = [top, ...bodyRows, mid, actionLine]
    if (recommended) {
      const hint = theme.muted('recommended: confirm')
      const hintPad = Math.max(0, inner - displayWidth('recommended: confirm'))
      out.push(`${theme.muted('│')} ${hint}${' '.repeat(hintPad)} ${theme.muted('│')}`)
    }
    out.push(bottom)
    return { rows: out, body, offset: this.offset, maxOffset, focus: this.focus }
  }

  /**
   * Scroll the body only.
   * @param move - scroll request.
   * @param theme - palette (for measuring the frame).
   * @param columns - terminal content columns.
   * @param rows - terminal rows.
   */
  move(move: GateMove, theme: Theme, columns: number, rows: number): void {
    const frame = this.frame(theme, columns, rows)
    const recommended = this.spec.recommended === 'confirm'
    const chrome = 4 + (recommended ? 1 : 0)
    const page = Math.max(1, rows - chrome)
    if (move.kind === 'home') this.offset = 0
    else if (move.kind === 'end') this.offset = frame.maxOffset
    else if (move.kind === 'page') this.offset += move.direction * page
    else this.offset += move.lines
    this.offset = Math.min(frame.maxOffset, Math.max(0, this.offset))
  }

  /**
   * Cycle footer focus y → e → n.
   * @param direction - 1 forward (Tab), -1 backward (Shift-Tab).
   */
  tab(direction: 1 | -1 = 1): void {
    const at = FOCUS_ORDER.indexOf(this.focus)
    const next = (at + direction + FOCUS_ORDER.length) % FOCUS_ORDER.length
    this.focus = FOCUS_ORDER[next] ?? 'confirm'
  }

  /**
   * Apply one key: actions settle, Tab cycles, arrows scroll.
   * @param key - decoded keystroke.
   * @param theme - palette.
   * @param columns - terminal content columns.
   * @param rows - terminal rows.
   * @returns the settled action, or undefined when the key was consumed without closing.
   */
  handleKey(key: Key, theme: Theme, columns: number, rows: number): GateAction | undefined {
    if (key.kind === 'escape') return 'abort'
    if (key.kind === 'tab') {
      this.tab(1)
      return undefined
    }
    if (key.kind === 'shift-tab') {
      this.tab(-1)
      return undefined
    }
    if (key.kind === 'enter') return this.focus
    if (key.kind === 'text') {
      const letter = key.text.toLowerCase()
      if (letter === 'y') return 'confirm'
      if (letter === 'e') return 'edit'
      if (letter === 'n') return 'abort'
      return undefined
    }
    if (key.kind === 'scroll') this.move({ kind: 'line', lines: key.lines }, theme, columns, rows)
    else if (key.kind === 'turn') this.move({ kind: 'line', lines: key.direction }, theme, columns, rows)
    else if (key.kind === 'up') this.move({ kind: 'line', lines: -1 }, theme, columns, rows)
    else if (key.kind === 'down') this.move({ kind: 'line', lines: 1 }, theme, columns, rows)
    else if (key.kind === 'page') this.move({ kind: 'page', direction: key.direction }, theme, columns, rows)
    else if (key.kind === 'home') this.move({ kind: 'home' }, theme, columns, rows)
    else if (key.kind === 'end' || key.kind === 'scroll-end') this.move({ kind: 'end' }, theme, columns, rows)
    return undefined
  }

  /**
   * Footer action row with focus emphasis.
   * @param theme - palette.
   * @param inner - usable columns inside the frame.
   */
  private actionRow(theme: Theme, inner: number): string {
    const confirm = this.focus === 'confirm'
      ? `${theme.ok('[y]')} ${theme.bold('confirm')}`
      : `${theme.ok('[y]')} confirm`
    const edit = this.focus === 'edit'
      ? theme.accent('[e] edit')
      : theme.muted('[e] edit')
    const abort = this.focus === 'abort'
      ? `${theme.err('[n]')} ${theme.bold('abort')}`
      : `${theme.err('[n]')} abort`
    return truncate(`${confirm}   ${edit}   ${abort}`, inner)
  }
}
