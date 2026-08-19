/**
 * The process-facing terminal, in two shapes.
 *
 * On a terminal this surface owns the keyboard AND the screen: raw mode, its own
 * key decoding, and an alternate-screen viewport ({@link Screen}) that holds the
 * transcript in a scrollback buffer of its own with the input box pinned below
 * it. That is what an inline completion menu, a multi-line prompt, and a session
 * that reads as its own space require — `readline` reports no lone Escape, draws
 * no menu, and decides for itself what Enter means.
 *
 * Off a terminal it is a line reader over `readline`, because a pipe has no
 * cursor to manage and every line in a script is a separate instruction. Both
 * shapes answer the same reads, which is what keeps piped runs and tests on the
 * same code path as a person typing.
 * @module codsh-cli/src/console
 */

import { createInterface } from 'node:readline'
import type { Interface } from 'node:readline'
import { DISABLE_PASTE_MARKERS, ENABLE_PASTE_MARKERS, KeyDecoder } from './keys.ts'
import { Screen } from './screen.ts'
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

/** Rows assumed when the output stream reports none. */
const FALLBACK_ROWS = 24

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
  readonly rows?: number
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
  /** The viewport this surface owns on a terminal; absent off one. */
  private readonly screen: Screen | undefined

  constructor(
    private readonly input: InputStream,
    private readonly output: OutputStream,
  ) {
    if (this.readsKeys) {
      input.setRawMode?.(true)
      // Asking the terminal to mark pastes is what lets a pasted block enter the
      // buffer whole instead of arriving as a run of Enter presses.
      this.output.write(ENABLE_PASTE_MARKERS)
      this.screen = new Screen({
        write: data => void this.output.write(data),
        columns: () => this.columns,
        rows: () => Math.max(2, this.output.rows ?? FALLBACK_ROWS),
      })
      // Registered before any caller's resize handler, so the viewport is
      // re-laid-out before anything redraws at the new size.
      this.output.on('resize', () => { this.screen?.resize() })
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

  /**
   * Columns content may be laid out for: one less than the width, because the
   * viewport wraps at that boundary. Markdown layout MUST use this figure — a
   * table laid out one column wider is refolded by the viewport, and its rows
   * shear apart.
   */
  get contentColumns(): number {
    return Math.max(1, this.columns - 1)
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
   * Take the viewport: the transcript and the prompt live on their own screen
   * from here, and the terminal keeps the buffer the person had.
   */
  enterScreen(): void {
    this.screen?.enter()
  }

  /**
   * Give the terminal back. Idempotent: every exit path calls it.
   */
  leaveScreen(): void {
    this.screen?.leave()
  }

  /** Whether this surface currently holds its own screen. */
  get owningScreen(): boolean {
    return this.screen?.entered === true
  }

  /**
   * Scroll the transcript inside the viewport.
   * @param delta - rows to move; negative goes back into history.
   */
  scrollBy(delta: number): void {
    this.screen?.scrollBy(delta)
  }

  /**
   * Set the notice shown while the transcript is scrolled back.
   * @param text - the styled line, or the empty string for none.
   */
  setScrollNotice(text: string): void {
    this.screen?.setScrollNotice(text)
  }

  /**
   * Scroll the transcript by a whole viewport.
   * @param direction - -1 for back into history, 1 towards the tail.
   */
  scrollPage(direction: -1 | 1): void {
    this.screen?.scrollPage(direction)
  }

  /** Return to the tail of the transcript. */
  scrollToBottom(): void {
    this.screen?.scrollToBottom()
  }

  /** Physical rows currently scrolled out of view; zero means at the tail. */
  get scrolledBy(): number {
    return this.screen?.scrolledBy ?? 0
  }

  /**
   * Clear the transcript this session accumulated.
   *
   * On its own screen there is no shell scrollback to preserve, so this empties
   * the buffer the viewport shows rather than wiping a shared terminal.
   */
  clearScreen(): void {
    this.screen?.clearTranscript()
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
   * Keep one finished transcript line.
   *
   * On its own screen the line goes into the viewport's scrollback, which is
   * what lets the transcript scroll under a prompt that does not move. Off one
   * it is written straight out, because a pipe's reader wants exactly that.
   * @param line - the line, without its terminator.
   */
  write(line: string): void {
    if (this.screen !== undefined) {
      this.screen.append([line])
      return
    }
    this.output.write(`${line}\n`)
  }

  /**
   * Replace the rows pinned below the transcript.
   *
   * This is the whole live area: an input box, a completion menu, a working
   * indicator, the status row. Off a terminal the call is ignored — a
   * redirected transcript must not collect frames of a box nobody can see.
   * @param rows - the rows to display, top to bottom.
   * @param cursor - where to leave the terminal cursor among them.
   * @param focus - whether the rows hold input focus, which is when the cursor
   *   shows. Parked anywhere else it reads as content colliding with it.
   */
  setRegion(rows: readonly string[], cursor: RegionCursor, focus = true): void {
    this.screen?.setChrome(rows, cursor, focus)
  }

  /** Take the pinned rows down, leaving the transcript alone. */
  clearRegion(): void {
    this.screen?.setChrome([], { row: 0, column: 0 }, false)
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
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    if (this.readsKeys) {
      // Order matters: the viewport hands back the buffer and the modes it took,
      // and only then does raw mode go, so the shell inherits nothing of ours.
      this.screen?.leave()
      this.output.write(DISABLE_PASTE_MARKERS)
      this.input.setRawMode?.(false)
      this.input.pause()
    }
    this.rl?.close()
    this.end()
  }

  /**
   * Write one line to the terminal the person keeps, not to our viewport.
   *
   * The exit summary is what needs this: the session's own screen disappears
   * with it, so the few facts worth keeping — the session id, what it cost —
   * have to land in the buffer that survives.
   * @param line - the line, without its terminator.
   */
  writeAfterScreen(line: string): void {
    this.output.write(`${line}\n`)
  }
}
