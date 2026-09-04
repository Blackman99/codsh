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
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, selectDshTarget } from './dsh-release-policy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every workspace manifest that could hold a harness range, root first.
 *
 * The two-package split moved those ranges apart: the e2e harness's own dsh
 * packages stayed at the root, while the plugins the bundle composes went to
 * `packages/bundle`. Reading one manifest leaves the other pinned, and a
 * profile install that resolves one set a release ahead of the other is the
 * version split that crashes at runtime — so the sync covers all of them.
 */
const manifestPaths = [
  join(root, 'package.json'),
  ...readdirSync(join(root, 'packages'))
    .map((dir) => join(root, 'packages', dir, 'package.json'))
    .filter((path) => existsSync(path)),
]

/** Where the installed `@deepseek-ai` trees are, one per workspace package. */
const scopeDirs = () =>
  [
    join(root, 'node_modules', '@deepseek-ai'),
    ...readdirSync(join(root, 'packages')).map((dir) =>
      join(root, 'packages', dir, 'node_modules', '@deepseek-ai'),
    ),
  ].filter((dir) => existsSync(dir))

/** The patch belongs to the bundle, which is the package that composes dsh. */
const patchPath = join(root, 'packages', 'bundle', 'cordis.patch.yml')

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
  for (const scopeDir of scopeDirs()) {
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
    // Hoisting is pnpm's business: an inserted package may sit under any
    // workspace package's tree, and any one of them satisfies the patch.
    const anywhere = scopeDirs().some((dir) => existsSync(join(dirname(dir), resolved)))
    if (!anywhere) {
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
const manifests = manifestPaths.map((path) => ({ path, pkg: JSON.parse(readFileSync(path, 'utf8')) }))
const dshMeta = await registry('@deepseek-ai/dsh')
const dshRange = manifests
  .map(({ pkg }) => pkg.dependencies?.['@deepseek-ai/dsh']
    ?? pkg.peerDependencies?.['@deepseek-ai/dsh']
    ?? pkg.devDependencies?.['@deepseek-ai/dsh'])
  .find((range) => range !== undefined)
if (dshRange === undefined) throw new Error('no @deepseek-ai/dsh range found in workspace manifests')
// A promoted `latest` opts into a new release line. Within the current range,
// also track the highest version a lockfile-free install would resolve: the
// harness has published same-core RCs without moving its tags. An unrelated
// alpha tag is neither signal and must not silently move codsh onto that line.
const dshLatest = selectDshTarget(dshMeta, dshRange)
if (dshLatest !== dshMeta['dist-tags'].latest) {
  console.log(`note: @deepseek-ai/dsh publishes ${dshLatest}, but its latest tag still reads ${dshMeta['dist-tags'].latest}\n`)
}
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
const SECTIONS = ['dependencies', 'peerDependencies', 'devDependencies']
/** Every stale range, carrying the manifest and section it lives in. */
const stale = []
for (const { path, pkg } of manifests) {
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      const latest = name.startsWith('@deepseek-ai/dsh') ? dshLatest : extraLatest[name]
      if (latest === undefined) continue
      const current = stripRange(range)
      if (compareVersions(current, latest) < 0) stale.push({ path, pkg, section, name, current, latest })
    }
  }
}

if (!stale.length) {
  console.log(`✓ in sync — every @deepseek-ai dep is already at the latest (dsh ${dshLatest})`)
  process.exit(0)
}

console.log(`dsh harness latest: ${dshLatest}\n`)
for (const { path, name, current, latest } of stale) {
  console.log(`  ${relative(root, path)} ${name}: ${current} → ${latest}`)
}
if (checkOnly) process.exit(1)

// ── 3. Bump the ranges and reinstall ───────────────────────────────────────
const touched = new Set()
for (const { path, pkg, section, name, latest } of stale) {
  pkg[section][name] = `^${latest}`
  touched.add(path)
}
for (const { path, pkg } of manifests) {
  if (!touched.has(path)) continue
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`↑ ${relative(root, path)} ranges bumped`)
}
// CI freezes the lockfile by default; the bump above intentionally makes it
// stale, so the install must be allowed to rewrite it.
run('pnpm install --no-frozen-lockfile')

// ── 4. Is codsh's bundle patch still coherent on the new tree? ─────────────
verifyPatchDrift()

// ── 5. Changeset so the next release picks up the bump ─────────────────────
if (writeChangeset) {
  const file = join(root, '.changeset', `dsh-sync-${dshLatest}.md`)
  if (!existsSync(file)) {
    writeFileSync(
      file,
      `---\n'codsh-bundle': patch\n'codsh-cli': patch\n---\n\nchore: sync \`@deepseek-ai/dsh-*\` (and co-released cordis packages) to ${dshLatest}\n`,
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
