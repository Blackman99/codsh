/**
 * The process-facing terminal, in two shapes.
 *
 * On a terminal this surface owns the keyboard: raw mode, its own key decoding,
 * and a managed region of rows at the bottom holding the input box. That is what
 * an inline completion menu and a multi-line prompt require — `readline` reports
 * no lone Escape, draws no menu, and decides for itself what Enter means.
 *
 * Off a terminal it is a line reader over `readline`, because a pipe has no
 * cursor to manage and every line in a script is a separate instruction. Both
 * shapes answer the same reads, which is what keeps piped runs and tests on the
 * same code path as a person typing.
 * @module codsh/src/console
 */

import { createInterface } from 'node:readline'
import type { Interface } from 'node:readline'
import { DISABLE_PASTE_MARKERS, ENABLE_PASTE_MARKERS, KeyDecoder } from './keys.ts'
import { truncate } from './theme.ts'
import type { Key } from './keys.ts'

/** Columns assumed when the output stream reports none (a pipe). */
const FALLBACK_COLUMNS = 80

/**
 * Narrowest width this surface will lay out for.
 *
 * A terminal can report a width of zero — a PTY opened without a window size
 * does — and honouring it would truncate every card line away to nothing. Below
 * this floor the lines overflow instead, which stays readable.
 */
const MIN_COLUMNS = 20

/** Erase the current line from the cursor rightwards. */
const CLEAR_LINE = '\u001B[K'

/** Erase from the cursor to the end of the screen. */
const CLEAR_BELOW = '\u001B[0J'

/** Hide the cursor while a region is redrawn, so it does not visibly jump. */
const HIDE_CURSOR = '\u001B[?25l'

/** Show the cursor again. */
const SHOW_CURSOR = '\u001B[?25h'

/**
 * How long a held Escape waits for a successor before it counts as the key.
 *
 * `ESC` alone and the first byte of `ESC [ A` are the same byte. A terminal
 * delivers the rest of a real sequence in the same read or the very next one, so
 * a wait this short never splits one while still answering the bare key
 * promptly.
 */
const ESCAPE_FLUSH_MS = 20

/** The output stream this surface writes to. */
export interface OutputStream extends NodeJS.WritableStream {
  readonly columns?: number
  readonly isTTY?: boolean
}

/** The input stream this surface reads from. */
export interface InputStream extends NodeJS.ReadableStream {
  readonly isTTY?: boolean
  setRawMode?(mode: boolean): unknown
}

/** One read waiting for the next line. */
interface Waiter {
  resolve(line: string | undefined): void
  dispose(): void
}

/** Where the cursor belongs among a region's rows. */
export interface RegionCursor {
  row: number
  column: number
}

/** Line input and output over one pair of process streams. */
export class TerminalConsole {
  private readonly rl: Interface | undefined
  private readonly decoder = new KeyDecoder()
  private readonly pending: string[] = []
  private readonly waiters: Waiter[] = []
  private keyHandler: ((key: Key) => void) | undefined
  /** Keys decoded before any handler registered — type-ahead is never dropped. */
  private readonly earlyKeys: Key[] = []
  private escapeTimer: NodeJS.Timeout | undefined
  private ended = false
  /** Rows currently drawn in the bottom region. */
  private regionRows: string[] = []
  /** Where among those rows the cursor was left. */
  private regionCursor: RegionCursor = { row: 0, column: 0 }
  /** Whether the region currently holds input focus, which shows the cursor. */
  private regionFocus = true

  constructor(
    private readonly input: InputStream,
    private readonly output: OutputStream,
  ) {
    if (this.readsKeys) {
      input.setRawMode?.(true)
      // Asking the terminal to mark pastes is what lets a pasted block enter the
      // buffer whole instead of arriving as a run of Enter presses.
      this.output.write(ENABLE_PASTE_MARKERS)
      input.on('data', (chunk: Buffer | string) => { this.onBytes(chunk) })
      input.on('end', () => { this.end() })
      this.rl = undefined
      return
    }
    this.rl = createInterface({ input, output, terminal: false })
    this.rl.on('line', (line: string) => { this.offer(line) })
    this.rl.on('close', () => { this.end() })
  }

