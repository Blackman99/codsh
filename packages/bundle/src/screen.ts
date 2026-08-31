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
import { computeStickyLayout } from './sticky.ts'
import { computeTimeline } from './timeline.ts'
import type { TimelineMark } from './timeline.ts'
import { wrapStyled } from './wrap.ts'

/** Logical transcript lines kept before the oldest are dropped. */
const MAX_SCROLLBACK = 5000

/** Blank columns to the left of every painted row, so text is not flush to the window. */
export const GUTTER = 2

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
  /** Whether a person explicitly chose the current form. */
  manual: boolean
  /** The left rule both forms are drawn with. */
  rule: string
  /** What the block is, for the readout naming what the pointer is over. */
  label: string
  /** Child session a click opens instead of folding, when the card is a view. */
  enter?: string
}

/** One real user prompt and the response section it starts. */
interface TurnPrompt {
  /** Logical index of the prompt's first line. */
  at: number
  /** Logical lines currently occupied, including its trailing separator. */
  shownLength: number
  /** Left rule used by the inline prompt and its sticky copy. */
  rule: string
  /** Original logical lines, independent of the current wrapping width. */
  full: string[]
  /** Lines the person explicitly entered, excluding generated metadata. */
  explicitLines: number
  /** Long prompts share the fold that controls their displayed form. */
  fold?: Fold
  /** Explicit form retained while a resize temporarily removes the fold. */
  preference?: boolean
}

/** One prompt measured in the physical rows shared by sticky and timeline UI. */
interface PromptLayout {
  prompt: TurnPrompt
  at: number
  rows: string[]
}

/** All row geometry needed to compose and interact with one viewport frame. */
interface FrameLayout {
  height: number
  end: number
  first: number
  prompts: PromptLayout[]
  sticky: ReturnType<typeof computeStickyLayout>
}

/** Stable reading position across logical transcript splices and reflow. */
interface ViewportAnchor {
  logical: number
  within: number
}

/** A modal-safe reading position that survives prompt reflow. */
export type ViewportBookmark =
  | { kind: 'tail' }
  | { kind: 'head'; logical: number; within: number }
  | { kind: 'turn'; turn: number; section: 'prompt' | 'response'; line: number; within: number }

/** One physical search match, plus its stable identity in the logical buffer. */
interface FindHit {
  row: number
  start: number
  end: number
  logical: number
  occurrence: number
}

/** What the pointer is resting on, for a surface that names it. */
export interface HoverBlock {
  /** What the block is, e.g. `thinking`. */
  label: string
  /** Lines its full form holds. */
  lines: number
  /** Whether it is showing that full form now. */
  expanded: boolean
  /** Whether a click opens the named child session rather than folding. */
  enter?: boolean
}

/** One real user turn exposed to navigation widgets. */
export interface TurnReference {
  /** Zero-based position in the retained transcript. */
  index: number
  /** Plain first-line label for selectors and previews. */
  summary: string
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
  /** Logical line owning each physical row, for resize anchoring. */
  private physicalLogical: number[] = []
  /** The bottom rows: input box, menu, indicator, status. */
  private chrome: string[] = []
  private chromeCursor: ChromeCursor = { row: 0, column: 0 }
  /** Whether the chrome holds input focus, which is when the cursor shows. */
  private chromeFocus = true
  /** Physical rows hidden below the viewport; zero means following the tail. */
  private offset = 0
  /** Live prompt whose response is still consuming display-only tail space. */
  private tailAnchor: TurnPrompt | undefined
  /** Blank display rows after the physical transcript; never retained or copied. */
  private tailRows = 0
  /** The prompt's own rows establish an anchor; only later rows may retire it. */
  private installingTailAnchor = false
  /** What to show while scrolled back, drawn over the viewport's top row. */
  private notice = ''
  /** A jumped expanded prompt at row one must not be covered by that notice. */
  private suppressNotice = false
  /** Completion menu painted over the viewport, just above the chrome. */
  private overlay: string[] = []
  /** Transient full-screen rows replacing transcript and chrome without mutating either. */
  private viewer: string[] | undefined
  /** A mouse selection over the transcript, in physical-row coordinates. */
  private selection: { anchor: { row: number; column: number }; focus: { row: number; column: number }; dragged: boolean } | undefined
  /** Sticky prompt pressed as display chrome; dragging cancels the click. */
  private pressedSticky: TurnPrompt | undefined
  /** Timeline target pressed in the reserved rail; null keeps an inert rail gesture owned. */
  private pressedTimeline: TurnPrompt | null | undefined
  /** Last pointer position, re-resolved against each frame's rail geometry. */
  private timelinePointer: { row: number; column: number } | undefined
  /** Whether a selector/viewer currently owns the surface over the rail. */
  private timelineHidden = false
  /** Last auxiliary glyph per viewport row, for rail-only repainting. */
  private paintedTimeline: string[] = []
  /** Collapsed blocks in the transcript, in order, with both of their forms. */
  private folds: Fold[] = []
  /** Real user prompts, which divide the transcript into response sections. */
  private prompts: TurnPrompt[] = []
  /** Prompt row geometry, invalidated only when prompt content or width changes. */
  private promptLayoutCache: PromptLayout[] | undefined
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
  /** Incremental find over the owned scrollback, absent when find is closed. */
  private find: { query: string; hits: FindHit[]; index: number } | undefined
  /** The last painted frame, so a repaint only touches rows that changed. */
  private painted: string[] = []
  /** Width the current frame was painted at, to detect a resize. */
  private paintedColumns = 0
  private active = false
  /** Opens a child session when a view-card is clicked. */
  private enterHandler: ((id: string) => void) | undefined

  constructor(private readonly host: ScreenHost) {}

  /**
   * What a click on a view-card does.
   * @param handler - receives the child session id; omit to restore folding.
   */
  setEnter(handler: ((id: string) => void) | undefined): void {
    this.enterHandler = handler
  }

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

  /** Real user turns retained in this Screen, oldest first. */
  get turnList(): TurnReference[] {
    return this.prompts.map((prompt, index) => {
      const summary = this.explicitPromptLines(prompt)
        .filter(line => line !== '')
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim()
      return { index, summary }
    })
  }

