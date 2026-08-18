/**
 * Installing this bundle's own preset into the Harness home.
 *
 * The launcher owns the roster's `roots`: `composeProfile` overwrites that key
 * with the installed app's shipped directory, so a bundle cannot contribute a
 * search root of its own. What it can reach is the writable user root the
 * roster appends by default, which is why a packaged preset is copied there
 * rather than pointed at in place.
 *
 * The copy is idempotent and never overwrites: a preset a person edited — or
 * one a newer package version would change — stays as it is, because the user
 * root is theirs. Removing the directory restores the packaged copy.
 * @module codsh-cli/src/preset-install
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises'
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
  if (existing !== undefined) return { path: target, installed: false }
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
