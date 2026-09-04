/**
 * Compact /ship grill frontier card: one interview question above the input.
 *
 * Not a GateModal. The transcript stays visible; Esc dismisses back to typing
 * without aborting /ship.
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
}

/** What one grill card is asking. */
export interface FrontierSpec {
  question: string
  options: readonly FrontierOption[]
}

/**
 * What handleKey did.
 *
 * `move` stays open; the others settle the card.
 */
export type FrontierKey =
  | { kind: 'accept'; value: string }
  | { kind: 'edit' }
  | { kind: 'dismiss' }
  | { kind: 'move' }

/** How Prompt.frontier settled. */
export type FrontierOutcome =
  | { kind: 'accept'; value: string }
  | { kind: 'edit' }
  | { kind: 'dismiss' }

/** One painted frame of the card. */
export interface FrontierFrame {
  rows: string[]
  focus: number
  offset: number
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

  constructor(private readonly spec: FrontierSpec) {
    this.focus = recommendedIndex(spec.options)
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
    const hint = theme.muted('[y] take · [e] edit · [up/down] pick')
    const rows = [top, ...body, framed(truncate(hint, inner), theme, inner), bottom]
    return {
      rows: rows.map(row => truncate(row, width)),
      focus: this.focus,
      offset: this.offset,
    }
  }

  /**
   * Apply one key: y/Enter accept the focused label, e edits, Esc dismisses,
   * arrows move. `n` is not abort — this card has no abort key.
   * @param key - decoded keystroke.
   */
  handleKey(key: Key): FrontierKey | undefined {
    if (key.kind === 'escape') return { kind: 'dismiss' }
    if (key.kind === 'enter') return { kind: 'accept', value: this.focusedLabel }
    if (key.kind === 'text') {
      const letter = key.text.toLowerCase()
      if (letter === 'y') return { kind: 'accept', value: this.focusedLabel }
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

  /**
   * Move focus, wrapping at the ends.
   * @param delta - steps; negative moves up.
   */
  private nudge(delta: number): void {
    const count = this.spec.options.length
    if (count === 0) return
    this.focus = (this.focus + delta % count + count) % count
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
    const label = truncate(option.label, budget)
    const body = focused ? theme.accent(label) : label
    return truncate(`${mark}${body}`, inner)
  }
}