  /** Turn owning the top of the current viewport, or the latest at the tail. */
  get currentTurn(): number | undefined {
    return this.currentTurnFor(this.frameLayout())
  }

  /** Turn owner derived from the same frame used by timeline paint and hits. */
  private currentTurnFor(frame: FrameLayout): number | undefined {
    if (frame.prompts.length === 0) return undefined
    if (this.offset === 0) return frame.prompts.length - 1
    if (frame.sticky !== undefined) return frame.sticky.prompt
    let current = 0
    for (const [index, layout] of frame.prompts.entries()) {
      if (layout.at > frame.first) break
      current = index
    }
    return current
  }

  /** Plain real-user lines, excluding generated image metadata and separators. */
  private explicitPromptLines(prompt: TurnPrompt): string[] {
    return prompt.full
      .slice(0, Math.max(0, prompt.explicitLines))
      .map(line => line.replaceAll(STYLES, '').trim())
  }

  /** Reveal one retained turn with its inline prompt at the viewport top. */
  jumpToTurn(index: number): boolean {
    const layout = this.promptLayouts()[index]
    if (layout === undefined) return false
    this.cancelTimelineNavigation()
    this.clearTailAnchor()
    const height = this.viewportHeight()
    const limit = Math.max(0, this.physical.length - height)
    const canStick = layout.prompt.fold?.expanded !== true
    // Cross one row past an eligible inline prompt so Sticky owns row one and
    // the notice uses its gap. Expanded prompts stay inline at their first row.
    const top = layout.at + (canStick ? Math.min(1, layout.rows.length) : 0)
    this.suppressNotice = !canStick
    this.offset = Math.min(limit, Math.max(0, this.physical.length - top - height))
    this.render()
    return true
  }

  /** Restore a previously captured physical scroll distance. */
  restoreScroll(offset: number): void {
    this.cancelTimelineNavigation()
    this.clearTailAnchor()
    const limit = Math.max(0, this.physical.length - this.viewportHeight())
    this.offset = Math.min(limit, Math.max(0, offset))
    this.suppressNotice = false
    this.render()
  }

  /** Capture a reading position in turn-relative logical coordinates. */
  captureViewportBookmark(): ViewportBookmark | undefined {
    if (this.offset === 0) return { kind: 'tail' }
    const anchor = this.viewportAnchor()
    if (anchor === undefined) return undefined
    let turn = -1
    for (const [index, prompt] of this.prompts.entries()) {
      if (prompt.at > anchor.logical) break
      turn = index
    }
    if (turn < 0) return { kind: 'head', ...anchor }
    const prompt = this.prompts[turn]
    if (prompt === undefined) return { kind: 'head', ...anchor }
    const responseAt = prompt.at + prompt.shownLength
    return anchor.logical < responseAt
      ? { kind: 'turn', turn, section: 'prompt', line: anchor.logical - prompt.at, within: anchor.within }
      : { kind: 'turn', turn, section: 'response', line: anchor.logical - responseAt, within: anchor.within }
  }

