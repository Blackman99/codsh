/**
 * The input box: a framed, multi-line prompt that wraps long lines, grows with
 * its content, and windows when it grows past its budget — with the completion
 * menu under it.
 *
 * Pure layout. It turns an {@link EditorView} into the rows of the bottom region
 * and says where the terminal cursor belongs, so the drawing code has no opinion
 * about editing and this file has none about terminals.
 *
 * Wrapping is by display width, hard at the boundary: a wrap that respected word
 * breaks would need the same word knowledge in the cursor mapping, and a cursor
 * that disagrees with the wrap by one cell is worse than a word split across
 * rows. Text is never truncated here — hiding typed text is how an input box
 * loses a person's work.
 * @module codsh-cli/src/inputbox
 */

import { displayWidth, truncate } from './theme.ts'
import type { EditorView } from './editor.ts'
import type { Theme } from './theme.ts'

/** How many candidates the menu shows before it says how many it hid. */
const MENU_LIMIT = 8

/** Columns the frame itself occupies: two borders and two pads. */
const FRAME_WIDTH = 4

/** Columns the gutter occupies inside the frame: the marker and its space. */
const GUTTER_WIDTH = 2

/** Content rows shown before the box windows around the cursor. */
const MAX_CONTENT_ROWS = 6

/** What the box is asked to show besides the buffer. */
export interface BoxOptions {
  /** Dim text shown inside an empty box, e.g. what `/` and `@` do. */
  placeholder?: string | undefined
  /** Dim text shown under the box when the menu is closed. */
  hint?: string | undefined
  /** Styles the frame; absent frames dim. A mode announces itself here. */
  accent?: ((text: string) => string) | undefined
}

/** The rows to draw and where the cursor goes among them. */
export interface BoxLayout {
  /** Rows, top to bottom, each already fitted to the terminal. */
  rows: string[]
  /** Index into {@link rows} where the cursor belongs. */
  cursorRow: number
  /** Display column of the cursor on that row, from zero. */
  cursorColumn: number
}

/** One wrapped segment of one logical line. */
interface VisualRow {
  /** The segment's text. */
  text: string
  /** Which logical line it came from. */
  logical: number
  /** The segment's first code point within that line. */
  start: number
  /** Code points in the segment. */
  length: number
  /** Whether this is the line's final segment, which owns the end-of-line cursor. */
  last: boolean
}

/**
 * Wrap one logical line into segments no wider than the budget.
 * @param line - the logical line.
 * @param logical - its index.
 * @param budget - display columns per segment.
 * @returns at least one segment, empty lines included.
 */
function wrapLine(line: string, logical: number, budget: number): VisualRow[] {
  const cells = Array.from(line)
  const rows: VisualRow[] = []
  let start = 0
  let width = 0
  let length = 0
  for (const cell of cells) {
    const cost = displayWidth(cell)
    if (width + cost > budget && length > 0) {
      rows.push({ text: cells.slice(start, start + length).join(''), logical, start, length, last: false })
      start += length
      width = 0
      length = 0
    }
    width += cost
    length += 1
  }
  rows.push({ text: cells.slice(start, start + length).join(''), logical, start, length, last: true })
  return rows
}

/**
 * Lay out the input box.
 * @param view - what the editor is showing.
 * @param theme - styling for the frame, the marker, and the menu.
 * @param columns - display columns available.
 * @param options - placeholder, hint, and frame accent.
 * @returns the rows and cursor position.
 */
