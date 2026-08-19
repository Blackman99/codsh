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
 * key: `write`, `bash`, `slow`, `markdown`, `reasoning`, `echo`, `tall`.
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

console.error('codsh dev: building')
execFileSync('pnpm', ['run', 'build'], { cwd: repo, stdio: 'inherit' })

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
