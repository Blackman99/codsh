/**
 * Terminal styling and display metrics: SGR sequences that degrade to plain
 * text off a TTY, and the display-column width a rendered string occupies.
 * @module codsh-cli/src/theme
 */

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
  return {
    colored: true,
    dim: wrap(palette ? '\u001B[38;5;245m' : SGR.dim),
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
 * Inclusive code-point ranges rendered two columns wide by a terminal: the
 * East Asian Wide and Fullwidth classes of Unicode TR11, which cover the CJK
 * blocks, Hangul, the fullwidth forms, and the emoji planes this surface
 * prints.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0x33FF],
  [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF],
  [0xA960, 0xA97F], [0xAC00, 0xD7A3], [0xF900, 0xFAFF],
  [0xFE10, 0xFE19], [0xFE30, 0xFE6F], [0xFF00, 0xFF60],
  [0xFFE0, 0xFFE6], [0x1F300, 0x1F64F], [0x1F900, 0x1F9FF],
  [0x20000, 0x2FFFD], [0x30000, 0x3FFFD],
]

/** Matches one SGR sequence, which occupies no display column. */
const SGR_PATTERN = /\u001B\[[0-9;]*m/gu

/**
 * Whether one code point occupies two display columns.
 * @param code - the code point to classify.
 * @returns true when the terminal renders it double-width.
 */
function isWide(code: number): boolean {
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high)
}

/**
 * Display columns a string occupies once printed, ignoring styling sequences.
 *
 * Combining marks are counted as zero and East Asian Wide/Fullwidth code
 * points as two, which is what a terminal's own cursor arithmetic does. This
 * covers the alignment and wrapping this surface needs; it is not a complete
 * grapheme segmenter, so a ZWJ emoji sequence still counts each joined code
 * point ({@link ../README.md | Known Limitations}).
 * @param text - the string to measure, possibly carrying SGR sequences.
 * @returns the number of display columns.
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const character of text.replace(SGR_PATTERN, '')) {
    const code = character.codePointAt(0)
    if (code === undefined) continue
    // Combining marks attach to the preceding cell and advance no column.
    if (code >= 0x0300 && code <= 0x036F) continue
    width += isWide(code) ? 2 : 1
  }
  return width
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
    const step = code >= 0x0300 && code <= 0x036F ? 0 : isWide(code) ? 2 : 1
    if (width + step > columns - 1) break
    width += step
    out += cell
    at += cell.length
  }
  return `${out}${styled ? '\u001B[0m' : ''}…`
}
