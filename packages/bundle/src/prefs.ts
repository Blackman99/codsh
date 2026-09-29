/**
 * The surface's own preferences file: one JSON object under the dsh home that
 * `/ui` and `/theme` each keep a key in.
 *
 * Every write merges into what is there, so saving one preference never
 * erases another, and lands by rename, so a crash mid-write never leaves half
 * a file for the next boot to read.
 * @module codsh-bundle/src/prefs
 */

import { readFile, rename, writeFile } from 'node:fs/promises'

/** Filename under the dsh home, beside `code-cli-history.json`. */
export const UI_PREFS_FILE = 'code-cli-ui.json'

/** What a prefs file holds: whatever keys any version wrote. */
export type Prefs = Record<string, unknown>

/**
 * Read the prefs file.
 * @param path - the JSON file.
 * @returns its object, or an empty one when it is missing, unreadable, or not an object.
 */
export async function readPrefs(path: string): Promise<Prefs> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Prefs
  } catch {
    return {}
  }
}

/**
 * Merge keys into the prefs file, keeping every key this write does not name
 * — including ones a newer version wrote.
 * @param path - the JSON file.
 * @param patch - the keys to set.
 */
export async function mergePrefs(path: string, patch: Prefs): Promise<void> {
  const next = { ...await readPrefs(path), ...patch }
  const staging = `${path}.${process.pid}.tmp`
  await writeFile(staging, `${JSON.stringify(next)}\n`)
  await rename(staging, path)
}
