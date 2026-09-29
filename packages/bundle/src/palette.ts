/**
 * The colour themes, as data: every slot a theme paints, in full RGB with
 * explicit overrides where quantizing to a smaller palette would lose the
 * colour's point, and the quantizers that fit a point to a terminal's depth.
 *
 * Modelled on Grok CLI's theme slots (`accent_user`, `bg_light`, `bg_dark`,
 * `bg_thinking`, `md_code_bg`, `diff_insert_bg`, …): a theme is a table, the
 * renderer asks for roles, and one resolution step turns a slot into the
 * escape a given terminal can show. The brand is DeepSeek's blue, #4D6BFE.
 * @module codsh-bundle/src/palette
 */

/** A point in sRGB. */
export type Rgb = readonly [number, number, number]

/** How many colours the terminal can show. */
export type Depth = 'truecolor' | '256' | '16'

/**
 * One colour, per depth. An explicit override beats quantization: a navy band
 * that the 256-colour gray ramp would swallow keeps its hue by naming its
 * index, and a 16-colour terminal gets the attribute that reads best there.
 */
export interface Swatch {
  /** The colour itself, painted as-is on a truecolor terminal. */
  readonly rgb?: Rgb
  /** A 256-colour palette index, used instead of the nearest one. */
  readonly x256?: number
  /** Literal SGR parameters for a 16-colour terminal: `94`, `40`, `2`, `1`. */
  readonly x16?: string
}

/** The theme names a person can choose. */
export type ThemeName = 'deepseek' | 'deepseek-light' | 'terminal'

/** A theme choice: a name, or `auto` to follow the terminal's background. */
export type ThemeSetting = 'auto' | ThemeName

/** Slots painted as a foreground. */
export type ForegroundSlot =
  | 'accent' | 'accent_soft' | 'fg_dim' | 'fg_muted' | 'border'
  | 'success' | 'error' | 'warning' | 'tool'
  | 'diff_insert_fg' | 'diff_delete_fg'
  | 'syntax_keyword' | 'syntax_type' | 'syntax_fn' | 'syntax_string' | 'syntax_number' | 'syntax_comment' | 'syntax_property'
  | 'logo_chevron' | 'logo_hull' | 'logo_water'

/** Slots painted as a background. */
export type BackgroundSlot =
  | 'bg_light' | 'bg_dark' | 'bg_thinking' | 'bg_error' | 'md_code_bg' | 'bg_meta' | 'bg_hover'
  | 'diff_insert_bg' | 'diff_delete_bg'

/** Every slot a theme may fill. */
export type Slot = ForegroundSlot | BackgroundSlot

/** Which layer each background slot paints; everything else is a foreground. */
const BACKGROUND_SLOTS: ReadonlySet<Slot> = new Set<BackgroundSlot>([
  'bg_light', 'bg_dark', 'bg_thinking', 'bg_error', 'md_code_bg', 'bg_meta', 'bg_hover',
  'diff_insert_bg', 'diff_delete_bg',
])

/**
 * Whether a slot is painted as a background.
 * @param slot - the slot.
 * @returns true for a `bg_*` or diff background slot.
 */
export function isBackground(slot: Slot): boolean {
  return BACKGROUND_SLOTS.has(slot)
}

/** One theme: its slots, and how it behaves where a slot is not enough. */
export interface PaletteSpec {
  readonly name: ThemeName
  /** Paint only the terminal's own sixteen colours, at every depth. */
  readonly ansiOnly: boolean
  /** Paint surface bands (the user prompt's fill); otherwise the prompt is bold. */
  readonly bands: boolean
  /** The terminal cursor colour to set with OSC 12, as `#rrggbb`. */
  readonly cursor?: string
  readonly slots: Readonly<Partial<Record<Slot, Swatch>>>
}

/** DeepSeek's brand blue, #4D6BFE: focus, the person's rail, the cursor, the mark. */
const BRAND: Swatch = { rgb: [77, 107, 254], x256: 63, x16: '94' }

/** The brand's lighter tint, #7E96F5: thinking, links, headings, paths. */
const TINT_DARK: Swatch = { rgb: [126, 150, 245], x256: 105, x16: '94' }

/** The brand's deeper shade, #3D56D6, for text-level accents on a light background. */
const TINT_LIGHT: Swatch = { rgb: [61, 86, 214], x256: 62, x16: '34' }

/** Slots both DeepSeek themes share. */
const SHARED: Readonly<Partial<Record<Slot, Swatch>>> = {
  accent: BRAND,
  fg_muted: { x16: '90' },
  border: { x16: '90' },
  success: { x16: '32' },
  error: { x16: '31' },
  syntax_comment: { x16: '2' },
  logo_water: { ...BRAND, x16: '34' },
}

