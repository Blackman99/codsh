/**
 * The prompt as the person sees it: an input box, a completion menu, a working
 * indicator, a status row, and — when a decision is being asked — a selection
 * widget in the box's place, or a compact /ship grill card above the box.
 *
 * This is where the two input shapes meet. On a terminal it drives the editor
 * from decoded keys and owns the bottom region; off one it reads lines from the
 * pipe and draws nothing. Callers ask for the next submission either way.
 * @module codsh-bundle/src/prompt
 */

import { Editor, imageTokenRanges } from './editor.ts'
import { generateImageThumbnail, imagePreviewCard, nativePreviewProtocol, openOriginalImage, readImageMetadata } from './image-preview.ts'
import type { ImagePreview } from './image-preview.ts'
import { caretAt, inputBox, menuScrollFrom, menuScrollLimit, menuTargetAt, wrapBudget } from './inputbox.ts'
import { planReport, planSummary } from './plan.ts'
import type { Plan } from './plan.ts'
import { GUTTER } from './screen.ts'
import { FrontierCard } from './frontier-card.ts'
import { GateModal, gateChip } from './gate-modal.ts'
import { Selector } from './selector.ts'
import { FullscreenViewer } from './viewer.ts'
import { DEFAULT_DENSITY, type Density } from './density.ts'
import { truncate } from './theme.ts'
import { todoReport, todoRow } from './todos.ts'
import { MessageQueue } from './queue.ts'
import { QueuePanel, queueRow, steerRefusal, steeringRow } from './queue-panel.ts'
import type { QueueItem } from './queue.ts'
import type { PanelAction, PanelTarget } from './queue-panel.ts'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import type { ClipboardImage } from './clipboard-image.ts'
import type { TerminalConsole } from './console.ts'
import type { EditorSources } from './editor.ts'
import type { FrontierOutcome, FrontierSpec } from './frontier-card.ts'
import type { GateAction, GateModalSpec } from './gate-modal.ts'
import type { Key } from './keys.ts'
import type { SelectOutcome, SelectSpec, SelectorStep, SelectorTarget } from './selector.ts'
import type { Theme } from './theme.ts'
import type { TodoList } from './todos.ts'
import type { ViewerSpec } from './viewer.ts'

/** How long a flash notice holds the hint row. */
const FLASH_MS = 1500

/**
 * Most todo items the expanded list may occupy.
 *
 * The chrome never scrolls, so an unbounded list would push the box off a short
 * terminal; the items past the cap are counted, never silently dropped.
 */
const TODO_ROWS = 10

/** What the prompt reports to its owner. */
export interface PromptHandlers {
  /** Ctrl-C: stop the work, or leave. */
  interrupt(): void
  /** Escape with nothing of the prompt's own to dismiss: stop the work. */
  escape(): void
  /** Ctrl-D on an untouched prompt: leave. */
  eof(): void
  /** Shift-Tab: cycle the session's mode. */
  shiftTab?(): void
  /** Ctrl-O: show the last clipped tool output in full. */
  expandOutput?(): void
  /** Shift-Left/Right: move between real user turns. */
  turn?(direction: -1 | 1): void
  /**
   * Ctrl-V: the system clipboard's image, or undefined for none.
   *
   * Injected rather than imported so the pure-module tests can hand the
   * prompt a fixture instead of a machine's clipboard.
   */
  readClipboardImage?(): Promise<ClipboardImage | undefined>
  /**
   * /ship GateModal opened or closed: refresh the MetaBar shipGate chip.
   * @param gate - 1 or 2 while open, undefined when cleared.
   */
  shipGate?(gate: 1 | 2 | undefined): void
  /**
   * Ctrl-Enter, or `s` in the queue panel: hand a prompt to the RUNNING turn.
   *
   * The owner prepares its images and gives it to the agent's inbox; the
   * prompt shows it as steering until {@link Prompt.steerClaimed} says the
   * model has it, or {@link Prompt.steerReturned} gives it back.
   * @returns 'steered' once the agent holds it; 'idle' when no turn was running to take it.
   */
  steer?(item: QueueItem): Promise<'steered' | 'idle'>
}

/**
 * One pasted image awaiting its submission.
 *
 * The wire form the runtime admits, plus the dimensions the paste already
 * probed — the submission pipeline says them back without re-decoding.
 */
export interface PendingImage {
  /** The number the `[Image #N]` token wears, for context that names it back. */
  id: number
  /** Base64 bytes and their sniffed media type. */
  image: EncodedImageAttachment
  width?: number
  height?: number
  byteSize?: number
  thumbnail?: string[]
  /**
   * Whether a mosaic has already been asked for.
   *
   * The decode runs in a child process and can come back with nothing — an
   * image no decoder here understands. Without this, that answer would be
   * re-asked on every cursor move that lands beside the token.
   */
  thumbnailRequested?: boolean
}

/**
 * One waiting read.
 *
 * A `turn` read is the loop asking for the next thing to run, and type-ahead
 * answers it first. An `answer` read is a question asked mid-turn, which only
 * the keyboard may answer: a line queued for the next turn is not a reply to a
 * question nobody had asked yet.
 */
interface Pending {
  kind: 'turn' | 'answer'
  resolve(text: string | undefined): void
  dispose(): void
}

/** One selection in progress. */
interface ActiveSelect {
  selector: Selector
  resolve(outcome: SelectOutcome): void
  dispose(): void
  preview?: (index: number) => void
  highlighted?: number
}

/** One transient full-screen reader in progress. */
interface ActiveView {
  viewer: FullscreenViewer
  resolve(): void
  dispose(): void
}

/** One /ship approval gate in progress. */
interface ActiveGate {
  modal: GateModal
  resolve(action: GateAction): void
  dispose(): void
}

/** One /ship grill frontier card in progress. */
interface ActiveFrontier {
  card: FrontierCard
  resolve(outcome: FrontierOutcome): void
  dispose(): void
}

/** Drives the input box and answers reads and selections. */
/** What sits under a pointer in the region below the transcript. */
type RegionTarget =
  | { kind: 'selector'; target: SelectorTarget }
  | { kind: 'candidate'; index: number }
  | { kind: 'caret'; row: number; cell: number }
  | { kind: 'todos' }
  /** The collapsed queue readout: a click opens the panel. */
  | { kind: 'queue' }
  /** A row of the open queue panel. */
  | { kind: 'queue-panel'; target: PanelTarget }

