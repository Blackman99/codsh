/**
 * The session's own screen: an alternate-screen viewport with its own scrollback.
 *
 * This is what makes a session feel like a place rather than a run of output.
 * The terminal's buffer is left exactly as the person had it — their shell
 * history is neither scrolled away nor interleaved — and everything this
 * surface shows lives in a buffer it owns: the transcript scrolls inside the
 * viewport while the input box stays where it is, at the bottom.
 *
 * Owning the viewport means doing three jobs the terminal used to do. Lines are
 * wrapped here ({@link wrapAll}), because a line that overflows would otherwise
 * overwrite the row below. Scrolling is ours, because the terminal's scrollback
 * does not exist on the alternate screen. And every frame is painted as a
 * whole, diffed against the last one — which is what removes the class of bug
 * that relative erase arithmetic keeps producing.
 * @module codsh/src/screen
 */

import { displayWidth, truncate } from './theme.ts'
import { wrapAll, wrapStyled } from './wrap.ts'

/** Logical transcript lines kept before the oldest are dropped. */
const MAX_SCROLLBACK = 5000

/** Enter the alternate screen, saving the cursor and the current buffer. */
const ENTER_ALT = '\u001B[?1049h'

/** Leave it, restoring both. */
const LEAVE_ALT = '\u001B[?1049l'

/**
 * Report wheel and button events, in the SGR encoding.
 *
 * Button tracking (1002) rather than any-motion (1003): the wheel and clicks
 * are all this surface reads, and motion reporting floods the input for
 * nothing. Most terminals still hand a Shift-drag to their own selection, so
 * copying text keeps working.
 */
const ENABLE_MOUSE = '\u001B[?1002h\u001B[?1006h'

/** Stop reporting them. */
const DISABLE_MOUSE = '\u001B[?1006l\u001B[?1002l'

/** Ask the terminal to paint a frame atomically, so no half-frame is shown. */
const SYNC_BEGIN = '\u001B[?2026h'

/** End the atomic frame. */
const SYNC_END = '\u001B[?2026l'

/** Erase the row from the cursor rightwards. */
const CLEAR_LINE = '\u001B[K'

/** Hide the cursor while a frame is painted. */
const HIDE_CURSOR = '\u001B[?25l'

/** Show it again. */
const SHOW_CURSOR = '\u001B[?25h'

