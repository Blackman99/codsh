/**
 * Terminal bytes to key events.
 *
 * Owning the keyboard is what an input box costs: `readline` cannot report a
 * lone Escape, cannot be asked to draw a completion menu, and decides for itself
 * what Enter means. Decoding here is the price of deciding those things.
 *
 * The decoder is incremental because a terminal splits sequences across reads:
 * an arrow key can arrive as `ESC`, then `[`, then `A`. Anything it cannot yet
 * resolve is held until the next byte rather than guessed at.
 * @module codsh-cli/src/keys
 */

/** What one keystroke means to the editor. */
export type Key =
  | { kind: 'text'; text: string }
  | { kind: 'enter' }
  | { kind: 'newline' }
  | { kind: 'tab' }
  | { kind: 'backspace' }
  | { kind: 'delete' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'escape' }
  | { kind: 'interrupt' }
  | { kind: 'eof' }
  | { kind: 'kill-line' }
  | { kind: 'kill-input' }
  | { kind: 'kill-word' }
  | { kind: 'word-left' }
  | { kind: 'word-right' }
  | { kind: 'shift-tab' }
  | { kind: 'clear-screen' }
  | { kind: 'expand-output' }
  | { kind: 'page'; direction: -1 | 1 }
  | { kind: 'scroll'; lines: number }
  | { kind: 'scroll-end' }
  | { kind: 'paste'; text: string }

/** Bracketed paste start, which a terminal wraps pasted text in. */
const PASTE_START = '\u001B[200~'

/** Bracketed paste end. */
const PASTE_END = '\u001B[201~'

/** Rows one wheel notch moves, matching what a terminal scrolls by default. */
const WHEEL_LINES = 3

