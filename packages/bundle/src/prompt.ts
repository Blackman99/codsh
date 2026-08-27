/**
 * The prompt as the person sees it: an input box, a completion menu, a working
 * indicator, a status row, and — when a decision is being asked — a selection
 * widget in the box's place.
 *
 * This is where the two input shapes meet. On a terminal it drives the editor
 * from decoded keys and owns the bottom region; off one it reads lines from the
 * pipe and draws nothing. Callers ask for the next submission either way.
 * @module codsh-bundle/src/prompt
 */

import { Editor } from './editor.ts'
import { inputBox } from './inputbox.ts'
import { Selector } from './selector.ts'
import { truncate } from './theme.ts'
import { todoReport, todoRow } from './todos.ts'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import type { ClipboardImage } from './clipboard-image.ts'
import type { TerminalConsole } from './console.ts'
import type { EditorSources } from './editor.ts'
import type { Key } from './keys.ts'
import type { SelectOutcome, SelectSpec } from './selector.ts'
import type { Theme } from './theme.ts'
import type { TodoList } from './todos.ts'

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
  /**
   * Ctrl-V: the system clipboard's image, or undefined for none.
   *
   * Injected rather than imported so the pure-module tests can hand the
   * prompt a fixture instead of a machine's clipboard.
   */
  readClipboardImage?(): Promise<ClipboardImage | undefined>
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
}

/** One waiting read. */
interface Pending {
  resolve(text: string | undefined): void
  dispose(): void
}

/** One selection in progress. */
interface ActiveSelect {
  selector: Selector
  resolve(outcome: SelectOutcome): void
  dispose(): void
}

