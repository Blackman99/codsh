/**
 * Installing this bundle's own preset into the Harness home.
 *
 * The launcher owns the roster's `roots`: `composeProfile` overwrites that key
 * with the installed app's shipped directory, so a bundle cannot contribute a
 * search root of its own. What it can reach is the writable user root the
 * roster appends by default, which is why a packaged preset is copied there
 * rather than pointed at in place.
 *
 * The copy is idempotent and never overwrites a person's edits. One exception:
 * a leftover `persona` `text` field (the 0.1.2 schema) is rewritten to `prefix`
 * so a copy from before the 0.1.5 harness still mounts. Removing the directory
 * restores the packaged copy.
 * @module codsh-bundle/src/preset-install
 */

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** The preset this bundle's patch names as the roster default. */
export const PACKAGED_PRESET = 'code-cli'

/**
 * The writable roster root, relative to the Harness home.
 *
 * Repeated rather than imported: `dsh-agent-presets` keeps this as its own
 * internal `USER_PRESET_DIR` and does not export it, and this package installs
 * from npm against a PUBLISHED dependency — an import added to the workspace
 * source would resolve here and break for everyone else. `tests/` asserts the
 * two stay equal, so a rename upstream fails loudly instead of silently
 * installing into a directory nothing reads.
 */
const USER_PRESET_DIR = '.agent-presets'

/**
 * The packaged preset directory.
 *
 * Resolved from this module rather than the process cwd so it is correct in the
 * built `lib/` layout and in the source tree alike; `agent-presets/` sits beside
 * both.
 */
const PACKAGED_ROOT = fileURLToPath(new URL('../agent-presets/', import.meta.url))

/** What one install attempt did. */
export interface PresetInstallResult {
  /** Absolute directory the preset occupies after the attempt. */
  path: string
  /** Whether this call created it; false when it was already present. */
  installed: boolean
  /** Whether an existing copy was rewritten from `persona.text` to `prefix`. */
  migrated?: boolean
}

/**
 * Where {@link installPackagedPreset} puts the preset by default.
 * @returns the absolute preset directory under the Harness home's user root.
 */
export function packagedPresetPath(): string {
  return dshHomePath(USER_PRESET_DIR, PACKAGED_PRESET)
}

/**
 * Copy the packaged preset into the user root unless it is already there.
 * @param home - the user preset root; defaults to the Harness home's.
 * @returns where the preset lives and whether this call wrote it.
 */
export async function installPackagedPreset(
  home: string = dshHomePath(USER_PRESET_DIR),
): Promise<PresetInstallResult> {
  const target = join(home, PACKAGED_PRESET)
  const existing = await readdir(target).catch(() => undefined)
  if (existing !== undefined) {
    const migrated = await migratePersonaTextToPrefix(target)
    return { path: target, installed: false, migrated }
  }
  const source = join(PACKAGED_ROOT, PACKAGED_PRESET)
  const entries = await readdir(source, { withFileTypes: true })
  await mkdir(target, { recursive: true })
  // A preset is one flat directory of composition files; there is no nesting to
  // walk, and a nested entry would not be part of the composition the roster
  // reads.
  for (const entry of entries) {
    if (!entry.isFile()) continue
    await copyFile(join(source, entry.name), join(target, entry.name))
  }
  return { path: target, installed: true }
}

/**
 * Rewrite a leftover `persona` `text` field to `prefix`.
 *
 * dsh-persona 0.1.5-rc.1 requires `prefix`; copies installed under 0.1.2 still
 * carry `text`, and that fails the loader before a session starts. The rewrite
 * keeps the person's wording. A composition that already has `prefix`, or no
 * persona row, is left alone.
 * @param target - the user-root preset directory.
 * @returns whether the composition file was rewritten.
 */
async function migratePersonaTextToPrefix(target: string): Promise<boolean> {
  const composition = join(target, 'agent.cordis.yml')
  const raw = await readFile(composition, 'utf8').catch(() => undefined)
  if (raw === undefined) return false
  const next = rewritePersonaTextToPrefix(raw)
  if (next === undefined) return false
  await writeFile(composition, next)
  return true
}

/**
 * Rewrite the `dsh-persona` row's `text` key to `prefix` when that is the only
 * schema gap.
 * @param raw - the composition file.
 * @returns the rewritten file, or undefined when no rewrite is due.
 */
export function rewritePersonaTextToPrefix(raw: string): string | undefined {
  const name = "name: '@deepseek-ai/dsh-persona'"
  const start = raw.indexOf(name)
  if (start < 0) return undefined
  const nextRow = raw.indexOf('\n- id:', start + name.length)
  const end = nextRow < 0 ? raw.length : nextRow
  const block = raw.slice(start, end)
  if (/\n[ \t]+prefix:/u.test(block) || !/\n[ \t]+text:/u.test(block)) return undefined
  return raw.slice(0, start) + block.replace(/^([ \t]+)text:/mu, '$1prefix:') + raw.slice(end)
}
