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
 * @module codsh-bundle/src/console
 */

import { spawn, spawnSync } from 'node:child_process'
import { openSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Interface } from 'node:readline'
import { DISABLE_PASTE_MARKERS, ENABLE_PASTE_MARKERS, KeyDecoder } from './keys.ts'
import type { HoverBlock, TurnReference, ViewportBookmark } from './screen.ts'
import { GUTTER, Screen } from './screen.ts'
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
/**
 * Tee every byte the viewport writes, and the size it wrote them at, into the
 * file `CODSH_TRACE` names.
 *
 * A frame that arrives corrupted is a disagreement between what this surface
 * emitted and what the terminal did with it, and the emitted half is the half
 * nobody can see after the fact. Off unless the variable is set; a failure to
 * open or write the file must never cost the session, so it degrades to no
 * tracing at all.
 * @param write - the real write to wrap.
 * @param size - the terminal size at the moment of writing.
 * @param env - the environment to read the path from.
 * @returns the write to use, traced or not.
 */
function traced(
  write: (data: string) => void,
  size: () => { columns: number; rows: number },
  env: Record<string, string | undefined>,
): (data: string) => void {
  const path = env.CODSH_TRACE
  if (path === undefined || path === '') return write
  let handle: number
  try {
    handle = openSync(path, 'a')
    // The size leads the file: replaying the bytes needs the geometry they
    // were painted for, and a resize mid-session changes it.
    const { columns, rows } = size()
    writeSync(handle, `\u001B_codsh;start ${String(columns)}x${String(rows)} ${new Date().toISOString()}\u001B\\`)
  } catch {
    return write
  }
  let last = ''
  return (data: string) => {
    try {
      const { columns, rows } = size()
      const now = `${String(columns)}x${String(rows)}`
      if (now !== last) {
        writeSync(handle, `\u001B_codsh;size ${now}\u001B\\`)
        last = now
      }
      writeSync(handle, data)
    } catch {
      // A trace that cannot be written is not a reason to stop drawing.
    }
    write(data)
  }
}

