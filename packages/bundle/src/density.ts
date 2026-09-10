/**
 * Transcript density: one `/ui compact|comfortable` axis.
 *
 * Compact is the default after the chrome redesign. Comfortable only adds
 * room — a blank row between turns, a two-line thinking preview while it
 * streams, a higher click-to-pager threshold on expanded diffs —
 * without touching GateModal, MetaBar, or folded ToolCards.
 * @module codsh-bundle/src/density
 */

import { readFile, writeFile } from 'node:fs/promises'

/** The two densities `/ui` switches. */
export type Density = 'compact' | 'comfortable'

/** Returning-user default: tight chrome, folded cards. */
export const DEFAULT_DENSITY: Density = 'compact'

/** Filename under the dsh home, beside `code-cli-history.json`. */
export const UI_PREFS_FILE = 'code-cli-ui.json'

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
 * Blank rows between two steps, by density.
 *
 * A step's reasoning and its tools are one block; this is the air between one
 * block and the next. Compact keeps a single separator row and comfortable
 * doubles it, the way it doubles the live thinking preview, so `/ui` keeps
 * governing the transcript's whole spacing scale.
 */
export const BLOCK_GAP: Record<Density, number> = {
  compact: 1,
  comfortable: 2,
}

/**
 * The step gap for one density, read from {@link BLOCK_GAP}.
 * @param density - the live mode.
 * @returns how many blank rows separate two steps.
 */
export function blockGap(density: Density): number {
  return BLOCK_GAP[density]
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
 * Rows the live thinking preview may occupy, by density.
 *
 * A row-count lookup rather than a branch inside the preview: a future density
 * value only adds an entry here. Compact shows a readable three rows;
 * comfortable doubles it.
 */
export const THINKING_PREVIEW_ROWS: Record<Density, number> = {
  compact: 3,
  comfortable: 6,
}

/**
 * Live thinking rows while a thought streams. Keeps the most recent rows and
 * never exceeds the density's budget.
 * @param density - the live mode.
 * @param finished - thinking lines already complete this burst.
 * @param live - the in-progress line, when one is open.
 * @param fallback - shown when nothing has arrived yet.
 * @returns one row, or up to the density's budget of rows.
 */
export function thinkingStreamPreview(
  density: Density,
  finished: readonly string[],
  live: string | undefined,
  fallback: string,
): string | readonly string[] {
  const rows = [...finished, ...live === undefined ? [] : [live]].filter(row => row !== '')
  const kept = rows.length === 0 ? [fallback] : rows.slice(-THINKING_PREVIEW_ROWS[density])
  return kept.length === 1 ? kept[0] ?? fallback : kept
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