export class Prompt {
  private readonly editor: Editor
  private pending: Pending | undefined
  private select_: ActiveSelect | undefined
  private view_: ActiveView | undefined
  private gate_: ActiveGate | undefined
  private frontier_: ActiveFrontier | undefined
  /** Open /ship gate number mirrored into StatusFacts via handlers.shipGate. */
  private shipGate_: 1 | 2 | undefined
  /**
   * Submissions made before anything asked for them.
   *
   * Typing while the agent works — or in the instant before a read begins — must
   * not be lost. Adjacent prompts leave as one message; `!` and `/` lines keep
   * their place and leave alone.
   */
  private readonly queue = new MessageQueue()
  /** Prompts handed to the running turn, until the agent claims them. */
  private inFlight: QueueItem[] = []
  /** The queue panel's view state, meaningful while {@link queueOpen}. */
  private readonly panel = new QueuePanel()
  /** Whether the queue panel has the keyboard, in the readout's place. */
  private queueOpen = false
  /** Where the queue's rows sit among the chrome rows, and how many. */
  private queueRowsAt: { start: number; count: number } | undefined
  /** Whether the submission in flight steers the running turn (Ctrl-Enter). */
  private steerNext = false
  /** Images pasted into the box, by the number their `[Image #N]` token wears. */
  private readonly pendingImages = new Map<number, PendingImage>()
  /** Numbers are never reused within a session: a recalled token must not
   * silently pick up a different image. */
  private imageCounter = 0
  /** The images belonging to the line the last read handed out. */
  private submittedImages: PendingImage[] = []
  /** Whether a clipboard read is already in flight; a second Ctrl+V waits. */
  private pastingImage = false
  /** The working indicator shown under the box. */
  private hint: string | undefined
  /**
   * What the hint row says when nothing else needs it: the key legend.
   *
   * With a legend the hint row is always there, so a hint, a flash, a find,
   * or a hover replaces it instead of adding a row — the box never moves.
   * Without one (a pipe, a test that set none) the row is absent as before.
   */
  private legend: string | undefined
  /** A short-lived notice that borrows the hint row, e.g. the copy toast. */
  private flash: string | undefined
  /** What the pointer is resting on, borrowing the hint row while it rests. */
  private hover: string | undefined
  private flashTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Where the selector's own rows begin among the chrome rows.
   *
   * Recorded while the chrome is composed, because that is the only moment
   * anything knows the offset: the region is handed over as a flat array of
   * strings and every part's position is lost with it.
   */
  private selectorRow: number | undefined
  /** Where the box's own rows begin among the chrome rows, and how many. */
  private boxRows: { start: number; count: number } | undefined
  /** Where the plan/todo readout sits among the chrome rows, and how many. */
  private todoRowsAt: { start: number; count: number } | undefined
  /**
   * What a press landed on, so a release somewhere else cancels it.
   *
   * A press that commits on the way down has no way back; sliding off before
   * letting go is the escape hatch every button has.
   */
  private pressedTarget: RegionTarget | undefined
  /**
   * Whether the press in flight anchored in the viewport rather than a region.
   *
   * A gesture belongs to where it began, through release: sweeping down past
   * the last line and letting go over the input box is how a person selects to
   * the end of what they can see, and the release is what copies.
   */
  private pressedViewport = false
  /**
   * Where a press landed in the buffer, when it landed in the box.
   *
   * A click waits for the release to place the cursor — putting one somewhere
   * is not a thing to be undone. A drag uses this as the selection's anchor.
   */
  private pressedCaret: { row: number; column: number } | undefined
  /** Whether the box-owned press in flight has moved, which makes it a selection. */
  private boxDragging = false
  /** Chrome rows last composed, so a drag that left the box can still clamp into it. */
  private chromeHeight = 0
  /** The row the pointer last marked, so a move that changes nothing repaints nothing. */
  private regionHover = ''
  /** The plan a `/ship` run is working through, when one has been found. */
  private plan: Plan | undefined
  /** The menu row a pointer rests on, handed to the box each render. */
  private menuHover: number | undefined
  /** The always-current session facts shown as the region's last row. */
  private status: string | ((columns: number) => string) | undefined
  /**
   * The agent's current todo list, kept in the chrome rather than only in the
   * transcript: the card that announced it scrolls away, this does not.
   */
  private todos: TodoList = []
  /** Whether the todo readout shows every item or only the one in flight. */
  private todosExpanded = false
  /** Incremental find over the transcript, absent when find is closed. */
  private finding: string | undefined
  /** Whether the shortcuts overlay is occupying chrome. */
  private shortcutsOpen = false
  /** The assistant line(s) still arriving, shown above the box. */
  private streaming: string | readonly string[] | undefined
  /** Live density; comfortable adds room in the transcript without touching prompt chrome. */
  private density: Density = DEFAULT_DENSITY
  /** Frame styling for the current mode, e.g. plan mode's accent. */
  private accent: ((text: string) => string) | undefined
  /** Whether a read is outstanding, which decides where a submission goes. */
  private reading = false
  /** Wheel rows accumulated this tick, painted once — scrolling per event janks. */
  private pendingScroll = 0
  private scrollFlushQueued = false
  /**
   * Whether the interactive session is running, which is when the box is worth
   * drawing. The box stays up while the agent works — typing ahead must be
   * visible, and a prompt that vanishes for every turn reads as losing focus —
   * so this is session-scoped, not read-scoped.
   */
  private engaged = false

  constructor(
    private readonly console: TerminalConsole,
    private readonly theme: Theme,
    sources: EditorSources,
    private readonly handlers: PromptHandlers,
    /** Dim text shown inside an empty box. */
    private readonly placeholder?: string,
  ) {
    this.editor = new Editor(sources)
    if (this.console.readsKeys) {
      this.console.onKey((key) => { this.onKey(key) })
      this.console.onResize(() => { this.render() })
    }
  }

  /** The editor's submission history, for persistence. */
  get history(): readonly string[] {
    return this.editor.pastSubmissions
  }

  /**
   * Preload history from an earlier session.
   * @param entries - past submissions, oldest first.
   */
  seedHistory(entries: readonly string[]): void {
    this.editor.seedHistory(entries)
  }

  /** Whether the box holds no typed text. */
  get empty(): boolean {
    return this.editor.empty
  }

  /**
   * Show the input box from now on, independent of an outstanding read.
   * @param engaged - whether the interactive session is running.
   */
  setEngaged(engaged: boolean): void {
    this.engaged = engaged
    this.render()
  }

  /**
   * Put earlier text back into the box for editing.
   * @param text - the text to edit.
   */
  prefill(text: string): void {
    this.editor.prefill(text)
    this.render()
  }

  /**
   * Set the legend the hint row falls back to.
   * @param text - the legend, or undefined for no row when nothing else needs one.
   */
  setLegend(text: string | undefined): void {
    if (text === this.legend) return
    this.legend = text
    this.render()
  }

  /**
   * Switch density. Open folds elsewhere are not touched.
   * @param density - the live mode.
   */
  setDensity(density: Density): void {
    if (this.density === density) return
    this.density = density
    this.render()
  }

  setHint(text: string | undefined): void {
    if (text === this.hint) return
    this.hint = text
    this.render()
  }

