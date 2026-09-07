/**
 * Terminal styling and display metrics: SGR sequences that degrade to plain
 * text off a TTY, and the display-column width a rendered string occupies.
 * @module codsh-bundle/src/theme
 */

import stringWidth from 'string-width'

/** Background color for user messages and sticky headers (deep plum / eggplant in dark mode). */
export const BG_USER_DARK_TRUECOLOR = '\u001B[48;2;30;19;38m'
export const BG_USER_DARK_256 = '\u001B[48;5;53m'

/** Background color for user messages and sticky headers (soft lavender in light mode). */
export const BG_USER_LIGHT_TRUECOLOR = '\u001B[48;2;243;234;246m'
export const BG_USER_LIGHT_256 = '\u001B[48;5;225m'

/** SGR codes applied by {@link Theme}, by role. */
const SGR = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  strike: '\u001B[9m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
  brightBlack: '\u001B[90m',
  brightYellow: '\u001B[93m',
} as const

/** Style roles the renderer asks for, resolved to SGR codes by {@link createTheme}. */
export interface Theme {
  /** Whether this theme emits SGR sequences at all. */
  readonly colored: boolean
  dim(text: string): string
  bold(text: string): string
  /** Strikethrough text. */
  strike(text: string): string
  /** Secondary chrome text (status model/cwd, legend, separators). */
  muted(text: string): string
  /** Focus and selection only: input frame default, marked selector rows. */
  accent(text: string): string
  /** Agent / user identity colour. */
  agent(text: string): string
  /** Failures and alarms. */
  err(text: string): string
  /** Completed work and added diff lines. */
  ok(text: string): string
  /** Warnings and pending state. */
  warn(text: string): string
  /** Tool names and card titles. */
  tool(text: string): string
  /** File paths and locations. */
  path(text: string): string
  /** Alias for {@link Theme.err}. */
  error(text: string): string
  /** Alias for {@link Theme.ok}. */
  success(text: string): string
  /** Alias for {@link Theme.warn}. */
  pending(text: string): string
  /** Alias for {@link Theme.agent}. */
  user(text: string): string
  /** Adopt the light- or dark-background palette. */
  setLight(light: boolean): void
  /** Roles used inside a fenced code block. */
  readonly syntax: SyntaxTheme
  /** Background for user messages / prompts (Grok bg_light). */
  bgUser(text: string): string
  /** Background for tool calls and executions (Grok bg_dark). */
  bgTool(text: string): string
  /** Background for reasoning / thinking blocks (Grok bg_thinking). */
  bgThinking(text: string): string
  /** Background for errors and failures (Grok diff_delete_bg / toolErrorBg). */
  bgError(text: string): string
  /** Background for code blocks (Grok md_code_bg). */
  bgCode(text: string): string
  /** Background for system / meta blocks (compaction, plan mode). */
  bgMeta(text: string): string
  /** Diff addition line (Grok diff_insert_bg + diff_insert_fg). */
  diffAdd(text: string): string
  /** Diff deletion line (Grok diff_delete_bg + diff_delete_fg). */
  diffDel(text: string): string
}

/** Styling for the token classes a code block is coloured by. */
export interface SyntaxTheme {
  keyword(text: string): string
  type(text: string): string
  fn(text: string): string
  string(text: string): string
  number(text: string): string
  comment(text: string): string
  property(text: string): string
}

