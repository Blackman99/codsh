#!/usr/bin/env node
/**
 * Keep codsh in lockstep with the DeepSeek Harness (dsh) releases.
 *
 * codsh never forks the harness: everything below the terminal surface is the
 * published `@deepseek-ai/dsh-*` set. "Syncing" therefore means (1) pointing
 * every dsh dependency range at the latest published harness release, (2)
 * re-verifying that `cordis.patch.yml` still matches the plugin ids the new
 * bundles declare, and (3) proving the tree still typechecks, builds and
 * passes tests against the bumped versions.
 *
 * Usage:
 *   node scripts/sync-dsh.mjs [--check] [--e2e] [--no-verify] [--no-changeset]
 *
 *   --check       Report only. Exit 0 when in sync, 1 when a newer harness
 *                 release exists, other non-zero on error. Never writes.
 *   --e2e         Also run the e2e suite (boots the real patched bundle).
 *   --no-verify   Skip typecheck/build/test after the bump.
 *   --no-changeset  Do not write a changeset entry.
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(root, 'package.json')
const patchPath = join(root, 'cordis.patch.yml')

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const runE2e = args.has('--e2e')
const verify = !args.has('--no-verify')
const writeChangeset = !args.has('--no-changeset')

const registry = (name) =>
  fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  }).then((r) => {
    if (!r.ok) throw new Error(`registry ${r.status} for ${name}`)
    return r.json()
  })

/** Compare `X.Y.Z[-rc.N]` version strings. Returns -1/0/1. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(v)
    if (!m) return null
    return [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]]
  }
  const ta = parse(a)
  const tb = parse(b)
  if (!ta || !tb) return a === b ? 0 : a < b ? -1 : 1
  for (let i = 0; i < 4; i++) {
    if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1
  }
  return 0
}

const stripRange = (range) => (range.startsWith('^') ? range.slice(1) : range)

/** All `- id:` rows of a cordis patch, split into referenced vs inserted. */
function parsePatchIds(file) {
  const referenced = new Set()
  const inserted = new Set()
  const names = new Set()
  let inInsert = false
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trimEnd()
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (!/^\s/.test(line)) {
      // Top-level list entry: either `- id: X` (referenced) or `- insert:`.
      inInsert = t === '- insert:'
      const m = /^- id:\s*(\S+)/.exec(t)
      if (m && !inInsert) referenced.add(m[1])
      continue
    }
    if (!inInsert) continue
    const m = /^\s*- id:\s*(\S+)/.exec(t)
    if (m) inserted.add(m[1])
    const n = /^\s*- name:\s*['"]?([^'"]+)['"]?\s*$/.exec(t)
    if (n) names.add(n[1])
  }
  return { referenced, inserted, names }
}

/** Collect every plugin id any installed dsh bundle patch declares. */
function declaredPluginIds() {
  const declared = new Set()
  const scopeDir = join(root, 'node_modules', '@deepseek-ai')
  if (existsSync(scopeDir)) {
    for (const dir of readdirSync(scopeDir)) {
      const f = join(scopeDir, dir, 'cordis.patch.yml')
      if (!existsSync(f)) continue
      const { referenced, inserted } = parsePatchIds(f)
      for (const id of referenced) declared.add(id)
      for (const id of inserted) declared.add(id)
    }
  }
  return declared
}

/** Verify codsh's own patch still matches the installed bundles. */
function verifyPatchDrift() {
  const problems = []
  const { referenced, inserted, names } = parsePatchIds(patchPath)
  const declared = declaredPluginIds()
  for (const id of referenced) {
    if (!declared.has(id)) {
      problems.push(
        `cordis.patch.yml references plugin id "${id}", but no installed ` +
          `@deepseek-ai bundle declares it — the row is dead or the id was renamed upstream.`,
      )
    }
  }
  for (const name of names) {
    const resolved = name.replace('/', '/node_modules/')
    if (!existsSync(join(root, 'node_modules', resolved))) {
      problems.push(
        `cordis.patch.yml inserts package "${name}", but it is not installed.`,
      )
    }
  }
  if (problems.length) {
    console.error('\n✗ dsh bundle patch drift:\n')
    for (const p of problems) console.error(`  - ${p}`)
    console.error(
      '\n  Update cordis.patch.yml to match the new harness composition, then rerun.',
    )
    process.exit(1)
  }
  console.log(
    `✓ patch ok: ${referenced.size} referenced ids all declared, ` +
      `${inserted.size} inserted rows resolve`,
  )
}

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })

// ── 1. What does the harness publish right now? ────────────────────────────
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const dshMeta = await registry('@deepseek-ai/dsh')
const dshLatest = dshMeta['dist-tags'].latest
const extra = ['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/schemastery']
const extraLatest = Object.fromEntries(
  await Promise.all(
    extra.map(async (n) => [n, (await registry(n))['dist-tags'].latest]),
  ),
)

// The current installed tree must always match codsh's patch; guard this
// regardless of whether a bump is pending.
verifyPatchDrift()

// ── 2. Which ranges would change? ──────────────────────────────────────────
const targets = new Map() // dep name → exact latest version
for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
  for (const [name, range] of Object.entries(pkg[section] ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) targets.set(name, dshLatest)
    else if (extraLatest[name]) targets.set(name, extraLatest[name])
  }
}
const stale = []
for (const [name, latest] of targets) {
  const current = stripRange(pkg.dependencies[name] ?? pkg.peerDependencies[name] ?? pkg.devDependencies[name])
  if (compareVersions(current, latest) < 0) stale.push([name, current, latest])
}

if (!stale.length) {
  console.log(`✓ in sync — every @deepseek-ai dep is already at the latest (dsh ${dshLatest})`)
  process.exit(0)
}

console.log(`dsh harness latest: ${dshLatest}\n`)
for (const [name, current, latest] of stale) {
  console.log(`  ${name}: ${current} → ${latest}`)
}
if (checkOnly) process.exit(1)

// ── 3. Bump the ranges and reinstall ───────────────────────────────────────
for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
  for (const name of Object.keys(pkg[section] ?? {})) {
    if (targets.has(name)) pkg[section][name] = `^${targets.get(name)}`
  }
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
console.log('\n↑ package.json ranges bumped')
run('pnpm install')

// ── 4. Is codsh's bundle patch still coherent on the new tree? ─────────────
verifyPatchDrift()

// ── 5. Changeset so the next release picks up the bump ─────────────────────
if (writeChangeset) {
  const file = join(root, '.changeset', `dsh-sync-${dshLatest}.md`)
  if (!existsSync(file)) {
    writeFileSync(
      file,
      `---\n'codsh-bundle': patch\n---\n\nchore: sync \`@deepseek-ai/dsh-*\` (and co-released cordis packages) to ${dshLatest}\n`,
    )
    console.log(`✓ changeset written: .changeset/dsh-sync-${dshLatest}.md`)
  }
}

// ── 6. Prove the tree still works on the bumped versions ───────────────────
if (verify) {
  run('pnpm run typecheck')
  run('pnpm run build')
  run('pnpm test')
  if (runE2e) run('pnpm run test:e2e')
}
console.log('\n✓ dsh sync complete')
