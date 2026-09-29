/**
 * The `/theme` choice: which names and aliases it accepts, where the one in
 * force comes from, and how it is reported and kept.
 *
 * Names are case-insensitive and forgiving the way Grok CLI's are — `dark`,
 * `light`, and `system` mean what a person would expect — and `CODSH_THEME`
 * picks a theme for one launch without touching the saved one, the way
 * `GROK_THEME` does.
 * @module codsh-bundle/src/theme-setting
 */

import type { ThemeSetting } from './palette.ts'
import { mergePrefs, readPrefs } from './prefs.ts'
import type { Theme } from './theme.ts'

/** One row of the theme catalog. */
export interface ThemeChoice {
  readonly name: ThemeSetting
  readonly detail: string
}

/** Every choice, in the order the picker lists them. */
export const THEME_CHOICES: readonly ThemeChoice[] = [
  { name: 'auto', detail: 'DeepSeek blue, light or dark to match the terminal' },
  { name: 'deepseek', detail: 'DeepSeek blue on a dark background' },
  { name: 'deepseek-light', detail: 'DeepSeek blue on a light background' },
  { name: 'terminal', detail: 'your terminal\'s own sixteen colours, no backgrounds' },
]

/** The environment variable that picks a theme for one launch. */
export const THEME_ENV = 'CODSH_THEME'

/** Other names each choice answers to. */
const ALIASES: Readonly<Record<string, ThemeSetting>> = {
  'system': 'auto',
  'default': 'auto',
  'dark': 'deepseek',
  'deepseek-dark': 'deepseek',
  'ds': 'deepseek',
  'light': 'deepseek-light',
  'ds-light': 'deepseek-light',
  'native': 'terminal',
  'ansi': 'terminal',
  'basic': 'terminal',
}

/**
 * Read a theme name the way a person types it.
 * @param raw - a name or alias, any case, possibly padded.
 * @returns the choice, or undefined when it names none.
 */
export function parseThemeSetting(raw: string): ThemeSetting | undefined {
  const name = raw.trim().toLowerCase()
  const exact = THEME_CHOICES.find(choice => choice.name === name)
  return exact?.name ?? ALIASES[name]
}

/** Where the theme in force at startup came from. */
export interface StartupTheme {
  readonly setting: ThemeSetting
  /** Whether `CODSH_THEME` decided it. */
  readonly fromEnv: boolean
  /** Why an environment value was ignored, when it was. */
  readonly warning?: string
}

/**
 * The theme a session starts with: `CODSH_THEME` when it names one, else the
 * saved choice, else `auto`.
 * @param env - the launch environment.
 * @param saved - the prefs file's `theme` value, whatever it holds.
 * @returns the choice and its provenance.
 */
export function startupThemeSetting(env: Record<string, string | undefined>, saved: unknown): StartupTheme {
  const fromSaved = typeof saved === 'string' ? parseThemeSetting(saved) : undefined
  const raw = env[THEME_ENV]
  if (raw !== undefined && raw.trim() !== '') {
    const chosen = parseThemeSetting(raw)
    if (chosen !== undefined) return { setting: chosen, fromEnv: true }
    return { setting: fromSaved ?? 'auto', fromEnv: false, warning: `${THEME_ENV}="${raw}" names no theme — ${choiceList()}` }
  }
  return { setting: fromSaved ?? 'auto', fromEnv: false }
}

/**
 * The choices as one comma-separated list, for an error.
 * @returns `auto, deepseek, deepseek-light, terminal`.
 */
export function choiceList(): string {
  return THEME_CHOICES.map(choice => choice.name).join(', ')
}

/**
 * Report the theme the way `/theme` prints it.
 * @param theme - the live theme.
 * @returns e.g. `theme · auto → deepseek-light`, or `theme · terminal`.
 */
export function themeReport(theme: Theme): string {
  if (!theme.colored) return `theme · ${theme.setting} · colour is off (NO_COLOR or not a terminal)`
  const painted = theme.resolved ?? theme.setting
  return theme.setting === painted ? `theme · ${painted}` : `theme · ${theme.setting} → ${painted}`
}

/**
 * Read the saved theme from the prefs file.
 * @param path - the prefs file.
 * @returns the raw saved value, for {@link startupThemeSetting}.
 */
export async function loadThemeSetting(path: string): Promise<unknown> {
  return (await readPrefs(path)).theme
}

/**
 * Keep a theme choice for the next session, leaving the file's other keys.
 * @param path - the prefs file.
 * @param setting - the choice.
 */
export async function saveThemeSetting(path: string, setting: ThemeSetting): Promise<void> {
  await mergePrefs(path, { theme: setting })
}
