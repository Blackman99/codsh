#!/usr/bin/env node
/**
 * Check what `npm pack` of codsh-cli would ship for the Rust client (ticket 66),
 * without packing a tarball, uploading, or publishing anything.
 *
 *   node scripts/rust-package-check.mjs [--require darwin-arm64,darwin-x64] [--json]
 *
 * Every staged `native/<platform>-<arch>/` must verify for its own platform
 * (manifest, SHA-256, executable header, this package's version) and carry its
 * notices, and every file the launcher loads at run time must be in the pack
 * list. `--require` fails when a named platform is not staged; a release that
 * promises macOS prebuilds runs it with both darwin keys.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NATIVE_TARGETS, availableKeys, binaryName, verifyArtifact } from '../packages/cli/bin/rust-artifact.mjs'

const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'packages/cli')
const args = process.argv.slice(2)
const json = args.includes('--json')
const requireIndex = args.indexOf('--require')
const required = requireIndex >= 0 ? String(args[requireIndex + 1] ?? '').split(',').filter(Boolean) : []
for (const key of required) {
  if (!(key in NATIVE_TARGETS)) throw new Error(`unknown platform ${key}; known: ${Object.keys(NATIVE_TARGETS).join(', ')}`)
}

export function packedFiles(directory = cli) {
  const cache = mkdtempSync(join(tmpdir(), 'codsh-pack-check-'))
  try {
    const listed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: directory, encoding: 'utf8', maxBuffer: 50_000_000,
      env: { ...process.env, npm_config_cache: join(cache, 'cache'), npm_config_update_notifier: 'false' },
    }))[0]
    return { name: listed.name, version: listed.version, files: new Set(listed.files.map(file => file.path)) }
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}

export function checkPackage({ directory = cli, requiredKeys = [] } = {}) {
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const packed = packedFiles(directory)
  const problems = []
  // Run-time files the launcher and its dsh plugins load from the package.
  for (const file of ['bin/codsh.mjs', 'bin/rust.mjs', 'bin/rust-artifact.mjs', 'bin/rust-acp-dsh.mjs', 'package.json']) {
    if (!packed.files.has(file)) problems.push(`${file} is not in the pack list`)
  }
  const staged = availableKeys(join(directory, 'native'))
  const platforms = []
  for (const key of staged) {
    const [platform, arch] = key.split('-')
    const result = verifyArtifact({ nativeRoot: join(directory, 'native'), version: pkg.version, platform, arch })
    const entry = { key, ok: result.ok }
    if (!result.ok) {
      problems.push(`${key}: ${result.message}`)
      entry.problem = result.code
    } else {
      if (result.manifest.version !== pkg.version) problems.push(`${key}: artifact.json has no version for ${pkg.version}; restage with pnpm run build:rust`)
      entry.target = result.manifest.target
      entry.sha256 = result.sha256
    }
    for (const file of [binaryName(platform), 'artifact.json', 'dependencies.json', 'LICENSE-codsh', 'UPSTREAM-LICENSE', 'UPSTREAM-THIRD-PARTY-NOTICES']) {
      if (!packed.files.has(`native/${key}/${file}`)) problems.push(`${key}: native/${key}/${file} is not in the pack list`)
    }
    if (![...packed.files].some(file => file.startsWith(`native/${key}/licenses/`))) problems.push(`${key}: no dependency license files are packed`)
    platforms.push(entry)
  }
  for (const key of requiredKeys) {
    if (!staged.includes(key)) problems.push(`${key} is required but not staged (stage it on a matching machine with pnpm run build:rust)`)
  }
  return { name: pkg.name, version: pkg.version, platforms, required: requiredKeys, ok: problems.length === 0, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkPackage({ requiredKeys: required })
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else {
    console.log(`${result.name} ${result.version}: ${result.platforms.length === 0 ? 'no Rust client staged' : result.platforms.map(entry => `${entry.key} ${entry.ok ? 'ok' : entry.problem}`).join(', ')}`)
    for (const line of result.problems) console.log(`  problem: ${line}`)
    console.log(result.ok ? 'package check passed; nothing was packed, uploaded, or published' : 'package check failed')
  }
  process.exit(result.ok ? 0 : 1)
}
