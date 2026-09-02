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
 * @module codsh-bundle/src/keys
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
  | { kind: 'toggle-todos' }
  | { kind: 'history-search' }
  | { kind: 'transcript-search' }
  | { kind: 'turn'; direction: -1 | 1 }
  | { kind: 'page'; direction: -1 | 1 }
  /**
   * Scroll by lines. A scroll that carries a place came from the wheel; one
   * without came from the keyboard, and must never be steered by where the
   * pointer happens to be resting.
   */
  | { kind: 'scroll'; lines: number; at?: { row: number; column: number } }
  | { kind: 'scroll-end' }
  | { kind: 'paste'; text: string }
  | { kind: 'paste-image' }
  | { kind: 'mouse-down'; row: number; column: number }
  | { kind: 'mouse-drag'; row: number; column: number }
  | { kind: 'mouse-move'; row: number; column: number }
  | { kind: 'mouse-up'; row: number; column: number }
  | { kind: 'focus'; focused: boolean }
  | { kind: 'osc-reply'; code: number; payload: string }

/** Bracketed paste start, which a terminal wraps pasted text in. */
const PASTE_START = '\u001B[200~'

/** Bracketed paste end. */
const PASTE_END = '\u001B[201~'

/**
 * Rows one wheel event moves.
 *
 * One, not three: trackpads and hi-res wheels emit a stream of events per
 * gesture, so a multiplier here compounds into overshoot. The smoothness comes
 * from coalescing the stream into one repaint, not from bigger steps.
 */
const WHEEL_LINES = 1

