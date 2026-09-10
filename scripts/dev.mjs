#!/usr/bin/env node
/**
 * The development loop: build, sync the working tree into a repo-local dsh
 * home, and boot the surface — seconds per iteration.
 *
 * The first run registers the packed tarball into `.dev-home` (a real profile
 * install, so every dependency resolves the way a user's does). Later runs
 * skip the install and copy the built artifacts straight over the profile's
 * unpacked copy of this package, which is what makes the loop fast.
 *
 * `MOCK=<mode>` boots against the keyless e2e mock model instead of a real
 * key: `write` (the default), `bash`, `heredoc`, `slow`, `steer`, `tall`,
 * `spec`, `markdown`, `reasoning`, `echo`, `vision`, and the `auto-vision`,
 * `auto-vision-slow`, `auto-vision-fail` trio behind automatic image
 * description. The list lives in `e2e/fixtures/mock-llm.src.ts`.
 * Arguments after `pnpm run dev` reach the app (`--resume`, `-p "task"`, …).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const repo = fileURLToPath(new URL('..', import.meta.url))
const bundle = join(repo, 'packages', 'bundle')
const home = join(repo, '.dev-home')
const installed = join(home, 'profiles', 'code', 'node_modules', 'codsh-bundle')

const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const dshBinField = JSON.parse(readFileSync(dshManifest, 'utf8')).bin
const dshBin = join(dirname(dshManifest), typeof dshBinField === 'string' ? dshBinField : dshBinField.dsh)

// Build with the tools directly rather than `pnpm run build`. pnpm 12 verifies
// the whole lockfile against its supply-chain policy before *any* command runs,
// so shelling out to it made the dev loop depend on every pinned entry being
// older than `minimumReleaseAge` — a condition this repository's dsh pins do not
// meet, which failed the build before it started. The bundle's own build script
// is just `tsdown && tsc -p tsconfig.build.json`; running those two preserves
// the build exactly while keeping the loop free of the installer.
const tsdownBin = join(dirname(require.resolve('tsdown/package.json')), JSON.parse(readFileSync(require.resolve('tsdown/package.json'), 'utf8')).bin.tsdown)
const tscBin = require.resolve('typescript/bin/tsc')

console.error('codsh dev: building')
execFileSync(process.execPath, [tsdownBin], { cwd: bundle, stdio: 'inherit' })
execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], { cwd: bundle, stdio: 'inherit' })

// A pre-split home registered the runtime under the launcher's old name and
// pinned a temp-dir tarball that no longer exists; nothing in it is worth
// keeping — it is a scratch profile — so a shape mismatch rebuilds it whole.
// Similarly, when the dsh runtime version or bundle package dependencies
// change, the installed profile's node_modules become stale and must rebuild.
const stampFile = join(home, '.dev-stamp')
const dshVersion = JSON.parse(readFileSync(dshManifest, 'utf8')).version
const bundlePkg = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'))
const expectedStamp = JSON.stringify({
  dsh: dshVersion,
  bundleVersion: bundlePkg.version,
  dependencies: bundlePkg.dependencies,
  peerDependencies: bundlePkg.peerDependencies,
})

const manifest = join(home, 'profiles', 'code', 'package.json')
if (existsSync(manifest)) {
  const profile = JSON.parse(readFileSync(manifest, 'utf8'))
  const stale = 'codsh-cli' in (profile.dependencies ?? {})
    || !existsSync(stampFile)
    || readFileSync(stampFile, 'utf8') !== expectedStamp
  if (stale) {
    console.error('codsh dev: .dev-home is out of date — rebuilding it')
    rmSync(home, { recursive: true, force: true })
  }
}

if (!existsSync(installed)) {
  // First run: a real profile install, so dependency resolution matches a
  // user's. The tarball is what registers; the fast path replaces its files.
  console.error('codsh dev: registering the packed working tree into .dev-home (first run)')
  const scratch = mkdtempSync(join(tmpdir(), 'codsh-dev-pack-'))
  const packed = execFileSync('npm', ['pack', '--pack-destination', scratch], { cwd: bundle, encoding: 'utf8' })
    .trim().split('\n').at(-1) ?? ''
  execFileSync(process.execPath, [dshBin, 'plugin', '--profile', 'code', 'add', join(scratch, packed)], {
    env: { ...process.env, DSH_HOME: home },
    stdio: 'inherit',
  })
  rmSync(scratch, { recursive: true, force: true })
  writeFileSync(stampFile, expectedStamp)
} else {
  // Fast path: the profile already carries every dependency; only this
  // package's own artifacts changed.
  for (const entry of ['lib', 'cordis.patch.yml', 'agent-presets', 'package.json']) {
    rmSync(join(installed, entry), { recursive: true, force: true })
    cpSync(join(bundle, entry), join(installed, entry), { recursive: true })
  }
  console.error('codsh dev: synced lib/ into .dev-home')
}

const args = ['--profile', 'code']
const mock = process.env.MOCK
if (mock !== undefined && mock !== '') {
  const overlay = join(home, 'mock.cordis.patch.yml')
  mkdirSync(home, { recursive: true })
  writeFileSync(overlay, [
    '- id: agent-default-model',
    '  config:',
    '    provider: cli-mock',
    '    model: cli-mock',
    '- id: llm-deepseek',
    '  disabled: true',
    '- insert:',
    '    - id: code-cli-mock-llm',
    `      name: '${pathToFileURL(join(repo, 'e2e', 'fixtures', 'mock-llm.mjs')).href}'`,
    '',
  ].join('\n'))
  args.push('--patch', overlay)
  console.error(`codsh dev: keyless mock model, mode "${mock}"`)
}
args.push(...process.argv.slice(2))

// INSPECT=1 opens the Node inspector on the app process only — the build and
// profile install above stay uninstrumented.
const inspect = process.env.INSPECT === '1' ? ['--inspect-brk'] : []
const run = spawnSync(process.execPath, [...inspect, dshBin, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    ...mock === undefined || mock === '' ? {} : { DSH_CODE_CLI_MOCK_TOOL: mock },
  },
})
process.exit(run.status ?? 0)
