/**
 * The input box: a framed, multi-line prompt that wraps long lines, grows with
 * its content, and windows when it grows past its budget — with the completion
 * menu overlaid on the transcript above it.
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
 * @module codsh-bundle/src/inputbox
 */

import { displayWidth, truncate } from './theme.ts'
import type { EditorView, GestureHit } from './editor.ts'
import type { Theme } from './theme.ts'

/** Start reverse video, which is how a buffer selection shows itself. */
const INVERSE = '\u001B[7m'

/** End reverse video only, leaving any other attributes alone. */
const INVERSE_OFF = '\u001B[27m'

/** How many candidates the menu shows before it says how many it hid. */
const MENU_LIMIT = 8

/** Columns the frame itself occupies: two borders and two pads. */
const FRAME_WIDTH = 4

/** Columns the gutter occupies inside the frame: the marker and its space. */
const GUTTER_WIDTH = 2

/** Content rows shown before the box windows around the cursor. */
const MAX_CONTENT_ROWS = 6

/** Underline on, used only for the typed fragment inside a menu label. */
const UNDERLINE_ON = '\u001B[4m'

/** Underline off, without resetting other attributes. */
const UNDERLINE_OFF = '\u001B[24m'

/** What the box is asked to show besides the buffer. */
export interface BoxOptions {
  /** Dim text shown inside an empty box, e.g. what `/` and `@` do. */
  placeholder?: string | undefined
  /** Dim text shown under the box when the menu is closed. */
  hint?: string | undefined
  /** Styles the frame; absent frames dim. A mode announces itself here. */
  accent?: ((text: string) => string) | undefined
  /**
   * Whether the box is in shell mode (`!` at the start of the first line).
   *
   * The frame and gutter announce it; the leading `!` is the gutter, not a
   * second character in the buffer.
   */
  shell?: boolean | undefined
  /** The menu row a pointer rests on, underlined rather than marked. */
  hoveredCandidate?: number | undefined
}

/** The rows to draw and where the cursor goes among them. */
export interface BoxLayout {
  /** Rows, top to bottom, each already fitted to the terminal. */
  rows: string[]
  /**
   * Completion menu, painted over the transcript just above the box so
   * opening it cannot grow the chrome or shake the output.
   */
  overlay: string[]
  /** Index into {@link rows} where the cursor belongs. */
  cursorRow: number
  /** Display column of the cursor on that row, from zero. */
  cursorColumn: number
}