  /** Display columns available for one line, never below {@link MIN_COLUMNS}. */
  get columns(): number {
    return Math.max(this.output.columns ?? FALLBACK_COLUMNS, MIN_COLUMNS)
  }

  /** Whether the output stream is a terminal. */
  get isTty(): boolean {
    return this.output.isTTY === true
  }

  /**
   * Whether this surface owns the keyboard.
   *
   * That needs both streams on a terminal: raw mode is what delivers a key
   * before its line, and there is no point managing rows on a stream with no
   * cursor.
   */
  get readsKeys(): boolean {
    return this.input.isTTY === true && this.isTty
  }

  /** Whether input has finished. */
  get finished(): boolean {
    return this.ended
  }

  /**
   * Register a handler for terminal window changes.
   * @param handler - called after each resize while registered.
   * @returns a disposer that removes it.
   */
  onResize(handler: () => void): () => void {
    if (!this.readsKeys) return () => {}
    // A writable stream is an emitter; only a terminal ever fires `resize`.
    this.output.on('resize', handler)
    return () => void this.output.off('resize', handler)
  }

  /**
   * Clear the visible screen.
   *
   * The scrollback survives — this wipes the viewport the way a shell's clear
   * does. The managed region is forgotten with it, so the caller redraws.
   */
  clearScreen(): void {
    if (!this.readsKeys) return
    this.output.write('\u001B[2J\u001B[H')
    this.regionRows = []
    this.regionCursor = { row: 0, column: 0 }
  }

  /**
   * Route decoded keys to a handler.
   * @param handler - receives every key while registered.
   * @returns a disposer that removes it.
   */
  onKey(handler: (key: Key) => void): () => void {
    this.keyHandler = handler
    // Keys typed between the banner and the prompt's construction were held;
    // they belong to this handler.
    for (const key of this.earlyKeys.splice(0)) handler(key)
    return () => { this.keyHandler = undefined }
  }

  /**
   * Decode one read and dispatch its keys.
   * @param chunk - the bytes the terminal delivered.
   */
  private onBytes(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (const key of this.decoder.push(text)) this.deliver(key)
    this.armEscapeFlush()
  }

  /** Hand one key to the handler, or hold it until one registers. */
  private deliver(key: Key): void {
    if (this.keyHandler === undefined) {
      this.earlyKeys.push(key)
      return
    }
    this.keyHandler(key)
  }

