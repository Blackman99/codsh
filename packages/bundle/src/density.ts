/**
 * Transcript density: one `/ui compact|comfortable` axis.
 *
 * Compact is the default after the chrome redesign. Comfortable only adds
 * room — a blank row between turns and a higher click-to-pager threshold on
 * expanded diffs — without touching GateModal, MetaBar, or the one-row
 * ToolCards. Thinking streams into the transcript in both, so neither needs
 * a preview under the box.
 * @module codsh-bundle/src/density
 */

import { readFile, writeFile } from 'node:fs/promises'

/** The two densities `/ui` switches. */
export type Density = 'compact' | 'comfortable'

/** Returning-user default: tight chrome, one-row cards. */
export const DEFAULT_DENSITY: Density = 'compact'

/** Filename under the dsh home, beside `code-cli-history.json`. */
export const UI_PREFS_FILE = 'code-cli-ui.json'

/**
 * Diff lines before a click opens the pager rather than expanding in place.
 *
 * ToolCards are one row either way. Ctrl-O still shows the full hunks; this
 * threshold only decides when the expanded form is large enough to read in
 * the pager.
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
