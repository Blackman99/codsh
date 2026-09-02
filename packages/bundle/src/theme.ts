/**
 * Terminal styling and display metrics: SGR sequences that degrade to plain
 * text off a TTY, and the display-column width a rendered string occupies.
 * @module codsh-bundle/src/theme
 */

import stringWidth from 'string-width'

/** SGR codes applied by {@link Theme}, by role. */
const SGR = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
} as const

/** Style roles the renderer asks for, resolved to SGR codes by {@link createTheme}. */
export interface Theme {
  /** Whether this theme emits SGR sequences at all. */
  readonly colored: boolean
  dim(text: string): string
  bold(text: string): string
  /** Failures, denied approvals, and removed diff lines. */
  error(text: string): string
  /** Completed work and added diff lines. */
  success(text: string): string
  /** Pending state and approval prompts. */
  pending(text: string): string
  /** Tool names and card titles. */
  tool(text: string): string
  /** File paths and locations. */
  path(text: string): string
  /** The user's own echoed input. */
  user(text: string): string
  /**
   * Adopt the light- or dark-background palette.
   *
   * Base ANSI colors are the terminal theme's to map, but the secondary-text
   * gray is an absolute palette entry, and the shade that recedes on a dark
   * background washes out on a light one.
   */
  setLight(light: boolean): void
  /** Roles used inside a fenced code block. */
  readonly syntax: SyntaxTheme
}

/** Styling for the token classes a code block is coloured by. */
export interface SyntaxTheme {
  keyword(text: string): string
  string(text: string): string
  number(text: string): string
  comment(text: string): string
}

/** A theme that emits no sequences, used off a TTY and under `NO_COLOR`. */
const PLAIN: Theme = {
  colored: false,
  setLight: () => {},
  dim: text => text,
  bold: text => text,
  error: text => text,
  success: text => text,
  pending: text => text,
  tool: text => text,
  path: text => text,
  user: text => text,
  syntax: {
    keyword: text => text,
    string: text => text,
    number: text => text,
    comment: text => text,
  },
}

/**
 * Build the theme for one surface.
 *
 * Color is suppressed off a TTY and whenever `NO_COLOR` is set to any value,
 * following the `no-color.org` convention: a redirected transcript stays
 * greppable, and a pipe never receives sequences a reader would have to strip.
 *
 * Secondary text uses a palette gray on a 256-color terminal rather than the
 * `dim` attribute: several terminals render `dim` at full brightness, and a
 * hierarchy nobody can see is no hierarchy — the placeholder, the menu details,
 * and the status row must sit visibly behind what the person typed.
 * @param isTty - whether the output stream is a terminal.
 * @param env - the environment to read `NO_COLOR` and the color depth from.
 * @returns the styling functions for this surface.
 */
export function createTheme(isTty: boolean, env: Record<string, string | undefined>): Theme {
  if (!isTty || env.NO_COLOR !== undefined) return PLAIN
  const palette = env.TERM?.includes('256color') === true || env.COLORTERM !== undefined
  const wrap = (code: string) => (text: string): string => `${code}${text}${SGR.reset}`
  // Mutable on purpose: the background answer arrives moments after the first
  // frame, and everything rendered from then on picks the readable shade.
  let gray = '\u001B[38;5;245m'
  return {
    colored: true,
    setLight(light: boolean) {
      gray = light ? '\u001B[38;5;242m' : '\u001B[38;5;245m'
    },
    dim: text => `${palette ? gray : SGR.dim}${text}${SGR.reset}`,
    bold: wrap(SGR.bold),
    error: wrap(SGR.red),
    success: wrap(SGR.green),
    pending: wrap(SGR.yellow),
    tool: wrap(SGR.cyan),
    path: wrap(SGR.blue),
    user: wrap(SGR.magenta),
    syntax: {
      keyword: wrap(SGR.magenta),
      string: wrap(SGR.green),
      number: wrap(SGR.cyan),
      comment: wrap(SGR.dim),
    },
  }
}

/**
 * Whether an OSC 10/11 color answer names a light color.
 *
 * Channels arrive as `rgb:RR/GG/BB` with one to four hex digits each; each is
 * normalized by its own width before the relative-luminance weighting.
 * @param payload - the reply payload, e.g. `rgb:ffff/ffff/ffff`.
 * @returns true for light, false for dark, undefined when unparseable.
 */
export function backgroundIsLight(payload: string): boolean | undefined {
  const match = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(payload.trim())
  if (match === null) return undefined
  const channel = (hex: string): number => Number.parseInt(hex, 16) / (16 ** hex.length - 1)
  const [red, green, blue] = [channel(match[1] ?? '0'), channel(match[2] ?? '0'), channel(match[3] ?? '0')]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.5
}

