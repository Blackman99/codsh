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
 * wrapped here ({@link wrapStyled}), because a line that overflows would otherwise
 * overwrite the row below. Scrolling is ours, because the terminal's scrollback
 * does not exist on the alternate screen. And every frame is painted as a
 * whole, diffed against the last one — which is what removes the class of bug
 * that relative erase arithmetic keeps producing.
 * @module codsh-bundle/src/screen
 */

import { displayWidth, truncate } from './theme.ts'
import { wrapStyled } from './wrap.ts'

/** Logical transcript lines kept before the oldest are dropped. */
const MAX_SCROLLBACK = 5000

/** Enter the alternate screen, saving the cursor and the current buffer. */
const ENTER_ALT = '\u001B[?1049h'

/** Leave it, restoring both. */
const LEAVE_ALT = '\u001B[?1049l'

/**
 * Report wheel, button, and pointer-motion events, in the SGR encoding.
 *
 * Any-motion tracking (1003) is what lets the surface say which block the
 * pointer rests on — the blocks are clickable, and a target that gives no
 * feedback until it is hit is not an affordance. Button tracking (1002) is
 * pushed under it so terminals that implement only that one keep the drag
 * that selects. Motion is a report per cell crossed, so the surface repaints
 * only when the block under the pointer changes, not on every report. Most
 * terminals still hand a Shift-drag to their own selection either way.
 */
const ENABLE_MOUSE = '\u001B[?1002h\u001B[?1003h\u001B[?1006h'

/** Stop reporting them. */
const DISABLE_MOUSE = '\u001B[?1006l\u001B[?1003l\u001B[?1002l'

/**
 * Push the kitty keyboard protocol's disambiguate flag — what Claude Code
 * pushes — so Shift+Enter, Esc, and control chords report unambiguously on
 * terminals that speak it. Others ignore the push and keep the legacy bytes.
 */
const ENABLE_KITTY_KEYS = '\u001B[>1u'

/** Pop it, restoring whatever the shell had. */
const DISABLE_KITTY_KEYS = '\u001B[<u'

/** Report focus in/out (mode 1004), which the bell policy reads. */
const ENABLE_FOCUS = '\u001B[?1004h'

/** Stop reporting focus. */
const DISABLE_FOCUS = '\u001B[?1004l'

/**
 * Ask the terminal for its background color (OSC 11), the way opencode and
 * Codex do. The reply decides the light-background palette; a terminal that
 * never answers leaves the dark default standing.
 */
const QUERY_BACKGROUND = '\u001B]11;?\u0007'

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

/** Dark-background hover fill, a slight lift off the default black. */
const FILL_DARK = '\u001B[48;5;236m'

/** Light-background hover fill, a slight drop off the default white. */
const FILL_LIGHT = '\u001B[48;5;253m'

/** Restore the terminal's default background, leaving other attributes. */
const FILL_OFF = '\u001B[49m'

/** A full SGR reset, which every styled span this surface prints ends with. */
const RESET = '\u001B[0m'

/**
 * Fill a row with the hover panel colour, padded to the content width.
 *
 * Every styled span this surface prints ends in a full reset, which would drop
 * the fill partway along the row — so the attribute is armed again after each
 * one, and turned off alone at the end. Spaces pad to the viewport width so
 * the block reads as a panel, the way opencode fills `backgroundElement`.
 * @param row - the styled row.
 * @param columns - display columns the panel should occupy.
 * @param light - whether the terminal background is light.
 * @returns the row, filled end to end.
 */
function fill(row: string, columns: number, light: boolean): string {
  const bg = light ? FILL_LIGHT : FILL_DARK
  const pad = Math.max(0, columns - displayWidth(row))
  const padded = `${row}${' '.repeat(pad)}`
  return `${bg}${padded.replaceAll(RESET, `${RESET}${bg}`)}${FILL_OFF}`
}

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

/** A collapsible transcript block, kept in both forms so either can show. */
interface Fold {
  /** Logical index of the block's first line. */
  at: number
  /** Logical lines the form currently on screen occupies. */
  shownLength: number
  /** The collapsed form. */
  summary: string[]
  /** The expanded form. */
  full: string[]
  /** Which of the two is on screen. */
  expanded: boolean
  /** The left rule both forms are drawn with. */
  rule: string
  /** What the block is, for the readout naming what the pointer is over. */
  label: string
}