/** Drives the input box and answers reads and selections. */
export class Prompt {
  private readonly editor: Editor
  private pending: Pending | undefined
  private select_: ActiveSelect | undefined
  /**
   * Submissions made before anything asked for them.
   *
   * Typing while the agent works — or in the instant before a read begins — must
   * not be lost; the queue is what a line reader provides for free.
   */
  private readonly queued: { text: string; images: PendingImage[] }[] = []
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
  /** A short-lived notice that borrows the hint row, e.g. the copy toast. */
  private flash: string | undefined
  /** What the pointer is resting on, borrowing the hint row while it rests. */
  private hover: string | undefined
  private flashTimer: ReturnType<typeof setTimeout> | undefined
  /** The always-current session facts shown as the region's last row. */
  private status: string | undefined
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
  /** The assistant line still arriving, shown above the box. */
  private streaming: string | undefined
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
   * Set the working indicator under the box.
   * @param text - the text, or undefined to drop the row.
   */
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
   * @param text - the full styled row, or undefined to drop it. Truncation is
   *   applied at paint time so a resize can grow the line back.
   */
  setStatus(text: string | undefined): void {
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
   * Set the assistant line currently arriving, shown above the box.
   * @param text - the partial line, or undefined when none is open.
   */
  setStreaming(text: string | undefined): void {
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
    const typedAhead = this.queued.shift()
    if (typedAhead !== undefined) {
      this.submittedImages = typedAhead.images
      return Promise.resolve(typedAhead.text)
    }
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
  select(spec: SelectSpec, signal?: AbortSignal): Promise<SelectOutcome> {
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
      this.select_ = {
        selector: new Selector(spec),
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
      this.handlers.interrupt()
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
      this.todosExpanded = !this.todosExpanded
      this.render()
      return
    }
    if (key.kind === 'transcript-search') {
      if (this.finding === undefined) {
        this.finding = ''
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
    // Scrolling belongs to the viewport, not to the buffer being edited.
    if (key.kind === 'page') {
      this.console.scrollPage(key.direction)
      this.render()
      return
    }
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
    // The terminal cannot select while mouse reporting is on, so the viewport
    // does: press anchors, motion extends, release copies — automatically, the
    // way opencode and Claude treat a selection as the intent to copy.
    if (key.kind === 'mouse-down') {
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
        : this.theme.dim(`  ${block.label} · ${block.lines} lines · click to ${block.expanded ? 'fold' : 'expand'}`)
      if (readout === this.hover) return
      this.hover = readout
      this.render()
      return
    }
    if (key.kind === 'mouse-up') {
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
      this.render()
      return
    }
    if (key.kind === 'paste-image') {
      void this.pasteImage()
      return
    }
    const action = this.editor.handle(key)
    switch (action.kind) {
      case 'submit': {
        const waiting = this.pending
        if (waiting === undefined) {
          // Nothing is asking yet; hold it for the next read rather than losing
          // the keystrokes. Its images are claimed now: a paste made after this
          // submission belongs to the next line, not retroactively to this one.
          this.queued.push({ text: action.text, images: this.claimImages(action.text) })
          break
        }
        waiting.dispose()
        waiting.resolve(action.text)
        this.console.scrollToBottom()
        break
      }
      case 'escape':
        if (this.queued.length > 0) {
          const last = this.queued.pop()
          if (last !== undefined) {
            for (const image of last.images) this.pendingImages.set(image.id, image)
            this.editor.prefill(last.text)
          }
          break
        }
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
      }
      if (found.width !== undefined) pending.width = found.width
      if (found.height !== undefined) pending.height = found.height
      this.pendingImages.set(id, pending)
      this.editor.handle({ kind: 'paste', text: `[Image #${id}]` })
      const size = found.width !== undefined && found.height !== undefined ? ` (${found.width}×${found.height} ${found.mediaType.slice(6)})` : ''
      this.setFlash(this.theme.dim(`  ✓ image #${id} attached${size}`))
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

  /**
   * The todo readout's rows: the one in flight, or the whole list once opened.
   * @param columns - display columns available.
   * @returns the rows, empty when no list is live.
   */
  private todoRows(columns: number): string[] {
    if (this.todos.length === 0) return []
    if (!this.todosExpanded) {
      const row = todoRow(this.todos, this.theme, columns, 'Ctrl+T opens the list')
      return row === undefined ? [] : [row]
    }
    return todoReport(this.todos, this.theme, columns, { hint: 'Ctrl+T closes', limit: TODO_ROWS })
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

  /** Recompose and redraw the bottom region. */
  private render(): void {
    if (!this.console.readsKeys) return
    const columns = this.console.columns - 1
    const rows: string[] = []
    let cursor = { row: 0, column: 0 }
    if (this.streaming !== undefined) rows.push(this.streaming)
    if (this.select_ !== undefined) {
      rows.push(...this.select_.selector.view(this.theme, columns))
    } else if (this.engaged || this.reading) {
      const bang = (this.editor.view.lines[0] ?? '').startsWith('!')
      const box = inputBox(this.editor.view, this.theme, columns, {
        placeholder: this.placeholder,
        accent: bang ? text => this.theme.pending(text) : this.accent,
        shell: bang,
      })
      cursor = { row: rows.length + box.cursorRow, column: box.cursorColumn }
      rows.push(...box.rows)
    }
    if (this.shortcutsOpen) {
      rows.push(this.theme.dim(truncate('  Ctrl+R history · Ctrl+F find · Ctrl+O folds · Ctrl+T todos', columns)))
      rows.push(this.theme.dim(truncate('  Ctrl+V image · Shift-Enter newline · Esc interrupt · ? closes', columns)))
    }
    if (this.queued.length > 0) {
      const preview = this.queued[0]?.text ?? ''
      const more = this.queued.length > 1 ? ` (+${this.queued.length - 1} more)` : ''
      rows.push(this.theme.dim(truncate(`  ↳ queued: ${preview.split('\n')[0] ?? ''}${more}`, columns)))
    }
    // Under the box and over the hint row: the list is context for the work in
    // flight, and the rows nearest the bottom stay the ones about right now.
    rows.push(...this.todoRows(columns))
    // Detached from the tail the box would look like it had stopped receiving
    // output, so the viewport says so — over its own top row, never as another
    // chrome row, which would move the box while scrolling.
    this.console.setScrollNotice(this.console.scrolledBy > 0
      ? this.theme.dim(truncate(`  ↑ ${this.console.scrolledBy} rows above · PgDn returns to the latest`, columns))
      : '')
    // Flash, find, and hover borrow an existing chrome row — the hint if one
    // is up, otherwise the status — so appearing cannot grow the region and
    // jump the box. Status is truncated at paint so a resize can grow it back.
    const overlay = this.flash ?? this.findRow(columns) ?? this.hover
    if (overlay !== undefined) rows.push(overlay)
    else if (this.hint !== undefined) rows.push(this.hint)
    if (this.status !== undefined && (overlay === undefined || this.hint !== undefined)) {
      rows.push(truncate(this.status, columns))
    }
    if (rows.length === 0) {
      this.console.clearRegion()
      return
    }
    // The cursor lives in the box and shows only there: parked visibly on a
    // display row it reads as content colliding with it, and the selector's ❯
    // marker is its own focus affordance.
    const focus = this.select_ === undefined && (this.engaged || this.reading)
    if (!focus) cursor = { row: rows.length - 1, column: 0 }
    this.console.setRegion(rows, cursor, focus)
  }
}