/** DeepSeek on a dark background. */
export const DEEPSEEK: PaletteSpec = {
  name: 'deepseek',
  ansiOnly: false,
  bands: true,
  cursor: '#4d6bfe',
  slots: {
    ...SHARED,
    accent_soft: TINT_DARK,
    fg_dim: { x256: 245, x16: '2' },
    warning: { x256: 172, x16: '93' },
    tool: { x256: 172, x16: '33' },
    bg_light: { rgb: [21, 26, 48], x256: 17, x16: '40' },
    bg_dark: { rgb: [14, 18, 24], x256: 235, x16: '40' },
    // 237 on purpose: the nearest index is 235, which is the tool fill's.
    bg_thinking: { rgb: [26, 29, 46], x256: 237, x16: '40' },
    bg_error: { rgb: [45, 15, 25], x256: 52, x16: '41' },
    md_code_bg: { rgb: [15, 18, 24], x256: 235, x16: '40' },
    bg_meta: { rgb: [18, 20, 26], x256: 236, x16: '40' },
    bg_hover: { x256: 236 },
    diff_insert_bg: { rgb: [10, 38, 30], x256: 22, x16: '42' },
    diff_insert_fg: { rgb: [80, 200, 140], x256: 120, x16: '30' },
    diff_delete_bg: { rgb: [45, 15, 25], x256: 52, x16: '41' },
    diff_delete_fg: { rgb: [240, 100, 110], x256: 203, x16: '37' },
    syntax_keyword: { rgb: [197, 134, 192], x256: 176, x16: '35' },
    syntax_type: { rgb: [78, 201, 176], x256: 73, x16: '36' },
    syntax_fn: { rgb: [220, 220, 170], x256: 186, x16: '33' },
    syntax_string: { rgb: [206, 145, 120], x256: 173, x16: '32' },
    syntax_number: { rgb: [181, 206, 168], x256: 151, x16: '36' },
    syntax_property: { rgb: [156, 220, 254], x256: 117, x16: '34' },
    logo_chevron: TINT_DARK,
    logo_hull: { rgb: [238, 241, 251], x256: 255, x16: '97' },
  },
}

/** DeepSeek on a light background: the same brand, deeper text accents. */
export const DEEPSEEK_LIGHT: PaletteSpec = {
  name: 'deepseek-light',
  ansiOnly: false,
  bands: true,
  cursor: '#4d6bfe',
  slots: {
    ...SHARED,
    accent_soft: TINT_LIGHT,
    fg_dim: { x256: 242, x16: '2' },
    warning: { x256: 130, x16: '93' },
    tool: { x256: 130, x16: '33' },
    bg_light: { rgb: [238, 241, 251], x256: 189, x16: '47' },
    bg_dark: { rgb: [243, 245, 248], x256: 255, x16: '47' },
    bg_thinking: { rgb: [243, 245, 253], x256: 255, x16: '47' },
    bg_error: { rgb: [254, 226, 226], x256: 224, x16: '41' },
    md_code_bg: { rgb: [240, 242, 246], x256: 254, x16: '47' },
    bg_meta: { rgb: [244, 244, 246], x256: 255, x16: '47' },
    bg_hover: { x256: 253 },
    diff_insert_bg: { rgb: [236, 253, 245], x256: 194, x16: '42' },
    diff_insert_fg: { rgb: [22, 101, 52], x256: 28, x16: '30' },
    diff_delete_bg: { rgb: [254, 242, 242], x256: 224, x16: '41' },
    diff_delete_fg: { rgb: [153, 27, 27], x256: 160, x16: '37' },
    syntax_keyword: { rgb: [175, 0, 219], x256: 176, x16: '35' },
    syntax_type: { rgb: [38, 127, 153], x256: 73, x16: '36' },
    syntax_fn: { rgb: [121, 94, 38], x256: 186, x16: '33' },
    syntax_string: { rgb: [163, 21, 21], x256: 173, x16: '32' },
    syntax_number: { rgb: [9, 134, 88], x256: 151, x16: '36' },
    syntax_property: { rgb: [0, 16, 128], x256: 117, x16: '34' },
    logo_chevron: TINT_LIGHT,
    logo_hull: { rgb: [21, 26, 48], x256: 17, x16: '30' },
  },
}

/**
 * The terminal's own palette: no surfaces of its own, the sixteen ANSI colours
 * a profile tunes, and bright black for decoration — so a translucent or
 * image-backed window shows through, and every depth renders the same.
 */
export const TERMINAL: PaletteSpec = {
  name: 'terminal',
  ansiOnly: true,
  bands: false,
  slots: {
    accent: { x16: '34' },
    accent_soft: { x16: '36' },
    fg_dim: { x16: '90' },
    fg_muted: { x16: '90' },
    border: { x16: '90' },
    success: { x16: '32' },
    error: { x16: '31' },
    warning: { x16: '93' },
    tool: { x16: '33' },
    // No band: the person's message is bold instead.
    bg_light: { x16: '1' },
    diff_insert_fg: { x16: '32' },
    diff_delete_fg: { x16: '31' },
    syntax_keyword: { x16: '35' },
    syntax_type: { x16: '36' },
    syntax_fn: { x16: '33' },
    syntax_string: { x16: '32' },
    syntax_number: { x16: '36' },
    syntax_comment: { x16: '90' },
    syntax_property: { x16: '34' },
    logo_chevron: { x16: '36' },
    logo_hull: { x16: '39' },
    logo_water: { x16: '34' },
  },
}

