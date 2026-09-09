/**
 * Compact /ship grill frontier card: one interview question above the input.
 *
 * Not a GateModal. The transcript stays visible; Esc dismisses back to typing
 * without aborting /ship. Left/right revisit consecutive questions in the
 * same batch. A write-in option is an inline field when focused.
 * @module codsh-bundle/src/frontier-card
 */

import { displayWidth, truncate } from './theme.ts'
import { wrapStyled } from './wrap.ts'
import type { Key } from './keys.ts'
import type { Theme } from './theme.ts'

/** One choice on a frontier question. */
export interface FrontierOption {
  label: string
  detail?: string
  recommended?: boolean
  /** When true, focusing this row is an inline field — type and Enter, no extra select. */
  writeIn?: boolean
}

/** What one grill card is asking. */
export interface FrontierSpec {
  question: string
  options: readonly FrontierOption[]
  /** Left goes to the previous consecutive question in this batch. */
  canBack?: boolean
  /** Right goes to the next already-answered question in this batch. */
  canForward?: boolean
  /** A previous answer to restore when revisiting this question. */
  prior?: { selected?: string; custom?: string }
}

/**
 * What handleKey did.
 *
 * `move` stays open; the others settle the card.
 */
export type FrontierKey =
  | { kind: 'accept'; value: string; custom?: true }
  | { kind: 'edit' }
  | { kind: 'dismiss' }
  | { kind: 'back' }
  | { kind: 'next' }
  | { kind: 'move' }

/** How Prompt.frontier settled. */
export type FrontierOutcome =
  | { kind: 'accept'; value: string; custom?: true }
  | { kind: 'edit' }
  | { kind: 'dismiss' }
  | { kind: 'back' }
  | { kind: 'next' }

/** One painted frame of the card. */
export interface FrontierFrame {
  rows: string[]
  focus: number
  offset: number
  /** Terminal cursor on a focused write-in field, in this frame's row space. */
  cursor?: { row: number; column: number }
}

/** Chrome rows that are never options: top, footer, bottom. */
const CHROME = 3

/** Question lines shown; a longer question truncates. */
const QUESTION_LINES = 2

/** Whole card stays short so the transcript is not pushed off. */
const MAX_ROWS = 8

/** Columns taken by `[rec] ` so unrecommended labels share the same gutter. */
const REC_GUTTER = 6

/**
 * Index of the recommended option: the first marked one, else the first option.
 * @param options - the choices.
 */
export function recommendedIndex(options: readonly FrontierOption[]): number {
  const marked = options.findIndex(option => option.recommended === true)
  return marked >= 0 ? marked : 0
}