export function inputBox(view: EditorView, theme: Theme, columns: number, options: BoxOptions = {}): BoxLayout {
  const accent = options.accent ?? ((text: string) => theme.dim(text))
  const inner = Math.max(8, columns - FRAME_WIDTH)
  const budget = inner - GUTTER_WIDTH
  const rule = '─'.repeat(inner + 2)

  const visual = view.lines.flatMap((line, index) => wrapLine(line, index, budget))
  // The cursor's visual row: the segment holding its column, with the line's
  // end position belonging to the final segment.
  const cursorVisual = visual.findIndex(row =>
    row.logical === view.row
    && view.column >= row.start
    && (view.column < row.start + row.length || (row.last && view.column === row.start + row.length)))
  const cursorAt = Math.max(0, cursorVisual)

  // Window around the cursor once the box outgrows its budget.
  const start = Math.max(0, Math.min(visual.length - MAX_CONTENT_ROWS, cursorAt - (MAX_CONTENT_ROWS - 1)))
  const end = Math.min(visual.length, start + MAX_CONTENT_ROWS)
  const shown = visual.slice(start, end)

  const empty = view.lines.length === 1 && view.lines[0] === ''
  const rows: string[] = [accent(`╭${rule}╮`)]
  if (empty && options.placeholder !== undefined) {
    const text = truncate(options.placeholder, budget)
    const pad = ' '.repeat(Math.max(0, budget - displayWidth(text)))
    rows.push(`${accent('│')} ${theme.user('›')} ${theme.dim(text)}${pad} ${accent('│')}`)
  } else {
    shown.forEach((row, index) => {
      const first = start + index === 0
      const clippedAbove = index === 0 && start > 0
      const clippedBelow = index === shown.length - 1 && end < visual.length
      // The gutter marks the very first row; a clipped edge replaces it so a
      // windowed box says there is more rather than looking complete.
      const gutter = clippedAbove || clippedBelow ? theme.dim('…') : first ? theme.user('›') : ' '
      const pad = ' '.repeat(Math.max(0, budget - displayWidth(row.text)))
      rows.push(`${accent('│')} ${gutter} ${row.text}${pad} ${accent('│')}`)
    })
  }
  rows.push(accent(`╰${rule}╯`))

  if (view.candidates.length > 0) {
    // The window follows the selection: a menu that only ever showed its first
    // page reads as broken the moment the arrows leave it.
    const first = Math.min(
      Math.max(0, view.selected - MENU_LIMIT + 1),
      Math.max(0, view.candidates.length - MENU_LIMIT),
    )
    const menu = view.candidates.slice(first, first + MENU_LIMIT)
    const width = Math.max(...menu.map(candidate => displayWidth(candidate.value)))
    if (first > 0) rows.push(theme.dim(`  ↑ ${first} more`))
    menu.forEach((candidate, index) => {
      const chosen = first + index === view.selected
      // The selected row is a colour, not merely bold: bold alone is nearly
      // invisible against a dark background. The typed fragment keeps the
      // accent on every row, so the menu reads as "your fragment, completed".
      const matched = view.token !== '' && candidate.value.startsWith(view.token) ? view.token.length : 0
      const head = candidate.value.slice(0, matched)
      const tail = candidate.value.slice(matched)
      const label = chosen
        ? theme.bold(theme.tool(candidate.value))
        : `${theme.tool(head)}${tail}`
      const pad = ' '.repeat(Math.max(0, width - displayWidth(candidate.value)))
      const detail = candidate.detail === '' ? '' : `  ${candidate.detail}`
      rows.push(truncate(`${chosen ? theme.user('❯') : ' '} ${label}${pad}${theme.dim(detail)}`, columns))
    })
    const below = view.candidates.length - first - menu.length
    if (below > 0) rows.push(theme.dim(`  ↓ ${below} more`))
  } else if (options.hint !== undefined) {
    rows.push(theme.dim(truncate(options.hint, columns)))
  }

  const inCursorRow = visual[cursorAt]
  const before = inCursorRow === undefined
    ? ''
    : Array.from(view.lines[view.row] ?? '').slice(inCursorRow.start, view.column).join('')
  return {
    rows,
    // Row 0 is the frame's top; the cursor's visual row sits below it, less the
    // rows the window clipped.
    cursorRow: 1 + (cursorAt - start),
    cursorColumn: FRAME_WIDTH + Math.min(displayWidth(before), budget),
  }
}
