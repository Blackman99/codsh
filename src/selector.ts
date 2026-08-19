/**
 * The arrow-key selection widget: approvals, questions, and any other choice a
 * person makes by moving a marker rather than by typing an answer.
 *
 * Pure state, like the editor: keys in, a verdict and rows out. One widget
 * serves single-select, multi-select, and shortcut keys, because three slightly
 * different pickers is how the same bug ships three times.
 * @module codsh-cli/src/selector
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
}

/** How one selection ended. */
export type SelectOutcome =
  | { kind: 'chosen'; indices: number[] }
  | { kind: 'custom' }
  | { kind: 'cancelled' }

/** What a key did to the selection. */
export type SelectorStep =
  | { kind: 'pending' }
  | { kind: 'done'; outcome: SelectOutcome }

/** An in-progress selection. */
/** Option rows shown at once; the window follows the marked row. */
const VISIBLE_ROWS = 10

export class Selector {
  private selected = 0
  private readonly checked = new Set<number>()

  constructor(private readonly spec: SelectSpec) {}

  /** How many rows the widget offers, the custom row included. */
  private get count(): number {
    return this.spec.options.length + (this.spec.custom === undefined ? 0 : 1)
  }

  /** Whether a row index is the custom "type your own" row. */
  private isCustom(index: number): boolean {
    return this.spec.custom !== undefined && index === this.spec.options.length
  }

  /**
   * Apply one key.
   * @param key - the decoded keystroke.
   * @returns whether the selection settled, and how.
   */
  handle(key: Key): SelectorStep {
    switch (key.kind) {
      case 'up':
        this.selected = (this.selected - 1 + this.count) % this.count
        return { kind: 'pending' }
      case 'down':
      case 'tab':
        this.selected = (this.selected + 1) % this.count
        return { kind: 'pending' }
      case 'enter':
        return this.accept(this.selected)
      case 'escape':
        return { kind: 'done', outcome: { kind: 'cancelled' } }
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
    if (this.spec.multi === true && text === ' ') {
      if (!this.isCustom(this.selected)) {
        if (this.checked.has(this.selected)) this.checked.delete(this.selected)
        else this.checked.add(this.selected)
      }
      return { kind: 'pending' }
    }
    const digit = Number(text)
    if (Number.isInteger(digit) && digit >= 1 && digit <= this.count) {
      // A digit is an answer, not a cursor move: single-select settles on it,
      // multi-select toggles it the way Space does on the marked row.
      if (this.spec.multi === true && !this.isCustom(digit - 1)) {
        this.selected = digit - 1
        if (this.checked.has(digit - 1)) this.checked.delete(digit - 1)
        else this.checked.add(digit - 1)
        return { kind: 'pending' }
      }
      return this.accept(digit - 1)
    }
    const shortcut = this.spec.options.findIndex(option => option.shortcut === text.toLowerCase())
    if (shortcut >= 0) return this.accept(shortcut)
    return { kind: 'pending' }
  }

  /**
   * Settle on a row.
   * @param index - the row accepted.
   * @returns the settled step.
   */
  private accept(index: number): SelectorStep {
    if (this.isCustom(index)) return { kind: 'done', outcome: { kind: 'custom' } }
    if (this.spec.multi === true) {
      // Enter confirms whatever is checked; with nothing checked it means the
      // marked row, so a plain Enter still answers.
      const indices = this.checked.size > 0 ? [...this.checked].sort((a, b) => a - b) : [index]
      return { kind: 'done', outcome: { kind: 'chosen', indices } }
    }
    return { kind: 'done', outcome: { kind: 'chosen', indices: [index] } }
  }

  /**
   * Render the widget.
   * @param theme - styling for the marker, shortcuts, and details.
   * @param columns - display columns available per row.
   * @returns the rows, title first.
   */
  view(theme: Theme, columns: number): string[] {
    const rows: string[] = [theme.bold(truncate(this.spec.title, columns))]
    // The window follows the mark: a long catalog must scroll under the
    // arrows, not hide everything past the first page.
    const total = this.count
    const first = Math.min(Math.max(0, this.selected - VISIBLE_ROWS + 1), Math.max(0, total - VISIBLE_ROWS))
    if (first > 0) rows.push(theme.dim(`  ↑ ${first} more`))
    for (let index = first; index < Math.min(total, first + VISIBLE_ROWS); index += 1) {
      const option = this.spec.options[index]
      if (option !== undefined) {
        rows.push(this.row(index, this.label(option, theme), option.detail, theme, columns))
      } else if (this.spec.custom !== undefined) {
        rows.push(this.row(index, theme.dim(this.spec.custom), undefined, theme, columns))
      }
    }
    const below = total - first - VISIBLE_ROWS
    if (below > 0) rows.push(theme.dim(`  ↓ ${below} more`))
    const how = this.spec.multi === true
      ? 'Space toggles · Enter confirms · Esc cancels'
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
    const marker = marked ? theme.user('❯') : ' '
    const box = this.spec.multi === true && !this.isCustom(index)
      ? (this.checked.has(index) ? theme.success('◉ ') : theme.dim('○ '))
      : ''
    const number = theme.dim(`${index + 1}.`)
    const trail = detail === undefined || detail === '' ? '' : theme.dim(`  ${detail}`)
    // Colour, not merely bold: bold alone barely reads on a dark background.
    const body = marked ? theme.bold(theme.tool(label)) : label
    return truncate(`${marker} ${number} ${box}${body}${trail}`, columns)
  }
}