  /** Wait briefly for the rest of a held sequence, then resolve it as Escape. */
  private armEscapeFlush(): void {
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    this.escapeTimer = undefined
    if (!this.decoder.pending) return
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined
      for (const key of this.decoder.flush()) this.deliver(key)
    }, ESCAPE_FLUSH_MS)
    this.escapeTimer.unref()
  }

  /**
   * Hand one input line to the longest-waiting read, or queue it.
   * @param line - the line the reader produced.
   */
  private offer(line: string): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) {
      this.pending.push(line)
      return
    }
    waiter.dispose()
    waiter.resolve(line)
  }

  /** Mark input finished and release every waiting read. */
  private end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.dispose()
      waiter.resolve(undefined)
    }
  }

  /**
   * Write one finished line above the managed region.
   *
   * The region is erased first and redrawn after, so the transcript stays
   * append-only while the input box keeps its place at the bottom.
   * @param line - the line, without its terminator.
   */
  write(line: string): void {
    if (this.regionRows.length === 0) {
      this.output.write(`${line}\n`)
      return
    }
    const rows = this.regionRows
    // The cursor returns exactly where it was: a write that reset it to the
    // row's left edge would park a visible cursor on the box frame.
    const cursor = this.regionCursor
    this.eraseRegion()
    this.output.write(`${line}\n`)
    this.drawRegion(rows, cursor, this.regionFocus)
  }

  /**
   * Replace the managed region at the bottom of the screen.
   *
   * This is the whole live area: an input box, a completion menu, a working
   * indicator. Everything the transcript keeps goes through {@link write}
   * instead, because a terminal cannot revise a row that has scrolled. Off a
   * terminal the call is ignored — a redirected transcript must not collect
   * frames of a box nobody can see.
   * @param rows - the rows to display, top to bottom.
   * @param cursor - where to leave the terminal cursor among them.
   * @param focus - whether the region holds input focus. Without it the cursor
   *   stays hidden: a block cursor parked on a display row (the status line,
   *   a streaming line) reads as content colliding with it.
   */
  setRegion(rows: readonly string[], cursor: RegionCursor, focus = true): void {
    if (!this.readsKeys) return
    this.eraseRegion()
    this.drawRegion(rows, cursor, focus)
    this.regionRows = [...rows]
    this.regionCursor = { ...cursor }
    this.regionFocus = focus
  }

  /** Remove the region, leaving the cursor where the next write will land. */
  clearRegion(): void {
    if (this.regionRows.length === 0) return
    this.eraseRegion()
    // The region may have parked the cursor hidden; what follows is ordinary
    // terminal use again.
    if (!this.regionFocus) this.output.write(SHOW_CURSOR)
    this.regionRows = []
    this.regionCursor = { row: 0, column: 0 }
    this.regionFocus = true
  }

  /** Move to the region's first row and erase everything from there down. */
  private eraseRegion(): void {
    if (this.regionRows.length === 0) return
    const up = this.regionCursor.row > 0 ? `\u001B[${this.regionCursor.row}A` : ''
    // Hidden through the whole erase-write-redraw cycle: a visible cursor
    // travelling across freshly written lines reads as flicker. The redraw
    // shows it again when the region holds focus.
    this.output.write(`${HIDE_CURSOR}${up}\r${CLEAR_BELOW}`)
  }

  /**
   * Draw rows from the cursor down and place the cursor among them.
   * @param rows - the rows to draw.
   * @param cursor - the target position.
   * @param focus - whether to show the cursor at that position afterwards.
   */
  private drawRegion(rows: readonly string[], cursor: RegionCursor, focus = true): void {
    if (rows.length === 0) return
    // Every row is cut to one less than the width: a row that exactly fills the
    // terminal wraps, and a wrapped row breaks the arithmetic that erases it.
    const fitted = rows.map(row => truncate(row, this.columns - 1))
    const body = fitted.map(row => `${CLEAR_LINE}${row}`).join('\n')
    const back = fitted.length - 1 - cursor.row
    const up = back > 0 ? `\u001B[${back}A` : ''
    const right = cursor.column > 0 ? `\u001B[${cursor.column}C` : ''
    this.output.write(`${HIDE_CURSOR}${body}${up}\r${right}${focus ? SHOW_CURSOR : ''}`)
  }

  /** Ring the terminal bell; a pipe gets nothing to beep with. */
  bell(): void {
    if (!this.isTty) return
    this.output.write('\u0007')
  }

  /**
   * Set the terminal window title.
   * @param title - the title text; control bytes are the terminal's to reject.
   */
  setTitle(title: string): void {
    if (!this.isTty) return
    this.output.write(`\u001B]2;${title}\u0007`)
  }

  /**
   * Read one line from a piped stream.
   *
   * Only the non-terminal shape reads this way; with the keyboard owned, input
   * arrives as keys and the caller drives an editor instead.
   * @param signal - aborts the pending read.
   * @returns the line, or undefined when input ended or the read aborted.
   */
  readLine(signal?: AbortSignal): Promise<string | undefined> {
    const queued = this.pending.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.ended) return Promise.resolve(undefined)
    if (signal?.aborted === true) return Promise.resolve(undefined)
    return new Promise<string | undefined>((resolve) => {
      const waiter: Waiter = {
        resolve,
        dispose: () => { signal?.removeEventListener('abort', onAbort) },
      }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        waiter.dispose()
        resolve(undefined)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Restore the terminal and stop reading. */
  close(): void {
    this.clearRegion()
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    if (this.readsKeys) {
      // Whatever state a draw left the cursor in, the shell gets it back.
      this.output.write(SHOW_CURSOR)
      this.output.write(DISABLE_PASTE_MARKERS)
      this.input.setRawMode?.(false)
      this.input.pause()
    }
    this.rl?.close()
    this.end()
  }
}