/** A theme that emits no sequences, used off a TTY and under `NO_COLOR`. */
const PLAIN: Theme = {
  colored: false,
  setLight: () => {},
  dim: text => text,
  bold: text => text,
  strike: text => text,
  muted: text => text,
  accent: text => text,
  agent: text => text,
  err: text => text,
  ok: text => text,
  warn: text => text,
  tool: text => text,
  path: text => text,
  error: text => text,
  success: text => text,
  pending: text => text,
  user: text => text,
  syntax: {
    keyword: text => text,
    type: text => text,
    fn: text => text,
    string: text => text,
    number: text => text,
    comment: text => text,
    property: text => text,
  },
  bgUser: text => text,
  bgTool: text => text,
  bgThinking: text => text,
  bgError: text => text,
  bgCode: text => text,
  bgMeta: text => text,
  diffAdd: text => text,
  diffDel: text => text,
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
  const truecolor = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit'
  const wrap = (code: string) => (text: string): string => `${code}${text}${SGR.reset}`
  // Mutable on purpose: the background answer arrives moments after the first
  // frame, and everything rendered from then on picks the readable shade.
  let isLight = false
  let gray = '\u001B[38;5;245m'
  let amber = '\u001B[38;5;172m'
  const err = wrap(SGR.red)
  const ok = wrap(SGR.green)
  const warn = (text: string): string => `${palette ? amber : SGR.brightYellow}${text}${SGR.reset}`
  const tool = (text: string): string => `${palette ? amber : SGR.yellow}${text}${SGR.reset}`
  const agent = wrap(SGR.magenta)

  const wrapBg = (getSeq: () => string) => (text: string): string => {
    if (text === '') return ''
    const seq = getSeq()
    if (seq === '') return text
    const inner = text.endsWith(SGR.reset) ? text.slice(0, -SGR.reset.length) : text
    return `${seq}${inner.replaceAll(SGR.reset, `${SGR.reset}${seq}`)}${SGR.reset}`
  }

  const getBgUser = (): string => isLight
    ? (truecolor ? BG_USER_LIGHT_TRUECOLOR : palette ? BG_USER_LIGHT_256 : '\u001B[47m')
    : (truecolor ? BG_USER_DARK_TRUECOLOR : palette ? BG_USER_DARK_256 : '\u001B[40m')

  const getBgTool = (): string => isLight
    ? (truecolor ? '\u001B[48;2;243;245;248m' : palette ? '\u001B[48;5;255m' : '\u001B[47m')
    : (truecolor ? '\u001B[48;2;14;18;24m' : palette ? '\u001B[48;5;235m' : '\u001B[40m')

  const getBgThinking = (): string => isLight
    ? (truecolor ? '\u001B[48;2;245;242;250m' : palette ? '\u001B[48;5;255m' : '\u001B[47m')
    : (truecolor ? '\u001B[48;2;20;16;32m' : palette ? '\u001B[48;5;236m' : '\u001B[40m')

  const getBgError = (): string => isLight
    ? (truecolor ? '\u001B[48;2;254;226;226m' : palette ? '\u001B[48;5;224m' : '\u001B[41m')
    : (truecolor ? '\u001B[48;2;45;15;25m' : palette ? '\u001B[48;5;52m' : '\u001B[41m')

  const getBgCode = (): string => isLight
    ? (truecolor ? '\u001B[48;2;240;242;246m' : palette ? '\u001B[48;5;254m' : '\u001B[47m')
    : (truecolor ? '\u001B[48;2;15;18;24m' : palette ? '\u001B[48;5;235m' : '\u001B[40m')

  const getBgMeta = (): string => isLight
    ? (truecolor ? '\u001B[48;2;244;244;246m' : palette ? '\u001B[48;5;255m' : '\u001B[47m')
    : (truecolor ? '\u001B[48;2;18;20;26m' : palette ? '\u001B[48;5;236m' : '\u001B[40m')

  const getDiffAdd = (): string => isLight
    ? (truecolor ? '\u001B[48;2;236;253;245;38;2;22;101;52m' : palette ? '\u001B[48;5;194;38;5;28m' : '\u001B[42;30m')
    : (truecolor ? '\u001B[48;2;10;38;30;38;2;80;200;140m' : palette ? '\u001B[48;5;22;38;5;120m' : '\u001B[42;30m')

  const getDiffDel = (): string => isLight
    ? (truecolor ? '\u001B[48;2;254;242;242;38;2;153;27;27m' : palette ? '\u001B[48;5;224;38;5;160m' : '\u001B[41;37m')
    : (truecolor ? '\u001B[48;2;45;15;25;38;2;240;100;110m' : palette ? '\u001B[48;5;52;38;5;203m' : '\u001B[41;37m')

  const getKeywordColor = (): string => truecolor
    ? (isLight ? '\u001B[38;2;175;0;219m' : '\u001B[38;2;197;134;192m')
    : palette ? '\u001B[38;5;176m' : SGR.magenta

  const getTypeColor = (): string => truecolor
    ? (isLight ? '\u001B[38;2;38;127;153m' : '\u001B[38;2;78;201;176m')
    : palette ? '\u001B[38;5;73m' : SGR.cyan

  const getFnColor = (): string => truecolor
    ? (isLight ? '\u001B[38;2;121;94;38m' : '\u001B[38;2;220;220;170m')
    : palette ? '\u001B[38;5;186m' : SGR.yellow

  const getStringColor = (): string => truecolor
    ? (isLight ? '\u001B[38;2;163;21;21m' : '\u001B[38;2;206;145;120m')
    : palette ? '\u001B[38;5;173m' : SGR.green

  const getNumberColor = (): string => truecolor
    ? (isLight ? '\u001B[38;2;9;134;88m' : '\u001B[38;2;181;206;168m')
    : palette ? '\u001B[38;5;151m' : SGR.cyan

  const getPropertyColor = (): string => truecolor
    ? (isLight ? '\u001B[38;2;0;16;128m' : '\u001B[38;2;156;220;254m')
    : palette ? '\u001B[38;5;117m' : SGR.blue

  return {
    colored: true,
    setLight(light: boolean) {
      isLight = light
      gray = light ? '\u001B[38;5;242m' : '\u001B[38;5;245m'
      amber = light ? '\u001B[38;5;130m' : '\u001B[38;5;172m'
    },
    dim: text => `${palette ? gray : SGR.dim}${text}${SGR.reset}`,
    bold: wrap(SGR.bold),
    strike: wrap(SGR.strike),
    muted: wrap(SGR.brightBlack),
    accent: wrap(SGR.cyan),
    agent,
    err,
    ok,
    warn,
    tool,
    path: wrap(SGR.blue),
    error: err,
    success: ok,
    pending: warn,
    user: agent,
    bgUser: wrapBg(getBgUser),
    bgTool: wrapBg(getBgTool),
    bgThinking: wrapBg(getBgThinking),
    bgError: wrapBg(getBgError),
    bgCode: wrapBg(getBgCode),
    bgMeta: wrapBg(getBgMeta),
    diffAdd: wrapBg(getDiffAdd),
    diffDel: wrapBg(getDiffDel),
    syntax: {
      keyword: text => `${getKeywordColor()}${text}${SGR.reset}`,
      type: text => `${getTypeColor()}${text}${SGR.reset}`,
      fn: text => `${getFnColor()}${text}${SGR.reset}`,
      string: text => `${getStringColor()}${text}${SGR.reset}`,
      number: text => `${getNumberColor()}${text}${SGR.reset}`,
      comment: wrap(SGR.dim),
      property: text => `${getPropertyColor()}${text}${SGR.reset}`,
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
