/**
 * Terminal styling and display metrics: SGR sequences that degrade to plain
 * text off a TTY, and the display-column width a rendered string occupies.
 * @module codsh-bundle/src/theme
 */

import stringWidth from 'string-width'
import { DEEPSEEK, DEEPSEEK_LIGHT, PALETTES, isBackground, nearest256, nearestAnsi, params } from './palette.ts'
import type { Depth, PaletteSpec, Slot, ThemeName, ThemeSetting } from './palette.ts'

export type { Slot, ThemeName, ThemeSetting } from './palette.ts'

/** SGR codes applied by {@link Theme}, by role. */
const SGR = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  italic: '\u001B[3m',
  underline: '\u001B[4m',
  strike: '\u001B[9m',
} as const

/** Style roles the renderer asks for, resolved to SGR codes by {@link createTheme}. */
export interface Theme {
  /** Whether this theme emits SGR sequences at all. */
  readonly colored: boolean
  /** The theme choice in force: a name, or `auto`. */
  readonly setting: ThemeSetting
  /** The palette painting now, or undefined when nothing is painted. */
  readonly resolved: ThemeName | undefined
  /** Whether surfaces get bands (the person's message fill); otherwise it is bold. */
  readonly bands: boolean
  /** The cursor colour this theme sets with OSC 12, as `#rrggbb`, if any. */
  readonly cursor: string | undefined
  dim(text: string): string
  bold(text: string): string
  /** Strikethrough text. */
  strike(text: string): string
  /** Italic text, for an answer's `<i>` and `<em>`. */
  italic(text: string): string
  /** Underlined text, for an answer's `<u>`. */
  underline(text: string): string
  /**
   * Foreground styling for a colour an answer names in inline HTML — a CSS
   * colour name, `#rgb`, `#rrggbb`, or `rgb(r, g, b)`.
   * @returns the styling function, or undefined when the spec names no colour.
   */
  color(spec: string): ((text: string) => string) | undefined
  /** Secondary chrome text (status model/cwd, legend, separators). */
  muted(text: string): string
  /** Brand and focus: input frame, the person's rail, marked selector rows. */
  accent(text: string): string
  /** Agent identity: thinking, skills, the model's side of the conversation. */
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
  /** A heading in an answer. */
  heading(text: string): string
  /** A link's label in an answer. */
  link(text: string): string
  /** Alias for {@link Theme.err}. */
  error(text: string): string
  /** Alias for {@link Theme.ok}. */
  success(text: string): string
  /** Alias for {@link Theme.warn}. */
  pending(text: string): string
  /** The person's side of the conversation: the brand, like {@link Theme.accent}. */
  user(text: string): string
  /**
   * Adopt the light- or dark-background palette. Only `auto` follows it; a
   * theme chosen by name keeps its own polarity.
   * @returns whether the painting palette changed.
   */
  setLight(light: boolean): boolean
  /**
   * Switch theme in place: every role already handed out paints the new
   * palette from its next call.
   * @returns whether the painting palette changed.
   */
  setTheme(setting: ThemeSetting): boolean
  /**
   * The raw escape one slot paints, for a renderer that composes its own
   * rows (a hover fill, the sticky header, the mark).
   * @returns the SGR sequence, or `''` when the slot is not painted.
   */
  sgr(slot: Slot): string
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
  setting: 'auto',
  resolved: undefined,
  bands: false,
  cursor: undefined,
  setLight: () => false,
  setTheme: () => false,
  sgr: () => '',
  dim: text => text,
  bold: text => text,
  strike: text => text,
  italic: text => text,
  underline: text => text,
  color: spec => parseColor(spec) === undefined ? undefined : text => text,
  muted: text => text,
  accent: text => text,
  agent: text => text,
  err: text => text,
  ok: text => text,
  warn: text => text,
  tool: text => text,
  path: text => text,
  heading: text => text,
  link: text => text,
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

/** One palette resolved for one terminal: the escape each slot paints. */
interface Resolved {
  readonly spec: PaletteSpec
  readonly seq: Readonly<Record<Slot, string>>
  readonly diffAdd: string
  readonly diffDel: string
}

/** Every slot, for resolving a palette whole. */
const SLOTS: readonly Slot[] = [
  'accent', 'accent_soft', 'fg_dim', 'fg_muted', 'border', 'success', 'error', 'warning', 'tool',
  'diff_insert_fg', 'diff_delete_fg',
  'syntax_keyword', 'syntax_type', 'syntax_fn', 'syntax_string', 'syntax_number', 'syntax_comment', 'syntax_property',
  'logo_chevron', 'logo_hull', 'logo_water',
  'bg_light', 'bg_dark', 'bg_thinking', 'bg_error', 'md_code_bg', 'bg_meta', 'bg_hover',
  'diff_insert_bg', 'diff_delete_bg',
]

/**
 * The escapes a palette paints at a depth. A 16-colour-only palette paints its
 * sixteen colours whatever the terminal could do.
 */
function resolvePalette(spec: PaletteSpec, depth: Depth): Resolved {
  const at: Depth = spec.ansiOnly ? '16' : depth
  const raw = (slot: Slot): string => params(spec.slots[slot], isBackground(slot) ? 'bg' : 'fg', at)
  const escape = (codes: string): string => codes === '' ? '' : `\u001B[${codes}m`
  const seq = Object.fromEntries(SLOTS.map(slot => [slot, escape(raw(slot))])) as Record<Slot, string>
  const pair = (bg: Slot, fg: Slot): string => escape([raw(bg), raw(fg)].filter(codes => codes !== '').join(';'))
  return { spec, seq, diffAdd: pair('diff_insert_bg', 'diff_insert_fg'), diffDel: pair('diff_delete_bg', 'diff_delete_fg') }
}

/**
 * The depth a terminal advertises: truecolor when `COLORTERM` says so, the
 * 256-colour palette when `TERM` or any `COLORTERM` does, sixteen otherwise.
 */
function depthOf(env: Record<string, string | undefined>): Depth {
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor'
  if (env.TERM?.includes('256color') === true || env.COLORTERM !== undefined) return '256'
  return '16'
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
 *
 * The record is built once and never replaced: renderers keep references to
 * its roles (`theme.bold`, `theme.syntax`), so a theme switch changes what
 * those same functions paint rather than handing out new ones.
 * @param isTty - whether the output stream is a terminal.
 * @param env - the environment to read `NO_COLOR` and the color depth from.
 * @param initial - the theme choice to start with.
 * @returns the styling functions for this surface.
 */
export function createTheme(isTty: boolean, env: Record<string, string | undefined>, initial: ThemeSetting = 'auto'): Theme {
  if (!isTty || env.NO_COLOR !== undefined) return PLAIN
  const depth = depthOf(env)
  // Mutable on purpose: the background answer arrives moments after the first
  // frame, and a person can switch theme mid-session; everything rendered
  // from then on picks the new palette.
  let setting: ThemeSetting = initial
  let light = false
  const pick = (): PaletteSpec => setting === 'auto' ? (light ? DEEPSEEK_LIGHT : DEEPSEEK) : PALETTES[setting]
  let active = resolvePalette(pick(), depth)
  const refresh = (): boolean => {
    const next = pick()
    if (next === active.spec) return false
    active = resolvePalette(next, depth)
    return true
  }

  const paint = (seq: string, text: string): string => seq === '' ? text : `${seq}${text}${SGR.reset}`
  const role = (slot: Slot) => (text: string): string => paint(active.seq[slot], text)
  const wrap = (code: string) => (text: string): string => `${code}${text}${SGR.reset}`
  const wrapBg = (getSeq: () => string) => (text: string): string => {
    if (text === '') return ''
    const seq = getSeq()
    if (seq === '') return text
    const inner = text.endsWith(SGR.reset) ? text.slice(0, -SGR.reset.length) : text
    return `${seq}${inner.replaceAll(SGR.reset, `${SGR.reset}${seq}`)}${SGR.reset}`
  }
  const background = (slot: Slot) => wrapBg(() => active.seq[slot])

  const accent = role('accent')
  const agent = role('accent_soft')
  const err = role('error')
  const ok = role('success')
  const warn = role('warning')

  return {
    colored: true,
    get setting() { return setting },
    get resolved() { return active.spec.name },
    get bands() { return active.spec.bands },
    get cursor() { return active.spec.cursor },
    setLight(next: boolean) {
      light = next
      return refresh()
    },
    setTheme(next: ThemeSetting) {
      setting = next
      return refresh()
    },
    sgr: slot => active.seq[slot],
    dim: role('fg_dim'),
    bold: wrap(SGR.bold),
    strike: wrap(SGR.strike),
    italic: wrap(SGR.italic),
    underline: wrap(SGR.underline),
    color: (spec) => {
      const parsed = parseColor(spec)
      if (parsed === undefined) return undefined
      // A named ANSI colour is the terminal's own: `green` matches what the
      // theme paints success in, on this person's palette, light or dark.
      if ('ansi' in parsed) return wrap(`\u001B[${parsed.ansi}m`)
      const [red, green, blue] = parsed.rgb
      const at: Depth = active.spec.ansiOnly ? '16' : depth
      if (at === 'truecolor') return wrap(`\u001B[38;2;${red};${green};${blue}m`)
      if (at === '256') return wrap(`\u001B[38;5;${nearest256(red, green, blue)}m`)
      return wrap(`\u001B[${nearestAnsi(red, green, blue)}m`)
    },
    muted: role('fg_muted'),
    accent,
    agent,
    err,
    ok,
    warn,
    tool: role('tool'),
    path: agent,
    heading: agent,
    link: agent,
    error: err,
    success: ok,
    pending: warn,
    user: accent,
    bgUser: background('bg_light'),
    bgTool: background('bg_dark'),
    bgThinking: background('bg_thinking'),
    bgError: background('bg_error'),
    bgCode: background('md_code_bg'),
    bgMeta: background('bg_meta'),
    diffAdd: wrapBg(() => active.diffAdd),
    diffDel: wrapBg(() => active.diffDel),
    syntax: {
      keyword: role('syntax_keyword'),
      type: role('syntax_type'),
      fn: role('syntax_fn'),
      string: role('syntax_string'),
      number: role('syntax_number'),
      comment: role('syntax_comment'),
      property: role('syntax_property'),
    },
  }
}

/** A colour an answer named: one of the terminal's own, or a point in sRGB. */
export type ColorSpec = { ansi: string } | { rgb: [number, number, number] }

/**
 * The ANSI colour names, as the SGR foreground code that reaches the
 * terminal's own palette. Not sRGB values: `green` in an answer should be the
 * green this person's terminal paints, the way the theme's own roles are.
 */
const ANSI_COLORS: Record<string, string> = {
  black: '30', red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36', white: '37',
  gray: '90', grey: '90',
}

/** The CSS colour names an answer is likely to reach for, in sRGB. */
const CSS_COLORS: Record<string, [number, number, number]> = {
  orange: [255, 165, 0], darkorange: [255, 140, 0], orangered: [255, 69, 0], gold: [255, 215, 0], goldenrod: [218, 165, 32],
  purple: [128, 0, 128], violet: [238, 130, 238], indigo: [75, 0, 130], plum: [221, 160, 221], orchid: [218, 112, 214],
  pink: [255, 192, 203], hotpink: [255, 105, 180], deeppink: [255, 20, 147], fuchsia: [255, 0, 255],
  brown: [165, 42, 42], chocolate: [210, 105, 30], tan: [210, 180, 140], khaki: [240, 230, 140], wheat: [245, 222, 179],
  crimson: [220, 20, 60], firebrick: [178, 34, 34], maroon: [128, 0, 0], darkred: [139, 0, 0],
  tomato: [255, 99, 71], coral: [255, 127, 80], salmon: [250, 128, 114],
  lime: [0, 255, 0], limegreen: [50, 205, 50], forestgreen: [34, 139, 34], seagreen: [46, 139, 87], springgreen: [0, 255, 127],
  darkgreen: [0, 100, 0], lightgreen: [144, 238, 144], olive: [128, 128, 0], teal: [0, 128, 128],
  aqua: [0, 255, 255], turquoise: [64, 224, 208], navy: [0, 0, 128], darkblue: [0, 0, 139], royalblue: [65, 105, 225],
  steelblue: [70, 130, 180], dodgerblue: [30, 144, 255], deepskyblue: [0, 191, 255], skyblue: [135, 206, 235], lightblue: [173, 216, 230],
  silver: [192, 192, 192], lightgray: [211, 211, 211], lightgrey: [211, 211, 211], darkgray: [169, 169, 169], darkgrey: [169, 169, 169],
  dimgray: [105, 105, 105], dimgrey: [105, 105, 105], beige: [245, 245, 220], ivory: [255, 255, 240], lavender: [230, 230, 250],
}

/**
 * Read a colour the way a browser would: a name, `#rgb`, `#rrggbb`, or
 * `rgb(r, g, b)`; case and surrounding space do not matter.
 * @param spec - the attribute value.
 * @returns the colour, or undefined when the text names none.
 */
export function parseColor(spec: string): ColorSpec | undefined {
  const name = spec.trim().toLowerCase()
  if (name in ANSI_COLORS) return { ansi: ANSI_COLORS[name] ?? '37' }
  const css = CSS_COLORS[name]
  if (css !== undefined) return { rgb: css }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(name)
  if (hex !== null) {
    const digits = hex[1] ?? ''
    const wide = digits.length === 6 ? digits : [...digits].map(d => d + d).join('')
    return { rgb: [0, 2, 4].map(at => Number.parseInt(wide.slice(at, at + 2), 16)) as [number, number, number] }
  }
  const fn = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)$/u.exec(name)
  if (fn !== null) {
    const channel = (text: string | undefined): number => Math.min(255, Number.parseInt(text ?? '0', 10))
    return { rgb: [channel(fn[1]), channel(fn[2]), channel(fn[3])] }
  }
  return undefined
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

/** Grapheme segmenter: the clustering `string-width` measures by, so the two agree by construction. */
const GRAPHEMES = new Intl.Segmenter()

/**
 * A reader of `text` one grapheme cluster at a time.
 *
 * A terminal paints a cluster — a base with its variation selector, skin tone,
 * ZWJ-joined partners, or combining marks — as one run of cells, and
 * {@link displayWidth} measures it whole: `🎙️` is two columns, not the one
 * column of its base plus the zero of its selector. A scan that stepped by
 * code point summed the parts instead and came out a column short, which is
 * how a table rule drifted one cell on every row that carried such an emoji,
 * and how a truncation cut a family emoji between its joiners. Plain ASCII
 * never clusters with plain ASCII, so the common line costs no segmentation.
 * @param text - the string to read, styling sequences included; an escape is
 *   a control character, which never joins a cluster.
 * @returns the cluster starting at an index; the caller advances by its length.
 */
export function graphemeAt(text: string): (at: number) => string {
  let segments: Intl.Segments | undefined
  return (at: number): string => {
    const code = text.charCodeAt(at)
    const next = at + 1 < text.length ? text.charCodeAt(at + 1) : 0
    if (code < 0x80 && next < 0x80) return text[at] ?? ''
    segments ??= GRAPHEMES.segment(text)
    const found = segments.containing(at)
    if (found === undefined) return ''
    // A mark right after an escape's final letter clusters with that letter in
    // the segmenter's eyes; the caller already consumed the letter.
    return found.index < at ? found.segment.slice(at - found.index) : found.segment
  }
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

/** Start reverse video, which is how a selection shows itself. */
const INVERSE = '\u001B[7m'

/** End reverse video only, leaving any other attributes alone. */
const INVERSE_OFF = '\u001B[27m'

/**
 * The string index where a display column begins.
 *
 * Columns are what the mouse reports and characters are what strings hold;
 * this is the bridge. A column landing inside a wide character snaps past it.
 * Styling sequences cost no columns and are skipped.
 * @param text - the string to scan, possibly carrying SGR sequences.
 * @param column - display column, 0-based.
 * @returns the index of the first character at or beyond that column.
 */
export function columnIndex(text: string, column: number): number {
  let width = 0
  let index = 0
  const cluster = graphemeAt(text)
  while (index < text.length) {
    const sequence = SGR_AT_START.exec(text.slice(index))
    if (sequence !== null) {
      index += sequence[0].length
      continue
    }
    if (width >= column) return index
    const cell = cluster(index)
    if (cell === '') break
    width += displayWidth(cell)
    index += cell.length
  }
  return text.length
}

/**
 * Mark a display-column span in reverse video.
 *
 * A reset inside the span would drop the invert, so it is armed again after
 * each one. A range that covers nothing is returned unchanged.
 * @param text - the styled row.
 * @param fromCol - first display column to mark, 0-based, inclusive.
 * @param toCol - first display column to leave unmarked, exclusive.
 * @returns the row with the span inverted.
 */
export function markSpan(text: string, fromCol: number, toCol: number): string {
  text = oneRow(text)
  if (fromCol >= toCol) return text
  let width = 0
  let out = ''
  let at = 0
  let inside = false
  const cluster = graphemeAt(text)
  while (at < text.length) {
    const sequence = SGR_AT_START.exec(text.slice(at))
    if (sequence !== null) {
      out += sequence[0]
      if (inside && sequence[0] === SGR.reset) out += INVERSE
      at += sequence[0].length
      continue
    }
    const cell = cluster(at)
    if (cell === '') break
    if (!inside && width < toCol && width + displayWidth(cell) > fromCol) {
      out += INVERSE
      inside = true
    }
    out += cell
    width += displayWidth(cell)
    at += cell.length
    if (inside && width >= toCol) {
      out += INVERSE_OFF
      inside = false
    }
  }
  if (inside) out += INVERSE_OFF
  return out
}

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
  const cluster = graphemeAt(text)
  while (at < text.length) {
    const sequence = SGR_AT_START.exec(text.slice(at))
    if (sequence !== null) {
      out += sequence[0]
      styled = true
      at += sequence[0].length
      continue
    }
    // One grapheme cluster per step: what the terminal paints as one glyph
    // run, measured whole, so a cut never falls inside a joined emoji.
    const cell = cluster(at)
    const step = displayWidth(cell)
    if (width + step > columns - 1) break
    width += step
    out += cell
    at += cell.length
  }
  return `${out}${styled ? '\u001B[0m' : ''}…`
}
