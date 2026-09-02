/**
 * The arrow-key selection widget: approvals, questions, and any other choice a
 * person makes by moving a marker rather than by typing an answer.
 *
 * Pure state, like the editor: keys in, a verdict and rows out. One widget
 * serves single-select, multi-select, and shortcut keys, because three slightly
 * different pickers is how the same bug ships three times.
 * @module codsh-bundle/src/selector
 */

import { truncate } from './theme.ts'
import type { Key } from './keys.ts'
import type { Theme } from './theme.ts'

/** One choice on offer. */
export interface SelectOption {
  /** What the choice is, shown as its row. */
  label: string
  /** Extra context shown dimly beside the label. */
  detail?: string
  /** Single key that picks this option outright (e.g. `y`). */
  shortcut?: string
}

/** What a selection asks. */
export interface SelectSpec {
  /** The question, shown above the options. */
  title: string
  options: readonly SelectOption[]
  /** Whether several options may be chosen; Space toggles, Enter confirms. */
  multi?: boolean
  /** Label for a trailing "type your own" row; absent offers none. */
  custom?: string
  /** Whether typing filters the list instead of digits/shortcuts settling. */
  filterable?: boolean
}

/** How one selection ended. */
export type SelectOutcome =
  | { kind: 'chosen'; indices: number[] }
  | { kind: 'custom' }
  | { kind: 'cancelled' }

/** What a pointer is over, in the widget's own row space. */
export type SelectorTarget =
  | { kind: 'option'; index: number }
  | { kind: 'custom' }

/** What a key did to the selection. */
export type SelectorStep =
  | { kind: 'pending' }
  | { kind: 'done'; outcome: SelectOutcome }

/** An in-progress selection. */
/** Option rows shown at once; the window follows the marked row. */
const VISIBLE_ROWS = 10

export class Selector {
  private selected = 0
  private query = ''
  private readonly checked = new Set<number>()
  /**
   * The row the pointer rests on, when it rests on one.
   *
   * Kept apart from {@link selected} on purpose: a pointer often comes to rest
   * somewhere nobody chose, and moving the mark would change what Enter does
   * as a side effect of where the mouse happens to be.
   */
  private hovered: number | undefined

  constructor(private readonly spec: SelectSpec) {}

  /** Original option index currently marked, absent for an empty/custom row. */
  get highlighted(): number | undefined {
    if (this.isCustom(this.selected)) return undefined
    return this.matching()[this.selected]
  }

