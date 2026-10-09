/**
 * Whether the bundle patch still names host rows the installed harness
 * declares. Nightly sync walks these ids after a bump; a missing row is the
 * drift that fails the job.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * All `- id:` rows of a cordis patch, split into referenced vs inserted, and
 * every package an inserted row (or a preset's child row) loads.
 * @param {string} file - path to a cordis.patch.yml.
 * @returns {{ referenced: Set<string>, inserted: Set<string>, names: Set<string> }}
 */
export function parsePatchIds(file) {
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
    // `name:` is usually the second key of a row, so it carries no `- `.
    // `cordis:group` and the like are loader built-ins, not packages.
    const n = /^(?:- )?name:\s*['"]?([^'"\s]+)['"]?$/.exec(t)
    if (n && !n[1].startsWith('cordis:')) names.add(n[1])
  }
  return { referenced, inserted, names }
}

/**
 * The patch files a bundle package composes, in order: its `dsh.bundle.patch`
 * (a path or a list), else a sibling `cordis.patch.yml`.
 * @param {string} packageDir - installed package directory.
 * @returns {string[]} existing patch file paths.
 */
export function bundlePatchFiles(packageDir) {
  let declared
  try {
    declared = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).dsh?.bundle?.patch
  } catch {
    declared = undefined
  }
  const relative = declared === undefined ? ['cordis.patch.yml'] : [declared].flat()
  return relative.map((path) => join(packageDir, path)).filter((path) => existsSync(path))
}

/**
 * Direct `@deepseek-ai` scopes a workspace install may hoist into.
 * @param {string} root - workspace root.
 * @returns {string[]} existing scope directories.
 */
export function scopeDirs(root) {
  const packages = existsSync(join(root, 'packages')) ? readdirSync(join(root, 'packages')) : []
  return [
    join(root, 'node_modules', '@deepseek-ai'),
    ...packages.map((dir) => join(root, 'packages', dir, 'node_modules', '@deepseek-ai')),
  ].filter((dir) => existsSync(dir))
}

/**
 * `@deepseek-ai` store entries (`@deepseek-ai+name@version`) the workspace
 * lockfile still pins. pnpm can leave a replaced version's directory behind in
 * `.pnpm`; its old patch would declare every row the bump removed and hide the
 * drift, so a scan only trusts entries the lockfile names.
 * @param {string} root - workspace root.
 * @returns {Set<string> | undefined} pinned entry prefixes, or undefined without a lockfile.
 */
function lockedStoreEntries(root) {
  const lockfile = join(root, 'pnpm-lock.yaml')
  if (!existsSync(lockfile)) return undefined
  const locked = new Set()
  for (const [, name, version] of readFileSync(lockfile, 'utf8').matchAll(/^ {2}'?(@deepseek-ai\/[^@'\s]+)@([^('\s:]+)/gm)) {
    locked.add(`${name.replace('/', '+')}@${version}`)
  }
  return locked
}

/**
 * `.pnpm` entry directories for `@deepseek-ai` packages the lockfile pins.
 * @param {string} root - workspace root.
 * @returns {string[]} entry names under `node_modules/.pnpm`.
 */
function storeEntries(root) {
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return []
  const locked = lockedStoreEntries(root)
  // A peer-resolved entry appends `_<peers or hash>`; versions never contain `_`.
  return readdirSync(store)
    .filter((entry) => entry.startsWith('@deepseek-ai+'))
    .filter((entry) => locked === undefined || locked.has(entry.split('_')[0]))
}

/**
 * Every installed `@deepseek-ai` bundle patch, including pnpm's virtual
 * store. pnpm 10 with shamefully-hoist puts dsh-base in the root scope; pnpm 12
 * may leave it only under `.pnpm`, and a scan that misses that copy reports
 * every host row as dead.
 * @param {string} root - workspace root.
 * @returns {string[]} patch file paths.
 */
export function installedPatchFiles(root) {
  const files = []
  const seen = new Set()
  const addPackage = (packageDir) => {
    for (const file of bundlePatchFiles(packageDir)) {
      if (seen.has(file)) continue
      seen.add(file)
      files.push(file)
    }
  }
  for (const scopeDir of scopeDirs(root)) {
    for (const dir of readdirSync(scopeDir)) addPackage(join(scopeDir, dir))
  }
  const store = join(root, 'node_modules', '.pnpm')
  for (const entry of storeEntries(root)) {
    const scopeDir = join(store, entry, 'node_modules', '@deepseek-ai')
    if (!existsSync(scopeDir)) continue
    for (const dir of readdirSync(scopeDir)) addPackage(join(scopeDir, dir))
  }
  return files
}

/**
 * Collect every plugin id any installed dsh bundle patch declares.
 * @param {string} root - workspace root.
 * @returns {Set<string>} referenced and inserted ids.
 */
export function declaredPluginIds(root) {
  const declared = new Set()
  for (const file of installedPatchFiles(root)) {
    const { referenced, inserted } = parsePatchIds(file)
    for (const id of referenced) declared.add(id)
    for (const id of inserted) declared.add(id)
  }
  return declared
}

/**
 * Whether an inserted package name is present anywhere the loader could resolve it.
 * @param {string} root - workspace root.
 * @param {string} name - row name such as `@deepseek-ai/dsh-agent-preset` or `@deepseek-ai/dsh-plugin-manager/tools`.
 * @returns {boolean} true when the package exists in a scope or the virtual store.
 */
export function insertedPackageInstalled(root, name) {
  const [scope, base] = name.split('/')
  const packageName = `${scope}/${base}`
  if (scopeDirs(root).some((dir) => existsSync(join(dir, base, 'package.json')))) return true
  const prefix = `${packageName.replace('/', '+')}@`
  const store = join(root, 'node_modules', '.pnpm')
  return storeEntries(root).some((entry) =>
    entry.startsWith(prefix) && existsSync(join(store, entry, 'node_modules', packageName, 'package.json')))
}

/**
 * Drift between the bundle's own patches and the installed harness composition.
 * @param {{ root: string, bundleDir: string }} options - workspace root and the bundle package directory.
 * @returns {string[]} problem descriptions; empty when the patches still match.
 */
export function patchDriftProblems({ root, bundleDir }) {
  const problems = []
  const declared = declaredPluginIds(root)
  for (const patchPath of bundlePatchFiles(bundleDir)) {
    const file = relative(bundleDir, patchPath)
    const { referenced, names } = parsePatchIds(patchPath)
    for (const id of referenced) {
      if (!declared.has(id)) {
        problems.push(
          `${file} references plugin id "${id}", but no installed ` +
            `@deepseek-ai bundle declares it — the row is dead or the id was renamed upstream.`,
        )
      }
    }
    for (const name of names) {
      if (!name.startsWith('@deepseek-ai/')) continue
      if (!insertedPackageInstalled(root, name)) {
        problems.push(`${file} inserts package "${name}", but it is not installed.`)
      }
    }
  }
  return problems
}