/** Styling escapes, removed before a row is measured or copied. */
const STYLES = /\u001B\[[0-9;]*m/gu

/** Start reverse video, which is how the selection shows itself. */
const INVERSE = '\u001B[7m'

/** End reverse video only, leaving any other attributes alone. */
const INVERSE_OFF = '\u001B[27m'

/**
 * The string index where a display column begins.
 *
 * Columns are what the mouse reports and characters are what strings hold;
 * this is the bridge. A column landing inside a wide character snaps past it.
 * @param text - plain text, no escapes.
 * @param column - display column, 0-based.
 * @returns the index of the first character at or beyond that column.
 */
function columnIndex(text: string, column: number): number {
  let width = 0
  let index = 0
  for (const character of text) {
    if (width >= column) return index
    width += displayWidth(character)
    index += character.length
  }
  return text.length
}

/** Where the cursor belongs within the chrome rows. */
export interface ChromeCursor {
  row: number
  column: number
}

/** What the screen writes to and measures itself against. */
export interface ScreenHost {
  /** Emit raw bytes to the terminal. */
  write(data: string): void
  /** Display columns currently available. */
  columns(): number
  /** Screen rows currently available. */
  rows(): number
}

/** An alternate-screen viewport over a scrollback buffer this surface owns. */
export class Screen {
  /** Logical transcript lines, unwrapped, oldest first. */
  private logical: string[] = []
  /** The same lines wrapped to the current width — what the viewport slices. */
  private physical: string[] = []
  /** The bottom rows: input box, menu, indicator, status. */
  private chrome: string[] = []
  private chromeCursor: ChromeCursor = { row: 0, column: 0 }
  /** Whether the chrome holds input focus, which is when the cursor shows. */
  private chromeFocus = true
  /** Physical rows hidden below the viewport; zero means following the tail. */
  private offset = 0
  /** What to show while scrolled back, drawn over the viewport's top row. */
  private notice = ''
  /** A mouse selection over the transcript, in physical-row coordinates. */
  private selection: { anchor: { row: number; column: number }; focus: { row: number; column: number }; dragged: boolean } | undefined
  /** Collapsed blocks in the transcript, in order, with both of their forms. */
  private folds: { at: number; shownLength: number; summary: string[]; full: string[]; expanded: boolean }[] = []
  /** Whether the folds currently show their full form. */
  private expanded = false
  /** The last painted frame, so a repaint only touches rows that changed. */
  private painted: string[] = []
  /** Width the current frame was painted at, to detect a resize. */
  private paintedColumns = 0
  private active = false

  constructor(private readonly host: ScreenHost) {}

  /** Whether the alternate screen is currently held. */
  get entered(): boolean {
    return this.active
  }

  /** Physical rows scrolled up out of view; zero means the tail is showing. */
  get scrolledBy(): number {
    return this.offset
  }

  /** Take the alternate screen and start reporting the mouse. */
  enter(): void {
    if (this.active) return
    this.active = true
    this.host.write(`${ENTER_ALT}${ENABLE_MOUSE}${HIDE_CURSOR}`)
    this.painted = []
    this.render()
  }

  /**
   * Give the terminal back exactly as it was.
   *
   * Idempotent, because every exit path calls it — a normal quit, an
   * interrupt, and a crash handler all have to leave the terminal usable.
   */
  leave(): void {
    if (!this.active) return
    this.active = false
    this.host.write(`${DISABLE_MOUSE}${SHOW_CURSOR}${LEAVE_ALT}`)
    this.painted = []
  }

  /**
   * Append finished transcript lines.
   *
   * Following the tail is the default; a person who has scrolled up stays
   * where they are, and the new rows accumulate below them.
   * @param lines - the lines to keep, already styled.
   */
  append(lines: readonly string[]): void {
    if (lines.length === 0) return
    const columns = this.contentColumns()
    for (const line of lines) {
      this.logical.push(line)
      this.physical.push(...wrapStyled(line, columns))
    }
    if (this.logical.length > MAX_SCROLLBACK) {
      const dropped = this.logical.length - MAX_SCROLLBACK
      this.logical.splice(0, dropped)
      // Folds slide with the buffer; one cut by the trim stops being a fold.
      this.folds = this.folds.flatMap((fold) => {
        const at = fold.at - dropped
        return at >= 0 ? [{ ...fold, at }] : []
      })
      this.rewrap()
    }
    this.render()
  }

  /**
   * Append one collapsible block: its summary now, its full form on demand.
   *
   * This is what makes every long block — not merely the latest — expandable:
   * the buffer keeps both forms, and toggling rebuilds the transcript in
   * place, exactly like a details/summary element.
   * @param summary - the collapsed lines, already styled.
   * @param full - the expanded lines, already styled.
   */
  appendFold(summary: readonly string[], full: readonly string[]): void {
    const shown = this.expanded ? full : summary
    this.folds.push({
      at: this.logical.length,
      shownLength: shown.length,
      summary: [...summary],
      full: [...full],
      expanded: this.expanded,
    })
    this.append(shown)
  }

  /**
   * Turn the last `count` appended lines into a collapsible block after the
   * fact.
   *
   * This is how a finished answer becomes foldable without ever having been
   * withheld: it streamed in the open, and only once complete does it grow a
   * summary form. The block starts expanded — the person is reading it — and
   * collapses with the rest when the conversation moves on.
   * @param count - how many trailing lines the block owns.
   * @param summary - the collapsed lines, already styled.
   */
  foldBack(count: number, summary: readonly string[]): void {
    const at = this.logical.length - count
    if (count <= 0 || at < 0) return
    // A block that would overlap an existing fold is not a block: refuse it
    // rather than corrupt the splice arithmetic.
    const last = this.folds.at(-1)
    if (last !== undefined && at < last.at + last.shownLength) return
    this.folds.push({ at, shownLength: count, summary: [...summary], full: this.logical.slice(at), expanded: true })
  }

  /** Whether any collapsible block exists. */
  get hasFolds(): boolean {
    return this.folds.length > 0
  }

  /** Whether the folds currently show their full form. */
  get foldsExpanded(): boolean {
    return this.expanded
  }

  /**
   * Swap every fold between its summary and its full form.
   * @returns false when there is nothing to toggle.
   */
  toggleFolds(): boolean {
    if (this.folds.length === 0) return false
    this.setFolds(!this.expanded)
    return true
  }

  /** Return every fold to its summary, the way moving on reads as dismissal. */
  collapseFolds(): void {
    // Freshly finished blocks sit expanded even while the global state says
    // collapsed, so the per-fold flags decide whether work exists.
    if (this.folds.some(fold => fold.expanded)) this.setFolds(false)
    else this.expanded = false
  }

  /** Put every fold into one form, whatever mix of states they are in now. */
  private setFolds(expanded: boolean): void {
    this.expanded = expanded
    // Rebuild back to front, so earlier folds' positions stay valid while the
    // later ones are spliced; remember each block's growth for the fix-up.
    const deltas = new Map<object, number>()
    for (const fold of [...this.folds].reverse()) {
      if (fold.expanded === expanded) {
        deltas.set(fold, 0)
        continue
      }
      const shown = expanded ? fold.full : fold.summary
      this.logical.splice(fold.at, fold.shownLength, ...shown)
      deltas.set(fold, shown.length - fold.shownLength)
      fold.shownLength = shown.length
      fold.expanded = expanded
    }
    // Positions after each splice shift by the growth of everything spliced
    // before them; recompute from the front.
    let shift = 0
    for (const fold of this.folds) {
      fold.at += shift
      shift += deltas.get(fold) ?? 0
    }
    this.rewrap()
    this.offset = 0
    this.painted = []
    this.render()
  }

  /**
   * Replace the bottom rows.
   * @param rows - the chrome, top to bottom.
   * @param cursor - where the cursor belongs among them.
   * @param focus - whether to show the cursor there.
   */
  setChrome(rows: readonly string[], cursor: ChromeCursor, focus: boolean): void {
    // Cut, never wrapped: a box border that wrapped would push the layout down
    // a row and the frame would disagree with itself.
    this.chrome = rows.map(row => truncate(row, this.contentColumns()))
    this.chromeCursor = { ...cursor }
    this.chromeFocus = focus
    this.render()
  }

  /**
   * Set the line shown while the reader is away from the tail.
   *
   * Drawn OVER the viewport's top row rather than added to the chrome: a notice
   * that changed the chrome's height would move the input box as a side effect
   * of scrolling, and would make a page up and a page down different sizes.
   * @param text - the styled notice, already fitted.
   */
  setScrollNotice(text: string): void {
    if (text === this.notice) return
    this.notice = text
    if (this.offset > 0) this.render()
  }

  /**
   * Scroll the transcript.
   * @param delta - rows to move; negative scrolls back into history.
   */
  scrollBy(delta: number): void {
    const limit = Math.max(0, this.physical.length - this.viewportHeight())
    const next = Math.min(limit, Math.max(0, this.offset - delta))
    if (next === this.offset) return
    this.offset = next
    this.render()
  }

  /**
   * Scroll by a whole viewport, which is what the page keys mean.
   * @param direction - -1 for back into history, 1 towards the tail.
   */
  scrollPage(direction: -1 | 1): void {
    // One row of overlap keeps a line of context across the jump.
    this.scrollBy(direction * Math.max(1, this.viewportHeight() - 1))
  }

  /** Jump back to the tail, which is also what a new submission does. */
  scrollToBottom(): void {
    if (this.offset === 0) return
    this.offset = 0
    this.render()
  }

  /**
   * Drop the transcript, keeping the chrome.
   *
   * Ctrl-L on a shared terminal clears a viewport the person may want back; on
   * our own screen the buffer IS the session's history, so this empties it.
   */
  clearTranscript(): void {
    this.logical = []
    this.physical = []
    this.folds = []
    this.expanded = false
    this.offset = 0
    this.painted = []
    this.render()
  }

  /** Re-wrap and repaint after the terminal changed size. */
  resize(): void {
    this.rewrap()
    // Nothing on screen can be trusted at a new size; the next frame is full.
    this.painted = []
    this.render()
  }

  /**
   * Anchor a selection where the left button went down.
   *
   * The terminal cannot select for us while mouse reporting is on, so the
   * viewport does it: press anchors, motion extends, release copies — the
   * shape opencode and Claude give the same gesture.
   * @param row - terminal row, 1-based.
   * @param column - terminal column, 1-based.
   */
  mouseDown(row: number, column: number): void {
    const had = this.selection !== undefined
    this.selection = undefined
    const at = this.locate(row, column, false)
    if (at !== undefined) this.selection = { anchor: at, focus: at, dragged: false }
    // A bare click also clears a standing highlight; the row diff repaints
    // exactly the rows that lost it.
    if (had) this.render()
  }

  /**
   * Extend the selection to where the pointer moved.
   * @param row - terminal row, 1-based.
   * @param column - terminal column, 1-based.
   */
  mouseDrag(row: number, column: number): void {
    if (this.selection === undefined) return
    const at = this.locate(row, column, true)
    if (at === undefined) return
    this.selection.focus = at
    this.selection.dragged = true
    this.render()
  }

  /**
   * Finish the gesture.
   *
   * The highlight stays up — the copy already happened, and the marks show
   * what it took — until the next click or reflow dismisses it.
   * @returns the selected text, or undefined for a bare click.
   */
  mouseUp(): string | undefined {
    const selection = this.selection
    if (selection === undefined) return undefined
    if (!selection.dragged) {
      this.selection = undefined
      return undefined
    }
    const text = this.selectedText()
    if (text === '') {
      this.selection = undefined
      this.render()
      return undefined
    }
    return text
  }

  /** The selection's bounds in order, top-left first. */
  private orderedSelection(): { from: { row: number; column: number }; to: { row: number; column: number } } | undefined {
    const selection = this.selection
    // A press that never moved selects nothing — and highlights nothing.
    if (selection === undefined || !selection.dragged) return undefined
    const { anchor, focus } = selection
    const backwards = focus.row < anchor.row || (focus.row === anchor.row && focus.column < anchor.column)
    const [from, to] = backwards ? [focus, anchor] : [anchor, focus]
    return { from, to }
  }

  /** The plain text under the selection, visual rows joined by newlines. */
  private selectedText(): string {
    const bounds = this.orderedSelection()
    if (bounds === undefined) return ''
    const rows: string[] = []
    for (let index = bounds.from.row; index <= bounds.to.row; index += 1) {
      const plain = (this.physical[index] ?? '').replaceAll(STYLES, '')
      const start = index === bounds.from.row ? columnIndex(plain, bounds.from.column) : 0
      const end = index === bounds.to.row ? columnIndex(plain, bounds.to.column + 1) : plain.length
      rows.push(plain.slice(start, end))
    }
    return rows.join('\n').replace(/^\n+|\n+$/gu, '') === '' ? '' : rows.join('\n')
  }

  /**
   * Map a terminal position to a physical buffer position.
   * @param row - terminal row, 1-based.
   * @param column - terminal column, 1-based.
   * @param clamp - pull an outside position to the nearest content row, the
   * way dragging past an edge keeps selecting, instead of refusing it.
   * @returns the position, or undefined when it misses the content.
   */
  private locate(row: number, column: number, clamp: boolean): { row: number; column: number } | undefined {
    if (this.physical.length === 0) return undefined
    const height = this.viewportHeight()
    const end = this.physical.length - this.offset
    const start = Math.max(0, end - height)
    let index = start + row - 1
    if (!clamp && (row - 1 >= height || index >= end || index < start)) return undefined
    index = Math.min(Math.max(index, start), end - 1)
    return { row: index, column: Math.max(0, column - 1) }
  }

  /** Rows the transcript viewport occupies. */
  private viewportHeight(): number {
    return Math.max(1, this.host.rows() - this.chrome.length)
  }

  /** Columns content is laid out for, one short of the width so no row wraps. */
  private contentColumns(): number {
    return Math.max(1, this.host.columns() - 1)
  }

  /** Re-wrap every kept line at the current width. */
  private rewrap(): void {
    // Physical rows are the selection's coordinate system; a reflow voids it.
    this.selection = undefined
    this.physical = wrapAll(this.logical, this.contentColumns())
    const limit = Math.max(0, this.physical.length - this.viewportHeight())
    this.offset = Math.min(this.offset, limit)
  }

  /**
   * Compose and paint the frame.
   *
   * The viewport is padded at the top when the transcript is shorter than the
   * screen, which is what puts the chrome at the bottom from the first frame
   * rather than wherever output happened to reach.
   */
  private render(): void {
    if (!this.active) return
    const columns = this.host.columns()
    if (columns !== this.paintedColumns) {
      this.physical = wrapAll(this.logical, this.contentColumns())
      this.painted = []
      this.paintedColumns = columns
    }
    const height = this.viewportHeight()
    const end = this.physical.length - this.offset
    const visible = this.physical.slice(Math.max(0, end - height), Math.max(0, end))
    // Content tops the screen the way a fresh terminal reads — the welcome at
    // the top, the gap between it and the chrome — and grows downward until it
    // reaches the chrome and starts scrolling.
    const padding = Array.from({ length: Math.max(0, height - visible.length) }, () => '')
    const bounds = this.orderedSelection()
    if (bounds !== undefined) {
      const first = Math.max(0, end - height)
      for (let index = 0; index < visible.length; index += 1) {
        const at = first + index
        if (at < bounds.from.row || at > bounds.to.row) continue
        const plain = (visible[index] ?? '').replaceAll(STYLES, '')
        const start = at === bounds.from.row ? columnIndex(plain, bounds.from.column) : 0
        const stop = at === bounds.to.row ? columnIndex(plain, bounds.to.column + 1) : plain.length
        let marked = plain.slice(start, stop)
        // A selected blank row still shows it belongs to the selection.
        if (marked === '' && at > bounds.from.row && at < bounds.to.row) marked = ' '
        if (marked === '' && start >= stop) continue
        visible[index] = `${plain.slice(0, start)}${INVERSE}${marked}${INVERSE_OFF}${plain.slice(stop)}`
      }
    }
    const viewport = [...visible, ...padding]
    // Scrolled back, the top row says so — replacing a row rather than adding
    // one, so the rest of the layout does not shift under the reader.
    if (this.offset > 0 && this.notice !== '' && viewport.length > 0) {
      viewport[0] = truncate(this.notice, this.contentColumns())
    }
    const frame = [...viewport, ...this.chrome]

    let out = SYNC_BEGIN + HIDE_CURSOR
    frame.forEach((row, index) => {
      // Only rows that changed are repainted: a frame that rewrites everything
      // makes a wide terminal flicker even inside a synchronized update.
      if (this.painted[index] === row) return
      out += `\u001B[${index + 1};1H${CLEAR_LINE}${row}`
    })
    // A shrunken frame leaves rows behind; clear what the new one does not fill.
    for (let index = frame.length; index < this.painted.length; index += 1) {
      out += `\u001B[${index + 1};1H${CLEAR_LINE}`
    }
    if (this.chromeFocus) {
      const row = frame.length - this.chrome.length + this.chromeCursor.row + 1
      out += `\u001B[${row};${this.chromeCursor.column + 1}H${SHOW_CURSOR}`
    }
    out += SYNC_END
    this.host.write(out)
    this.painted = frame
  }
}
