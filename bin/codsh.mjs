#!/usr/bin/env node
/**
 * The `codsh` command: the dsh launcher booted onto the code profile, with
 * this package registered as that profile's bundle on first run.
 *
 * dsh owns profiles, plugin installation, and the boot; this wrapper only
 * makes `codsh` a one-command experience — it is exactly
 * `dsh plugin --profile code add <this package>` once, then
 * `dsh --profile code <args>` every time.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ownDir = fileURLToPath(new URL('..', import.meta.url))
const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
const dshBinField = JSON.parse(readFileSync(dshPackage, 'utf8')).bin
const dshBin = join(dirname(dshPackage), typeof dshBinField === 'string' ? dshBinField : dshBinField.dsh)

/** Whether the code profile already carries this package. */
function registered() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const manifest = join(home, 'profiles', 'code', 'package.json')
  if (!existsSync(manifest)) return false
  try {
    const profile = JSON.parse(readFileSync(manifest, 'utf8'))
    return 'codsh-cli' in (profile.dependencies ?? {})
  } catch {
    return false
  }
}

if (!registered()) {
  console.error('codsh: registering this package into the dsh code profile (first run)')
  // A bare directory installs as `link:`, whose dependencies never reach the
  // profile's resolver. A development checkout (it has node_modules) packs to
  // the release tarball; an installed copy is clean and `file:` copies it,
  // with its dependencies resolved by the profile install either way.
  let spec = `file:${ownDir}`
  let scratch
  if (existsSync(join(ownDir, 'node_modules'))) {
    scratch = mkdtempSync(join(tmpdir(), 'codsh-pack-'))
    const packed = spawnSync('npm', ['pack', '--pack-destination', scratch], { cwd: ownDir, encoding: 'utf8' })
    if (packed.status !== 0) {
      console.error(packed.stderr ?? 'codsh: npm pack failed')
      process.exit(packed.status ?? 1)
    }
    spec = join(scratch, packed.stdout.trim().split('\n').at(-1) ?? '')
  }
  const setup = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', 'code', 'add', spec], { stdio: 'inherit' })
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
  if (setup.status !== 0) process.exit(setup.status ?? 1)
}

const run = spawnSync(process.execPath, [dshBin, '--profile', 'code', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(run.status ?? 0)