export class TerminalConsole {
  private readonly rl: Interface | undefined
  private readonly decoder = new KeyDecoder()
  private readonly pending: string[] = []
  private readonly waiters: Waiter[] = []
  private keyHandler: ((key: Key) => void) | undefined
  /** Keys decoded before any handler registered — type-ahead is never dropped. */
  private readonly earlyKeys: Key[] = []
  /** Whether the terminal window has focus; undefined until it reports. */
  private focused: boolean | undefined
  /** The terminal's OSC 11 background answer, kept for late listeners. */
  private background: string | undefined
  private backgroundHandler: ((payload: string) => void) | undefined
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
      const rows = (): number => Math.max(2, this.output.rows ?? FALLBACK_ROWS)
      this.screen = new Screen({
        write: traced(
          data => void this.output.write(data),
          () => ({ columns: this.columns, rows: rows() }),
          process.env,
        ),
        columns: () => this.columns,
        rows,
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

  /** Physical terminal rows available to a full-screen modal surface. */
  get rows(): number {
    return Math.max(2, this.output.rows ?? FALLBACK_ROWS)
  }

  /**
   * Columns content may be laid out for.
   *
   * One less than the width so a row cannot wrap the terminal, and on a
   * viewport two less again for the left gutter. Markdown, the live line, and
   * the chrome MUST use this figure — a box laid out one gutter wider is
   * truncated with an ellipsis on every row, and a live line that fills the
   * width wraps into the box beneath it.
   */
  get contentColumns(): number {
    return Math.max(1, this.columns - 1 - (this.screen !== undefined ? GUTTER : 0))
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

  /**
   * Hand the real TTY to a child, then take the viewport back.
   *
   * Raw mode and the alternate screen both have to go: the shell needs cooked
   * input and the person's own buffer, the way Claude Code and opencode yield
   * `!` to sh. SIGINT is swallowed here so Ctrl-C reaches the child.
   * @param work - runs while this process is not reading the keyboard.
   */
  async runInForeground<T>(work: () => Promise<T>): Promise<T> {
    if (!this.readsKeys) return work()
    this.input.pause()
    this.input.setRawMode?.(false)
    this.output.write(DISABLE_PASTE_MARKERS)
    this.screen?.leave()
    const ignore = (): void => {}
    process.on('SIGINT', ignore)
    try {
      return await work()
    } finally {
      process.removeListener('SIGINT', ignore)
      this.input.setRawMode?.(true)
      this.output.write(ENABLE_PASTE_MARKERS)
      this.input.resume()
      this.screen?.enter()
    }
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
   * Float rows over the transcript just above the chrome.
   * @param rows - the overlay, or empty to clear it.
   */
  setOverlay(rows: readonly string[]): void {
    this.screen?.setOverlay(rows)
  }

  /** Show or clear a transient frame over transcript and input chrome. */
  setViewer(rows: readonly string[] | undefined): void {
    this.screen?.setViewer(rows)
  }

  /** Hide the conversation timeline beneath a modal selector or viewer. */
  setTimelineHidden(hidden: boolean): void {
    this.screen?.setTimelineHidden(hidden)
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

  /**
   * Search the owned scrollback.
   * @param query - the needle.
   */
  searchTranscript(query: string): { query: string; hits: number; index: number } | undefined {
    return this.screen?.searchTranscript(query)
  }

  /**
   * Step to another hit of the current query.
   * @param direction - 1 towards the tail, -1 towards the head.
   */
  nextTranscriptHit(direction: 1 | -1): { query: string; hits: number; index: number } | undefined {
    return this.screen?.nextTranscriptHit(direction)
  }

  /** Close find. Transcript content is untouched. */
  clearTranscriptSearch(): void {
    this.screen?.clearTranscriptSearch()
  }

  /** Incremental find over the scrollback, absent when find is closed. */
  get transcriptSearch(): { query: string; hits: number; index: number } | undefined {
    return this.screen?.transcriptSearch
  }

  /** Physical rows currently scrolled out of view; zero means at the tail. */
  get scrolledBy(): number {
    return this.screen?.scrolledBy ?? 0
  }

  /** Real user turns retained by the interactive viewport. */
  get turnList(): TurnReference[] {
    return this.screen?.turnList ?? []
  }

  /** Zero-based turn owning the current viewport. */
  get currentTurn(): number | undefined {
    return this.screen?.currentTurn
  }

  /** Reveal one real user turn. */
  jumpToTurn(index: number): boolean {
    return this.screen?.jumpToTurn(index) ?? false
  }

  /** Restore a captured physical scroll distance. */
  restoreScroll(offset: number): void {
    this.screen?.restoreScroll(offset)
  }

  /** Capture a modal-safe logical reading position. */
  captureViewportBookmark(): ViewportBookmark | undefined {
    return this.screen?.captureViewportBookmark()
  }

  /** Restore a logical reading position after modal preview and reflow. */
  restoreViewportBookmark(bookmark: ViewportBookmark | undefined): void {
    this.screen?.restoreViewportBookmark(bookmark)
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
    // Protocol reports are the console's own: no editor or selector wants
    // them, and buffering them as "early keys" would replay them as typing.
    if (key.kind === 'focus') {
      this.focused = key.focused
      if (!key.focused) this.screen?.mouseLeave()
      // The prompt still needs the report: a hover readout lives in the chrome,
      // and leaving the window has to give that row back.
      if (this.keyHandler === undefined) return
      this.keyHandler(key)
      return
    }
    if (key.kind === 'osc-reply') {
      if (key.code === 11) {
        this.background = key.payload
        this.backgroundHandler?.(key.payload)
      }
      return
    }
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
   * @param rule - a styled left rule to draw down the line, `''` for none. Off
   *   a terminal it is dropped: a pipe's reader wants the text, not the frame.
   */
  write(line: string, rule = ''): void {
    this.writeAll([line], rule)
  }

  /**
   * Write a block of finished lines that share one rule.
   *
   * One call rather than one per line: appending is what a resume spends its
   * time in, and the per-append work — the trim check, the anchor, the frame —
   * is paid once for the block instead of once for every line in it.
   * @param lines - the lines to keep, in order.
   * @param rule - a styled left rule marking which block they belong to.
   */
  writeAll(lines: readonly string[], rule = ''): void {
    if (lines.length === 0) return
    if (this.screen !== undefined) {
      this.screen.append(lines, rule)
      return
    }
    // Pipe readers still need the gutter glyph (› / ✻ / │ / ·); colour is
    // already absent off a TTY. Blank separators stay blank.
    for (const line of lines) {
      const prefix = line === '' || rule === '' ? '' : rule
      this.output.write(`${prefix}${line}\n`)
    }
  }

  /**
   * Where a terminal row falls in the region below the transcript.
   * @param row - terminal row, 1-based.
   * @returns the region and index, or `undefined` off a terminal or for a row
   *   the transcript owns.
   */
  regionRowAt(row: number): { region: 'chrome' | 'overlay'; index: number } | undefined {
    return this.screen?.regionRowAt(row)
  }

  /** Hold painting while a replay pours a session in; see Screen. */
  suspendPainting(): void {
    this.screen?.suspendPainting()
  }

  /** Paint again after a replay. */
  resumePainting(): void {
    this.screen?.resumePainting()
  }

  /**
   * Append the real user's prompt as the header of a response section.
   *
   * A TTY records the prompt boundary for sticky history navigation. A pipe
   * has no viewport, so it receives the exact ordinary transcript lines.
   * @param lines - rendered prompt lines, including its separator.
   * @param rule - the user's styled left rule; omitted from redirected output.
   * @param anchor - false while replaying retained session history.
   * @param explicitLines - logical text lines the person entered, excluding metadata.
   */
  appendPrompt(lines: readonly string[], rule = '', anchor = true, explicitLines = 1): void {
    if (this.screen !== undefined) {
      this.screen.appendPrompt(lines, rule, anchor, explicitLines)
      return
    }
    for (const line of lines) {
      const prefix = line === '' || rule === '' ? '' : rule
      this.output.write(`${prefix}${line}\n`)
    }
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

  /**
   * Keep one collapsible block: summary now, full form behind the toggle.
   *
   * Off a terminal only the summary is written — a pipe has no keys to toggle
   * with, and scripts want the digest.
   * @param summary - the collapsed lines.
   * @param full - the expanded lines.
   * @param rule - a styled left rule for the whole block, `''` for none.
   * @param label - what the block is, for the readout naming what the pointer
   * is over.
   * @param enter - child session a click opens instead of folding, when set.
   * @param page - raw text a click reads instead of expanding, when set.
   */
  appendFold(summary: readonly string[], full: readonly string[], rule = '', label = '', enter?: string, page?: string): void {
    if (this.screen !== undefined) {
      this.screen.appendFold(summary, full, rule, label, enter, page)
      return
    }
    for (const line of summary) {
      const prefix = line === '' || rule === '' ? '' : rule
      this.output.write(`${prefix}${line}\n`)
    }
  }

  /**
   * What a click on a view-card does.
   * @param handler - receives the child session id; omit to restore folding.
   */
  setPager(handler: ((text: string) => void) | undefined): void {
    this.screen?.setPager(handler)
  }

  setEnter(handler: ((id: string) => void) | undefined): void {
    this.screen?.setEnter(handler)
  }

  /**
   * Swap every collapsible block between summary and full form.
   * @returns false when there is nothing to toggle.
   */
  /**
   * Anchor a mouse selection at a terminal position.
   * @param row - terminal row, 1-based.
   * @param column - terminal column, 1-based.
   */
  mouseDown(row: number, column: number): void {
    this.screen?.mouseDown(row, column)
  }

  /**
   * Extend the mouse selection to a terminal position.
   * @param row - terminal row, 1-based.
   * @param column - terminal column, 1-based.
   */
  mouseDrag(row: number, column: number): void {
    this.screen?.mouseDrag(row, column)
  }

  /**
   * Note where the pointer is resting, nothing held down.
   * @param row - terminal row, 1-based.
   * @param column - terminal column, 1-based.
   * @returns the block now under the pointer when it changed, undefined
   * otherwise.
   */
  mouseMove(row: number, column: number): HoverBlock | undefined {
    return this.screen?.mouseMove(row, column)
  }

  /**
   * The pointer left the transcript — the chrome, or the window.
   *
   * Drops the hover fill and the timeline preview the move last named.
   */
  mouseLeave(): void {
    this.screen?.mouseLeave()
  }

  /**
   * Finish the mouse selection.
   * @returns the selected text, or undefined for a bare click.
   */
  mouseUp(): string | undefined {
    return this.screen?.mouseUp()
  }

  /**
   * Put text on the clipboard.
   *
   * Two channels, because neither is universal: OSC 52 reaches through SSH and
   * works wherever the terminal permits it, and the platform helper covers the
   * terminals that refuse the escape. `CODSH_CLIPBOARD` narrows it to `osc52`,
   * `system`, or `off` — tests use `osc52` so a run never touches the real
   * clipboard.
   * @param text - the plain text to copy.
   * @returns whether a copy was attempted at all.
   */
  copyText(text: string): boolean {
    const mode = process.env['CODSH_CLIPBOARD'] ?? 'both'
    if (mode === 'off' || text === '') return false
    const command = process.platform === 'darwin'
      ? ['pbcopy']
      : process.platform === 'win32'
        ? ['clip']
        : process.env['WAYLAND_DISPLAY'] === undefined
          ? ['xclip', '-selection', 'clipboard']
          : ['wl-copy']
    if (mode === 'system') {
      const result = spawnSync(command[0] ?? '', command.slice(1), {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 2_000,
      })
      return result.error === undefined && result.status === 0
    }
    if (mode !== 'system') {
      this.output.write(`\u001B]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`)
    }
    if (mode !== 'osc52') {
      try {
        const child = spawn(command[0] ?? '', command.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] })
        // A machine without the helper still copied via OSC 52; stay quiet.
        child.on('error', () => {})
        child.stdin.end(text)
      } catch {
        // Same: the escape sequence is the fallback.
      }
    }
    return true
  }

  toggleFolds(): boolean {
    return this.screen?.toggleFolds() ?? false
  }

  /** Return automatic blocks to their summaries, preserving explicit choices. */
  collapseFolds(): void {
    this.screen?.collapseFolds()
  }

  /** Take the pinned rows down, leaving the transcript alone. */
  clearRegion(): void {
    this.screen?.setOverlay([])
    this.screen?.setChrome([], { row: 0, column: 0 }, false)
  }

  /** Ring the terminal bell; a pipe gets nothing to beep with. */
  bell(): void {
    if (!this.isTty) return
    // A person already looking at the terminal needs no bell: on terminals
    // that report focus (mode 1004) it rings only while they are away. A
    // terminal that never reported keeps the always-ring behavior.
    if (this.focused === true) return
    this.output.write('\u0007')
  }

  /**
   * Register for the terminal's background-color answer (OSC 11).
   *
   * The answer often lands before anyone is ready to hear it — the query goes
   * out with the first frame — so a buffered reply is delivered immediately.
   * @param handler - receives the raw payload, e.g. `rgb:1e1e/1e1e/2e2e`.
   */
  onBackground(handler: (payload: string) => void): void {
    this.backgroundHandler = handler
    if (this.background !== undefined) handler(this.background)
  }

  /**
   * Adopt the light- or dark-background hover fill.
   * @param light - true when OSC 11 named a light color.
   */
  setLight(light: boolean): void {
    this.screen?.setLight(light)
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
   * Whether the person is away, as far as the terminal has said: focus
   * reported out, or never reported at all — the same reading the bell takes.
   */
  get away(): boolean {
    return this.isTty && this.focused !== true
  }

  /**
   * Send one notification through the terminal (OSC 9), the way the bell
   * rings: only while the person is away.
   * @param text - one line, already free of control characters.
   * @returns whether the sequence was written.
   */
  notify(text: string): boolean {
    if (!this.away) return false
    this.output.write(`\u001B]9;${text}\u0007`)
    return true
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
