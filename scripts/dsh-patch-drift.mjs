/**
 * Whether the bundle patch still names host rows the installed harness
 * declares. Nightly sync walks these ids after a bump; a missing row is the
 * drift that fails the job.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * All `- id:` rows of a cordis patch, split into referenced vs inserted.
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
    const n = /^\s*- name:\s*['"]?([^'"]+)['"]?\s*$/.exec(t)
    if (n) names.add(n[1])
  }
  return { referenced, inserted, names }
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
 * Every installed `@deepseek-ai` `cordis.patch.yml`, including pnpm's virtual
 * store. pnpm 10 with shamefully-hoist puts dsh-base in the root scope; pnpm 12
 * may leave it only under `.pnpm`, and a scan that misses that copy reports
 * every host row as dead.
 * @param {string} root - workspace root.
 * @returns {string[]} patch file paths.
 */
export function installedPatchFiles(root) {
  const files = []
  const seen = new Set()
  const add = (file) => {
    if (seen.has(file) || !existsSync(file)) return
    seen.add(file)
    files.push(file)
  }
  for (const scopeDir of scopeDirs(root)) {
    for (const dir of readdirSync(scopeDir)) add(join(scopeDir, dir, 'cordis.patch.yml'))
  }
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return files
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith('@deepseek-ai+')) continue
    const scopeDir = join(store, entry, 'node_modules', '@deepseek-ai')
    if (!existsSync(scopeDir)) continue
    for (const dir of readdirSync(scopeDir)) add(join(scopeDir, dir, 'cordis.patch.yml'))
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
 * @param {string} name - package name such as `@deepseek-ai/dsh-agent-presets`.
 * @returns {boolean} true when the package exists in a scope or the virtual store.
 */
export function insertedPackageInstalled(root, name) {
  const resolved = name.replace('/', '/node_modules/')
  if (scopeDirs(root).some((dir) => existsSync(join(dirname(dir), resolved)))) return true
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return false
  const prefix = `${name.replace('/', '+')}@`
  return readdirSync(store).some((entry) => {
    if (!entry.startsWith(prefix)) return false
    return existsSync(join(store, entry, 'node_modules', name))
  })
}

/**
 * Drift between the bundle patch and the installed harness composition.
 * @param {{ root: string, patchPath: string }} options - workspace and patch paths.
 * @returns {string[]} problem descriptions; empty when the patch still matches.
 */
export function patchDriftProblems({ root, patchPath }) {
  const problems = []
  const { referenced, names } = parsePatchIds(patchPath)
  const declared = declaredPluginIds(root)
  for (const id of referenced) {
    if (!declared.has(id)) {
      problems.push(
        `cordis.patch.yml references plugin id "${id}", but no installed ` +
          `@deepseek-ai bundle declares it — the row is dead or the id was renamed upstream.`,
      )
    }
  }
  for (const name of names) {
    if (!insertedPackageInstalled(root, name)) {
      problems.push(`cordis.patch.yml inserts package "${name}", but it is not installed.`)
    }
  }
  return problems
}