  /** Restore a reading position after modal previews and terminal reflow. */
  restoreViewportBookmark(bookmark: ViewportBookmark | undefined): void {
    if (bookmark === undefined) return
    this.cancelTimelineNavigation()
    if (bookmark.kind === 'tail') {
      this.scrollToBottom()
      return
    }
    let anchor: ViewportAnchor
    if (bookmark.kind === 'head') {
      anchor = { logical: bookmark.logical, within: bookmark.within }
    } else {
      const prompt = this.prompts[bookmark.turn]
      if (prompt === undefined) return
      const base = bookmark.section === 'prompt' ? prompt.at : prompt.at + prompt.shownLength
      const next = this.prompts[bookmark.turn + 1]
      const end = bookmark.section === 'prompt' ? prompt.at + prompt.shownLength : next?.at ?? this.logical.length
      anchor = {
        logical: Math.min(base + bookmark.line, Math.max(base, end - 1)),
        within: bookmark.within,
      }
    }
    this.clearTailAnchor()
    this.suppressNotice = false
    this.restoreViewportAnchor(anchor)
    this.render()
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
    this.paintedTimeline = []
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
    this.paintedTimeline = []
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
    this.cancelTimelineNavigation()
    const extendsPromptLayouts = this.prompts.some(prompt => prompt.at >= this.logical.length)
    const heldEnd = this.offset > 0 ? this.physical.length - this.offset : undefined
    const heldAnchor = this.offset > 0 ? this.viewportAnchor() : undefined
    let mappedAnchor = heldAnchor
    let trimmed = false
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
        this.physicalLogical.push(this.logical.length - 1)
      }
    }
    // appendPrompt installs its descriptor before these rows arrive. A reader
    // browsing history may have populated the cache via viewportAnchor above,
    // so rebuild once the prompt's real physical rows now exist. Ordinary
    // streamed response rows sit after every prompt and keep the cache hot.
    if (extendsPromptLayouts) this.promptLayoutCache = undefined
    this.ranges = undefined
    if (this.logical.length > MAX_SCROLLBACK) {
      trimmed = true
      const dropped = this.logical.length - MAX_SCROLLBACK
      mappedAnchor = this.mapViewportAnchor(mappedAnchor, 0, dropped, 0)
      this.mapFindHits(0, dropped, 0)
      this.logical.splice(0, dropped)
      this.rules.splice(0, dropped)
      // Folds slide with the buffer; one cut by the trim stops being a fold.
      this.folds = this.folds.filter((fold) => {
        fold.at -= dropped
        return fold.at >= 0
      })
      const kept = new Set(this.folds)
      this.prompts = this.prompts.filter((prompt) => {
        prompt.at -= dropped
        return prompt.at >= 0 && (prompt.fold === undefined || kept.has(prompt.fold))
      })
      // A trim may have removed the pressed prompt and its fold; a later mouse
      // release must never splice through a descriptor that no longer exists.
      this.pressedSticky = undefined
      this.cancelTimelineNavigation()
      this.painted = []
      // A hovered block may have been cut from the head.
      this.hovered = undefined
      this.rewrap()
      if (mappedAnchor !== undefined) this.restoreViewportAnchor(mappedAnchor)
    }
    if (heldEnd !== undefined && !trimmed) {
      this.offset = Math.max(0, this.physical.length - heldEnd)
    }
    if (!trimmed) this.refreshTranscriptSearch()
    this.refreshTailAnchor(!this.installingTailAnchor)
    this.render()
  }

  /**
   * Append the real user prompt that starts a response section.
   *
   * The prompt stays ordinary transcript content. Its descriptor is only the
   * navigation seam the viewport needs to reproduce it at the top once the
   * inline copy has scrolled away.
   * @param lines - rendered prompt lines, including its trailing separator.
   * @param rule - the user's styled left rule.
   * @param anchor - whether a live submission may reserve display-only tail space.
   * @param explicitLines - logical text lines the person entered, excluding metadata.
   */
  appendPrompt(lines: readonly string[], rule = '', anchor = true, explicitLines = 1): void {
    if (lines.length === 0) return
    const shouldAnchor = anchor && this.active && this.offset === 0
    if (shouldAnchor) this.clearTailAnchor()
    const full = [...lines]
    const summary = this.promptSummary(full, rule)
    if (summary === undefined) {
      const prompt = { at: this.logical.length, shownLength: lines.length, rule, full, explicitLines }
      this.prompts.push(prompt)
      this.promptLayoutCache = undefined
      if (shouldAnchor) this.tailAnchor = prompt
      this.installingTailAnchor = shouldAnchor
      try {
        this.append(lines, rule)
      } finally {
        this.installingTailAnchor = false
      }
      return
    }
    const shown = summary
    const fold: Fold = {
      at: this.logical.length,
      shownLength: shown.length,
      summary,
      full,
      expanded: false,
      manual: false,
      rule,
      label: 'prompt',
    }
    this.folds.push(fold)
    const prompt = { at: fold.at, shownLength: shown.length, rule, full, fold, explicitLines }
    this.prompts.push(prompt)
    this.promptLayoutCache = undefined
    if (shouldAnchor) this.tailAnchor = prompt
    this.installingTailAnchor = shouldAnchor
    try {
      this.append(shown, rule)
    } finally {
      this.installingTailAnchor = false
    }
  }

  /** Drop display-only tail space without touching the retained transcript. */
  private clearTailAnchor(): void {
    this.tailAnchor = undefined
    this.tailRows = 0
  }

  /** Cancel a stale rail target while retaining ownership through mouse-up. */
  private cancelTimelineNavigation(): void {
    if (this.pressedTimeline !== undefined) this.pressedTimeline = null
  }

  /** Fit the live prompt at row one while its real response has not filled the viewport. */
  private refreshTailAnchor(retireWhenFilled = false): void {
    const anchor = this.tailAnchor
    if (anchor === undefined) {
      this.tailRows = 0
      return
    }
    if (this.offset > 0 || !this.prompts.includes(anchor)) {
      this.clearTailAnchor()
      return
    }
    const layout = this.promptLayouts().find(candidate => candidate.prompt === anchor)
    if (layout === undefined) {
      this.clearTailAnchor()
      return
    }
    this.tailRows = Math.max(0, this.viewportHeight() - (this.physical.length - layout.at))
    if (this.tailRows === 0 && retireWhenFilled) this.tailAnchor = undefined
  }

  /** Three visual prompt rows plus its separator, or no fold when it fits. */
  private promptSummary(lines: readonly string[], rule: string): string[] | undefined {
    const content = lines.at(-1) === '' ? lines.slice(0, -1) : [...lines]
    const textColumns = Math.max(1, this.contentColumns() - displayWidth(rule))
    const wrapped = content.flatMap(line => wrapStyled(line, textColumns))
    if (wrapped.length <= 3) return undefined
    const third = wrapped[2] ?? ''
    return [
      ...wrapped.slice(0, 2),
      truncate(`${third} …`, textColumns),
      ...lines.at(-1) === '' ? [''] : [],
    ]
  }

  /** Move every later descriptor after a prompt form changes length. */
  private shiftAfter(at: number, delta: number, ownerPrompt: TurnPrompt, ownerFold?: Fold): void {
    if (delta === 0) return
    for (const fold of this.folds) if (fold !== ownerFold && fold.at > at) fold.at += delta
    for (const prompt of this.prompts) if (prompt !== ownerPrompt && prompt.at > at) prompt.at += delta
  }

  /** Move a viewport anchor through one replacement in logical coordinates. */
  private mapViewportAnchor(anchor: ViewportAnchor | undefined, at: number, removed: number, added: number): ViewportAnchor | undefined {
    if (anchor === undefined || anchor.logical < at) return anchor
    if (anchor.logical >= at + removed) return { ...anchor, logical: anchor.logical + added - removed }
    return { ...anchor, logical: at + Math.min(anchor.logical - at, Math.max(0, added - 1)) }
  }

  /** Move cached logical search identities through one buffer replacement. */
  private mapFindHits(at: number, removed: number, added: number): void {
    if (this.find === undefined) return
    for (const hit of this.find.hits) {
      if (hit.logical < at) continue
      if (hit.logical >= at + removed) hit.logical += added - removed
      else hit.logical = added === 0 ? -1 : at + Math.min(hit.logical - at, added - 1)
    }
  }

  /** Rebuild prompt folds when a new width changes their visual line count. */
  private refreshPromptFolds(anchor?: ViewportAnchor): ViewportAnchor | undefined {
    let mapped = anchor
    for (const prompt of this.prompts) {
      const summary = this.promptSummary(prompt.full, prompt.rule)
      const fold = prompt.fold
      if (summary === undefined) {
        if (fold === undefined) continue
        const shown = prompt.full
        const delta = shown.length - prompt.shownLength
        if (delta !== 0 || shown.some((line, index) => line !== this.logical[prompt.at + index])) {
          mapped = this.mapViewportAnchor(mapped, prompt.at, prompt.shownLength, shown.length)
          this.mapFindHits(prompt.at, prompt.shownLength, shown.length)
          this.logical.splice(prompt.at, prompt.shownLength, ...shown)
          this.rules.splice(prompt.at, prompt.shownLength, ...shown.map(line => line === '' ? '' : prompt.rule))
        }
        prompt.shownLength = shown.length
        this.shiftAfter(prompt.at, delta, prompt, fold)
        this.folds = this.folds.filter(candidate => candidate !== fold)
        delete prompt.fold
        continue
      }
      if (fold === undefined) {
        const expanded = prompt.preference ?? false
        const shown = expanded ? prompt.full : summary
        const delta = shown.length - prompt.shownLength
        if (delta !== 0 || shown.some((line, index) => line !== this.logical[prompt.at + index])) {
          mapped = this.mapViewportAnchor(mapped, prompt.at, prompt.shownLength, shown.length)
          this.mapFindHits(prompt.at, prompt.shownLength, shown.length)
          this.logical.splice(prompt.at, prompt.shownLength, ...shown)
          this.rules.splice(prompt.at, prompt.shownLength, ...shown.map(line => line === '' ? '' : prompt.rule))
        }
        const created: Fold = {
          at: prompt.at,
          shownLength: shown.length,
          summary,
          full: prompt.full,
          expanded,
          manual: prompt.preference !== undefined,
          rule: prompt.rule,
          label: 'prompt',
        }
        prompt.fold = created
        prompt.shownLength = shown.length
        this.folds.push(created)
        this.folds.sort((left, right) => left.at - right.at)
        this.shiftAfter(prompt.at, delta, prompt, created)
        continue
      }
      fold.summary = summary
      if (fold.expanded) continue
      const delta = summary.length - prompt.shownLength
      if (delta !== 0 || summary.some((line, index) => line !== this.logical[prompt.at + index])) {
        mapped = this.mapViewportAnchor(mapped, prompt.at, prompt.shownLength, summary.length)
        this.mapFindHits(prompt.at, prompt.shownLength, summary.length)
        this.logical.splice(prompt.at, prompt.shownLength, ...summary)
        this.rules.splice(prompt.at, prompt.shownLength, ...summary.map(line => line === '' ? '' : prompt.rule))
      }
      fold.shownLength = summary.length
      prompt.shownLength = summary.length
      this.shiftAfter(prompt.at, delta, prompt, fold)
    }
    return mapped
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
   * @param enter - child session a click opens instead of folding, when set.
   */
  appendFold(summary: readonly string[], full: readonly string[], rule = '', label = '', enter?: string): void {
    const shown = summary
    this.folds.push({
      at: this.logical.length,
      shownLength: shown.length,
      summary: [...summary],
      full: [...full],
      expanded: false,
      manual: false,
      rule,
      label,
      ...enter === undefined ? {} : { enter },
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
      manual: false,
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
    return this.folds.length > 0 && this.folds.every(fold => fold.expanded)
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
    this.setFolds(!this.folds.every(fold => fold.expanded), true)
    return true
  }

  /** Return automatic folds to their summaries while preserving explicit choices. */
  collapseFolds(): void {
    if (this.folds.some(fold => !fold.manual && fold.expanded)) this.setFolds(false, false, true)
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
    if (fold.enter !== undefined && this.enterHandler !== undefined) {
      this.enterHandler(fold.enter)
      return
    }
    this.setFold(fold, !fold.expanded, true)
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
  private setFold(fold: Fold, expanded: boolean, manual: boolean): void {
    this.clearTailAnchor()
    const shown = expanded ? fold.full : fold.summary
    const delta = shown.length - fold.shownLength
    this.mapFindHits(fold.at, fold.shownLength, shown.length)
    this.logical.splice(fold.at, fold.shownLength, ...shown)
    this.rules.splice(fold.at, fold.shownLength, ...shown.map(line => line === '' ? '' : fold.rule))
    fold.shownLength = shown.length
    fold.expanded = expanded
    fold.manual = manual
    // Only what sits after the block moves; the block starts where it started.
    for (const other of this.folds) if (other.at > fold.at) other.at += delta
    for (const prompt of this.prompts) {
      if (prompt.fold === fold) {
        prompt.shownLength = shown.length
        if (manual) prompt.preference = expanded
        else delete prompt.preference
      }
      else if (prompt.at > fold.at) prompt.at += delta
    }
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

  /** Put chosen folds into one form and optionally pin that choice. */
  private setFolds(expanded: boolean, manual: boolean, automaticOnly = false): void {
    this.clearTailAnchor()
    const anchor = this.offset > 0 ? this.viewportAnchor() : undefined
    // Rebuild back to front, so earlier folds' positions stay valid while the
    // later ones are spliced; remember each block's growth for the fix-up.
    const deltas = new Map<Fold, number>()
    const original = new Map(this.folds.map(fold => [fold, fold.at]))
    const originalLengths = new Map(this.folds.map(fold => [fold, fold.shownLength]))
    const promptByFold = new Map(this.prompts.flatMap(prompt => prompt.fold === undefined ? [] : [[prompt.fold, prompt] as const]))
    for (const fold of [...this.folds].reverse()) {
      if (automaticOnly && fold.manual) {
        deltas.set(fold, 0)
        continue
      }
      if (fold.expanded === expanded) {
        fold.manual = manual
        const prompt = promptByFold.get(fold)
        if (prompt !== undefined) {
          if (manual) prompt.preference = expanded
          else delete prompt.preference
        }
        deltas.set(fold, 0)
        continue
      }
      const shown = expanded ? fold.full : fold.summary
      this.mapFindHits(fold.at, fold.shownLength, shown.length)
      this.logical.splice(fold.at, fold.shownLength, ...shown)
      this.rules.splice(fold.at, fold.shownLength, ...shown.map(line => line === '' ? '' : fold.rule))
      deltas.set(fold, shown.length - fold.shownLength)
      fold.shownLength = shown.length
      fold.expanded = expanded
      fold.manual = manual
    }
    // Positions after each splice shift by the growth of everything spliced
    // before them; recompute from the front.
    let shift = 0
    for (const fold of this.folds) {
      fold.at += shift
      shift += deltas.get(fold) ?? 0
    }
    for (const prompt of this.prompts) {
      if (prompt.fold !== undefined) {
        prompt.at = prompt.fold.at
        prompt.shownLength = prompt.fold.shownLength
        if (!automaticOnly || !prompt.fold.manual) {
          if (prompt.fold.manual) prompt.preference = prompt.fold.expanded
          else delete prompt.preference
        }
        continue
      }
      let moved = 0
      for (const fold of this.folds) {
        if ((original.get(fold) ?? fold.at) >= prompt.at) break
        moved += deltas.get(fold) ?? 0
      }
      prompt.at += moved
    }
    let mappedAnchor = anchor
    if (anchor !== undefined) {
      let shift = 0
      let logical = anchor.logical
      for (const fold of this.folds) {
        const at = original.get(fold) ?? fold.at
        const length = originalLengths.get(fold) ?? fold.shownLength
        if (anchor.logical < at) break
        if (anchor.logical < at + length) {
          logical = at + shift + Math.min(anchor.logical - at, Math.max(0, fold.shownLength - 1))
          break
        }
        shift += deltas.get(fold) ?? 0
        logical = anchor.logical + shift
      }
      mappedAnchor = { logical, within: anchor.within }
    }
    this.rewrap()
    if (mappedAnchor !== undefined) this.restoreViewportAnchor(mappedAnchor)
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
    if (rows.length !== this.chrome.length) this.cancelTimelineNavigation()
    // Cut, never wrapped: a box border that wrapped would push the layout down
    // a row and the frame would disagree with itself.
    this.chrome = rows.map(row => truncate(row, this.contentColumns()))
    this.chromeCursor = { ...cursor }
    this.chromeFocus = focus
    this.refreshTailAnchor()
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
   * Float rows over the viewport just above the chrome.
   *
   * The chrome's height does not change, so opening a completion menu cannot
   * shake the transcript. Empty clears the layer.
   * @param rows - the overlay, top to bottom.
   */
  setOverlay(rows: readonly string[]): void {
    if (rows.length === this.overlay.length && rows.every((row, index) => row === this.overlay[index])) return
    this.overlay = [...rows]
    this.render()
  }

  /** Replace the entire visible frame with a transient reader; omit to restore it. */
  setViewer(rows: readonly string[] | undefined): void {
    const next = rows === undefined ? undefined : [...rows]
    if (next === undefined && this.viewer === undefined) return
    if (next !== undefined && this.viewer !== undefined && next.length === this.viewer.length
      && next.every((row, index) => row === this.viewer?.[index])) return
    this.cancelTimelineNavigation()
    this.viewer = next
    this.painted = []
    this.paintedTimeline = []
    this.render()
  }

  /** Hide the right-column timeline while a modal surface owns the viewport. */
  setTimelineHidden(hidden: boolean): void {
    if (hidden === this.timelineHidden) return
    if (this.timelinePointer !== undefined) this.painted = []
    this.timelineHidden = hidden
    this.timelinePointer = undefined
    this.cancelTimelineNavigation()
    this.render()
  }

  /**
   * Scroll the transcript.
   * @param delta - rows to move; negative scrolls back into history.
   */
  scrollBy(delta: number): void {
    const anchored = this.tailAnchor !== undefined
    this.clearTailAnchor()
    const limit = Math.max(0, this.physical.length - this.viewportHeight())
    const next = Math.min(limit, Math.max(0, this.offset - delta))
    if (next === this.offset && !anchored) return
    this.cancelTimelineNavigation()
    this.offset = next
    this.suppressNotice = false
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
    const anchored = this.tailAnchor !== undefined
    this.clearTailAnchor()
    if (this.offset === 0 && !anchored) return
    this.cancelTimelineNavigation()
    this.offset = 0
    this.suppressNotice = false
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
    const hits = this.collectFindHits(query)
    const index = hits.length === 0 ? 0 : hits.length - 1
    this.find = { query, hits, index }
    this.revealFindHit()
    return { query, hits: hits.length, index }
  }

  /** Locate physical matches while assigning each a stable logical identity. */
  private collectFindHits(query: string): FindHit[] {
    const hits: FindHit[] = []
    const needle = query.toLowerCase()
    if (needle !== '') {
      const occurrences = new Map<number, number>()
      for (const [row, line] of this.physical.entries()) {
        const plain = line.replaceAll(STYLES, '')
        const lower = plain.toLowerCase()
        const logical = this.physicalLogical[row] ?? -1
        let from = 0
        for (;;) {
          const at = lower.indexOf(needle, from)
          if (at < 0) break
          const occurrence = occurrences.get(logical) ?? 0
          hits.push({ row, start: at, end: at + needle.length, logical, occurrence })
          occurrences.set(logical, occurrence + 1)
          from = at + needle.length
        }
      }
    }
    return hits
  }

  /** Re-index search rows after wrapping or logical splices without moving the reader. */
  private refreshTranscriptSearch(): void {
    const find = this.find
    if (find === undefined) return
    const selected = find.hits[find.index]
    const hits = this.collectFindHits(find.query)
    let index = Math.min(find.index, Math.max(0, hits.length - 1))
    if (selected !== undefined) {
      const preserved = hits.findIndex(hit =>
        hit.logical === selected.logical && hit.occurrence === selected.occurrence)
      if (preserved >= 0) index = preserved
    }
    find.hits = hits
    find.index = index
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
    this.cancelTimelineNavigation()
    this.clearTailAnchor()
    this.suppressNotice = false
    const hit = this.find?.hits[this.find.index]
    if (hit === undefined) {
      this.render()
      return
    }
    const { end, first } = this.frameLayout()
    if (hit.row < first || hit.row >= end) {
      const height = this.viewportHeight()
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
    this.physicalLogical = []
    this.folds = []
    this.prompts = []
    this.promptLayoutCache = undefined
    this.ranges = undefined
    this.hovered = undefined
    this.pressedSticky = undefined
    this.selection = undefined
    this.pressedTimeline = undefined
    this.timelinePointer = undefined
    this.find = undefined
    this.offset = 0
    this.clearTailAnchor()
    this.suppressNotice = false
    this.painted = []
    this.paintedTimeline = []
    this.render()
  }

  /** Logical line and wrapped subrow currently at the top of transcript content. */
  private viewportAnchor(): ViewportAnchor | undefined {
    const row = this.frameLayout().first
    const logical = this.physicalLogical[row]
    if (logical === undefined) return undefined
    let within = 0
    for (let at = row - 1; at >= 0 && this.physicalLogical[at] === logical; at -= 1) within += 1
    return { logical, within }
  }

  /** Reposition a scrolled viewport at a logical line after layout changes. */
  private restoreViewportAnchor(anchor: ViewportAnchor): void {
    const rows: number[] = []
    for (const [row, logical] of this.physicalLogical.entries()) if (logical === anchor.logical) rows.push(row)
    const target = rows[Math.min(anchor.within, Math.max(0, rows.length - 1))]
    if (target === undefined) return
    const limit = Math.max(0, this.physical.length - this.viewportHeight())
    let next = Math.min(limit, this.offset)
    for (let pass = 0; pass < 4; pass += 1) {
      const difference = this.frameLayout(next).first - target
      if (difference === 0) break
      next = Math.min(limit, Math.max(0, next + difference))
    }
    this.offset = next
  }

  /** Re-wrap and repaint after the terminal changed size. */
  resize(): void {
    this.cancelTimelineNavigation()
    const following = this.offset === 0
    const anchor = this.refreshPromptFolds(this.viewportAnchor())
    this.rewrap()
    if (!following && anchor !== undefined) this.restoreViewportAnchor(anchor)
    this.refreshTailAnchor()
    // Nothing on screen can be trusted at a new size; the next frame is full.
    this.painted = []
    this.paintedTimeline = []
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
    const frame = this.frameLayout()
    const marks = this.timelineMarks(frame)
    const previous = this.timelinePointer === undefined
      ? undefined
      : this.timelineMarkAt(this.timelinePointer.row, this.timelinePointer.column, marks)
    const timeline = this.timelineMarkAt(row, column, marks)
    if (this.coversTimeline(row, column, marks)) {
      this.timelinePointer = { row, column }
      if (timeline !== previous || this.hovered !== undefined) {
        this.hovered = undefined
        this.painted = []
        this.render()
      }
      return undefined
    }
    this.timelinePointer = undefined
    if (previous !== undefined) {
      this.painted = []
      this.render()
    }
    if (this.coversOverlay(row)) {
      if (this.hovered !== undefined) {
        this.hovered = undefined
        this.render()
      }
      return undefined
    }
    const at = this.locate(row, column, false)
    const fold = at === undefined ? undefined : this.foldAt(at.row)
    if (fold !== this.hovered) {
      this.hovered = fold
      this.render()
    }
    if (fold === undefined) return undefined
    return {
      label: fold.label,
      lines: fold.full.length,
      expanded: fold.expanded,
      ...fold.enter === undefined ? {} : { enter: true },
    }
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
    const frame = this.frameLayout()
    const marks = this.timelineMarks(frame)
    const timeline = this.timelineMarkAt(row, column, marks)
    if (this.coversTimeline(row, column, marks)) {
      const target = timeline === undefined ? undefined : timeline.kind === 'turn' ? timeline.turn : timeline.target
      this.pressedTimeline = timeline === undefined || target === undefined ? null : this.prompts[target]
      return
    }
    const had = this.selection !== undefined
    this.selection = undefined
    this.pressedSticky = undefined
    if (this.coversOverlay(row)) {
      if (had) this.render()
      return
    }
    const stickyPrompt = this.stickyPromptAt(row)
    if (stickyPrompt !== undefined) {
      this.pressedSticky = stickyPrompt
      if (had) this.render()
      return
    }
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
    if (this.pressedTimeline !== undefined) {
      // The drag cancels navigation but remains a rail-owned gesture through
      // release, so an older transcript selection can never be copied again.
      this.pressedTimeline = null
      return
    }
    if (this.pressedSticky !== undefined) {
      this.pressedSticky = undefined
      return
    }
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
    const timeline = this.pressedTimeline
    this.pressedTimeline = undefined
    if (timeline !== undefined) {
      if (timeline !== null) {
        const turn = this.prompts.indexOf(timeline)
        if (turn >= 0) this.jumpToTurn(turn)
      }
      return undefined
    }
    const sticky = this.pressedSticky
    this.pressedSticky = undefined
    if (sticky?.fold !== undefined) {
      this.setFold(sticky.fold, true, true)
      const at = this.promptLayouts().find(layout => layout.prompt === sticky)?.at
      if (at !== undefined) {
        const limit = Math.max(0, this.physical.length - this.viewportHeight())
        this.offset = Math.min(limit, Math.max(0, this.physical.length - at - this.viewportHeight()))
        this.painted = []
        this.render()
      }
      return undefined
    }
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
  /** Whether a terminal row sits on the floating completion layer. */
  private coversOverlay(row: number): boolean {
    if (this.overlay.length === 0) return false
    const chromeStart = this.host.rows() - this.chrome.length
    const overlayStart = chromeStart - this.overlay.length
    return row - 1 >= overlayStart && row - 1 < chromeStart
  }

  /** Sticky header content under a terminal row; its gap is not interactive. */
  private stickyPromptAt(row: number): TurnPrompt | undefined {
    const { sticky, prompts } = this.frameLayout()
    if (sticky === undefined || row < 1 || row > sticky.renderHeight) return undefined
    return prompts[sticky.prompt]?.prompt
  }

  /** Marks currently visible in the rightmost terminal column. */
  private timelineMarks(frame: FrameLayout): TimelineMark[] {
    if (this.timelineHidden || frame.prompts.length < 2 || frame.height < 3) return []
    const current = this.currentTurnFor(frame)
    if (current === undefined) return []
    let above: number | undefined
    let below: number | undefined
    for (const [index, layout] of frame.prompts.entries()) {
      if (layout.at < frame.first) above = index
      else if (layout.at > frame.first && below === undefined) below = index
    }
    if (this.offset === 0) {
      below = undefined
    }
    return computeTimeline(frame.prompts.length, current, frame.height, {
      ...above === undefined ? {} : { above },
      ...below === undefined ? {} : { below },
    })
  }

  /** Timeline mark under a terminal position, including navigation arrows. */
  private timelineMarkAt(row: number, column: number, marks: readonly TimelineMark[]): TimelineMark | undefined {
    if (column !== this.host.columns() || row < 1 || row > this.viewportHeight()) return undefined
    return marks.find(mark => mark.row === row - 1)
  }

  /** Whether the active rail owns a terminal cell, including gaps between marks. */
  private coversTimeline(row: number, column: number, marks: readonly TimelineMark[]): boolean {
    return marks.length > 0 && column === this.host.columns() && row >= 1 && row <= this.viewportHeight()
  }

  /** Apply the real user's colour from its rule to the current timeline dot. */
  private timelineGlyph(mark: TimelineMark, hovered: boolean): string {
    if (mark.kind === 'above' || mark.kind === 'below') {
      const glyph = mark.kind === 'above' ? '↑' : '↓'
      if (mark.target === undefined) return `\u001B[2m${glyph}${RESET}`
      return hovered ? `\u001B[1m${glyph}${RESET}` : glyph
    }
    if (!mark.current) return hovered ? '·' : `\u001B[2m·${RESET}`
    const style = this.prompts[mark.turn]?.rule.match(STYLES)?.[0]
    return style === undefined ? '●' : `${style}●${RESET}`
  }

  /** Two display-only rows painted beside the hovered tick. */
  private timelinePreview(marks: readonly TimelineMark[]): { row: number; column: number; rows: string[] } | undefined {
    const pointer = this.timelinePointer
    if (pointer === undefined || this.timelineHidden) return undefined
    const mark = this.timelineMarkAt(pointer.row, pointer.column, marks)
    if (mark?.kind !== 'turn') return undefined
    const prompt = this.prompts[mark.turn]
    if (prompt === undefined) return undefined
    const width = Math.min(32, Math.max(8, this.contentColumns() - 3))
    const wrapped = this.explicitPromptLines(prompt).flatMap(line => wrapStyled(line, width))
    const rows = wrapped.slice(0, 2)
    if (wrapped.length > rows.length && rows.length > 0) {
      const last = rows.length - 1
      rows[last] = truncate(`${rows[last] ?? ''} …`, width)
    }
    if (rows.length === 0) return undefined
    const row = Math.min(Math.max(0, mark.row), Math.max(0, this.viewportHeight() - rows.length))
    return { row, column: Math.max(GUTTER + 1, this.host.columns() - width), rows }
  }

  private locate(row: number, column: number, clamp: boolean): { row: number; column: number } | undefined {
    if (this.physical.length === 0) return undefined
    const { height, end, first, sticky } = this.frameLayout()
    const physicalEnd = Math.min(end, this.physical.length)
    const reserved = sticky?.reservedRows ?? 0
    const contentHeight = height - reserved
    let visual = row - 1 - reserved
    if (!clamp && (visual < 0 || visual >= contentHeight || first + visual >= physicalEnd)) return undefined
    visual = Math.min(Math.max(visual, 0), Math.max(0, Math.min(contentHeight, physicalEnd - first) - 1))
    const index = Math.min(Math.max(first + visual, first), physicalEnd - 1)
    return { row: index, column: Math.max(0, column - 1 - GUTTER) }
  }

  /** Rows the transcript viewport occupies. */
  private viewportHeight(): number {
    return Math.max(1, this.host.rows() - this.chrome.length)
  }

  /** Columns content is laid out for, one short of the width so no row wraps. */
  private contentColumns(): number {
    return Math.max(1, this.host.columns() - 1 - GUTTER)
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
    this.promptLayoutCache = undefined
    this.cancelTimelineNavigation()
    this.physical = []
    this.ruleWidths = []
    this.physicalLogical = []
    for (const [at, line] of this.logical.entries()) {
      const rule = this.rules[at] ?? ''
      const width = displayWidth(rule)
      for (const row of this.wrapLine(line, rule, columns)) {
        this.physical.push(row)
        this.ruleWidths.push(width)
        this.physicalLogical.push(at)
      }
    }
    this.refreshTranscriptSearch()
  }

  /** User prompts measured in the same physical rows the viewport scrolls. */
  private promptLayouts(): PromptLayout[] {
    if (this.promptLayoutCache !== undefined) return this.promptLayoutCache
    const columns = this.contentColumns()
    const layouts: PromptLayout[] = []
    let logical = 0
    let physical = 0
    const height = (index: number): number =>
      this.wrapLine(this.logical[index] ?? '', this.rules[index] ?? '', columns).length
    for (const prompt of this.prompts) {
      for (; logical < prompt.at; logical += 1) physical += height(logical)
      const at = physical
      let contentLength = prompt.shownLength
      if (this.logical[prompt.at + contentLength - 1] === '') contentLength -= 1
      for (; logical < prompt.at + contentLength; logical += 1) physical += height(logical)
      layouts.push({ prompt, at, rows: this.physical.slice(at, physical) })
      for (; logical < prompt.at + prompt.shownLength; logical += 1) physical += height(logical)
    }
    this.promptLayoutCache = layouts
    return layouts
  }

  /** Re-wrap every kept line at the current width. */
  private rewrap(): void {
    // Physical rows are the selection's coordinate system; a reflow voids it.
    this.selection = undefined
    this.wrapBuffer()
    const limit = Math.max(0, this.physical.length - this.viewportHeight())
    this.offset = Math.min(this.offset, limit)
  }

  /** All row geometry needed to compose one frame at an offset. */
  private frameLayout(offset = this.offset): FrameLayout {
    const height = this.viewportHeight()
    const end = this.physical.length + this.tailRows - offset
    const scrollTop = Math.max(0, end - height)
    const prompts = this.promptLayouts()
    const sticky = computeStickyLayout(scrollTop, height, prompts.map(({ prompt, at, rows }) => ({
      at,
      fullHeight: rows.length,
      // Explicit newlines carry meaning: a short two- or three-line request
      // must remain readable as a unit after it pins. A single logical line
      // may still compact after wrapping, while prompts long enough to own a
      // Fold retain the existing three-rows-to-one sticky behaviour. The
      // count arrives from Transcript so generated image metadata is excluded.
      minHeight: prompt.fold === undefined && prompt.explicitLines > 1
        ? rows.length
        : 1,
      sticky: prompt.fold?.expanded !== true,
    })))
    const contentHeight = Math.max(0, height - (sticky?.reservedRows ?? 0))
    return { height, end, first: Math.max(0, end - contentHeight), prompts, sticky }
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
    if (this.viewer !== undefined) {
      const columns = this.host.columns()
      const height = this.host.rows()
      const shown = this.viewer.slice(0, height).map(row => truncate(row, this.contentColumns()))
      const frame = [...shown, ...Array.from({ length: Math.max(0, height - shown.length) }, () => '')]
      let out = SYNC_BEGIN + HIDE_CURSOR
      frame.forEach((row, index) => {
        if (this.painted[index] === row) return
        out += `\u001B[${index + 1};1H${CLEAR_LINE}${' '.repeat(GUTTER)}${row}`
      })
      for (let index = frame.length; index < this.painted.length; index += 1) {
        out += `\u001B[${index + 1};1H${CLEAR_LINE}`
      }
      for (let index = 0; index < Math.max(height, this.paintedTimeline.length); index += 1) {
        out += `\u001B[${index + 1};${columns}H `
      }
      out += SYNC_END
      this.host.write(out)
      this.painted = frame
      this.paintedTimeline = Array.from({ length: height }, () => ' ')
      return
    }
    const columns = this.host.columns()
    if (columns !== this.paintedColumns) {
      this.refreshPromptFolds()
      this.wrapBuffer()
      this.refreshTailAnchor()
      this.painted = []
      this.paintedTimeline = []
      this.paintedColumns = columns
    }
    const layout = this.frameLayout()
    const { height, end, first, prompts, sticky } = layout
    const timeline = this.timelineMarks(layout)
    const visible = this.physical.slice(first, Math.max(0, end))
    // Content tops the screen the way a fresh terminal reads — the welcome at
    // the top, the gap between it and the chrome — and grows downward until it
    // reaches the chrome and starts scrolling.
    const padding = Array.from({ length: Math.max(0, height - visible.length) }, () => '')
    const bounds = this.orderedSelection()
    if (bounds !== undefined) {
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
        const width = this.contentColumns()
        for (let at = range.from; at <= range.to; at += 1) {
          const index = at - first
          if (index >= 0 && index < visible.length) {
            visible[index] = fill(visible[index] ?? '', width, this.light)
          }
        }
      }
    }
    let viewport: string[]
    if (sticky !== undefined) {
      const source = prompts[sticky.prompt]?.rows ?? []
      const from = sticky.state === 'pushed' ? sticky.clipTop : 0
      const header = source.slice(from, from + sticky.renderHeight)
      const gap = sticky.state === 'pinned' && sticky.reservedRows > sticky.renderHeight
        ? [this.offset > 0 && this.notice !== '' ? truncate(this.notice, this.contentColumns()) : '']
        : []
      viewport = [...header, ...gap, ...visible, ...padding].slice(0, height)
    } else {
      viewport = [...visible, ...padding]
      // Scrolled back, the top row says so — replacing a row rather than adding
      // one, so the rest of the layout does not shift under the reader.
      if (this.offset > 0 && this.notice !== '' && !this.suppressNotice && viewport.length > 0) {
        viewport[0] = truncate(this.notice, this.contentColumns())
      }
    }
    if (this.overlay.length > 0 && viewport.length > 0) {
      const width = this.contentColumns()
      const start = Math.max(0, viewport.length - this.overlay.length)
      this.overlay.forEach((row, index) => {
        const at = start + index
        if (at < viewport.length) viewport[at] = fill(truncate(row, width), width, this.light)
      })
    }
    const frame = [...viewport, ...this.chrome]

    let out = SYNC_BEGIN + HIDE_CURSOR
    const repainted = new Set<number>()
    frame.forEach((row, index) => {
      // Only rows that changed are repainted: a frame that rewrites everything
      // makes a wide terminal flicker even inside a synchronized update.
      if (this.painted[index] === row) return
      repainted.add(index)
      out += `\u001B[${index + 1};1H${CLEAR_LINE}${' '.repeat(GUTTER)}${row}`
    })
    // A shrunken frame leaves rows behind; clear what the new one does not fill.
    for (let index = frame.length; index < this.painted.length; index += 1) {
      repainted.add(index)
      out += `\u001B[${index + 1};1H${CLEAR_LINE}`
    }
    const hoveredTimeline = this.timelinePointer === undefined
      ? undefined
      : this.timelineMarkAt(this.timelinePointer.row, this.timelinePointer.column, timeline)
    const preview = this.timelinePreview(timeline)
    if (preview !== undefined) {
      const width = this.host.columns() - preview.column
      preview.rows.forEach((row, index) => {
        out += `\u001B[${preview.row + index + 1};${preview.column}H${fill(truncate(row, width), width, this.light)}`
      })
    }
    const rail = Array.from({ length: height }, () => ' ')
    for (const mark of timeline) rail[mark.row] = this.timelineGlyph(mark, mark === hoveredTimeline)
    const railRows = Math.max(rail.length, this.paintedTimeline.length)
    for (let index = 0; index < railRows; index += 1) {
      const glyph = rail[index] ?? ' '
      if (glyph === this.paintedTimeline[index] && !repainted.has(index)) continue
      out += `\u001B[${index + 1};${columns}H${glyph}`
    }
    if (this.chromeFocus) {
      const row = frame.length - this.chrome.length + this.chromeCursor.row + 1
      out += `\u001B[${row};${this.chromeCursor.column + 1 + GUTTER}H${SHOW_CURSOR}`
    }
    out += SYNC_END
    this.host.write(out)
    this.painted = frame
    this.paintedTimeline = rail
  }
}
