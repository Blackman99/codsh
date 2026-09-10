/**
 * Full-screen /ship approval gate: confirm · edit · abort.
 *
 * Shared vocabulary with Selector and FrontierCard: take is confirm (`y` /
 * Enter), edit is `e` focusing an inline field, abort is `n` / Esc — the
 * only surface that paints abort. Enter on the field submits the typed note.
 */

import { displayWidth, truncate } from './theme.ts'
import { wrapStyled } from './wrap.ts'
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
export type GateAction = 'confirm' | { kind: 'edit'; note: string } | 'abort'

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
  /** Terminal cursor on the focused edit field, in this frame's row space. */
  cursor?: { row: number; column: number }
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

/** A bullet or numbered marker with its indent, whose continuation rows hang under the text. */
const BULLET_LEAD = /^(\s*)(?:[✔✓·•\-*]|\d+[.)])(\s+)/u

/**
 * Lay one body line out as the rows it needs at the card's width.
 *
 * A spec summary or a ticket list arrives as long lines — a paragraph, a
 * ticket with what it delivers and what blocks it — and the card used to cut
 * every one at the frame, which left a gate showing a single clipped row of
 * the very text it asked the person to approve. Rows wrap instead, and a
 * bullet's continuation hangs under its text so the list still reads as one.
 * @param line - one raw body line.
 * @param inner - display columns inside the frame.
 * @param theme - palette.
 * @returns the physical rows, at least one.
 */
function layoutBodyLine(line: string, inner: number, theme: Theme): string[] {
  const lead = BULLET_LEAD.exec(line)
  const hang = lead === null ? 0 : Math.min(inner - 1, displayWidth(lead[0]))
  const rows = wrapStyled(styleBodyLine(line, theme), Math.max(1, inner - hang))
  return rows.map((row, index) => (index === 0 || hang === 0 ? row : `${' '.repeat(hang)}${row}`))
}

/** One /ship approval gate rendered into the alternate-buffer viewer slot. */
export class GateModal {
  private offset = 0
  private focus: GateFocus = 'confirm'
  /** Typed revision while the edit field is focused; empty until the person types. */
  private draft = ''
  /** Insertion point inside {@link draft}, in code points. */
  private caret = 0
  /** Whether `e` (or Tab onto edit) opened the inline field. */
  private writing = false

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
    const physical = this.spec.bodyLines.flatMap(line => layoutBodyLine(line, inner, theme))
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
    const cursor = this.writing && this.focus === 'edit'
      ? this.editCursor(inner, out.length)
      : undefined
    return {
      rows: out,
      body,
      offset: this.offset,
      maxOffset,
      focus: this.focus,
      ...cursor === undefined ? {} : { cursor },
    }
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
    this.writing = this.focus === 'edit'
    if (!this.writing) {
      this.draft = ''
      this.caret = 0
    }
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
    if (this.writing && this.focus === 'edit') {
      if (key.kind === 'enter') return this.acceptEdit()
      if (key.kind === 'tab') {
        this.tab(1)
        return undefined
      }
      if (key.kind === 'shift-tab') {
        this.tab(-1)
        return undefined
      }
      if (key.kind === 'left') {
        if (this.caret > 0) this.caret -= 1
        return undefined
      }
      if (key.kind === 'right') {
        const length = Array.from(this.draft).length
        if (this.caret < length) this.caret += 1
        return undefined
      }
      if (key.kind === 'backspace') {
        if (this.caret === 0) return undefined
        const points = Array.from(this.draft)
        points.splice(this.caret - 1, 1)
        this.draft = points.join('')
        this.caret -= 1
        return undefined
      }
      if (key.kind === 'delete') {
        const points = Array.from(this.draft)
        if (this.caret < points.length) {
          points.splice(this.caret, 1)
          this.draft = points.join('')
        }
        return undefined
      }
      if (key.kind === 'text' || key.kind === 'paste') {
        const points = Array.from(this.draft)
        const inserted = Array.from(key.text)
        points.splice(this.caret, 0, ...inserted)
        this.draft = points.join('')
        this.caret += inserted.length
        return undefined
      }
    }
    if (key.kind === 'tab') {
      this.tab(1)
      return undefined
    }
    if (key.kind === 'shift-tab') {
      this.tab(-1)
      return undefined
    }
    if (key.kind === 'enter') {
      if (this.focus === 'edit') {
        this.startEdit()
        return undefined
      }
      return this.focus
    }
    if (key.kind === 'text') {
      const letter = key.text.toLowerCase()
      if (letter === 'y') return 'confirm'
      if (letter === 'e') {
        this.startEdit()
        return undefined
      }
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
      ? theme.accent(this.writing ? this.editField() : '[e] edit')
      : theme.muted('[e] edit')
    const abort = this.focus === 'abort'
      ? `${theme.err('[n]')} ${theme.bold('abort')}`
      : `${theme.err('[n]')} abort`
    return truncate(`${confirm} · ${edit} · ${abort}`, inner)
  }

  /** Open the inline edit field. */
  private startEdit(): void {
    this.focus = 'edit'
    this.writing = true
    this.draft = ''
    this.caret = 0
  }

  /** Submit the typed revision, or stay open until there is one. */
  private acceptEdit(): GateAction | undefined {
    const note = this.draft.trim()
    if (note === '') return undefined
    return { kind: 'edit', note }
  }

  /** The inline field: placeholder caret, or typed text with a caret. */
  private editField(): string {
    const points = Array.from(this.draft)
    if (this.draft === '') return '[e] edit ▌'
    return `[e] ${points.slice(0, this.caret).join('')}▌${points.slice(this.caret).join('')}`
  }

  /**
   * Cursor for the focused edit field, in this frame's row space.
   * @param inner - usable columns inside the frame.
   * @param frameRows - how many rows the painted frame has.
   */
  private editCursor(inner: number, frameRows: number): { row: number; column: number } {
    const prefix = this.draft === '' ? '[e] edit ' : `[e] ${Array.from(this.draft).slice(0, this.caret).join('')}`
    const column = 2 + displayWidth(prefix)
    const recommended = this.spec.recommended === 'confirm'
    const actionRow = frameRows - 2 - (recommended ? 1 : 0)
    return { row: Math.max(0, actionRow), column: Math.min(inner + 1, Math.max(2, column)) }
  }
}