/**
 * Display columns a string occupies once printed, ignoring styling sequences.
 *
 * Measured by `string-width` — the width authority cli-table3, ink, and every
 * maintained terminal renderer sit on — so East Asian Wide, emoji presentation
 * (`⚡` included), combining marks, and ZWJ sequences all match what a
 * terminal's cursor actually does. A hand-kept range table here mis-sized `⚡`
 * and sheared a real table's columns; widths are exactly the kind of data
 * nobody should maintain by hand.
 * @param text - the string to measure, possibly carrying SGR sequences.
 * @returns the number of display columns.
 */
export function displayWidth(text: string): number {
  if (text === '') return 0
  // Fast path: printable ASCII is one column each, no library call needed —
  // this sits under per-character wrapping loops.
  let ascii = true
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code > 0x7E) {
      ascii = false
      break
    }
  }
  if (ascii) return text.length
  return stringWidth(text)
}

/**
 * Every C0 control character except the escape SGR sequences are built from,
 * plus DEL.
 */
const CONTROL = /[\u0000-\u001A\u001C-\u001F\u007F]/u

/**
 * One escape sequence, matched where the scan stands.
 *
 * The C0 characters inside one belong to it — an OSC hyperlink or clipboard
 * write ends in BEL — so a sequence is copied whole rather than flattened
 * character by character.
 */
const ESCAPE_AT = /(?:\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007|\u001B[\s\S])/gy

/**
 * Flatten a string into something one row can hold.
 *
 * A newline in a row is not a character but a cursor movement, and the width
 * authority scores it zero columns — so a row carrying one measures as though
 * it fits, and painting it drops the terminal's cursor a line and writes the
 * remainder at column 1 of the row below. That row is usually one the frame
 * diff considers unchanged — a box border, say — so nothing ever paints over
 * the spill and it outlives every later frame. Every C0 character does this or
 * worse, so each becomes one space. It happens before anything measures: the
 * column a control character never had is exactly what the measurement got
 * wrong.
 * @param text - the string a single row will hold.
 * @param keepNewlines - leave `\n` in, for a caller that breaks rows on it.
 * @returns the string without control characters, keeping the escapes that style it.
 */
export function oneRow(text: string, keepNewlines = false): string {
  // Most rows hold nothing to flatten, and this sits under the wrapping loop.
  if (!CONTROL.test(text)) return text
  let out = ''
  let at = 0
  while (at < text.length) {
    const code = text.charCodeAt(at)
    if (code === 0x1B) {
      ESCAPE_AT.lastIndex = at
      const escape = ESCAPE_AT.exec(text)
      if (escape !== null) {
        out += escape[0]
        at += escape[0].length
        continue
      }
    }
    const control = code <= 0x1A || (code >= 0x1C && code <= 0x1F) || code === 0x7F
    out += control && !(keepNewlines && code === 0x0A) ? ' ' : text[at]
    at += 1
  }
  return out
}

/** Matches one SGR sequence at the start of a string. */
const SGR_AT_START = /^\u001B\[[0-9;]*m/u

/**
 * Shorten a string to at most `columns` display columns, marking the cut with
 * an ellipsis when anything was dropped.
 *
 * Styling survives: sequences cost no columns and travel with the text they
 * style, and a cut that kept any styling closes it with a reset before the
 * ellipsis so nothing leaks onto the next row. A string that already fits is
 * returned exactly as it came — a fit is not a licence to restyle it.
 * @param text - the string to shorten, possibly carrying SGR sequences.
 * @param columns - the display-column budget; a budget under 2 yields the empty string.
 * @returns the string, unchanged when it already fits.
 */
export function truncate(text: string, columns: number): string {
  // Before the measurement, never after: a row is one row, and a control
  // character inside one is a lie about how many columns it occupies.
  text = oneRow(text)
  if (displayWidth(text) <= columns) return text
  if (columns < 2) return ''
  let width = 0
  let out = ''
  let styled = false
  let at = 0
  while (at < text.length) {
    const sequence = SGR_AT_START.exec(text.slice(at))
    if (sequence !== null) {
      out += sequence[0]
      styled = true
      at += sequence[0].length
      continue
    }
    const code = text.codePointAt(at) ?? 0
    const cell = String.fromCodePoint(code)
    const step = displayWidth(cell)
    if (width + step > columns - 1) break
    width += step
    out += cell
    at += cell.length
  }
  return `${out}${styled ? '\u001B[0m' : ''}…`
}