/** What the pointer is resting on, for a surface that names it. */
export interface HoverBlock {
  /** What the block is, e.g. `thinking`. */
  label: string
  /** Lines its full form holds. */
  lines: number
  /** Whether it is showing that full form now. */
  expanded: boolean
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
  /**
   * The left rule each logical line carries, `''` for none.
   *
   * Kept beside the text rather than inside it: a rule has to repeat on every
   * row a line wraps to, and it must never reach the clipboard — it is a mark
   * the surface draws, not something the person wrote.
   */
  private rules: string[] = []
  /** The same lines wrapped to the current width — what the viewport slices. */
  private physical: string[] = []
  /** Display columns the rule occupies on each physical row, for copy and hits. */
  private ruleWidths: number[] = []
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
  private folds: Fold[] = []
  /** The block the pointer rests on, or undefined when it rests on none. */
  private hovered: Fold | undefined
  /** Whether OSC 11 named a light background; the hover fill picks a shade. */
  private light = false
  /**
   * Physical row ranges the blocks occupy, or undefined when they need
   * measuring again.
   *
   * Motion arrives a report per cell crossed, and measuring a block's row from
   * the wrapped height of everything above it is a walk over the buffer — far
   * too much to redo per report. The walk happens once after the buffer
   * changes instead, and every report in between is a lookup.
   */
  private ranges: { fold: Fold; from: number; to: number }[] | undefined
  /** Whether the folds currently show their full form. */
  private expanded = false
  /** Incremental find over the owned scrollback, absent when find is closed. */
  private find: { query: string; hits: { row: number; start: number; end: number }[]; index: number } | undefined
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

  /**
   * Adopt the light- or dark-background hover fill.
   * @param light - true when OSC 11 named a light color.
   */
  setLight(light: boolean): void {
    if (this.light === light) return
    this.light = light
    if (this.hovered !== undefined) this.render()
  }

  /** Physical rows scrolled up out of view; zero means the tail is showing. */
  get scrolledBy(): number {
    return this.offset
  }

  /** Incremental find over the scrollback, absent when find is closed. */
  get transcriptSearch(): { query: string; hits: number; index: number } | undefined {
    if (this.find === undefined) return undefined
    return { query: this.find.query, hits: this.find.hits.length, index: this.find.index }
  }

  /** Take the alternate screen and start reporting the mouse. */
  enter(): void {
    if (this.active) return
    this.active = true
    this.host.write(`${ENTER_ALT}${ENABLE_MOUSE}${ENABLE_KITTY_KEYS}${ENABLE_FOCUS}${QUERY_BACKGROUND}${HIDE_CURSOR}`)
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
    this.host.write(`${DISABLE_FOCUS}${DISABLE_KITTY_KEYS}${DISABLE_MOUSE}${SHOW_CURSOR}${LEAVE_ALT}`)
    this.painted = []
  }

