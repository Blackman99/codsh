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
  private readonly queued: string[] = []
  /** The working indicator shown under the box. */
  private hint: string | undefined
  /** A short-lived notice that borrows the hint row, e.g. the copy toast. */
  private flash: string | undefined
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
   * @param text - the styled row, or undefined to drop it.
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
    if (typedAhead !== undefined) return Promise.resolve(typedAhead)
    if (this.console.finished) return Promise.resolve(undefined)
    this.reading = true
    this.render()
    return new Promise<string | undefined>((resolve) => {
      const settle = (text: string | undefined): void => {
        this.pending = undefined
        this.reading = false
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
    const action = this.editor.handle(key)
    switch (action.kind) {
      case 'submit': {
        const waiting = this.pending
        if (waiting === undefined) {
          // Nothing is asking yet; hold it for the next read rather than losing
          // the keystrokes.
          this.queued.push(action.text)
          break
        }
        waiting.dispose()
        waiting.resolve(action.text)
        this.console.scrollToBottom()
        break
      }
      case 'escape':
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
      const box = inputBox(this.editor.view, this.theme, columns, {
        placeholder: this.placeholder,
        accent: this.accent,
      })
      cursor = { row: rows.length + box.cursorRow, column: box.cursorColumn }
      rows.push(...box.rows)
    }
    if (this.queued.length > 0) {
      const preview = this.queued[0] ?? ''
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
    const notice = this.flash ?? this.hint
    if (notice !== undefined) rows.push(notice)
    if (this.status !== undefined) rows.push(this.status)
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