/** Every theme, by name. */
export const PALETTES: Readonly<Record<ThemeName, PaletteSpec>> = {
  'deepseek': DEEPSEEK,
  'deepseek-light': DEEPSEEK_LIGHT,
  'terminal': TERMINAL,
}

/**
 * The SGR parameters one swatch paints at a depth, on one layer.
 *
 * Truecolor takes the point itself; 256 colours take the named index or the
 * nearest one; 16 colours take the named parameters or the nearest ANSI
 * colour. A swatch that names only a 256 index (a hover fill) keeps it at
 * every depth — that is how it was always painted.
 * @param swatch - the colour, or undefined for "not painted".
 * @param layer - foreground or background.
 * @param depth - the terminal's depth.
 * @returns the parameters without `ESC [` and `m`, or `''`.
 */
export function params(swatch: Swatch | undefined, layer: 'fg' | 'bg', depth: Depth): string {
  if (swatch === undefined) return ''
  const base = layer === 'fg' ? 38 : 48
  const { rgb, x256, x16 } = swatch
  const indexed = (index: number): string => `${base};5;${index}`
  if (depth === 'truecolor') {
    if (rgb !== undefined) return `${base};2;${rgb[0]};${rgb[1]};${rgb[2]}`
    if (x256 !== undefined) return indexed(x256)
    return x16 ?? ''
  }
  if (depth === '256') {
    if (x256 !== undefined) return indexed(x256)
    if (rgb !== undefined) return indexed(nearest256(rgb[0], rgb[1], rgb[2]))
    return x16 ?? ''
  }
  if (x16 !== undefined) return x16
  if (rgb !== undefined) {
    const code = nearestAnsi(rgb[0], rgb[1], rgb[2])
    return layer === 'fg' ? code : String(Number(code) + 10)
  }
  return x256 === undefined ? '' : indexed(x256)
}

/** The sixteen ANSI colours as xterm paints them, with their SGR foreground codes. */
export const ANSI_PALETTE: readonly [number, number, number, string][] = [
  [0, 0, 0, '30'], [205, 0, 0, '31'], [0, 205, 0, '32'], [205, 205, 0, '33'],
  [0, 0, 238, '34'], [205, 0, 205, '35'], [0, 205, 205, '36'], [229, 229, 229, '37'],
  [127, 127, 127, '90'], [255, 0, 0, '91'], [0, 255, 0, '92'], [255, 255, 0, '93'],
  [92, 92, 255, '94'], [255, 0, 255, '95'], [0, 255, 255, '96'], [255, 255, 255, '97'],
]

/** Squared distance between two sRGB points; ordering is all that is needed. */
const apart = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number =>
  (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2

/**
 * The SGR foreground code of the ANSI colour closest to an sRGB point.
 * @param red - 0..255.
 * @param green - 0..255.
 * @param blue - 0..255.
 * @returns a code such as `94`.
 */
export function nearestAnsi(red: number, green: number, blue: number): string {
  let best = ANSI_PALETTE[0] ?? [0, 0, 0, '37']
  for (const candidate of ANSI_PALETTE) {
    if (apart(red, green, blue, candidate[0], candidate[1], candidate[2]) < apart(red, green, blue, best[0], best[1], best[2])) best = candidate
  }
  return best[3]
}

/** Levels of the 256-colour palette's 6×6×6 cube. */
export const CUBE: readonly number[] = [0, 95, 135, 175, 215, 255]

/**
 * The 256-colour index closest to an sRGB point: the cube, or the gray ramp
 * when that is nearer.
 * @param red - 0..255.
 * @param green - 0..255.
 * @param blue - 0..255.
 * @returns an index in 16..255.
 */
export function nearest256(red: number, green: number, blue: number): number {
  const level = (value: number): number =>
    CUBE.reduce((best, candidate, index) => Math.abs(candidate - value) < Math.abs((CUBE[best] ?? 0) - value) ? index : best, 0)
  const [ri, gi, bi] = [level(red), level(green), level(blue)]
  const cubeApart = apart(red, green, blue, CUBE[ri] ?? 0, CUBE[gi] ?? 0, CUBE[bi] ?? 0)
  // The ramp runs 232..255 at 8, 18, … 238.
  const step = Math.min(23, Math.max(0, Math.round((Math.round((red + green + blue) / 3) - 8) / 10)))
  const gray = 8 + 10 * step
  return apart(red, green, blue, gray, gray, gray) < cubeApart ? 232 + step : 16 + 36 * ri + 6 * gi + bi
}