/** An SGR mouse report: `ESC [ < button ; column ; row (M|m)`. */
const MOUSE = /^\u001B\[<(\d+);(\d+);(\d+)([Mm])/

/** Wheel-up button code in the SGR encoding; wheel-down is one higher. */
const WHEEL_UP = 64

/** Sequences that resolve to one key, longest first so a prefix never wins. */
const SEQUENCES: readonly (readonly [string, Key])[] = [
  // Scrolling the transcript: the viewport is ours, so these are ours to read.
  ['\u001B[5~', { kind: 'page', direction: -1 }],
  ['\u001B[6~', { kind: 'page', direction: 1 }],
  ['\u001B[1;2A', { kind: 'scroll', lines: -1 }],
  ['\u001B[1;2B', { kind: 'scroll', lines: 1 }],
  ['\u001B[1;5F', { kind: 'scroll-end' }],
  ['\u001B[1;5D', { kind: 'word-left' }],
  ['\u001B[1;5C', { kind: 'word-right' }],
  ['\u001B[1;3D', { kind: 'word-left' }],
  ['\u001B[1;3C', { kind: 'word-right' }],
  ['\u001B[3~', { kind: 'delete' }],
  ['\u001B[1~', { kind: 'home' }],
  ['\u001B[4~', { kind: 'end' }],
  ['\u001B[7~', { kind: 'home' }],
  ['\u001B[8~', { kind: 'end' }],
  ['\u001B[A', { kind: 'up' }],
  ['\u001B[B', { kind: 'down' }],
  ['\u001B[C', { kind: 'right' }],
  ['\u001B[D', { kind: 'left' }],
  ['\u001B[H', { kind: 'home' }],
  ['\u001B[F', { kind: 'end' }],
  ['\u001BOA', { kind: 'up' }],
  ['\u001BOB', { kind: 'down' }],
  ['\u001BOC', { kind: 'right' }],
  ['\u001BOD', { kind: 'left' }],
  ['\u001BOH', { kind: 'home' }],
  ['\u001BOF', { kind: 'end' }],
  ['\u001B[Z', { kind: 'shift-tab' }],
  // Alt+b / Alt+f step by word, Alt+Backspace kills one: the Emacs bindings a
  // terminal sends as Escape-prefixed letters.
  ['\u001Bb', { kind: 'word-left' }],
  ['\u001Bf', { kind: 'word-right' }],
  ['\u001B\u007F', { kind: 'kill-word' }],
  // Alt-Enter inserts a line break; Enter alone submits.
  ['\u001B\r', { kind: 'newline' }],
  ['\u001B\n', { kind: 'newline' }],
]

/**
 * Control bytes that map straight to one key.
 *
 * Both carriage return and line feed submit. A terminal in raw mode sends `\r`
 * for Enter, but not every one does, and a key that inserted a line break
 * instead of submitting would be the worse failure — Alt-Enter is the binding
 * that adds a line.
 */
const CONTROLS: Readonly<Record<string, Key>> = {
  '\r': { kind: 'enter' },
  '\n': { kind: 'enter' },
  '\t': { kind: 'tab' },
  '\u007F': { kind: 'backspace' },
  '\b': { kind: 'backspace' },
  '\u0003': { kind: 'interrupt' },
  '\u0004': { kind: 'eof' },
  '\u0001': { kind: 'home' },
  '\u0005': { kind: 'end' },
  '\u000B': { kind: 'kill-line' },
  '\u000C': { kind: 'clear-screen' },
  '\u000F': { kind: 'expand-output' },
  '\u0015': { kind: 'kill-input' },
  '\u0017': { kind: 'kill-word' },
}

/** Decodes terminal bytes into keys, holding partial sequences between reads. */
export class KeyDecoder {
  private held = ''
  private pasting = false
  private pasted = ''

  /**
   * Feed one read's worth of input.
   * @param chunk - the bytes as text.
   * @returns the keys this read completed, in order.
   */
  push(chunk: string): Key[] {
    this.held += chunk
    const keys: Key[] = []
    for (;;) {
      const key = this.take()
      if (key === undefined) break
      keys.push(...key)
    }
    return keys
  }

  /** Whether bytes are held back awaiting the rest of a sequence. */
  get pending(): boolean {
    return this.held !== ''
  }

  /**
   * Resolve a held Escape that no further byte arrived for.
   *
   * `ESC` alone and the first byte of `ESC [ A` are the same byte, so the two can
   * only be told apart by what follows — or by nothing following. The caller arms
   * a short timer after each read and calls this when it expires: an arrow key
   * split across reads completes long before that, and a key pressed by itself
   * never completes at all.
   * @returns the Escape key, or nothing when the held bytes are a real prefix.
   */
  flush(): Key[] {
    if (this.pasting || this.held !== '\u001B') return []
    this.held = ''
    return [{ kind: 'escape' }]
  }

  /**
   * Resolve the held bytes into one key, if they are enough.
   * @returns the keys produced, or undefined when more bytes are needed.
   */
  private take(): Key[] | undefined {
    if (this.held === '') return undefined
    if (this.pasting) return this.takePasted()
    if (this.held.startsWith(PASTE_START)) {
      this.held = this.held.slice(PASTE_START.length)
      this.pasting = true
      this.pasted = ''
      return []
    }
    // A partial bracketed-paste marker must not be read as an Escape.
    if (PASTE_START.startsWith(this.held)) return undefined
    const mouse = MOUSE.exec(this.held)
    if (mouse !== null) {
      this.held = this.held.slice(mouse[0].length)
      const button = Number(mouse[1])
      // Only the wheel moves the transcript; a click is the terminal's own
      // business, and swallowing it silently is what keeps selection working.
      if (button === WHEEL_UP) return [{ kind: 'scroll', lines: -WHEEL_LINES }]
      if (button === WHEEL_UP + 1) return [{ kind: 'scroll', lines: WHEEL_LINES }]
      return []
    }
    // A mouse report still arriving must not be read as an Escape either.
    if (/^\u001B(\[(<\d*(;\d*){0,2})?)?$/.test(this.held)) return undefined
    for (const [sequence, key] of SEQUENCES) {
      if (this.held.startsWith(sequence)) {
        this.held = this.held.slice(sequence.length)
        return [key]
      }
      if (sequence.startsWith(this.held)) return undefined
    }
    const first = this.held[0] ?? ''
    if (first === '\u001B') {
      // An Escape that begins no known sequence: the terminal sent something
      // this surface has no binding for, so the introducer is dropped rather
      // than typed into the buffer as a control character.
      this.held = this.held.slice(1)
      return []
    }
    const control = CONTROLS[first]
    if (control !== undefined) {
      this.held = this.held.slice(1)
      return [control]
    }
    // Take every printable character available in one key, so a fast typist or a
    // multi-byte character is not split into separate edits.
    const printable = /^[^\u0000-\u001F\u007F]+/u.exec(this.held)
    if (printable === null) {
      this.held = this.held.slice(1)
      return []
    }
    this.held = this.held.slice(printable[0].length)
    return [{ kind: 'text', text: printable[0] }]
  }

  /**
   * Collect bracketed-paste content up to its end marker.
   * @returns the paste key once complete, otherwise undefined.
   */
  private takePasted(): Key[] | undefined {
    const end = this.held.indexOf(PASTE_END)
    if (end < 0) {
      // Keep a possible partial end marker held back so it is never pasted.
      const safe = Math.max(0, this.held.length - PASTE_END.length + 1)
      this.pasted += this.held.slice(0, safe)
      this.held = this.held.slice(safe)
      return undefined
    }
    this.pasted += this.held.slice(0, end)
    this.held = this.held.slice(end + PASTE_END.length)
    this.pasting = false
    const text = this.pasted
    this.pasted = ''
    return [{ kind: 'paste', text }]
  }
}

/** Ask the terminal to wrap pasted text in markers. */
export const ENABLE_PASTE_MARKERS = '\u001B[?2004h'

/** Stop the terminal wrapping pasted text, restoring what it did before. */
export const DISABLE_PASTE_MARKERS = '\u001B[?2004l'