/** Strip SGR so padding uses display width. */
function plainWidth(text: string): number {
  return displayWidth(text.replace(/\u001B\[[0-9;]*m/gu, ''))
}

/**
 * Paint one inner line inside a muted frame, padded to `inner`.
 * @param content - already truncated to `inner`.
 * @param theme - palette.
 * @param inner - columns between the borders.
 */
function framed(content: string, theme: Theme, inner: number): string {
  const pad = Math.max(0, inner - plainWidth(content))
  return `${theme.muted('│')} ${content}${' '.repeat(pad)} ${theme.muted('│')}`
}

/**
 * Question rows: at most two lines, leftover truncated on the last.
 * @param question - the interview question.
 * @param inner - columns inside the frame.
 */
function questionRows(question: string, inner: number): string[] {
  const width = Math.max(1, inner)
  const wrapped = wrapStyled(question, width)
  if (wrapped.length <= QUESTION_LINES) return wrapped.length === 0 ? [''] : wrapped
  const head = wrapped.slice(0, QUESTION_LINES - 1)
  const rest = wrapped.slice(QUESTION_LINES - 1).join(' ')
  return [...head, truncate(rest, width)]
}

/** Compact grill interview card painted above the input box. */
export class FrontierCard {
  private focus: number
  private offset = 0
  /** Typed text for the focused write-in option; empty until the person types. */
  private draft = ''

  constructor(private readonly spec: FrontierSpec) {
    this.focus = recommendedIndex(spec.options)
    const prior = spec.prior
    if (prior?.custom !== undefined && prior.custom !== '') {
      const write = spec.options.findIndex(option => option.writeIn === true)
      if (write >= 0) {
        this.focus = write
        this.draft = prior.custom
      }
    } else if (prior?.selected !== undefined) {
      const index = spec.options.findIndex(option => option.label === prior.selected)
      if (index >= 0) this.focus = index
    }
  }

  /** Option index that holds keyboard focus. */
  get focused(): number {
    return this.focus
  }

  /** Label of the focused option, or empty when there are none. */
  get focusedLabel(): string {
    return this.spec.options[this.focus]?.label ?? ''
  }

  /**
   * Paint the card into at most {@link MAX_ROWS} lines.
   * @param theme - palette.
   * @param columns - terminal content columns.
   */
  frame(theme: Theme, columns: number): FrontierFrame {
    const width = Math.max(1, columns)
    const question = this.spec.question
    if (width < 8) {
      return {
        rows: [truncate(question, width)],
        focus: this.focus,
        offset: 0,
      }
    }
    const inner = Math.max(1, width - 4)
    const asked = questionRows(question, inner)
    const optionBudget = Math.max(1, MAX_ROWS - CHROME - asked.length)
    const total = this.spec.options.length
    const visible = Math.max(1, Math.min(total, optionBudget))
    const maxOffset = Math.max(0, total - visible)
    if (this.focus < this.offset) this.offset = this.focus
    if (this.focus >= this.offset + visible) this.offset = this.focus - visible + 1
    this.offset = Math.min(maxOffset, Math.max(0, this.offset))
    const rule = '─'.repeat(Math.max(0, width - 2))
    const top = theme.muted(`┌${rule}┐`)
    const bottom = theme.muted(`└${rule}┘`)
    // Question stays default colour — the frame is the muted chrome.
    const body: string[] = asked.map(line => framed(line, theme, inner))
    for (let index = this.offset; index < this.offset + visible; index += 1) {
      const option = this.spec.options[index]
      if (option === undefined) continue
      body.push(framed(this.optionRow(option, index === this.focus, theme, inner), theme, inner))
    }
    // Shared vocabulary: take / edit; Esc is back (dismiss), never abort.
    // y is ok (green); arrows are accent (cyan). Left revisits the previous
    // consecutive question. No n.
    const writing = this.writing()
    const nav = [
      ...this.spec.canBack === true ? [`${theme.accent('[←]')} back`] : [],
      ...this.spec.canForward === true ? [`${theme.accent('[→]')} next`] : [],
    ]
    const hint = writing
      ? [`${theme.ok('[enter]')} take`, `${theme.accent('[↑↓]')} pick`, ...nav].join(' · ')
      : [`${theme.ok('[y]')} take`, '[e] edit', `${theme.accent('[↑↓]')} pick`, ...nav].join(' · ')
    const rows = [top, ...body, framed(truncate(hint, inner), theme, inner), bottom]
    const focusedRow = asked.length + (this.focus - this.offset)
    const typed = this.draft === '' ? `${this.focusedLabel} ` : this.draft
    const caretColumn = 2 + REC_GUTTER + displayWidth(typed)
    return {
      rows: rows.map(row => truncate(row, width)),
      focus: this.focus,
      offset: this.offset,
      ...writing && focusedRow >= 0 && focusedRow < body.length
        ? { cursor: { row: 1 + focusedRow, column: Math.min(width - 2, Math.max(2, caretColumn)) } }
        : {},
    }
  }

  /**
   * Apply one key: y/Enter accept the focused label, e edits, Esc dismisses,
   * arrows move. `n` is not abort — this card has no abort key.
   * @param key - decoded keystroke.
   */
  handleKey(key: Key): FrontierKey | undefined {
    if (key.kind === 'escape') return { kind: 'dismiss' }
    if (key.kind === 'left' && this.spec.canBack === true) return { kind: 'back' }
    if (key.kind === 'right' && this.spec.canForward === true) return { kind: 'next' }
    if (key.kind === 'enter') return this.acceptFocused()
    if (this.writing()) {
      if (key.kind === 'backspace') {
        this.draft = Array.from(this.draft).slice(0, -1).join('')
        return { kind: 'move' }
      }
      if (key.kind === 'text') {
        this.draft += key.text
        return { kind: 'move' }
      }
      if (key.kind === 'paste') {
        this.draft += key.text
        return { kind: 'move' }
      }
    }
    if (key.kind === 'text') {
      const letter = key.text.toLowerCase()
      if (letter === 'y') return this.acceptFocused()
      if (letter === 'e') return { kind: 'edit' }
      return undefined
    }
    if (key.kind === 'up') {
      this.nudge(-1)
      return { kind: 'move' }
    }
    if (key.kind === 'down' || key.kind === 'tab') {
      this.nudge(1)
      return { kind: 'move' }
    }
    if (key.kind === 'shift-tab') {
      this.nudge(-1)
      return { kind: 'move' }
    }
    if (key.kind === 'scroll') {
      this.nudge(key.lines > 0 ? 1 : -1)
      return { kind: 'move' }
    }
    return undefined
  }

  /** Whether the focused option is a write-in field. */
  private writing(): boolean {
    return this.spec.options[this.focus]?.writeIn === true
  }

  /** Accept the focused option, or the typed write-in text. */
  private acceptFocused(): FrontierKey {
    if (this.writing()) {
      const value = this.draft.trim()
      if (value === '') return { kind: 'move' }
      return { kind: 'accept', value, custom: true }
    }
    return { kind: 'accept', value: this.focusedLabel }
  }

  /**
   * Move focus, wrapping at the ends.
   * @param delta - steps; negative moves up.
   */
  private nudge(delta: number): void {
    const count = this.spec.options.length
    if (count === 0) return
    this.focus = (this.focus + delta % count + count) % count
    this.draft = ''
  }

  /**
   * One option line: recommended marked `[rec]` in ok, focus in accent.
   * @param option - the choice.
   * @param focused - whether this row holds the keyboard.
   * @param theme - palette.
   * @param inner - columns inside the frame.
   */
  private optionRow(option: FrontierOption, focused: boolean, theme: Theme, inner: number): string {
    const rec = option.recommended === true
    const mark = rec ? `${theme.ok('[rec]')} ` : ' '.repeat(REC_GUTTER)
    const budget = Math.max(1, inner - REC_GUTTER)
    if (option.writeIn === true && focused) {
      const shown = this.draft === '' ? `${option.label} ▌` : `${this.draft}▌`
      return truncate(`${mark}${theme.accent(truncate(shown, budget))}`, inner)
    }
    const label = truncate(option.label, budget)
    const body = focused ? theme.accent(label) : label
    return truncate(`${mark}${body}`, inner)
  }
}