  /** Original option indices currently shown, in order. */
  private matching(): number[] {
    const options = this.spec.options
    if (this.query === '' || this.spec.filterable !== true) {
      return options.map((_, index) => index)
    }
    const needle = this.query.toLowerCase()
    return options.flatMap((option, index) => (
      `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(needle) ? [index] : []
    ))
  }

  /** How many rows the widget offers, the custom row included. */
  private get count(): number {
    return this.matching().length + (this.spec.custom === undefined ? 0 : 1)
  }

  /** Whether a visible row index is the custom "type your own" row. */
  private isCustom(index: number): boolean {
    return this.spec.custom !== undefined && index === this.matching().length
  }

  /**
   * What sits on one row of {@link view}'s output.
   *
   * The arithmetic mirrors the render exactly, and lives beside it for that
   * reason: a title, an optional filter line, an optional "more above" line,
   * then the window of rows, and the two trailing lines the pointer cannot
   * act on.
   * @param row - a row index within this widget's own rows, title at zero.
   * @returns what the row offers, or `undefined` for a row that offers nothing.
   */
  targetAt(row: number): SelectorTarget | undefined {
    let at = 1
    if (this.spec.filterable === true && this.query !== '') at += 1
    const total = this.count
    const first = this.windowStart()
    if (first > 0) at += 1
    const shown = Math.min(total, first + VISIBLE_ROWS) - first
    if (row < at || row >= at + shown) return undefined
    const index = first + (row - at)
    return this.isCustom(index) ? { kind: 'custom' } : { kind: 'option', index }
  }

  /**
   * Mark the row the pointer rests on, or none.
   * @param target - what the pointer is over.
   */
  setHovered(target: SelectorTarget | undefined): void {
    this.hovered = target === undefined
      ? undefined
      : target.kind === 'custom' ? this.matching().length : target.index
  }

  /**
   * Act on a row the pointer chose.
   *
   * A single-select row settles the whole selection, because a click that only
   * moved the mark would be a gesture that needs a second gesture. A
   * multi-select row toggles instead — committing on the first row would make
   * a second choice impossible — which is what Space does on the keyboard. The
   * custom row is neither: it is the way out of the list, and a click takes it.
   * @param target - the row chosen.
   * @returns whether the selection settled, and how.
   */
  click(target: SelectorTarget): SelectorStep {
    if (target.kind === 'custom') return { kind: 'done', outcome: { kind: 'custom' } }
    if (this.spec.multi === true) {
      const original = this.matching()[target.index]
      if (original === undefined) return { kind: 'pending' }
      this.selected = target.index
      if (this.checked.has(original)) this.checked.delete(original)
      else this.checked.add(original)
      return { kind: 'pending' }
    }
    return this.accept(target.index)
  }

  /** First row of the window, which follows the marked row. */
  private windowStart(): number {
    return Math.min(Math.max(0, this.selected - VISIBLE_ROWS + 1), Math.max(0, this.count - VISIBLE_ROWS))
  }

  /**
   * Apply one key.
   * @param key - the decoded keystroke.
   * @returns whether the selection settled, and how.
   */
  handle(key: Key): SelectorStep {
    switch (key.kind) {
      case 'up':
        if (this.count === 0) return { kind: 'pending' }
        this.selected = (this.selected - 1 + this.count) % this.count
        return { kind: 'pending' }
      case 'down':
      case 'tab':
        if (this.count === 0) return { kind: 'pending' }
        this.selected = (this.selected + 1) % this.count
        return { kind: 'pending' }
      case 'enter':
        return this.accept(this.selected)
      case 'escape':
        return { kind: 'done', outcome: { kind: 'cancelled' } }
      case 'backspace':
        if (this.spec.filterable === true && this.query.length > 0) {
          this.query = Array.from(this.query).slice(0, -1).join('')
          this.selected = 0
        }
        return { kind: 'pending' }
      case 'text':
        return this.typed(key.text)
      default:
        return { kind: 'pending' }
    }
  }

  /**
   * Resolve a typed character: a digit jumps, a shortcut picks, Space toggles.
   * @param text - what was typed.
   * @returns whether the selection settled.
   */
  private typed(text: string): SelectorStep {
    if (this.spec.filterable === true) {
      if (this.query === '') {
        const shortcut = this.spec.options.findIndex(option => option.shortcut === text.toLowerCase())
        if (shortcut >= 0) return this.acceptOriginal(shortcut)
      }
      this.query += text
      this.selected = 0
      return { kind: 'pending' }
    }
    if (this.spec.multi === true && text === ' ') {
      if (!this.isCustom(this.selected)) {
        const original = this.matching()[this.selected]
        if (original !== undefined) {
          if (this.checked.has(original)) this.checked.delete(original)
          else this.checked.add(original)
        }
      }
      return { kind: 'pending' }
    }
    const digit = Number(text)
    if (Number.isInteger(digit) && digit >= 1 && digit <= this.count) {
      // A digit is an answer, not a cursor move: single-select settles on it,
      // multi-select toggles it the way Space does on the marked row.
      if (this.spec.multi === true && !this.isCustom(digit - 1)) {
        this.selected = digit - 1
        const original = this.matching()[digit - 1]
        if (original !== undefined) {
          if (this.checked.has(original)) this.checked.delete(original)
          else this.checked.add(original)
        }
        return { kind: 'pending' }
      }
      return this.accept(digit - 1)
    }
    const shortcut = this.spec.options.findIndex(option => option.shortcut === text.toLowerCase())
    if (shortcut >= 0) return this.acceptOriginal(shortcut)
    return { kind: 'pending' }
  }

  /**
   * Settle on a visible row.
   * @param index - the visible row accepted.
   * @returns the settled step.
   */
  private accept(index: number): SelectorStep {
    if (this.isCustom(index)) return { kind: 'done', outcome: { kind: 'custom' } }
    const original = this.matching()[index]
    if (original === undefined) return { kind: 'pending' }
    return this.acceptOriginal(original)
  }

  /**
   * Settle on an original option index.
   * @param original - the option's index in the spec.
   * @returns the settled step.
   */
  private acceptOriginal(original: number): SelectorStep {
    if (this.spec.multi === true) {
      const indices = this.checked.size > 0 ? [...this.checked].sort((a, b) => a - b) : [original]
      return { kind: 'done', outcome: { kind: 'chosen', indices } }
    }
    return { kind: 'done', outcome: { kind: 'chosen', indices: [original] } }
  }

  /**
   * Render the widget.
   * @param theme - styling for the marker, shortcuts, and details.
   * @param columns - display columns available per row.
   * @returns the rows, title first.
   */
  view(theme: Theme, columns: number): string[] {
    const rows: string[] = [theme.bold(truncate(this.spec.title, columns))]
    if (this.spec.filterable === true && this.query !== '') {
      rows.push(theme.dim(truncate(`  filter: ${this.query}`, columns)))
    }
    const shown = this.matching()
    const total = this.count
    const first = this.windowStart()
    if (first > 0) rows.push(theme.dim(`  ↑ ${first} more`))
    for (let index = first; index < Math.min(total, first + VISIBLE_ROWS); index += 1) {
      if (this.isCustom(index)) {
        rows.push(this.row(index, theme.dim(this.spec.custom ?? ''), undefined, theme, columns))
        continue
      }
      const option = this.spec.options[shown[index] ?? -1]
      if (option !== undefined) {
        rows.push(this.row(index, this.label(option, theme), option.detail, theme, columns))
      }
    }
    const below = total - first - VISIBLE_ROWS
    if (below > 0) rows.push(theme.dim(`  ↓ ${below} more`))
    const how = this.spec.multi === true
      ? 'Space toggles · Enter confirms · Esc cancels'
      : this.spec.filterable === true
        ? 'type to filter · ↑↓ move · Enter accepts · Esc cancels'
        : '↑↓ move · Enter accepts · Esc cancels'
    rows.push(theme.dim(truncate(`  ${how}`, columns)))
    return rows
  }

  /**
   * One option's label with its number and shortcut.
   * @param option - the option to label.
   * @param theme - styling for the shortcut.
   * @returns the label text.
   */
  private label(option: SelectOption, theme: Theme): string {
    const shortcut = option.shortcut === undefined ? '' : theme.dim(` (${option.shortcut})`)
    return `${option.label}${shortcut}`
  }

  /**
   * One rendered row.
   * @param index - the row's index.
   * @param label - the row's label, already styled.
   * @param detail - dim context beside it.
   * @param theme - styling for the marker and detail.
   * @param columns - display columns available.
   * @returns the row text.
   */
  private row(index: number, label: string, detail: string | undefined, theme: Theme, columns: number): string {
    const marked = index === this.selected
    // The marker column says what each row is: `❯` is what Enter takes, and a
    // dim dot is only where the pointer rests. One column, two answers that
    // cannot be confused, and no second alphabet.
    const marker = marked ? theme.user('❯') : index === this.hovered ? theme.dim('·') : ' '
    const box = this.spec.multi === true && !this.isCustom(index)
      ? (this.checked.has(this.matching()[index] ?? index) ? theme.success('◉ ') : theme.dim('○ '))
      : ''
    const number = theme.dim(`${index + 1}.`)
    const trail = detail === undefined || detail === '' ? '' : theme.dim(`  ${detail}`)
    // Colour, not merely bold: bold alone barely reads on a dark background.
    const body = marked ? theme.bold(theme.tool(label)) : label
    return truncate(`${marker} ${number} ${box}${body}${trail}`, columns)
  }
}