/** One wrapped segment of one logical line. */
export interface VisualRow {
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
export function wrapLine(line: string, logical: number, budget: number): VisualRow[] {
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
 * Display columns one row of the buffer wraps at.
 *
 * Movement has to wrap at the same width the box draws at, or the row a
 * person sees themselves on is not the row the cursor moves from.
 * @param columns - display columns available to the whole box.
 * @returns columns available to the text inside it.
 */
export function wrapBudget(columns: number): number {
  return Math.max(8, columns - FRAME_WIDTH) - GUTTER_WIDTH
}

/**
 * Step the cursor one visual row, across a wrap or a line end.
 *
 * The buffer's rows and the box's rows are not the same thing: one long line
 * occupies several rows on screen, and an arrow that moved by logical line
 * would jump the whole wrapped line at once — which is how Up from the second
 * row of a wrapped line reached the history instead of the row above it.
 * @param lines - the buffer's logical lines.
 * @param row - the cursor's logical line.
 * @param column - the cursor's code-point column within that line.
 * @param delta - -1 for the row above, 1 for the row below.
 * @param budget - display columns each row wraps at.
 * @returns where the cursor lands, or `undefined` when there is no such row —
 *   which is the edge where history takes over.
 */
export function visualStep(
  lines: readonly string[],
  row: number,
  column: number,
  delta: -1 | 1,
  budget: number,
): { row: number; column: number } | undefined {
  const visual = lines.flatMap((line, index) => wrapLine(line, index, budget))
  const at = visual.findIndex(candidate => candidate.logical === row
    && column >= candidate.start
    && (column < candidate.start + candidate.length || (candidate.last && column === candidate.start + candidate.length)))
  if (at < 0) return undefined
  const target = visual[at + delta]
  const current = visual[at]
  if (target === undefined || current === undefined) return undefined
  // The column is kept as an offset into the row, so moving between rows of
  // different lengths lands where the eye expects and never past the end.
  const offset = Math.min(column - current.start, target.length)
  return { row: target.logical, column: target.start + offset }
}

/**
 * Paint a menu label so the typed fragment and the selection never share a
 * colour: the contained span is underlined, the selected name stays full
 * intensity, and the rest recedes.
 */
function paintMenuLabel(value: string, token: string, chosen: boolean, theme: Theme): string {
  const rest = (text: string): string => (chosen ? text : theme.dim(text))
  const match = (text: string): string =>
    theme.colored ? `${UNDERLINE_ON}${text}${UNDERLINE_OFF}` : text
  if (token === '') return rest(value)
  const lower = value.toLowerCase()
  let at = lower.indexOf(token.toLowerCase())
  let span = token.length
  if (at < 0 && /^[/@$]/u.test(token) && token.length > 1) {
    const inner = token.slice(1)
    at = lower.indexOf(inner.toLowerCase())
    span = inner.length
  }
  if (at < 0) return rest(value)
  return `${rest(value.slice(0, at))}${match(value.slice(at, at + span))}${rest(value.slice(at + span))}`
}

/**
 * Shift first-line hits left by one when the leading `!` is the gutter, not
 * buffer text the person sees.
 */
function displayHits(hits: readonly GestureHit[], shell: boolean): GestureHit[] {
  if (!shell) return [...hits]
  return hits.flatMap(hit => {
    if (hit.row !== 0) return [hit]
    const start = Math.max(0, hit.start - 1)
    const end = Math.max(0, hit.end - 1)
    return end > start ? [{ ...hit, start, end }] : []
  })
}

/**
 * Shift a first-line selection left by one when the leading `!` is the gutter.
 */
function displaySelection(
  selection: EditorView['selection'],
  shell: boolean,
): EditorView['selection'] {
  if (selection === undefined || !shell) return selection
  const shift = (at: { row: number; column: number }): { row: number; column: number } =>
    at.row === 0 ? { row: 0, column: Math.max(0, at.column - 1) } : at
  const start = shift(selection.start)
  const end = shift(selection.end)
  return start.row === end.row && start.column === end.column ? undefined : { start, end }
}

/**
 * The selected code-point range within one wrapped segment, if any.
 * @param logical - the buffer line the segment belongs to.
 * @param start - the segment's first code point within that line.
 * @param length - code points in the segment.
 * @param selection - the buffer span, already shifted for a shell box.
 */
function selectionOnRow(
  logical: number,
  start: number,
  length: number,
  selection: EditorView['selection'],
): { from: number; to: number } | undefined {
  if (selection === undefined) return undefined
  if (logical < selection.start.row || logical > selection.end.row) return undefined
  const from = logical === selection.start.row ? Math.max(0, selection.start.column - start) : 0
  const to = logical === selection.end.row ? Math.min(length, Math.max(0, selection.end.column - start)) : length
  if (from >= to) return undefined
  return { from, to }
}

/**
 * Paint a wrapped segment: known gestures in their colours, then the selected
 * span in reverse video over the raw text so a copy still reads as what was typed.
 */
function paintContent(
  text: string,
  logical: number,
  start: number,
  hits: readonly GestureHit[],
  selection: EditorView['selection'],
  theme: Theme,
): string {
  const marked = selectionOnRow(logical, start, Array.from(text).length, selection)
  if (marked === undefined) return paintGestures(text, logical, start, hits, theme)
  const cells = Array.from(text)
  const before = paintGestures(cells.slice(0, marked.from).join(''), logical, start, hits, theme)
  const after = paintGestures(cells.slice(marked.to).join(''), logical, start + marked.to, hits, theme)
  return `${before}${INVERSE}${cells.slice(marked.from, marked.to).join('')}${INVERSE_OFF}${after}`
}

/**
 * Colour a wrapped segment's known `/command` and `$skill` spans.
 */
function paintGestures(
  text: string,
  logical: number,
  start: number,
  hits: readonly GestureHit[],
  theme: Theme,
): string {
  const end = start + Array.from(text).length
  const here = hits
    .filter(hit => hit.row === logical && hit.start < end && hit.end > start)
    .sort((left, right) => left.start - right.start)
  if (here.length === 0) return text
  const cells = Array.from(text)
  let out = ''
  let at = 0
  for (const hit of here) {
    const from = Math.max(0, hit.start - start)
    const to = Math.min(cells.length, hit.end - start)
    if (from >= to) continue
    out += cells.slice(at, from).join('')
    const slice = cells.slice(from, to).join('')
    out += hit.kind === 'skill' ? theme.user(slice) : theme.tool(slice)
    at = to
  }
  return out + cells.slice(at).join('')
}

/** Candidate rows painted as a floating layer, empty when the menu is closed. */
/**
 * First candidate of the menu's window, which follows the marked row.
 * @param view - what the editor is showing.
 * @returns the index the window starts at.
 */
function menuWindowStart(view: EditorView): number {
  const following = Math.min(
    Math.max(0, view.selected - MENU_LIMIT + 1),
    Math.max(0, view.candidates.length - MENU_LIMIT),
  )
  return view.menuScroll ?? following
}

/** The furthest the menu's window may start, so the wheel can be clamped. */
export function menuScrollLimit(view: EditorView): number {
  return Math.max(0, view.candidates.length - MENU_LIMIT)
}

/**
 * Where the menu's window starts now, so the wheel can move from it.
 * @param view - what the editor is showing.
 * @returns the first candidate the window shows.
 */
export function menuScrollFrom(view: EditorView): number {
  return menuWindowStart(view)
}

/**
 * Which candidate sits on one row of the menu.
 *
 * The arithmetic mirrors {@link menuRows}: an optional "more above" line, the
 * window, and an optional "more below" line the pointer cannot act on.
 * @param view - what the editor is showing.
 * @param row - a row index within the menu's own rows.
 * @returns the candidate's index, or `undefined` for a row that offers none.
 */
export function menuTargetAt(view: EditorView, row: number): number | undefined {
  if (view.candidates.length === 0) return undefined
  const first = menuWindowStart(view)
  const at = first > 0 ? 1 : 0
  const shown = Math.min(view.candidates.length, first + MENU_LIMIT) - first
  if (row < at || row >= at + shown) return undefined
  return first + (row - at)
}

function menuRows(view: EditorView, theme: Theme, columns: number, hovered?: number): string[] {
  if (view.candidates.length === 0) return []
  const first = menuWindowStart(view)
  const menu = view.candidates.slice(first, first + MENU_LIMIT)
  const width = Math.max(...menu.map(candidate => displayWidth(candidate.value)))
  const rows: string[] = []
  if (first > 0) rows.push(theme.dim(`  ↑ ${first} more`))
  for (const [index, candidate] of menu.entries()) {
    const chosen = first + index === view.selected
    const label = paintMenuLabel(candidate.value, view.token, chosen, theme)
    const pad = ' '.repeat(Math.max(0, width - displayWidth(candidate.value)))
    const detail = candidate.detail === '' ? '' : `  ${candidate.detail}`
    // The marker column, not the label: the label already underlines the
    // fragment that was typed, so a second underline there would say two
    // things with one mark.
    const marker = chosen ? theme.user('❯') : first + index === hovered ? theme.dim('·') : ' '
    rows.push(truncate(`${marker} ${label}${pad}${theme.dim(detail)}`, columns))
  }
  const below = view.candidates.length - first - menu.length
  if (below > 0) rows.push(theme.dim(`  ↓ ${below} more`))
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
/** The wrapped rows a box shows, and the window it shows them through. */
interface BoxLayoutRows {
  /** The buffer's lines, with a shell mode's `!` already taken off. */
  lines: readonly string[]
  /** The cursor's column within its line, with a shell mode's `!` taken off. */
  column: number
  /** Every wrapped segment of every line, in order. */
  visual: VisualRow[]
  /** The segment the cursor sits on. */
  cursorAt: number
  /** First and last segment the window shows. */
  start: number
  end: number
}

/**
 * Where the box's rows come from.
 *
 * Read by the render and by {@link caretAt}, because a pointer has to land on
 * the row a person is looking at: two copies of this arithmetic would put the
 * cursor somewhere the box never drew.
 * @param view - what the editor is showing.
 * @param columns - display columns available to the whole box.
 * @param shell - whether the leading `!` is the gutter rather than content.
 * @returns the wrapped rows and the window over them.
 */
function boxLayout(view: EditorView, columns: number, shell: boolean): BoxLayoutRows {
  const budget = wrapBudget(columns)
  const lines = shell
    ? [(view.lines[0] ?? '').slice(1), ...view.lines.slice(1)]
    : view.lines
  const column = shell && view.row === 0 ? Math.max(0, view.column - 1) : view.column
  const visual = lines.flatMap((line, index) => wrapLine(line, index, budget))
  // The cursor's visual row: the segment holding its column, with the line's
  // end position belonging to the final segment.
  const cursorVisual = visual.findIndex(row =>
    row.logical === view.row
    && column >= row.start
    && (column < row.start + row.length || (row.last && column === row.start + row.length)))
  const cursorAt = Math.max(0, cursorVisual)
  // Window around the cursor once the box outgrows its budget.
  const start = Math.max(0, Math.min(visual.length - MAX_CONTENT_ROWS, cursorAt - (MAX_CONTENT_ROWS - 1)))
  return { lines, column, visual, cursorAt, start, end: Math.min(visual.length, start + MAX_CONTENT_ROWS) }
}

/** Cells before a content row's text: the frame, a space, the gutter, a space. */
const TEXT_AT = 4

/**
 * Where a pointer landed in the buffer.
 *
 * Near misses clamp rather than miss: the text inside a box is a narrow target
 * and "just above the first line" or "past the end of this one" are ordinary
 * intentions, so a border row takes the nearest content row and a column
 * outside the text takes the nearest end of it.
 * @param view - what the editor is showing.
 * @param columns - display columns available to the whole box.
 * @param row - the row within the box's own rows, the top border at zero.
 * @param cell - the display column within that row, from zero.
 * @param shell - whether the leading `!` is the gutter rather than content.
 * @returns where the cursor belongs in the buffer.
 */
export function caretAt(
  view: EditorView,
  columns: number,
  row: number,
  cell: number,
  shell = false,
): { row: number; column: number } {
  const { visual, start, end } = boxLayout(view, columns, shell)
  const shownCount = Math.max(1, end - start)
  const within = Math.min(Math.max(0, row - 1), shownCount - 1)
  const target = visual[start + within]
  if (target === undefined) return { row: 0, column: shell ? 1 : 0 }
  let remaining = Math.max(0, cell - TEXT_AT)
  let offset = 0
  for (const character of Array.from(target.text)) {
    const width = displayWidth(character)
    if (remaining < width) break
    remaining -= width
    offset += 1
  }
  const column = target.start + Math.min(offset, target.length)
  // The `!` a shell box hides is still a character in the buffer.
  return { row: target.logical, column: shell && target.logical === 0 ? column + 1 : column }
}

export function inputBox(view: EditorView, theme: Theme, columns: number, options: BoxOptions = {}): BoxLayout {
  const shell = options.shell === true && (view.lines[0] ?? '').startsWith('!')
  const accent = options.accent ?? ((text: string) => theme.dim(text))
  const inner = Math.max(8, columns - FRAME_WIDTH)
  const budget = wrapBudget(columns)
  const rule = '─'.repeat(inner + 2)
  const { lines, column, visual, cursorAt, start, end } = boxLayout(view, columns, shell)
  const shown = visual.slice(start, end)

  const empty = lines.length === 1 && lines[0] === ''
  const mark = shell ? theme.pending('!') : theme.user('›')
  const hits = displayHits(view.hits, shell)
  const selection = displaySelection(view.selection, shell)
  const overlay = menuRows(view, theme, columns, options.hoveredCandidate)
  const rows: string[] = [accent(`╭${rule}╮`)]
  if (empty && (shell || options.placeholder !== undefined)) {
    const text = truncate(shell ? 'command' : (options.placeholder ?? ''), budget)
    const pad = ' '.repeat(Math.max(0, budget - displayWidth(text)))
    rows.push(`${accent('│')} ${mark} ${theme.dim(text)}${pad} ${accent('│')}`)
  } else {
    shown.forEach((row, index) => {
      const first = start + index === 0
      const clippedAbove = index === 0 && start > 0
      const clippedBelow = index === shown.length - 1 && end < visual.length
      // The gutter marks the very first row; a clipped edge replaces it so a
      // windowed box says there is more rather than looking complete.
      const gutter = clippedAbove || clippedBelow ? theme.dim('…') : first ? mark : ' '
      const painted = paintContent(row.text, row.logical, row.start, hits, selection, theme)
      const pad = ' '.repeat(Math.max(0, budget - displayWidth(row.text)))
      rows.push(`${accent('│')} ${gutter} ${painted}${pad} ${accent('│')}`)
    })
  }
  rows.push(accent(`╰${rule}╯`))

  if (view.candidates.length === 0 && view.search !== undefined) {
    const failing = view.search.hits === 0
    const label = failing ? 'failing bck-i-search' : 'bck-i-search'
    rows.push(theme.dim(truncate(`  ${label}: ${view.search.query}`, columns)))
  } else if (view.candidates.length === 0 && options.hint !== undefined) {
    rows.push(theme.dim(truncate(options.hint, columns)))
  }

  const inCursorRow = visual[cursorAt]
  const before = inCursorRow === undefined
    ? ''
    : Array.from(lines[view.row] ?? '').slice(inCursorRow.start, column).join('')
  return {
    rows,
    overlay,
    cursorRow: 1 + (cursorAt - start),
    cursorColumn: FRAME_WIDTH + Math.min(displayWidth(before), budget),
  }
}