/** An SGR mouse report: `ESC [ < button ; column ; row (M|m)`. */
const MOUSE = /^\u001B\[<(\d+);(\d+);(\d+)([Mm])/

/**
 * A kitty-keyboard-protocol report: `ESC [ code (:alternates) ; mods (:event) u`.
 *
 * The viewport pushes the protocol's disambiguate flag on entry (the same
 * flag Claude Code pushes), so terminals that speak it report Esc and every
 * modified key unambiguously — which is what makes Shift+Enter a key at all.
 * Terminals that don't speak it ignore the push and keep sending the legacy
 * sequences below.
 */
const KITTY = /^\u001B\[(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?u/

/**
 * A cursor or editing key in its CSI form: `ESC [ (number) (; mods) final`.
 *
 * The modifier field is open-ended — xterm adds Meta at 8, kitty adds Super,
 * Hyper, Meta, Caps Lock and Num Lock above it — so a fixed table of chords
 * can only ever list the few it thought of, and a person holding a lock sends
 * a report that matches none of them.
 */
const CSI_KEY = /^\u001B\[(\d*)(?:;(\d+))?([ABCDFH~])/

/** What each CSI final byte means with no chord held. */
const CURSOR_KEYS: Readonly<Record<string, Key>> = {
  A: { kind: 'up' },
  B: { kind: 'down' },
  C: { kind: 'right' },
  D: { kind: 'left' },
  H: { kind: 'home' },
  F: { kind: 'end' },
}

/** What each `~`-terminated CSI number means, chord or not. */
const TILDE_KEYS: Readonly<Record<string, Key>> = {
  1: { kind: 'home' },
  3: { kind: 'delete' },
  4: { kind: 'end' },
  5: { kind: 'page', direction: -1 },
  6: { kind: 'page', direction: 1 },
  7: { kind: 'home' },
  8: { kind: 'end' },
}

/** Kitty modifier bits, after the encoded +1 offset is removed. */
const KITTY_SHIFT = 1

/** The Alt bit. */
const KITTY_ALT = 2

/** The Control bit. */
const KITTY_CTRL = 4

/** Wheel-up button code in the SGR encoding; wheel-down is one higher. */
const WHEEL_UP = 64

/** Modifier bits in an SGR button code: Shift, Meta, and Control. */
const MOUSE_MODIFIERS = 4 | 8 | 16

/** The motion bit, set on every report the pointer's movement produces. */
const MOUSE_MOTION = 32

/**
 * The button code any-motion tracking sends when no button is held.
 *
 * Motion with a button reports that button; motion with none reports 3, the
 * same code a release carries — so a move is the motion bit over this, which
 * is what tells the surface which block the pointer is merely resting on.
 */
const MOUSE_NO_BUTTON = 3

/**
 * An OSC reply from the terminal: `ESC ] code ; payload (BEL | ESC \)`.
 *
 * The viewport asks for the background color (OSC 11) on entry; the reply
 * arrives on stdin and must be consumed here — leaked past the decoder it
 * would be typed into the input box as text.
 */
const OSC_REPLY = /^\u001B\](\d+);([^\u0007\u001B]*)(?:\u0007|\u001B\\)/

/** An OSC reply still arriving, its possible ST half included. */
const OSC_PARTIAL = /^\u001B\](?:\d*(?:;[^\u0007\u001B]*)?)?\u001B?$/

/** Sequences that resolve to one key, longest first so a prefix never wins. */
const SEQUENCES: readonly (readonly [string, Key])[] = [
  // Focus reporting (mode 1004), which the viewport enables: the bell policy
  // reads it — a person already looking at the terminal needs no bell.
  ['\u001B[I', { kind: 'focus', focused: true }],
  ['\u001B[O', { kind: 'focus', focused: false }],
  // Scrolling the transcript: the viewport is ours, so these are ours to read.
  ['\u001B[5~', { kind: 'page', direction: -1 }],
  ['\u001B[6~', { kind: 'page', direction: 1 }],
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
  '\u0014': { kind: 'toggle-todos' },
  '\u0012': { kind: 'history-search' },
  '\u0006': { kind: 'transcript-search' },
  '\u0015': { kind: 'kill-input' },
  // Ctrl+V reads the system clipboard for an image — the binding Claude Code
  // uses. An image never arrives through bracketed paste (that channel is
  // text by construction), so the surface has to go get the bytes itself.
  // The kitty form (CSI 118;5u) lands here too, via the Ctrl+letter lookup.
  '\u0016': { kind: 'paste-image' },
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
      const at = { row: Number(mouse[3]), column: Number(mouse[2]) }
      if (button === WHEEL_UP) return [{ kind: 'scroll', lines: -WHEEL_LINES, at }]
      if (button === WHEEL_UP + 1) return [{ kind: 'scroll', lines: WHEEL_LINES, at }]
      // The left button drives selection: press anchors it, motion extends
      // it, release copies it. Modified clicks stay the terminal's business —
      // a Shift-drag keeps reaching the terminal's own selection.
      const column = Number(mouse[2])
      const row = Number(mouse[3])
      // A bare move, with or without a modifier held: nothing is being
      // dragged, so it only says where the pointer is.
      if ((button & ~MOUSE_MODIFIERS) === (MOUSE_MOTION | MOUSE_NO_BUTTON)) {
        return [{ kind: 'mouse-move', row, column }]
      }
      if ((button & ~MOUSE_MOTION) === 0 && (button & MOUSE_MODIFIERS) === 0) {
        if (mouse[4] === 'm') return [{ kind: 'mouse-up', row, column }]
        if ((button & MOUSE_MOTION) !== 0) return [{ kind: 'mouse-drag', row, column }]
        return [{ kind: 'mouse-down', row, column }]
      }
      return []
    }
    const kitty = KITTY.exec(this.held)
    if (kitty !== null) {
      this.held = this.held.slice(kitty[0].length)
      return this.kittyKey(Number(kitty[1]), Number(kitty[2] ?? '1'), Number(kitty[3] ?? '1'))
    }
    const osc = OSC_REPLY.exec(this.held)
    if (osc !== null) {
      this.held = this.held.slice(osc[0].length)
      const code = Number(osc[1])
      // Only the color queries this surface sends have interesting answers;
      // any other terminal report is consumed silently.
      if (code === 10 || code === 11) return [{ kind: 'osc-reply', code, payload: osc[2] ?? '' }]
      return []
    }
    // A mouse, kitty, or OSC report still arriving must not be read as an
    // Escape — or worse, typed.
    if (/^\u001B(\[[\d;:<]*)?$/.test(this.held) || OSC_PARTIAL.test(this.held)) return undefined
    for (const [sequence, key] of SEQUENCES) {
      if (this.held.startsWith(sequence)) {
        this.held = this.held.slice(sequence.length)
        return [key]
      }
      if (sequence.startsWith(this.held)) return undefined
    }
    const csi = CSI_KEY.exec(this.held)
    if (csi !== null) {
      this.held = this.held.slice(csi[0].length)
      return this.csiKey(csi[1] ?? '', Number(csi[2] ?? '1'), csi[3] ?? '')
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
   * Map one kitty-protocol report onto the same keys the legacy bytes make.
   * @param code - the key's Unicode code point.
   * @param mods - the encoded modifiers, offset by one.
   * @param event - press (1), repeat (2), or release (3).
   * @returns the keys produced; unknown chords are swallowed, never typed.
   */
  private kittyKey(code: number, mods: number, event: number): Key[] {
    if (event === 3) return []
    // Lock keys ride along as high bits; only the chord modifiers matter.
    const bits = Math.max(0, mods - 1)
    const shift = (bits & KITTY_SHIFT) !== 0
    const alt = (bits & KITTY_ALT) !== 0
    const ctrl = (bits & KITTY_CTRL) !== 0
    if (code === 27) return [{ kind: 'escape' }]
    // The key this protocol exists for: Shift+Enter breaks the line, exactly
    // like Alt+Enter always has; Enter alone still submits.
    if (code === 13) return [shift || alt ? { kind: 'newline' } : { kind: 'enter' }]
    if (code === 9) return [shift ? { kind: 'shift-tab' } : { kind: 'tab' }]
    if (code === 127 || code === 8) return [alt || ctrl ? { kind: 'kill-word' } : { kind: 'backspace' }]
    if (ctrl && code >= 97 && code <= 122) {
      const control = CONTROLS[String.fromCharCode(code - 96)]
      return control === undefined ? [] : [control]
    }
    if (alt) {
      if (code === 98) return [{ kind: 'word-left' }]
      if (code === 102) return [{ kind: 'word-right' }]
      return []
    }
    // A text key that reached the CSI form anyway (Shift or a lock held).
    if (!ctrl && code >= 32) return [{ kind: 'text', text: String.fromCodePoint(code) }]
    return []
  }

  /**
   * Map one CSI cursor or editing report onto its key.
   *
   * Locks are stripped the same way {@link kittyKey} strips them: a chord is
   * only ever Shift, Alt, and Control, and Caps Lock left on must not turn an
   * arrow into typed text.
   * @param number - the leading parameter, `''` when the report carried none.
   * @param mods - the encoded modifiers, offset by one.
   * @param final - the report's final byte.
   * @returns the keys produced; an unknown report is swallowed, never typed.
   */
  private csiKey(number: string, mods: number, final: string): Key[] {
    const bits = Math.max(0, mods - 1)
    const shift = (bits & KITTY_SHIFT) !== 0
    const alt = (bits & KITTY_ALT) !== 0
    const ctrl = (bits & KITTY_CTRL) !== 0
    if (final === '~') {
      const key = TILDE_KEYS[number]
      return key === undefined ? [] : [key]
    }
    if (shift) {
      if (final === 'A') return [{ kind: 'scroll', lines: -1 }]
      if (final === 'B') return [{ kind: 'scroll', lines: 1 }]
      if (final === 'D') return [{ kind: 'turn', direction: -1 }]
      if (final === 'C') return [{ kind: 'turn', direction: 1 }]
    }
    if (ctrl && final === 'F') return [{ kind: 'scroll-end' }]
    if (ctrl || alt) {
      if (final === 'D') return [{ kind: 'word-left' }]
      if (final === 'C') return [{ kind: 'word-right' }]
    }
    const key = CURSOR_KEYS[final]
    return key === undefined ? [] : [key]
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
