/**
 * Transcript density: one `/ui compact|comfortable` axis.
 *
 * Compact is the default after the chrome redesign. Comfortable only adds
 * room — a blank row between turns, a two-line thinking preview while it
 * streams, a higher click-to-pager threshold on expanded diffs, and one
 * idle tip — without touching GateModal, MetaBar, or folded ToolCards.
 * @module codsh-bundle/src/density
 */

import { readFile, writeFile } from 'node:fs/promises'

/** The two densities `/ui` switches. */
export type Density = 'compact' | 'comfortable'

/** Returning-user default: tight chrome, folded cards, no idle tip. */
export const DEFAULT_DENSITY: Density = 'compact'

/** Filename under the dsh home, beside `code-cli-history.json`. */
export const UI_PREFS_FILE = 'code-cli-ui.json'

/** How long an empty box sits idle before the comfortable tip returns. */
export const IDLE_TIP_MS = 30_000

/** Comfortable idle hint; muted, gone on the first key. */
export const IDLE_TIP = '⇧Tab plan · Ctrl+T todos'

/**
 * Diff lines before a click opens the pager rather than expanding in place.
 *
 * Collapsed ToolCards stay one line either way. Ctrl-O still shows the full
 * hunks; this threshold only decides when the expanded form is large enough
 * to read in the pager.
 */
export const DIFF_SOFT_CAP: Record<Density, number> = {
  compact: 24,
  comfortable: 48,
}

/**
 * Parse a `/ui` argument.
 * @param raw - typed argument, possibly padded.
 * @returns the density, or undefined when it is not one of the two.
 */
export function parseDensity(raw: string): Density | undefined {
  const trimmed = raw.trim()
  if (trimmed === 'compact' || trimmed === 'comfortable') return trimmed
  return undefined
}

/**
 * Report the current mode the way `/ui` with no argument prints it.
 * @param density - the live mode.
 * @returns one muted-ready line, no styling.
 */
export function densityReport(density: Density): string {
  return `ui · ${density}`
}

/**
 * Live thinking rows while a thought streams: compact keeps one line,
 * comfortable shows two (the last finished line plus the one still arriving).
 * @param density - the live mode.
 * @param finished - thinking lines already complete this burst.
 * @param live - the in-progress line, when one is open.
 * @param fallback - shown when nothing has arrived yet.
 * @returns one row, or two for comfortable.
 */
export function thinkingStreamPreview(
  density: Density,
  finished: readonly string[],
  live: string | undefined,
  fallback: string,
): string | readonly string[] {
  const current = live ?? finished.at(-1) ?? fallback
  if (density === 'compact') return current
  const prior = live === undefined ? finished.slice(-2, -1) : finished.slice(-1)
  const rows = [...prior, current].filter(row => row !== '')
  return rows.length <= 1 ? current : rows.slice(-2)
}

/**
 * Read a persisted density from a prefs file.
 * @param path - JSON file `{ "density": "compact" | "comfortable" }`.
 * @returns the saved mode, or undefined when missing or unreadable.
 */
export async function loadDensity(path: string): Promise<Density | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || !('density' in parsed)) return undefined
    return parseDensity(String((parsed as { density: unknown }).density))
  } catch {
    return undefined
  }
}

/**
 * Persist the live density for the next session.
 * @param path - JSON file to overwrite.
 * @param density - the mode to keep.
 */
export async function saveDensity(path: string, density: Density): Promise<void> {
  await writeFile(path, `${JSON.stringify({ density })}\n`)
}