  /**
   * Show a notice on the hint row briefly, then give the row back.
   *
   * The hint row belongs to the working indicator, which repaints itself
   * continuously — a notice written through setHint would last one tick. The
   * flash outranks the hint until its moment passes.
   * @param text - the styled notice.
   */
  setFlash(text: string): void {
    this.flash = text
    if (this.flashTimer !== undefined) clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => {
      this.flash = undefined
      this.flashTimer = undefined
      this.render()
    }, FLASH_MS)
    this.flashTimer.unref()
    this.render()
  }

  /**
   * Set the status row, the region's always-current last line.
   * @param text - the full styled row, a dynamic formatter taking display columns,
   *   or undefined to drop it. Truncation is applied at paint time so a resize
   *   can grow the line back.
   */
  setStatus(text: string | ((columns: number) => string) | undefined): void {
    if (text === this.status) return
    this.status = text
    this.render()
  }

  /**
   * Set the todo readout to the list the session now holds.
   *
   * Compared by content, not identity: this is pushed on every session event,
   * and a repaint per event would flicker the chrome for nothing.
   * @param todos - the current list, empty to drop the readout.
   */
  setTodos(todos: TodoList): void {
    if (todos.length === this.todos.length
      && todos.every((todo, at) => todo.content === this.todos[at]?.content
        && todo.status === this.todos[at]?.status)) return
    this.todos = todos
    this.render()
  }

  /**
   * Set the frame accent, which is how a mode shows on the box itself.
   * @param accent - the styling, or undefined for the default frame.
   */
  setAccent(accent: ((text: string) => string) | undefined): void {
    this.accent = accent
    this.render()
  }

  /**
   * Set or clear the MetaBar `/ship` gate chip.
   * @param gate - 1 or 2 while a GateModal is open, undefined to clear.
   */
  setShipGate(gate: 1 | 2 | undefined): void {
    if (this.shipGate_ === gate) return
    this.shipGate_ = gate
    this.handlers.shipGate?.(gate)
  }

  /** The open /ship gate number, if any. */
  get shipGate(): 1 | 2 | undefined {
    return this.shipGate_
  }

  /**
   * Set the assistant line currently arriving, shown above the box.
   * @param text - the partial line, or undefined when none is open.
   */
  setStreaming(text: string | readonly string[] | undefined): void {
    this.streaming = text
    this.render()
  }

  /**
   * Write one finished transcript line above the region.
   * @param line - the line to keep.
   * @param rule - a styled left rule marking which block the line belongs to.
   */
  write(line: string, rule = ''): void {
    this.console.write(line, rule)
  }

  /**
   * Wait for the next submitted text.
   * @param signal - abandons the read, which an aborted tool call does.
   * @returns the text, or undefined when input ended or the read was abandoned.
   */
  read(signal?: AbortSignal): Promise<string | undefined> {
    if (!this.console.readsKeys) return this.console.readLine(signal)
    // Type-ahead first: adjacent prompts leave as one message, a `!` or `/`
    // line alone, so the loop dispatches by prefix exactly as it does a line
    // typed at an idle prompt.
    const drained = this.queue.drain()
    if (drained !== undefined) {
      this.submittedImages = drained.images
      if (this.queue.length === 0) this.queueOpen = false
      this.render()
      return Promise.resolve(drained.text)
    }
    return this.awaitSubmission('turn', signal)
  }

  /**
   * Wait for the answer to a question asked mid-turn.
   *
   * Never served from the queue: a line typed for the NEXT turn is not the
   * reply to a question that had not been asked yet. It stays queued, visibly,
   * and the next Enter answers.
   * @param signal - abandons the read, which a cancelled tool call does.
   * @returns the answer, or undefined when input ended or the read was abandoned.
   */
  readAnswer(signal?: AbortSignal): Promise<string | undefined> {
    if (!this.console.readsKeys) return this.console.readLine(signal)
    return this.awaitSubmission('answer', signal)
  }

  /** Park a read until the next Enter. */
  private awaitSubmission(kind: Pending['kind'], signal?: AbortSignal): Promise<string | undefined> {
    if (this.console.finished) return Promise.resolve(undefined)
    this.reading = true
    this.render()
    return new Promise<string | undefined>((resolve) => {
      const settle = (text: string | undefined): void => {
        this.pending = undefined
        this.reading = false
        this.submittedImages = text === undefined ? [] : this.claimImages(text)
        resolve(text)
      }
      const onAbort = (): void => { settle(undefined) }
      this.pending = {
        kind,
        resolve: settle,
        dispose: () => { signal?.removeEventListener('abort', onAbort) },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Put one decision to the keyboard as an arrow-key selection.
   *
   * Only the terminal shape can offer this; the caller keeps a line-based
   * fallback for pipes, where the selection keys cannot arrive.
   * @param spec - the question and its options.
   * @param signal - cancels the selection, which an aborted tool call does.
   * @returns how the person decided.
   */
  select(spec: SelectSpec, signal?: AbortSignal, preview?: (index: number) => void): Promise<SelectOutcome> {
    if (this.console.finished || signal?.aborted === true) {
      return Promise.resolve({ kind: 'cancelled' })
    }
    return new Promise<SelectOutcome>((resolve) => {
      const settle = (outcome: SelectOutcome): void => {
        this.select_ = undefined
        resolve(outcome)
        this.render()
      }
      const onAbort = (): void => { settle({ kind: 'cancelled' }) }
      const selector = new Selector(spec)
      const highlighted = selector.highlighted
      this.select_ = {
        selector,
        resolve: settle,
        dispose: () => { signal?.removeEventListener('abort', onAbort) },
        ...preview === undefined ? {} : { preview },
        ...highlighted === undefined ? {} : { highlighted },
      }
      if (highlighted !== undefined) preview?.(highlighted)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.render()
    })
  }

  /** Open one raw-content target in a transient full-screen reader. */
  view(spec: ViewerSpec, signal?: AbortSignal): Promise<void> {
    if (!this.console.readsKeys || this.console.finished || signal?.aborted === true) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        const active = this.view_
        this.view_ = undefined
        active?.dispose()
        this.console.setViewer(undefined)
        resolve()
        this.render()
      }
      const onAbort = (): void => { settle() }
      this.view_ = {
        viewer: new FullscreenViewer(spec),
        resolve: settle,
        dispose: () => { signal?.removeEventListener('abort', onAbort) },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.render()
    })
  }

  /**
   * Put one /ship approval gate on the full-screen viewer surface.
   * @param spec - which gate, title, and body.
   * @param signal - cancels as abort (same as Esc/n).
   * @returns confirm | edit | abort.
   */
  gate(spec: GateModalSpec, signal?: AbortSignal): Promise<GateAction> {
    if (!this.console.readsKeys || this.console.finished || signal?.aborted === true) {
      return Promise.resolve('abort')
    }
    return new Promise<GateAction>((resolve) => {
      const settle = (action: GateAction): void => {
        const active = this.gate_
        this.gate_ = undefined
        active?.dispose()
        this.setShipGate(undefined)
        this.console.setViewer(undefined)
        resolve(action)
        this.render()
      }
      const onAbort = (): void => { settle('abort') }
      this.gate_ = {
        modal: new GateModal(spec),
        resolve: settle,
        dispose: () => { signal?.removeEventListener('abort', onAbort) },
      }
      this.setShipGate(gateChip(spec.kind))
      signal?.addEventListener('abort', onAbort, { once: true })
      this.render()
    })
  }

  /**
   * Put one /ship grill question on a compact card above the input.
   *
   * Not a viewer: the transcript and MetaBar stay up. Esc dismisses the card
   * (soft cancel) and does not abort /ship.
   * @param spec - the question and its options.
   * @param signal - cancels as dismiss (empty, not abort).
   */
  frontier(spec: FrontierSpec, signal?: AbortSignal): Promise<FrontierOutcome> {
    if (!this.console.readsKeys || this.console.finished || signal?.aborted === true) {
      return Promise.resolve({ kind: 'dismiss' })
    }
    return new Promise<FrontierOutcome>((resolve) => {
      const settle = (outcome: FrontierOutcome): void => {
        const active = this.frontier_
        this.frontier_ = undefined
        active?.dispose()
        if (outcome.kind === 'edit') this.editor.prefill(active?.card.focusedLabel ?? spec.options[0]?.label ?? '')
        resolve(outcome)
        this.render()
      }
      const onAbort = (): void => { settle({ kind: 'dismiss' }) }
      this.frontier_ = {
        card: new FrontierCard(spec),
        resolve: settle,
        dispose: () => { signal?.removeEventListener('abort', onAbort) },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.render()
    })
  }

  /** Take the region down, so what follows lands at the bottom of the screen. */
  clear(): void {
    this.reading = false
    this.console.clearRegion()
  }

  /**
   * Apply one key: control keys to the owner, a selection's keys to the
   * selector, everything else to the editor.
   * @param key - the decoded keystroke.
   */
  private onKey(key: Key): void {
    // Ctrl-C outranks every mode: the reflex to stop must always land.
    if (key.kind === 'interrupt') {
      this.shortcutsOpen = false
      this.queueOpen = false
      this.handlers.interrupt()
      return
    }
    const fronting = this.frontier_
    if (fronting !== undefined) {
      const action = fronting.card.handleKey(key)
      if (action === undefined) {
        this.render()
        return
      }
      if (action.kind === 'move') {
        this.render()
        return
      }
      // Esc is dismiss, never handlers.escape / abort ship.
      fronting.resolve(action)
      return
    }
    const gating = this.gate_
    if (gating !== undefined) {
      const action = gating.modal.handleKey(key, this.theme, this.console.contentColumns, this.console.rows)
      if (action !== undefined) {
        // settle (stored as resolve) clears gate_/viewer/shipGate — same path as abort.
        gating.resolve(action)
        return
      }
      this.render()
      return
    }
    const viewing = this.view_
    if (viewing !== undefined) {
      if (key.kind === 'escape') {
        viewing.resolve()
        return
      }
      if (key.kind === 'scroll') viewing.viewer.move({ kind: 'line', lines: key.lines }, this.theme, this.console.contentColumns, this.console.rows)
      else if (key.kind === 'turn') viewing.viewer.move({ kind: 'line', lines: key.direction }, this.theme, this.console.contentColumns, this.console.rows)
      else if (key.kind === 'up') viewing.viewer.move({ kind: 'line', lines: -1 }, this.theme, this.console.contentColumns, this.console.rows)
      else if (key.kind === 'down') viewing.viewer.move({ kind: 'line', lines: 1 }, this.theme, this.console.contentColumns, this.console.rows)
      else if (key.kind === 'page') viewing.viewer.move({ kind: 'page', direction: key.direction }, this.theme, this.console.contentColumns, this.console.rows)
      else if (key.kind === 'home') viewing.viewer.move({ kind: 'home' }, this.theme, this.console.contentColumns, this.console.rows)
      else if (key.kind === 'end' || key.kind === 'scroll-end') viewing.viewer.move({ kind: 'end' }, this.theme, this.console.contentColumns, this.console.rows)
      else if (key.kind === 'text' && key.text === 'c') {
        // The one gesture that covers every kind the reader opens: an answer,
        // a fenced block, and a diff, which `/copy` cannot address because
        // tool cards are deliberately outside its index.
        if (!this.console.copyText(viewing.viewer.text)) return
        viewing.viewer.markCopied()
      }
      else return
      this.render()
      return
    }
    if (key.kind === 'focus') {
      if (!key.focused) this.dropPointerHover()
      return
    }
    if (key.kind === 'clear-screen') {
      this.console.clearScreen()
      this.render()
      return
    }
    if (key.kind === 'shift-tab') {
      this.handlers.shiftTab?.()
      return
    }
    if (key.kind === 'expand-output') {
      this.handlers.expandOutput?.()
      return
    }
    // Handled here rather than reported to the owner: the readout is the
    // chrome's own state, and nothing outside it changes when the list opens.
    if (key.kind === 'toggle-todos') {
      // One open panel at a time: the chrome has room for a list, not two.
      this.todosExpanded = !this.todosExpanded
      this.queueOpen = false
      this.render()
      return
    }
    if (key.kind === 'transcript-search') {
      if (this.finding === undefined) {
        this.finding = ''
        this.queueOpen = false
        this.console.searchTranscript('')
      } else {
        this.console.nextTranscriptHit(1)
      }
      this.render()
      return
    }
    if (this.finding !== undefined) {
      this.onFindKey(key)
      return
    }
    if (this.shortcutsOpen) {
      if (key.kind === 'escape' || (key.kind === 'text' && key.text === '?')) {
        this.shortcutsOpen = false
        this.render()
        return
      }
      this.shortcutsOpen = false
    }
    if (key.kind === 'text' && key.text === '?' && this.editor.empty) {
      this.shortcutsOpen = true
      this.render()
      return
    }
    if (key.kind === 'toggle-queue') {
      this.toggleQueuePanel()
      return
    }
    // The open panel owns the keyboard, the way a selector does. The pointer
    // keeps its own path below, so a click on a panel row still lands there.
    if (this.queueOpen && !isPointerKey(key)) {
      this.onQueuePanelKey(key)
      return
    }
    // Scrolling belongs to the viewport, not to the buffer being edited.
    if (key.kind === 'page') {
      this.console.scrollPage(key.direction)
      this.render()
      return
    }
    if (key.kind === 'scroll' && key.at !== undefined && this.scrollList(key.at, key.lines)) return
    if (key.kind === 'scroll') {
      // Negative lines scroll back into history — wheel up shows older output,
      // the direction every terminal scrolls. A gesture arrives as a burst of
      // events; they coalesce into one repaint after the burst's chunk.
      this.pendingScroll += key.lines
      if (!this.scrollFlushQueued) {
        this.scrollFlushQueued = true
        queueMicrotask(() => {
          this.scrollFlushQueued = false
          const delta = this.pendingScroll
          this.pendingScroll = 0
          if (delta !== 0) {
            this.console.scrollBy(delta)
            this.render()
          }
        })
      }
      return
    }
    if (key.kind === 'scroll-end') {
      this.console.scrollToBottom()
      this.render()
      return
    }
    if (key.kind === 'turn') {
      this.handlers.turn?.(key.direction)
      this.render()
      return
    }
    // The rows below the transcript belong to whatever composed them, so a
    // pointer there never reaches the viewport: a press on an option acts on
    // it, and a press on a border does nothing rather than starting a
    // selection nobody asked for.
    if (key.kind === 'mouse-down' || key.kind === 'mouse-up' || key.kind === 'mouse-move' || key.kind === 'mouse-drag') {
      // ...unless the viewport anchored the gesture. A selection swept out of
      // the transcript is still that selection, so the drag that left and the
      // release that copies keep reaching it instead of dying on a row that
      // offers nothing. A button-less move says nothing is held any more,
      // which is also how a release lost outside the window heals.
      if (key.kind === 'mouse-move') {
        this.pressedViewport = false
        this.pressedCaret = undefined
        this.boxDragging = false
      }
      if (key.kind === 'mouse-move' && this.pointerLeftWindow(key.row, key.column)) {
        this.dropPointerHover()
        return
      }
      const owned = this.pressedViewport && (key.kind === 'mouse-drag' || key.kind === 'mouse-up')
      const region = owned ? undefined : this.console.regionRowAt(key.row)
      if (region !== undefined) {
        this.onRegionPointer(key.kind, region, key.column, key.row)
        return
      }
      if (this.pressedCaret !== undefined && (key.kind === 'mouse-drag' || key.kind === 'mouse-up')) {
        // The box anchored the gesture. Sweeping out of it still selects, the
        // way a viewport drag that left the transcript keeps selecting: the
        // pointer is clamped to the nearest text rather than cancelling.
        this.onRegionPointer(key.kind, undefined, key.column, key.row)
        return
      }
      if (this.pressedTarget !== undefined) {
        // The press began on a row and the pointer left the region; releasing
        // out here is the cancel.
        if (key.kind === 'mouse-up' || key.kind === 'mouse-down') this.pressedTarget = undefined
        if (key.kind === 'mouse-move') this.clearRegionHover()
        if (key.kind !== 'mouse-move') return
      }
      if (this.console.coversOverlay?.(key.row) && this.hasActiveImage) {
        if (key.kind === 'mouse-up') this.openActiveImage()
        return
      }
    }
    // The terminal cannot select while mouse reporting is on, so the viewport
    // does: press anchors, motion extends, release copies — automatically, the
    // way opencode and Claude treat a selection as the intent to copy.
    if (key.kind === 'mouse-down') {
      this.pressedViewport = true
      this.console.mouseDown(key.row, key.column)
      return
    }
    if (key.kind === 'mouse-drag') {
      this.console.mouseDrag(key.row, key.column)
      return
    }
    // The pointer merely resting somewhere: a block says what it is and what a
    // click would do to it, so a clickable block is not a target you discover
    // by hitting it. Reports arrive per cell crossed, and the viewport answers
    // only when the block under the pointer changed — so this repaints then.
    if (key.kind === 'mouse-move') {
      const block = this.console.mouseMove(key.row, key.column)
      const readout = block === undefined
        ? undefined
        : this.theme.dim(`  ${block.label} · ${block.lines} lines · click to ${block.enter === true ? 'enter' : block.expanded ? 'fold' : 'expand'}`)
      if (readout === this.hover) return
      this.hover = readout
      this.render()
      return
    }
    if (key.kind === 'mouse-up') {
      this.pressedViewport = false
      const text = this.console.mouseUp()
      if (text !== undefined && this.console.copyText(text)) {
        const rows = text.split('\n').length
        this.setFlash(this.theme.dim(rows > 1 ? `  ✓ copied ${rows} lines` : '  ✓ copied'))
      }
      return
    }
    const selecting = this.select_
    if (selecting !== undefined) {
      const step = selecting.selector.handle(key)
      if (step.kind === 'done') {
        selecting.dispose()
        selecting.resolve(step.outcome)
        return
      }
      const highlighted = selecting.selector.highlighted
      if (highlighted !== undefined && highlighted !== selecting.highlighted) {
        selecting.highlighted = highlighted
        selecting.preview?.(highlighted)
      }
      this.render()
      return
    }
    if (key.kind === 'paste-image') {
      void this.pasteImage()
      return
    }
    // The open list is chrome of its own: Escape folds it back to one line
    // rather than aborting the session the way an empty box does.
    if (key.kind === 'escape' && this.todosExpanded) {
      this.todosExpanded = false
      this.render()
      return
    }
    // The arrows move by the rows a person sees, so the model is told the
    // width they are wrapped at before it reads one — a resize between keys
    // would otherwise move the cursor by yesterday's geometry.
    this.editor.setWrapWidth(wrapBudget(this.console.contentColumns))
    // Ctrl-Enter is Enter that steers: the editor still accepts the line —
    // history, the completion menu, the empty-box no-op stay its — and the
    // submit case reads the flag.
    if (key.kind === 'steer') {
      this.steerNext = true
      key = { kind: 'enter' }
    }
    const action = this.editor.handle(key)
    if (action.kind !== 'submit') this.steerNext = false
    switch (action.kind) {
      case 'submit': {
        const steer = this.steerNext
        this.steerNext = false
        const waiting = this.pending
        if (waiting !== undefined) {
          // Something is asking — the loop for its next line, or a question
          // for its answer — and Enter answers it, steering or not.
          waiting.dispose()
          waiting.resolve(action.text)
          this.console.scrollToBottom()
          break
        }
        // Nothing is asking yet; hold it for the next read rather than losing
        // the keystrokes. Its images are claimed now: a paste made after this
        // submission belongs to the next line, not retroactively to this one.
        const images = this.claimImages(action.text)
        if (steer) {
          void this.requestSteer(this.queue.make(action.text, images))
          break
        }
        this.queue.push(action.text, images)
        break
      }
      case 'escape':
        // Escape means stop, whatever is queued: taking a line back is the
        // panel's job (Ctrl-Q), so an interrupt is never one Escape short.
        this.handlers.escape()
        break
      case 'eof': {
        const waiting = this.pending
        if (waiting !== undefined) {
          waiting.dispose()
          waiting.resolve(undefined)
        }
        this.handlers.eof()
        break
      }
      default:
        break
    }
    this.render()
  }

  /**
   * Read the clipboard and attach its image behind an `[Image #N]` token.
   *
   * The read shells out and takes real time, so it runs off the key handler;
   * a second Ctrl+V during it is dropped rather than raced. Numbers count up
   * for the whole session — a token in a recalled line must never quietly
   * name a different image than the one it was minted for.
   */
  private async pasteImage(): Promise<void> {
    const read = this.handlers.readClipboardImage
    if (read === undefined || this.pastingImage) return
    this.pastingImage = true
    try {
      const found = await read()
      if (found === undefined) {
        this.setFlash(this.theme.dim('  no image in the clipboard'))
        return
      }
      this.imageCounter += 1
      const id = this.imageCounter
      const pending: PendingImage = {
        id,
        image: { mediaType: found.mediaType, data: found.data.toString('base64'), name: `Pasted image #${id}` },
        byteSize: found.data.length,
        ...found.width !== undefined ? { width: found.width } : {},
        ...found.height !== undefined ? { height: found.height } : {},
      }
      this.pendingImages.set(id, pending)
      this.editor.handle({ kind: 'paste', text: `[Image #${id}]` })
      const size = found.width !== undefined && found.height !== undefined ? ` (${found.width}×${found.height} ${found.mediaType.slice(6)})` : ''
      this.setFlash(this.theme.dim(`  ✓ image #${id} attached${size}`))
      const meta = found.width === undefined || found.height === undefined ? readImageMetadata(found.data) : undefined
      if (meta?.width !== undefined && pending.width === undefined) pending.width = meta.width
      if (meta?.height !== undefined && pending.height === undefined) pending.height = meta.height
      // A terminal that paints the image itself needs no mosaic, and building
      // one would spend a process launch and a decode on nothing.
      if (nativePreviewProtocol(pending) === undefined) {
        pending.thumbnailRequested = true
        const maxW = Math.max(24, this.console.columns - 8)
        const maxH = Math.max(4, this.previewRows - 5)
        void generateImageThumbnail(found.data, maxW, maxH).then((thumb) => {
          if (thumb !== undefined) pending.thumbnail = thumb
          this.render()
        })
      }
    } finally {
      this.pastingImage = false
      this.render()
    }
  }

  /**
   * The images a submitted line actually references, in token order.
   *
   * The tokens are the source of truth: a token the person deleted drops its
   * image, a token duplicated by editing still names one attachment once.
   * Claimed images leave the pending pool, so a token recalled from history
   * later submits as plain text rather than resurrecting consumed bytes.
   * @param text - the submitted line.
   * @returns the referenced images, ready to ride the submission.
   */
  private claimImages(text: string): PendingImage[] {
    const images: PendingImage[] = []
    for (const match of text.matchAll(/\[Image #(\d+)\]/gu)) {
      const id = Number(match[1])
      const pending = this.pendingImages.get(id)
      if (pending === undefined) continue
      this.pendingImages.delete(id)
      images.push(pending)
    }
    return images
  }

  /**
   * The images belonging to the line the last read returned.
   *
   * A drain, in the transcript's `take*` idiom: the caller reads the line,
   * then takes its images exactly once.
   * @returns the images in token order, empty for a plain line.
   */
  takeAttachments(): PendingImage[] {
    const images = this.submittedImages
    this.submittedImages = []
    return images
  }

  /** The type-ahead, in the order it will leave. */
  get queued(): readonly QueueItem[] {
    return this.queue.items
  }

  /** Prompts handed to the running turn and not yet claimed by the model. */
  get steering(): readonly QueueItem[] {
    return this.inFlight
  }

  /**
   * Whether a steer has a turn to land in: nothing is asking for the next
   * line, so one is running — or a question of its own is open inside it.
   */
  private get canSteer(): boolean {
    return this.handlers.steer !== undefined && this.pending?.kind !== 'turn'
  }

  /** The chrome rows of what is waiting: steers in flight, then the queue. */
  private queueRows(columns: number): string[] {
    const rows = this.inFlight.map(item => steeringRow(item.text, this.theme, columns))
    if (this.queueOpen && this.queue.length > 0) {
      rows.push(...this.panel.view(this.queue.items, this.theme, columns, this.canSteer))
      return rows
    }
    const row = queueRow(this.queue.items, this.theme, columns)
    if (row !== undefined) rows.push(row)
    return rows
  }

  /** Ctrl-Q, or a click on the readout: open the panel, or fold it back. */
  private toggleQueuePanel(): void {
    if (this.select_ !== undefined) return
    if (this.queueOpen) {
      this.queueOpen = false
      this.render()
      return
    }
    if (this.queue.length === 0) {
      this.setFlash(this.theme.dim('  queue is empty'))
      return
    }
    if (this.finding !== undefined) {
      this.finding = undefined
      this.console.clearTranscriptSearch()
    }
    this.todosExpanded = false
    this.shortcutsOpen = false
    this.queueOpen = true
    this.panel.reset()
    this.render()
  }

  /** A key while the panel is open. */
  private onQueuePanelKey(key: Key): void {
    const action = this.panel.handle(key, this.queue.items, this.canSteer)
    if (action.kind === 'pending' && key.kind === 'text' && key.text === 's') {
      // The panel refused: say why, so the key does not read as dead.
      const marked = this.queue.items[this.panel.mark]
      const why = marked === undefined ? undefined : steerRefusal(marked, this.canSteer)
      if (why !== undefined) {
        this.setFlash(this.theme.dim(`  ${why}`))
        return
      }
    }
    this.applyPanelAction(action)
  }

  /** Carry out what the panel asked for, by key or by click. */
  private applyPanelAction(action: PanelAction): void {
    switch (action.kind) {
      case 'close':
        this.queueOpen = false
        break
      case 'edit':
        this.editQueued(action.id)
        return
      case 'remove':
        this.removeQueued(action.id)
        return
      case 'move':
        this.moveQueued(action.id, action.delta)
        return
      case 'steer':
        this.steerQueued(action.id)
        return
      case 'pending':
        break
    }
    this.render()
  }

  /**
   * Take a queued line back into the box for editing, its images with it.
   * @param id - the item.
   * @returns false for an unknown id, or when the box holds text that would be lost.
   */
  editQueued(id: number): boolean {
    const item = this.queue.find(id)
    if (item === undefined) return false
    if (!this.editor.empty) {
      this.setFlash(this.theme.dim('  clear the box first (Ctrl+U) — it would be overwritten'))
      return false
    }
    this.queue.remove(id)
    this.restoreToBox(item)
    this.queueOpen = false
    this.render()
    return true
  }

  /**
   * Drop a queued line. Its images go with it: a `[Image #N]` token recalled
   * from history later submits as plain text, the rule every claim follows.
   * @returns false for an unknown id.
   */
  removeQueued(id: number): boolean {
    if (this.queue.remove(id) === undefined) return false
    if (this.queue.length === 0) this.queueOpen = false
    this.render()
    return true
  }

  /**
   * Swap a queued line with its neighbour.
   * @returns false at either end, or for an unknown id.
   */
  moveQueued(id: number, delta: -1 | 1): boolean {
    const moved = this.queue.move(id, delta)
    if (moved) this.render()
    return moved
  }

  /** Hand a queued prompt to the running turn. */
  steerQueued(id: number): void {
    const item = this.queue.find(id)
    if (item === undefined) return
    const why = steerRefusal(item, this.canSteer)
    if (why !== undefined) {
      this.setFlash(this.theme.dim(`  ${why}`))
      return
    }
    this.queue.remove(id)
    this.queueOpen = false
    void this.requestSteer(item)
  }

  /** Put a line back where it was typed: its images pending again, its text in the box. */
  private restoreToBox(item: QueueItem): void {
    for (const image of item.images) this.pendingImages.set(image.id, image)
    this.editor.prefill(item.text)
  }

  /** Resolve a waiting read with an item whose images were already claimed. */
  private answerWith(waiting: Pending, item: QueueItem): void {
    for (const image of item.images) this.pendingImages.set(image.id, image)
    waiting.dispose()
    waiting.resolve(item.text)
    this.console.scrollToBottom()
  }

  /**
   * Steer a prompt into the running turn, or send it if nothing is running.
   *
   * A `!` or `/` line cannot steer — the shell and the commands run in their
   * own turn — so it joins the queue instead. With the loop waiting for its
   * next line there is no turn to steer, and the line is simply sent.
   */
  private async requestSteer(item: QueueItem): Promise<void> {
    const steer = this.handlers.steer
    if (item.kind !== 'prompt' || steer === undefined) {
      this.queue.append(item)
      this.setFlash(this.theme.dim('  only a message can steer — ! and / lines run in their turn'))
      return
    }
    const waiting = this.pending
    if (waiting?.kind === 'turn') {
      this.answerWith(waiting, item)
      return
    }
    this.inFlight = [...this.inFlight, item]
    this.render()
    const outcome = await steer(item)
    if (outcome === 'steered') return
    // Nothing was running by the time it was ready: it goes first, so the next
    // message the loop reads carries it.
    this.steerReturned(item.id)
    this.setFlash(this.theme.dim('  nothing is running — it goes with the next message'))
  }

  /**
   * The agent took a steer into its turn; the transcript shows it from here.
   * @param id - the item, as {@link PromptHandlers.steer} received it.
   */
  steerClaimed(id: number): void {
    if (!this.inFlight.some(item => item.id === id)) return
    this.inFlight = this.inFlight.filter(item => item.id !== id)
    this.render()
  }

  /**
   * A steer the agent never took comes back to the head of the queue — or
   * straight to the loop when it is already asking — so nothing typed is lost.
   * @param id - the item.
   */
  steerReturned(id: number): void {
    const item = this.inFlight.find(candidate => candidate.id === id)
    if (item === undefined) return
    this.inFlight = this.inFlight.filter(candidate => candidate.id !== id)
    const waiting = this.pending
    if (waiting?.kind === 'turn') {
      this.answerWith(waiting, item)
      return
    }
    this.queue.unshift(item)
    this.render()
  }

  /**
   * The todo readout's rows: the one in flight, or the whole list once opened.
   * @param columns - display columns available.
   * @returns the rows, empty when no list is live.
   */
  private todoRows(columns: number): string[] {
    const plan = this.plan
    if (!this.todosExpanded) {
      // One teaser, not two: the plan when there is one, because it outlives
      // the turn's own list and says how much of the work is left.
      const row = plan === undefined
        ? todoRow(this.todos, this.theme, columns, 'Ctrl+T')
        : planSummary(plan, this.theme, columns, 'click or Ctrl+T opens the list')
      return row === undefined ? [] : [row]
    }
    // Both, plan first: they are different granularities of the same work —
    // what `/ship` approved, and what this turn is tracking inside it.
    // If todos duplicate the plan's tickets (e.g. ship tickets tracked 1:1 via todo_write),
    // omit the redundant todo list to avoid echoing identical items.
    const redundantTodos = plan !== undefined && this.todos.length > 0
      && this.todos.every(todo => plan.tickets.some(t => {
        const todoNorm = todo.content.trim().toLowerCase()
        const planNorm = t.title.trim().toLowerCase()
        return todoNorm.includes(planNorm) || planNorm.includes(todoNorm)
      }))

    return [
      ...plan === undefined ? [] : planReport(plan, this.theme, columns, TODO_ROWS, 'click or Ctrl+T closes'),
      ...redundantTodos ? [] : todoReport(this.todos, this.theme, columns, { hint: 'Ctrl+T closes', limit: TODO_ROWS }),
    ]
  }

  /**
   * Set the plan a `/ship` run is working through, or none.
   * @param plan - the plan read from the spec file.
   */
  setPlan(plan: Plan | undefined): void {
    this.plan = plan
    this.render()
  }

  /**
   * Keys while transcript find is open: typing is the query, arrows step,
   * Escape closes. The transcript is not edited.
   * @param key - the decoded keystroke.
   */
  private onFindKey(key: Key): void {
    if (key.kind === 'escape') {
      this.finding = undefined
      this.console.clearTranscriptSearch()
      this.render()
      return
    }
    if (key.kind === 'up') {
      this.console.nextTranscriptHit(-1)
      this.render()
      return
    }
    if (key.kind === 'down') {
      this.console.nextTranscriptHit(1)
      this.render()
      return
    }
    if (key.kind === 'backspace') {
      this.finding = Array.from(this.finding ?? '').slice(0, -1).join('')
      this.console.searchTranscript(this.finding)
      this.render()
      return
    }
    if (key.kind === 'text') {
      this.finding = `${this.finding ?? ''}${key.text}`
      this.console.searchTranscript(this.finding)
      this.render()
      return
    }
    if (key.kind === 'paste') {
      this.finding = `${this.finding ?? ''}${key.text.replaceAll('\n', '')}`
      this.console.searchTranscript(this.finding)
      this.render()
      return
    }
  }

  /**
   * The find readout, or undefined when find is closed.
   * @param columns - display columns available.
   */
  private findRow(columns: number): string | undefined {
    if (this.finding === undefined) return undefined
    const found = this.console.transcriptSearch
    const hits = found?.hits ?? 0
    const at = hits === 0 ? 0 : (found?.index ?? 0) + 1
    const status = hits === 0 ? 'no matches' : `${at}/${hits}`
    return this.theme.dim(truncate(`  find: ${this.finding}  ${status}  ↑↓ next  Esc closes`, columns))
  }

  /**
   * Turn the wheel on the list the pointer is over, when it is over one.
   *
   * Only the wheel: a scroll without a place came from the keyboard, and a
   * pointer resting somewhere must never decide what Shift+Up moves.
   * @param at - where the wheel turned.
   * @param lines - rows to move by.
   * @returns whether a list took it.
   */
  private scrollList(at: { row: number; column: number }, lines: number): boolean {
    const region = this.console.regionRowAt(at.row)
    if (region === undefined) return false
    if (region.region === 'overlay') {
      if (this.editor.view.candidates.length === 0) return false
      const view = this.editor.view
      this.editor.scrollMenu(lines, menuScrollFrom(view), menuScrollLimit(view))
      this.render()
      return true
    }
    const queue = this.queueRowsAt
    if (this.queueOpen && queue !== undefined && region.index >= queue.start && region.index < queue.start + queue.count) {
      this.panel.scrollBy(lines, this.queue.items)
      this.render()
      return true
    }
    const start = this.selectorRow
    const selecting = this.select_
    if (start === undefined || selecting === undefined) return false
    if (selecting.selector.keyboardOnly) return false
    if (region.index < start) return false
    selecting.selector.scrollBy(lines)
    this.render()
    return true
  }

  /**
   * Act on a pointer in the region below the transcript.
   * @param kind - which pointer event arrived.
   * @param region - the region and the row's index within it, or none when a
   *   box-owned gesture has left the chrome and is being clamped back in.
   * @param column - terminal column, 1-based.
   * @param terminalRow - terminal row, 1-based.
   */
  private onRegionPointer(
    kind: 'mouse-down' | 'mouse-up' | 'mouse-move' | 'mouse-drag',
    region: { region: 'chrome' | 'overlay'; index: number } | undefined,
    column: number,
    terminalRow: number,
  ): void {
    const target = region === undefined ? undefined : this.regionTarget(region, column)
    if (kind === 'mouse-move') {
      // The chrome is not a transcript block: keep the pointer mark on a
      // selector row, but give the status row back if a fold had borrowed it.
      const dropped = this.hover !== undefined
      this.hover = undefined
      this.console.mouseLeave()
      this.setRegionHover(target)
      if (dropped) this.render()
      return
    }
    if (kind === 'mouse-drag') {
      if (this.pressedCaret === undefined) return
      this.boxDragging = true
      this.editor.select(this.pressedCaret, this.boxCaretAt(region, column, terminalRow))
      this.render()
      return
    }
    if (kind === 'mouse-down') {
      this.pressedTarget = target
      this.pressedCaret = target?.kind === 'caret'
        ? caretAt(
          this.editor.view,
          this.console.contentColumns,
          target.row,
          target.cell,
          (this.editor.view.lines[0] ?? '').startsWith('!'),
        )
        : undefined
      this.boxDragging = false
      return
    }
    const pressed = this.pressedTarget
    this.pressedTarget = undefined
    const caret = this.pressedCaret
    this.pressedCaret = undefined
    const dragged = this.boxDragging
    this.boxDragging = false
    if (caret !== undefined) {
      if (dragged) {
        this.editor.select(caret, this.boxCaretAt(region, column, terminalRow))
        const text = this.editor.selectedText
        if (text !== '' && this.console.copyText(text)) {
          const rows = text.split('\n').length
          this.setFlash(this.theme.dim(rows > 1 ? `  ✓ copied ${rows} lines` : '  ✓ copied'))
          return
        }
        this.render()
        return
      }
      // A press that never moved is still Caret placement: the release is the
      // position it means, and sliding off before that takes it back.
      if (pressed === undefined || target === undefined) return
      if (regionKey(pressed) !== regionKey(target)) return
      if (target.kind !== 'caret') return
      const bang = (this.editor.view.lines[0] ?? '').startsWith('!')
      const at = caretAt(this.editor.view, this.console.contentColumns, target.row, target.cell, bang)
      this.editor.setCursor(at.row, at.column)
      this.render()
      return
    }
    // Same row down and up, or nothing happened: a press that slid somewhere
    // else on its way to being released was taken back.
    if (pressed === undefined || target === undefined) return
    if (regionKey(pressed) !== regionKey(target)) return
    if (target.kind === 'candidate') {
      this.editor.chooseCandidate(target.index)
      this.menuHover = undefined
      this.render()
      return
    }
    if (target.kind === 'todos') {
      this.todosExpanded = !this.todosExpanded
      this.render()
      return
    }
    if (target.kind === 'queue') {
      this.toggleQueuePanel()
      return
    }
    if (target.kind === 'queue-panel') {
      this.applyPanelAction(this.panel.click(target.target, this.queue.items))
      return
    }
    if (target.kind !== 'selector') return
    const selecting = this.select_
    if (selecting === undefined) return
    this.settleSelection(selecting.selector.click(target.target))
  }

  /**
   * Where a pointer sits in the buffer, clamped into the box's own rows.
   *
   * A drag that left the chrome still has to land somewhere the box drew:
   * above it is the first content row, below it the last, a column past the
   * text the nearest end — the same near-miss rule Caret placement uses.
   * @param region - the chrome row when the pointer is still in the region.
   * @param column - terminal column, 1-based.
   * @param terminalRow - terminal row, 1-based.
   */
  private boxCaretAt(
    region: { region: 'chrome' | 'overlay'; index: number } | undefined,
    column: number,
    terminalRow: number,
  ): { row: number; column: number } {
    const box = this.boxRows
    const bang = (this.editor.view.lines[0] ?? '').startsWith('!')
    const count = Math.max(1, box?.count ?? 1)
    let boxRow: number
    if (region?.region === 'chrome' && box !== undefined) {
      boxRow = Math.min(Math.max(0, region.index - box.start), count - 1)
    } else {
      const chromeStart = this.console.rows - this.chromeHeight + 1
      const boxStart = chromeStart + (box?.start ?? 0)
      boxRow = Math.min(Math.max(0, terminalRow - boxStart), count - 1)
    }
    return caretAt(this.editor.view, this.console.contentColumns, boxRow, column - 1 - GUTTER, bang)
  }

  /**
   * What sits on one row of the region, when anything does.
   * @param region - the region and the row's index within it.
   * @returns the selector row under the pointer, or `undefined`.
   */
  private regionTarget(
    region: { region: 'chrome' | 'overlay'; index: number },
    column: number,
  ): RegionTarget | undefined {
    if (region.region === 'overlay') {
      // The completion menu is drawn over the transcript rather than among the
      // chrome rows, so it answers in the overlay's own row space.
      const index = menuTargetAt(this.editor.view, region.index)
      return index === undefined ? undefined : { kind: 'candidate', index }
    }
    const start = this.selectorRow
    const selecting = this.select_
    if (start !== undefined && selecting !== undefined) {
      // A decision a click must not make takes no pointer at all: no target to
      // press, and no mark under the pointer suggesting there is one.
      if (selecting.selector.keyboardOnly) return undefined
      const target = selecting.selector.targetAt(region.index - start)
      if (target !== undefined) return { kind: 'selector', target }
    }
    const todos = this.todoRowsAt
    if (todos !== undefined && region.index >= todos.start && region.index < todos.start + todos.count) {
      return { kind: 'todos' }
    }
    const queue = this.queueRowsAt
    if (queue !== undefined && region.index >= queue.start && region.index < queue.start + queue.count) {
      // Steering rows come first and take no pointer; the readout or the
      // panel follows them.
      const row = region.index - queue.start - this.inFlight.length
      if (row < 0) return undefined
      if (!this.queueOpen) return { kind: 'queue' }
      const target = this.panel.targetAt(row, this.queue.items)
      return target === undefined ? undefined : { kind: 'queue-panel', target }
    }
    const box = this.boxRows
    if (box === undefined) return undefined
    const row = region.index - box.start
    if (row < 0 || row >= box.count) return undefined
    // The screen prepends its own gutter before every row it paints, so the
    // column the terminal reports is that much wider than the row's own.
    return { kind: 'caret', row, cell: column - 1 - GUTTER }
  }

  /**
   * Mark the row the pointer rests on, repainting only when it moved.
   * @param target - the row under the pointer, or `undefined`.
   */
  private setRegionHover(target: RegionTarget | undefined): void {
    const next = target === undefined ? '' : regionKey(target)
    if (next === this.regionHover) return
    this.regionHover = next
    this.menuHover = target?.kind === 'candidate' ? target.index : undefined
    this.select_?.selector.setHovered(target?.kind === 'selector' ? target.target : undefined)
    this.panel.setHovered(target?.kind === 'queue-panel' ? target.target : undefined)
    this.render()
  }

  /** Drop the pointer mark when the pointer leaves the region. */
  private clearRegionHover(): void {
    if (this.regionHover === '') return
    this.regionHover = ''
    this.menuHover = undefined
    this.select_?.selector.setHovered(undefined)
    this.panel.setHovered(undefined)
    this.render()
  }

  /**
   * Whether a motion report is from outside the window.
   *
   * Some terminals send a 0,0 any-motion event when the pointer leaves; others
   * report a cell past the last row or column. Either is "not on this surface".
   * @param row - terminal row, 1-based.
   * @param column - terminal column, 1-based.
   */
  private pointerLeftWindow(row: number, column: number): boolean {
    return row < 1 || column < 1 || row > this.console.rows || column > this.console.columns
  }

  /**
   * Give the status row back, and drop the fill the transcript was drawing.
   *
   * Used when the pointer leaves the window, or when focus-out is the only
   * report the terminal will send for that.
   */
  private dropPointerHover(): void {
    const dropped = this.hover !== undefined
    this.hover = undefined
    this.console.mouseLeave()
    if (this.regionHover !== '') this.clearRegionHover()
    else if (dropped) this.render()
  }

  /**
   * Finish what a selector step decided, the way a keystroke would.
   * @param step - what the selector did.
   */
  private settleSelection(step: SelectorStep): void {
    const selecting = this.select_
    if (selecting === undefined) return
    if (step.kind === 'done') {
      selecting.dispose()
      selecting.resolve(step.outcome)
      return
    }
    const highlighted = selecting.selector.highlighted
    if (highlighted !== undefined && highlighted !== selecting.highlighted) {
      selecting.highlighted = highlighted
      selecting.preview?.(highlighted)
    }
    this.render()
  }

  /** Recompose and redraw the bottom region. */
  private render(): void {
    if (!this.console.readsKeys) return
    const columns = this.console.contentColumns
    if (this.gate_ !== undefined) {
      this.console.setViewer(this.gate_.modal.frame(this.theme, columns, this.console.rows).rows)
      return
    }
    if (this.view_ !== undefined) {
      this.console.setViewer(this.view_.viewer.frame(this.theme, columns, this.console.rows).rows)
      return
    }
    const rows: string[] = []
    let cursor = { row: 0, column: 0 }
    if (this.streaming !== undefined) {
      if (typeof this.streaming === 'string') rows.push(this.streaming)
      else rows.push(...this.streaming)
    }
    let menuOverlay: readonly string[] = []
    this.selectorRow = undefined
    this.boxRows = undefined
    this.todoRowsAt = undefined
    this.queueRowsAt = undefined
    if (this.frontier_ !== undefined) {
      rows.push(...this.frontier_.card.frame(this.theme, columns).rows)
    }
    if (this.select_ !== undefined) {
      this.selectorRow = rows.length
      rows.push(...this.select_.selector.view(this.theme, columns))
    } else if (this.engaged || this.reading || this.frontier_ !== undefined) {
      const bang = (this.editor.view.lines[0] ?? '').startsWith('!')
      const box = inputBox(this.editor.view, this.theme, columns, {
        placeholder: this.placeholder,
        accent: bang ? text => this.theme.pending(text) : this.accent ?? (text => this.theme.accent(text)),
        shell: bang,
        hoveredCandidate: this.menuHover,
      })
      cursor = { row: rows.length + box.cursorRow, column: box.cursorColumn }
      this.boxRows = { start: rows.length, count: box.rows.length }
      rows.push(...box.rows)
      menuOverlay = box.overlay
    }
    if (this.shortcutsOpen) {
      rows.push(this.theme.dim(truncate('  Ctrl+R history · Ctrl+F find · Ctrl+O folds · Ctrl+T todos · Ctrl+Z undo', columns)))
      rows.push(this.theme.dim(truncate('  Ctrl+Q queue · Ctrl+Enter steer · Ctrl+V image · Shift-Enter newline', columns)))
      rows.push(this.theme.dim(truncate('  Esc interrupt · ? closes', columns)))
      rows.push(this.theme.muted(truncate('  /status → model · permissions · tokens · context', columns)))
    }
    // What is waiting: a steer in flight, then the queue — one row, or the
    // open panel in its place.
    const queueRows = this.queueRows(columns)
    if (queueRows.length > 0) this.queueRowsAt = { start: rows.length, count: queueRows.length }
    rows.push(...queueRows)
    // Under the box and over the hint row: the list is context for the work in
    // flight, and the rows nearest the bottom stay the ones about right now.
    const todo = this.todoRows(columns)
    if (todo.length > 0) this.todoRowsAt = { start: rows.length, count: todo.length }
    rows.push(...todo)
    // Detached from the tail the box would look like it had stopped receiving
    // output, so the viewport says so — over its own last row, never as another
    // chrome row, which would move the box while scrolling. The row is also the
    // click that ends the scroll, which is why it says so.
    this.console.setScrollNotice(this.console.scrolledBy > 0
      ? this.theme.dim(truncate(`  ↑ ${this.console.scrolledBy} rows above · click or PgDn returns to the latest`, columns))
      : '')
    // Flash, find, and hover borrow an existing chrome row — the hint if one
    // is up, otherwise the status — so appearing cannot grow the region and
    // jump the box. Status is truncated at paint so a resize can grow it back.
    // The legend keeps the row while the box is up; under a selector the
    // keys it names are not the ones that apply.
    const hint = this.hint ?? (this.select_ === undefined && this.frontier_ === undefined ? this.legend : undefined)
    const overlay = this.flash ?? this.findRow(columns) ?? this.hover
    if (overlay !== undefined) rows.push(overlay)
    else if (hint !== undefined) rows.push(truncate(hint, columns))
    const statusText = typeof this.status === 'function' ? this.status(columns) : this.status
    if (statusText !== undefined && (overlay === undefined || hint !== undefined)) {
      rows.push(truncate(statusText, columns))
    }
    this.chromeHeight = rows.length
    if (rows.length === 0) {
      this.console.setTimelineHidden(this.select_ !== undefined)
      this.console.clearRegion()
      return
    }
    // The cursor lives in the box and shows only there: parked visibly on a
    // display row it reads as content colliding with it, and the selector's ❯
    // marker is its own focus affordance.
    const focus = this.select_ === undefined && this.frontier_ === undefined && !this.queueOpen && (this.engaged || this.reading)
    if (!focus) cursor = { row: rows.length - 1, column: 0 }
    // Frontier keeps the timeline: it is a card above the box, not a viewer.
    this.console.setTimelineHidden(this.select_ !== undefined)
    const preview = this.imagePreviewOverlay(columns)
    const isPreview = menuOverlay.length === 0 && preview.rows.length > 0
    const consoleOverlay = menuOverlay.length > 0 ? menuOverlay : preview.rows
    this.console.setOverlay(consoleOverlay, isPreview, isPreview ? preview.graphic : undefined)
    this.console.setRegion(rows, cursor, focus)
  }

  /**
   * Return the pending image if the cursor is directly at the left or right edge
   * of an `[Image #N]` token in the editor.
   */
  private activeImageAtCursor(): PendingImage | undefined {
    const view = this.editor.view
    const line = view.lines[view.row] ?? ''
    const ranges = imageTokenRanges(line)
    for (const range of ranges) {
      if (view.column === range.start || view.column === range.end) {
        const pending = this.pendingImages.get(range.id)
        if (pending !== undefined) {
          const wantsMosaic = pending.thumbnail === undefined
            && pending.thumbnailRequested !== true
            && pending.image.data !== ''
            && nativePreviewProtocol(pending) === undefined
          if (wantsMosaic) {
            pending.thumbnailRequested = true
            const buf = Buffer.from(pending.image.data, 'base64')
            const maxW = Math.max(24, this.console.columns - 8)
            const maxH = Math.max(4, this.previewRows - 5)
            void generateImageThumbnail(buf, maxW, maxH).then(thumb => {
              if (thumb !== undefined) {
                pending.thumbnail = thumb
                this.render()
              }
            })
          }
          return pending
        }
      }
    }
    return undefined
  }

  /** Whether the cursor is currently resting next to an image token. */
  get hasActiveImage(): boolean {
    return this.activeImageAtCursor() !== undefined
  }

  /** Open the active pending image in the platform default native viewer. */
  openActiveImage(): boolean {
    const active = this.activeImageAtCursor()
    if (active === undefined) return false
    const opened = openOriginalImage(active)
    if (opened) {
      this.setFlash(this.theme.dim(`  ✓ opened image #${active.id} in system viewer`))
    }
    return opened
  }

  /**
   * Floating image preview overlay, shown when cursor is next to an image token.
   * @param columns - terminal content columns.
   */
  private imagePreviewOverlay(columns: number): ImagePreview {
    const active = this.activeImageAtCursor()
    if (active === undefined) return { rows: [] }
    return imagePreviewCard(active, this.theme, columns, this.previewRows)
  }

  /**
   * Rows the preview card has to live in.
   *
   * The overlay floats inside the viewport, which is what the chrome leaves of
   * the screen — so the card is measured against that, never against the
   * terminal's own height, or the rows that say what the image is fall off the
   * bottom while the picture keeps the space.
   */
  private get previewRows(): number {
    return Math.max(6, this.console.rows - this.chromeHeight)
  }
}

/** Whether a key is the pointer — a button, a motion, or the wheel — rather than the keyboard. */
function isPointerKey(key: Key): boolean {
  return key.kind === 'mouse-down' || key.kind === 'mouse-up' || key.kind === 'mouse-move' || key.kind === 'mouse-drag'
    || (key.kind === 'scroll' && key.at !== undefined)
}

/**
 * One comparable name for what a pointer is over.
 * @param target - the row under the pointer.
 * @returns a key equal only for the same row.
 */
function regionKey(target: RegionTarget): string {
  // A caret is the box, not a cell: a press that lands in the box and is let
  // go one column over is still a person putting the cursor there, and the
  // release is the position they meant.
  if (target.kind === 'caret') return 'caret'
  if (target.kind === 'candidate') return `candidate:${String(target.index)}`
  if (target.kind === 'todos') return 'todos'
  if (target.kind === 'queue') return 'queue'
  if (target.kind === 'queue-panel') {
    return target.target.kind === 'item' ? `queue:item:${String(target.target.index)}` : `queue:${target.target.kind}`
  }
  return target.target.kind === 'custom' ? 'selector:custom' : `selector:${String(target.target.index)}`
}