  /**
   * Append finished transcript lines.
   *
   * Following the tail is the default; a person who has scrolled up stays
   * where they are, and the new rows accumulate below them.
   * @param lines - the lines to keep, already styled.
   */
  append(lines: readonly string[], rule = ''): void {
    if (lines.length === 0) return
    const columns = this.contentColumns()
    for (const line of lines) {
      // A blank line keeps no rule: the separator between blocks would
      // otherwise show as a lone mark hanging under the block it ended.
      const own = line === '' ? '' : rule
      this.logical.push(line)
      this.rules.push(own)
      for (const row of this.wrapLine(line, own, columns)) {
        this.physical.push(row)
        this.ruleWidths.push(displayWidth(own))
      }
    }
    this.ranges = undefined
    if (this.logical.length > MAX_SCROLLBACK) {
      const dropped = this.logical.length - MAX_SCROLLBACK
      this.logical.splice(0, dropped)
      this.rules.splice(0, dropped)
      // Folds slide with the buffer; one cut by the trim stops being a fold.
      this.folds = this.folds.flatMap((fold) => {
        const at = fold.at - dropped
        return at >= 0 ? [{ ...fold, at }] : []
      })
      // The blocks are rebuilt as new objects, so what was hovered is gone.
      this.hovered = undefined
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
   * @param rule - a styled left rule for the whole block, `''` for none.
   * @param label - what the block is, for the hover readout that names it.
   */
  appendFold(summary: readonly string[], full: readonly string[], rule = '', label = ''): void {
    const shown = this.expanded ? full : summary
    this.folds.push({
      at: this.logical.length,
      shownLength: shown.length,
      summary: [...summary],
      full: [...full],
      expanded: this.expanded,
      rule,
      label,
    })
    this.append(shown, rule)
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
   * @param label - what the block is, for the hover readout that names it.
   */
  foldBack(count: number, summary: readonly string[], label = ''): void {
    const at = this.logical.length - count
    if (count <= 0 || at < 0) return
    // A block that would overlap an existing fold is not a block: refuse it
    // rather than corrupt the splice arithmetic.
    const last = this.folds.at(-1)
    if (last !== undefined && at < last.at + last.shownLength) return
    this.folds.push({
      at,
      shownLength: count,
      summary: [...summary],
      full: this.logical.slice(at),
      expanded: true,
      // One block, one rule: the summary is drawn with whatever the lines it
      // replaces were drawn with, skipping the blanks that hold none.
      rule: this.rules.slice(at).find(rule => rule !== '') ?? '',
      label,
    })
    // The block is new even though its lines are not, so where blocks sit has
    // to be measured again before the pointer can be told it is over one.
    this.ranges = undefined
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
   *
   * What the blocks show decides the direction, not what the last Ctrl+O did:
   * clicking blocks open one at a time would otherwise leave the key pointing
   * the wrong way, and a press that visibly does nothing reads as broken.
   * @returns false when there is nothing to toggle.
   */
  toggleFolds(): boolean {
    if (this.folds.length === 0) return false
    this.setFolds(!this.folds.every(fold => fold.expanded))
    return true
  }

  /** Return every fold to its summary, the way moving on reads as dismissal. */
  collapseFolds(): void {
    // Freshly finished blocks sit expanded even while the global state says
    // collapsed, so the per-fold flags decide whether work exists.
    if (this.folds.some(fold => fold.expanded)) this.setFolds(false)
    else this.expanded = false
  }

  /**
   * Work the block a bare click landed on, the way a details element opens.
   *
   * The whole block is the target, in both forms: collapsed, the `+N lines`
   * line is what a person aims at, and open, anywhere inside the text folds it
   * back — hunting for a head row that has scrolled off the top is not an
   * affordance. Selecting text inside a block is a drag, which never reaches
   * here, so reading is unaffected.
   * @param row - physical buffer row the press anchored on.
   */
  private clickFold(row: number): void {
    const fold = this.foldAt(row)
    if (fold === undefined) return
    this.setFold(fold, !fold.expanded)
  }

  /**
   * Where each block sits in physical rows.
   *
   * Blocks are recorded in logical lines while the mouse reports physical
   * rows, so the wrapped height of everything above a block is what bridges
   * the two — measured under each line's own rule, which costs columns and so
   * changes the height.
   * @returns one range per block, in buffer order.
   */
  private foldRanges(): { fold: Fold; from: number; to: number }[] {
    if (this.ranges !== undefined) return this.ranges
    const columns = this.contentColumns()
    const height = (index: number): number => this.wrapLine(this.logical[index] ?? '', this.rules[index] ?? '', columns).length
    const ranges: { fold: Fold; from: number; to: number }[] = []
    let physical = 0
    let index = 0
    for (const fold of this.folds) {
      for (; index < fold.at; index += 1) physical += height(index)
      const from = physical
      for (; index < fold.at + fold.shownLength; index += 1) physical += height(index)
      ranges.push({ fold, from, to: physical - 1 })
    }
    this.ranges = ranges
    return ranges
  }

  /**
   * The block covering a physical row.
   * @param row - physical buffer row, 0-based.
   * @returns the block, or undefined when the row is not in one.
   */
  private foldAt(row: number): Fold | undefined {
    return this.foldRanges().find(range => row >= range.from && row <= range.to)?.fold
  }

  /**
   * Swap one block, leaving the reader where they were.
   *
   * Someone who opened a block halfway up their history did not ask to be
   * moved to the tail: the rows above the block keep their screen positions,
   * and the transcript grows or shrinks below them. Following the tail there
   * is nothing to hold on to, so the frame keeps following it — which is what
   * Ctrl+O does for every block at once.
   * @param fold - the block to swap.
   * @param expanded - the form to put on screen.
   */
  private setFold(fold: Fold, expanded: boolean): void {
    const shown = expanded ? fold.full : fold.summary
    const delta = shown.length - fold.shownLength
    this.logical.splice(fold.at, fold.shownLength, ...shown)
    this.rules.splice(fold.at, fold.shownLength, ...shown.map(() => fold.rule))
    fold.shownLength = shown.length
    fold.expanded = expanded
    // Only what sits after the block moves; the block starts where it started.
    for (const other of this.folds) if (other.at > fold.at) other.at += delta
    const before = this.physical.length
    const offset = this.offset
    // Re-wrapping clamps the offset to the new height, so the reader's own
    // distance from the tail is remembered from before it and re-applied.
    this.rewrap()
    if (offset > 0) {
      const limit = Math.max(0, this.physical.length - this.viewportHeight())
      this.offset = Math.min(limit, Math.max(0, offset + this.physical.length - before))
    }
    this.painted = []
    this.render()
  }

  /** Put every fold into one form, whatever mix of states they are in now. */
  private setFolds(expanded: boolean): void {
    this.expanded = expanded
    // Rebuild back to front, so earlier folds' positions stay valid while the
    // later ones are spliced; remember each block's growth for the fix-up.
    const deltas = new Map<Fold, number>()
    for (const fold of [...this.folds].reverse()) {
      if (fold.expanded === expanded) {
        deltas.set(fold, 0)
        continue
      }
      const shown = expanded ? fold.full : fold.summary
      this.logical.splice(fold.at, fold.shownLength, ...shown)
      this.rules.splice(fold.at, fold.shownLength, ...shown.map(() => fold.rule))
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
   * Search the owned scrollback.
   *
   * Hits are physical rows, case-insensitive. A new query starts on the
   * newest hit so recent output is what find lands on first.
   * @param query - the needle; empty means no hits yet.
   * @returns the current find state.
   */
  searchTranscript(query: string): { query: string; hits: number; index: number } {
    const hits: { row: number; start: number; end: number }[] = []
    const needle = query.toLowerCase()
    if (needle !== '') {
      for (const [row, line] of this.physical.entries()) {
        const plain = line.replaceAll(STYLES, '')
        const lower = plain.toLowerCase()
        let from = 0
        for (;;) {
          const at = lower.indexOf(needle, from)
          if (at < 0) break
          hits.push({ row, start: at, end: at + needle.length })
          from = at + needle.length
        }
      }
    }
    const index = hits.length === 0 ? 0 : hits.length - 1
    this.find = { query, hits, index }
    this.revealFindHit()
    return { query, hits: hits.length, index }
  }

  /**
   * Step to another hit of the current query.
   * @param direction - 1 towards the tail, -1 towards the head.
   * @returns the current find state, or undefined when find is closed.
   */
  nextTranscriptHit(direction: 1 | -1): { query: string; hits: number; index: number } | undefined {
    if (this.find === undefined || this.find.hits.length === 0) return this.transcriptSearch
    const count = this.find.hits.length
    this.find.index = (this.find.index + direction + count) % count
    this.revealFindHit()
    return this.transcriptSearch
  }

  /** Close find. Transcript content is untouched. */
  clearTranscriptSearch(): void {
    if (this.find === undefined) return
    this.find = undefined
    this.render()
  }

  /** Scroll so the current hit is in the viewport, then paint. */
  private revealFindHit(): void {
    const hit = this.find?.hits[this.find.index]
    if (hit === undefined) {
      this.render()
      return
    }
    const height = this.viewportHeight()
    const end = this.physical.length - this.offset
    const start = Math.max(0, end - height)
    if (hit.row < start || hit.row >= end) {
      const limit = Math.max(0, this.physical.length - height)
      this.offset = Math.min(limit, Math.max(0, this.physical.length - hit.row - 1))
    }
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
    this.rules = []
    this.physical = []
    this.ruleWidths = []
    this.folds = []
    this.ranges = undefined
    this.hovered = undefined
    this.find = undefined
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
   * Note where the pointer is resting, with nothing held down.
   *
   * A block is clickable, so it says so while the pointer is on it rather
   * than only once it is hit. Reports arrive a cell at a time, so the frame is
   * only touched when the block under the pointer actually changes — moving
   * along one block, or across the chrome, costs a lookup and nothing else.
   * @param row - terminal row, 1-based.
   * @param column - terminal column, 1-based.
   * @returns the block under the pointer, or undefined for none — reported
   * every time, so a caller need not track the changes itself.
   */
  mouseMove(row: number, column: number): HoverBlock | undefined {
    const at = this.locate(row, column, false)
    const fold = at === undefined ? undefined : this.foldAt(at.row)
    if (fold !== this.hovered) {
      this.hovered = fold
      this.render()
    }
    if (fold === undefined) return undefined
    return { label: fold.label, lines: fold.full.length, expanded: fold.expanded }
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
   * what it took — until the next click or reflow dismisses it. A press that
   * never moved is not a selection but a click, and a click on a collapsible
   * block works that one block: open it, or fold it back.
   * @returns the selected text, or undefined for a bare click.
   */
  mouseUp(): string | undefined {
    const selection = this.selection
    if (selection === undefined) return undefined
    if (!selection.dragged) {
      this.selection = undefined
      this.clickFold(selection.anchor.row)
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
      // The rule is chrome the surface drew down the block's left edge, not
      // text anyone typed, so a selection that swept over it hands back the
      // content and leaves the mark behind.
      const rule = this.ruleWidths[index] ?? 0
      const first = index === bounds.from.row ? Math.max(bounds.from.column, rule) : rule
      const start = columnIndex(plain, first)
      const end = index === bounds.to.row ? columnIndex(plain, bounds.to.column + 1) : plain.length
      rows.push(plain.slice(start, Math.max(start, end)))
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

  /**
   * Wrap one logical line, repeating its rule on every row.
   *
   * The rule costs columns, so the text wraps inside what is left of the width;
   * a continuation row without the rule would break the block's left edge
   * exactly where a long line made it matter most.
   * @param line - the styled logical line.
   * @param rule - the styled left rule, `''` for none.
   * @param columns - display columns available for rule and text together.
   * @returns the physical rows, rule included.
   */
  private wrapLine(line: string, rule: string, columns: number): string[] {
    if (rule === '') return wrapStyled(line, columns)
    const rows = wrapStyled(line, Math.max(1, columns - displayWidth(rule)))
    return rows.map(row => `${rule}${row}`)
  }

  /** Re-wrap every kept line at the current width, rules and all. */
  private wrapBuffer(): void {
    const columns = this.contentColumns()
    this.ranges = undefined
    this.physical = []
    this.ruleWidths = []
    for (const [at, line] of this.logical.entries()) {
      const rule = this.rules[at] ?? ''
      const width = displayWidth(rule)
      for (const row of this.wrapLine(line, rule, columns)) {
        this.physical.push(row)
        this.ruleWidths.push(width)
      }
    }
  }

  /** Re-wrap every kept line at the current width. */
  private rewrap(): void {
    // Physical rows are the selection's coordinate system; a reflow voids it.
    this.selection = undefined
    this.wrapBuffer()
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
      this.wrapBuffer()
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
    const findHit = this.find?.hits[this.find.index]
    if (findHit !== undefined) {
      const first = Math.max(0, end - height)
      const index = findHit.row - first
      if (index >= 0 && index < visible.length) {
        const plain = (visible[index] ?? '').replaceAll(STYLES, '')
        const marked = plain.slice(findHit.start, findHit.end)
        if (marked !== '') {
          visible[index] = `${plain.slice(0, findHit.start)}${INVERSE}${marked}${INVERSE_OFF}${plain.slice(findHit.end)}`
        }
      }
    }
    const hovered = this.hovered
    if (hovered !== undefined) {
      const range = this.foldRanges().find(entry => entry.fold === hovered)
      if (range !== undefined) {
        const first = Math.max(0, end - height)
        const width = this.contentColumns()
        for (let at = range.from; at <= range.to; at += 1) {
          const index = at - first
          if (index >= 0 && index < visible.length) {
            visible[index] = fill(visible[index] ?? '', width, this.light)
          }
        }
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
