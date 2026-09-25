#!/usr/bin/env node
/**
 * Local git worktrees for the isolated Rust client (ticket 174).
 *
 * One implementation serves `codsh --rust -w`, `codsh --rust worktree ...`,
 * `/worktree` in the TUI, and subagent `isolation: "worktree"` inside dsh.
 * Every worktree is a plain `git worktree` on its own `codsh/<label>` branch
 * under `<pool>/<repo>/<label>`, where `<pool>` is `$GROK_HOME/worktrees`.
 * One JSON record per worktree lives in `<pool>/.registry/`.
 *
 * Safety rules:
 * - The source checkout is only read. Uncommitted changes are carried into
 *   the new worktree (and committed there as one snapshot) when no ref is
 *   named; the source files and index stay as they were.
 * - A label directory or branch that already exists is never reused or
 *   reset; the label gets a numeric suffix instead.
 * - Git hooks of the repository do not run for these internal operations.
 * - Applying is an explicit command. Merge mode (the default) writes a file
 *   only when the checkout still holds the content the worktree started
 *   from; anything else is a conflict and is left untouched. `--overwrite`
 *   replaces conflicting files and is never the default.
 * - Removal refuses a worktree with uncommitted work unless forced, keeps
 *   the branch whenever it holds commits, and never deletes a path outside
 *   the pool.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BRANCH_PREFIX = 'codsh/'
const MAX_LABEL = 48
const MAX_SUFFIX = 99
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u
// Ignored output directories that do not count as work for gc: the repository
// ignores them (git reports them as `!!`) and the name is a tool's output or
// cache directory. A hand-written, unignored `build/` still counts.
const CACHE_DIRS = new Set(['target', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'dist', 'build', '.next', '.nuxt', '.turbo', '.cache', '.gradle', '.parcel-cache', 'coverage'])

export class WorktreeError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

/** The worktree pool: `$CODSH_WORKTREE_HOME`, else `$GROK_HOME/worktrees`. */
export function poolDir(env = process.env) {
  if (env.CODSH_WORKTREE_HOME) return resolve(env.CODSH_WORKTREE_HOME)
  if (env.GROK_HOME) return resolve(env.GROK_HOME, 'worktrees')
  throw new WorktreeError('no worktree pool: set GROK_HOME (codsh --rust sets it)', 2)
}

export function registryDir(pool) {
  return join(pool, '.registry')
}

function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', ...args], {
      cwd,
      encoding: options.buffer ? 'buffer' : 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      input: options.input,
    })
  } catch (error) {
    if (options.allowFail) return null
    const stderr = error.stderr ? String(error.stderr).trim() : ''
    throw new WorktreeError(`git ${args.filter(arg => !arg.startsWith('-c')).slice(0, 3).join(' ')} failed${stderr ? `: ${stderr.split('\n').slice(-3).join(' ')}` : ''}`)
  }
}

function gitInput(cwd, args, input) {
  try {
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : ''
    throw new WorktreeError(`git ${args[0]} failed${stderr ? `: ${stderr.split('\n').slice(-3).join(' ')}` : ''}`)
  }
}

function nulList(text) {
  return String(text ?? '').split('\0').filter(Boolean)
}

/** Lowercase, `[a-z0-9-]`, collapsed and trimmed, at most 48 characters. */
export function sanitizeLabel(name) {
  const out = String(name ?? '').toLowerCase().replace(/[ _]/gu, '-').replace(/[^a-z0-9-]/gu, '').replace(/-+/gu, '-').replace(/^-+|-+$/gu, '')
  return out.slice(0, MAX_LABEL).replace(/-+$/u, '')
}

export function autoLabel(now = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${randomBytes(4).toString('hex')}`
}

/** Last two meaningful components of the repository root, as a label. */
export function repoSlug(root) {
  const parts = root.split(sep).filter(part => part && part !== 'home' && part !== 'Users' && !part.startsWith('.'))
  return sanitizeLabel(parts.slice(-2).join('-')) || 'repo'
}

function now() {
  return Math.floor(Date.now() / 1000)
}

function realDir(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The main checkout root of a git directory, or a WorktreeError for a non-git directory. */
export function sourceRoot(cwd) {
  if (!existsSync(cwd)) throw new WorktreeError(`${cwd} does not exist`, 2)
  const top = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true })
  if (top === null) {
    throw new WorktreeError(`${cwd} is not inside a git repository; worktree isolation needs git, so nothing was created`, 2)
  }
  const bare = git(cwd, ['rev-parse', '--is-bare-repository'], { allowFail: true })
  if (bare?.trim() === 'true') throw new WorktreeError(`${cwd} is a bare repository; nothing was created`, 2)
  return realDir(top.trim())
}

function recordPath(pool, id) {
  return join(registryDir(pool), `${id}.json`)
}

export function readRecord(pool, id) {
  if (!ID_RE.test(id)) return null
  try {
    const value = JSON.parse(readFileSync(recordPath(pool, id), 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

export function writeRecord(pool, record) {
  const dir = registryDir(pool)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = recordPath(pool, record.id)
  const temp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, target)
  return record
}

function dropRecord(pool, id) {
  rmSync(recordPath(pool, id), { force: true })
}

export function listRecords(pool) {
  let names = []
  try {
    names = readdirSync(registryDir(pool))
  } catch {
    return []
  }
  return names
    .filter(name => name.endsWith('.json'))
    .map(name => readRecord(pool, name.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

function branchExists(root, branch) {
  return git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) !== null
}

function chooseLabel(pool, base, root, wanted) {
  const taken = label => existsSync(join(base, label)) || readRecord(pool, label) !== null || branchExists(root, `${BRANCH_PREFIX}${label}`)
  if (!taken(wanted)) return wanted
  for (let index = 2; index <= MAX_SUFFIX; index += 1) {
    const candidate = `${wanted.slice(0, MAX_LABEL - 4)}-${index}`
    if (!taken(candidate)) return candidate
  }
  return autoLabel()
}

function copyUntracked(from, to, path) {
  const source = join(from, path)
  const target = join(to, path)
  const info = lstatSync(source)
  mkdirSync(dirname(target), { recursive: true })
  if (info.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target)
  } else if (info.isFile()) {
    copyFileSync(source, target)
    chmodSync(target, info.mode & 0o777)
  }
}

/**
 * Create a worktree.
 * @param {object} options
 * @param {string} options.source - the directory the user or parent agent is in.
 * @param {string} [options.label] - `-w NAME`; sanitized, suffixed on collision.
 * @param {string} [options.ref] - base ref; a clean checkout when set.
 * @param {'session'|'subagent'} [options.type]
 * @param {string} [options.sessionId] - owning session, when known.
 * @param {string} [options.parentSessionId] - delegating session of a subagent worktree.
 * @param {string} [options.pool]
 */
export function createWorktree(options) {
  const pool = options.pool ?? poolDir()
  const sourceCwd = realDir(options.source)
  const root = sourceRoot(sourceCwd)
  const poolReal = realDir(pool)
  if (poolReal === root || poolReal.startsWith(`${root}${sep}`)) {
    // A pool inside the repository would be checked out into itself.
    throw new WorktreeError(`the worktree pool ${pool} is inside the repository ${root}; move GROK_HOME out of it`, 2)
  }
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })?.trim()
  const ref = options.ref ? String(options.ref) : undefined
  let start
  if (ref !== undefined) {
    if (ref.startsWith('-')) throw new WorktreeError(`invalid ref ${ref}`, 2)
    start = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true })?.trim()
    if (!start) throw new WorktreeError(`ref ${ref} does not name a commit in ${root}; nothing was created`, 2)
  } else {
    if (!head) throw new WorktreeError(`${root} has no commit yet; commit once or pass --worktree-ref`, 2)
    start = head
  }
  const slug = repoSlug(root)
  const base = join(pool, slug)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  mkdirSync(registryDir(pool), { recursive: true, mode: 0o700 })
  const wanted = sanitizeLabel(options.label) || autoLabel()
  const label = chooseLabel(pool, base, root, wanted)
  const path = join(base, label)
  const branch = `${BRANCH_PREFIX}${label}`
  // Reserve the id first so two creators cannot pick the same label.
  const record = {
    id: label,
    label,
    requestedLabel: options.label ? String(options.label) : null,
    type: options.type === 'subagent' ? 'subagent' : 'session',
    path,
    branch,
    repo: slug,
    sourceRoot: root,
    sourceCwd,
    ref: ref ?? null,
    startCommit: start,
    baseCommit: start,
    copyMode: ref === undefined ? 'dirty' : 'clean',
    carried: [],
    createdAt: now(),
    lastAccessedAt: now(),
    sessionId: options.sessionId ?? null,
    parentSessionId: options.parentSessionId ?? null,
    ownerPid: options.ownerPid ?? null,
    applied: [],
    // Always a plain git worktree. A Grove request (ticket 191: env
    // GROK_WORKTREE_TYPE, [cli] grove_worktree, or enable-all) is recorded
    // with the setting that asked; there is no Grove backend to use.
    strategy: 'git',
    grove: groveRequest(options.grove),
  }
  writeRecord(pool, record)
  let added = false
  try {
    git(root, ['worktree', 'add', '--quiet', '-b', branch, path, start])
    added = true
    if (record.copyMode === 'dirty') {
      const diff = git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD'], { buffer: true })
      const carried = new Set(nulList(git(root, ['diff', '--name-only', '-z', '--no-renames', 'HEAD'])))
      if (diff.length > 0) gitInput(path, ['apply', '--binary', '--whitespace=nowarn', '-'], diff)
      for (const entry of nulList(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))) {
        // A trailing slash is a nested repository; it is not copied.
        if (entry.endsWith('/')) continue
        copyUntracked(root, path, entry)
        carried.add(entry)
      }
      if (carried.size > 0) {
        git(path, ['add', '-A'])
        git(path, ['-c', 'user.name=codsh', '-c', 'user.email=codsh@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', `codsh: carry uncommitted changes from ${root}`])
        record.baseCommit = git(path, ['rev-parse', 'HEAD']).trim()
        record.carried = [...carried].sort()
      }
    }
  } catch (error) {
    // Leave nothing half-made: the directory, the admin entry, the branch.
    if (added) git(root, ['worktree', 'remove', '--force', path], { allowFail: true })
    if (existsSync(path) && path.startsWith(`${realDir(pool)}${sep}`)) rmSync(path, { recursive: true, force: true })
    git(root, ['worktree', 'prune'], { allowFail: true })
    if (branchExists(root, branch)) git(root, ['branch', '-D', branch], { allowFail: true })
    dropRecord(pool, label)
    throw error instanceof WorktreeError ? error : new WorktreeError(String(error?.message ?? error))
  }
  const offset = relative(root, sourceCwd)
  const inner = offset && !offset.startsWith('..') ? join(path, offset) : path
  record.sessionCwd = existsSync(inner) ? inner : path
  writeRecord(pool, record)
  return record
}

function groveRequest(source = process.env.CODSH_WORKTREE_GROVE) {
  const text = typeof source === 'string' ? source.trim() : ''
  if (!text) return null
  return { requested: true, source: text.slice(0, 80), used: false, reason: 'no Grove backend in this client; plain git worktree' }
}

/** Find a record by id, label, or path (a path inside a worktree counts). */
export function resolveRecord(pool, idOrPath) {
  const key = String(idOrPath ?? '').trim()
  if (!key) throw new WorktreeError('name a worktree id or path', 2)
  const direct = readRecord(pool, key)
  if (direct) return direct
  const records = listRecords(pool)
  const byLabel = records.filter(record => record.label === key)
  if (byLabel.length === 1) return byLabel[0]
  const path = realDir(resolve(key))
  const inside = records.find(record => path === realDir(record.path) || path.startsWith(`${realDir(record.path)}${sep}`))
  if (inside) return inside
  throw new WorktreeError(`no tracked worktree ${key}; run codsh --rust worktree list`, 3)
}

/** The worktree record whose checkout holds `cwd`, or null. */
export function recordForPath(pool, cwd) {
  const path = realDir(cwd)
  for (const record of listRecords(pool)) {
    const root = realDir(record.path)
    if (path === root || path.startsWith(`${root}${sep}`)) return record
  }
  return null
}

export function touchRecord(pool, id, fields = {}) {
  const record = readRecord(pool, id)
  if (!record) throw new WorktreeError(`no tracked worktree ${id}`, 3)
  return writeRecord(pool, { ...record, ...fields, lastAccessedAt: now() })
}

function statusEntries(path, ignored = false) {
  const out = git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...ignored ? ['--ignored'] : []], { allowFail: true })
  if (out === null) return null
  const items = nulList(out)
  const entries = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const code = item.slice(0, 2)
    entries.push({ code, path: item.slice(3) })
    if (code[0] === 'R' || code[0] === 'C') index += 1
  }
  return entries
}

function isCacheEntry(path) {
  return path.replace(/\/+$/u, '').split('/').some(part => CACHE_DIRS.has(part))
}

/** Changed paths in the worktree relative to its base: tracked edits, deletions, commits, untracked files. */
export function changedPaths(record) {
  const tracked = nulList(git(record.path, ['diff', '--name-only', '-z', '--no-renames', record.baseCommit]))
  const untracked = nulList(git(record.path, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(entry => !entry.endsWith('/'))
  return [...new Set([...tracked, ...untracked])].sort()
}

function describe(record) {
  const exists = existsSync(record.path)
  let dirty = null
  let changed = null
  let head = null
  if (exists) {
    const status = statusEntries(record.path)
    dirty = status === null ? null : status.length > 0
    try {
      changed = changedPaths(record).length
      head = git(record.path, ['rev-parse', 'HEAD']).trim()
    } catch {
      changed = null
    }
  }
  return { ...record, exists, dirty, changedFiles: changed, head }
}

export function listWorktrees({ pool = poolDir(), repo, type, all = false, cwd = process.cwd() } = {}) {
  let records = listRecords(pool)
  let scope = 'all repositories'
  if (repo) {
    const wanted = existsSync(repo) ? (() => {
      try { return sourceRoot(repo) } catch { return realDir(repo) }
    })() : null
    records = records.filter(record => record.repo === repo || (wanted !== null && record.sourceRoot === wanted))
    scope = `repository ${repo}`
  } else if (!all) {
    let root = null
    try {
      const own = recordForPath(pool, cwd)
      root = own ? own.sourceRoot : sourceRoot(cwd)
    } catch {}
    if (root) {
      records = records.filter(record => record.sourceRoot === root)
      scope = `repository ${root}`
    }
  }
  if (type) records = records.filter(record => record.type === type)
  return { pool, scope, worktrees: records.map(describe) }
}

function readSide(path) {
  let info
  try {
    info = lstatSync(path)
  } catch {
    return { kind: 'missing', data: null }
  }
  if (info.isSymbolicLink()) return { kind: 'symlink', data: null }
  if (info.isDirectory()) return { kind: 'directory', data: null }
  if (!info.isFile()) return { kind: 'special', data: null }
  return { kind: 'file', data: readFileSync(path), mode: info.mode & 0o777 }
}

function baseEntry(record, path) {
  const listed = git(record.path, ['ls-tree', '-z', record.baseCommit, '--', path])
  const entry = nulList(listed)[0]
  if (!entry) return { kind: 'missing', data: null }
  const mode = entry.split(' ')[0]
  if (mode === '120000') return { kind: 'symlink', data: null }
  if (mode === '160000') return { kind: 'submodule', data: null }
  if (mode !== '100644' && mode !== '100755') return { kind: 'special', data: null }
  return { kind: 'file', data: git(record.path, ['cat-file', 'blob', `${record.baseCommit}:${path}`], { buffer: true }) }
}

function sameData(a, b) {
  if (a === null || b === null) return a === b
  return Buffer.compare(a, b) === 0
}

/** True when every existing component from `root` to `target`'s parent is a real directory inside `root`. */
function safeTarget(root, target) {
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  const parts = rel.split(sep)
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    let info
    try {
      info = lstatSync(current)
    } catch {
      return true
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return false
  }
  return true
}

/**
 * Apply a worktree's changes to the checkout it came from.
 * @param {object} options
 * @param {string} options.id - id, label, or path.
 * @param {'merge'|'overwrite'} [options.mode]
 * @param {boolean} [options.dryRun]
 */
export function applyWorktree({ pool = poolDir(), id, mode = 'merge', dryRun = false }) {
  const record = resolveRecord(pool, id)
  if (!existsSync(record.path)) throw new WorktreeError(`worktree ${record.id} is missing at ${record.path}; nothing to apply`, 3)
  if (!existsSync(record.sourceRoot)) throw new WorktreeError(`source checkout ${record.sourceRoot} is gone; nothing was applied`, 3)
  const root = realDir(record.sourceRoot)
  const plan = { applied: [], unchanged: [], conflicts: [] }
  const writes = []
  for (const path of changedPaths(record)) {
    if (path.split('/').includes('..') || isAbsolute(path)) {
      plan.conflicts.push({ path, reason: 'unsafe path' })
      continue
    }
    const theirs = readSide(join(record.path, path))
    const target = join(root, path)
    if (theirs.kind !== 'file' && theirs.kind !== 'missing') {
      plan.conflicts.push({ path, reason: `${theirs.kind} in the worktree is not applied` })
      continue
    }
    if (!safeTarget(root, target)) {
      plan.conflicts.push({ path, reason: 'a parent directory in the checkout is a symlink or not a directory' })
      continue
    }
    const ours = readSide(target)
    if (ours.kind !== 'file' && ours.kind !== 'missing') {
      plan.conflicts.push({ path, reason: `${ours.kind} in the checkout is not replaced` })
      continue
    }
    const change = theirs.kind === 'missing' ? 'deleted' : ours.kind === 'missing' ? 'added' : 'modified'
    if (sameData(ours.data, theirs.data)) {
      plan.unchanged.push({ path })
      continue
    }
    if (mode !== 'overwrite') {
      const base = baseEntry(record, path)
      if (base.kind !== 'file' && base.kind !== 'missing') {
        plan.conflicts.push({ path, reason: `${base.kind} at the base is not merged` })
        continue
      }
      if (!sameData(ours.data, base.data)) {
        plan.conflicts.push({ path, reason: ours.kind === 'missing' ? 'deleted in the checkout since the worktree was created' : base.data === null ? 'the checkout added its own version' : 'changed in the checkout since the worktree was created' })
        continue
      }
    }
    writes.push({ path, target, theirs, change })
    plan.applied.push({ path, change })
  }
  if (!dryRun) {
    for (const write of writes) {
      if (write.theirs.kind === 'missing') {
        rmSync(write.target, { force: true })
      } else {
        mkdirSync(dirname(write.target), { recursive: true })
        const temp = `${write.target}.codsh-apply-${randomBytes(3).toString('hex')}`
        writeFileSync(temp, write.theirs.data, { mode: write.theirs.mode })
        chmodSync(temp, write.theirs.mode)
        renameSync(temp, write.target)
      }
    }
    if (writes.length > 0 || plan.conflicts.length > 0) {
      const fresh = readRecord(pool, record.id) ?? record
      writeRecord(pool, {
        ...fresh,
        lastAccessedAt: now(),
        applied: [...fresh.applied ?? [], { at: now(), mode, files: plan.applied.map(item => item.path), conflicts: plan.conflicts.map(item => item.path) }],
      })
    }
  }
  return {
    id: record.id,
    worktree: record.path,
    gitRoot: root,
    mode,
    dryRun,
    status: plan.conflicts.length > 0 ? 'conflicts' : 'success',
    ...plan,
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Reasons removing this worktree would lose work, or [] when it is safe. */
export function workAtRisk(record) {
  if (!existsSync(record.path)) return []
  const reasons = []
  const status = statusEntries(record.path, true)
  if (status === null) return ['its git state cannot be read']
  const dirty = status.filter(entry => entry.code !== '!!')
  const ignored = status.filter(entry => entry.code === '!!' && !isCacheEntry(entry.path))
  if (dirty.length > 0) reasons.push(`${dirty.length} uncommitted or untracked path(s)`)
  if (ignored.length > 0) reasons.push(`${ignored.length} ignored path(s) that are not caches`)
  const head = git(record.path, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })?.trim()
  if (head) {
    const holders = git(record.path, ['for-each-ref', '--contains', head, '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes'], { allowFail: true })
    if (holders !== null && holders.trim() === '') reasons.push(`commit ${head.slice(0, 12)} is held by no branch or tag`)
  }
  return reasons
}

/** Remove one tracked worktree (or an untracked directory inside the pool). */
export function removeWorktree({ pool = poolDir(), id, force = false, dryRun = false, dropSnapshot = false }) {
  const poolReal = realDir(pool)
  let record
  try {
    record = resolveRecord(pool, id)
  } catch (error) {
    const path = realDir(resolve(String(id)))
    if (!path.startsWith(`${poolReal}${sep}`) || !existsSync(path)) throw error
    record = { id: null, path, sourceRoot: null, branch: null, untracked: true }
  }
  const path = realDir(record.path)
  if (!path.startsWith(`${poolReal}${sep}`)) {
    throw new WorktreeError(`refusing to remove ${record.path}: it is outside the worktree pool ${pool}`, 2)
  }
  const risk = force ? [] : workAtRisk(record)
  if (risk.length > 0) {
    throw new WorktreeError(`worktree ${record.id ?? record.path} still holds work (${risk.join('; ')}); apply or commit it, or pass --force to remove it anyway`, 4)
  }
  let branch = null
  if (record.branch && record.sourceRoot && existsSync(record.sourceRoot)) {
    const tip = git(record.sourceRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`], { allowFail: true })?.trim()
    if (tip) branch = { name: record.branch, deleted: tip === record.startCommit || (dropSnapshot && tip === record.baseCommit), tip }
  }
  if (!dryRun) {
    if (existsSync(path)) {
      const root = record.sourceRoot && existsSync(record.sourceRoot) ? record.sourceRoot : null
      const removed = root ? git(root, ['worktree', 'remove', ...force ? ['--force', '--force'] : [], path], { allowFail: true }) : null
      if (removed === null && existsSync(path)) {
        if (!force && root) throw new WorktreeError(`git refused to remove ${path}; pass --force to remove it anyway`, 4)
        rmSync(path, { recursive: true, force: true })
      }
      if (root) git(root, ['worktree', 'prune'], { allowFail: true })
    }
    // The branch goes only when it never moved past its start commit; any
    // commit keeps it. `dropSnapshot` (automatic cleanup of a subagent
    // worktree that changed nothing) also drops the carried-changes snapshot,
    // which only copies what is still in the source checkout.
    if (branch?.deleted) git(record.sourceRoot, ['branch', '-D', branch.name], { allowFail: true })
    if (record.id) dropRecord(pool, record.id)
  }
  return { id: record.id, path, dryRun, forced: force, branch, untracked: Boolean(record.untracked) }
}

/** Parse `7d`, `12h`, `30m`, `45s`, or a bare number of seconds. */
export function parseAge(text) {
  const match = /^(\d+)([smhdw]?)$/u.exec(String(text ?? '').trim())
  if (!match) throw new WorktreeError(`invalid --max-age ${text}; use a number with s, m, h, d, or w (for example 7d)`, 2)
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2]]
  return Number(match[1]) * unit
}

export function gcWorktrees({ pool = poolDir(), maxAge, dryRun = false, force = false }) {
  const report = { dryRun, maxAgeSecs: maxAge ?? null, removed: [], kept: [], held: [], fresh: 0 }
  const records = listRecords(pool)
  for (const record of records) {
    if (maxAge === undefined || maxAge === null) {
      report.fresh += 1
      continue
    }
    const age = now() - Math.max(record.lastAccessedAt ?? 0, record.createdAt ?? 0)
    if (age <= maxAge) {
      report.fresh += 1
      continue
    }
    if (!force && pidAlive(record.ownerPid) && record.ownerPid !== process.pid) {
      report.held.push({ id: record.id, reason: `process ${record.ownerPid} is still using it` })
      continue
    }
    const risk = workAtRisk(record)
    if (risk.length > 0) {
      report.kept.push({ id: record.id, reason: risk.join('; ') })
      continue
    }
    try {
      report.removed.push(removeWorktree({ pool, id: record.id, force: true, dryRun }))
    } catch (error) {
      report.kept.push({ id: record.id, reason: error.message })
    }
  }
  return report
}

/** Rebuild the registry from the pool: keep records whose directory exists, add untracked checkouts, drop the rest. */
export function rebuildRegistry({ pool = poolDir() }) {
  const result = { kept: 0, added: [], dropped: [] }
  for (const record of listRecords(pool)) {
    if (existsSync(record.path)) {
      result.kept += 1
    } else {
      dropRecord(pool, record.id)
      result.dropped.push(record.id)
    }
  }
  let repos = []
  try {
    repos = readdirSync(pool, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  } catch {}
  for (const repo of repos) {
    for (const entry of readdirSync(join(pool, repo.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(pool, repo.name, entry.name)
      if (!existsSync(join(path, '.git')) || recordForPath(pool, path)) continue
      const id = sanitizeLabel(entry.name)
      if (!id || readRecord(pool, id)) continue
      let root = null
      try {
        const common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
        root = realDir(dirname(common))
      } catch {}
      const head = git(path, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })?.trim() ?? null
      const branch = git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })?.trim() ?? null
      const info = statSync(path)
      writeRecord(pool, {
        id,
        label: entry.name,
        type: 'untracked',
        path,
        branch,
        repo: repo.name,
        sourceRoot: root,
        sourceCwd: root,
        ref: null,
        startCommit: head,
        baseCommit: head,
        copyMode: 'unknown',
        carried: [],
        createdAt: Math.floor(info.mtimeMs / 1000),
        lastAccessedAt: Math.floor(info.mtimeMs / 1000),
        sessionId: null,
        parentSessionId: null,
        ownerPid: null,
        applied: [],
        rebuilt: true,
      })
      result.added.push(id)
    }
  }
  return result
}

export function registryStats({ pool = poolDir() }) {
  const records = listRecords(pool)
  const byType = {}
  const byRepo = {}
  let missing = 0
  for (const record of records) {
    byType[record.type] = (byType[record.type] ?? 0) + 1
    byRepo[record.repo] = (byRepo[record.repo] ?? 0) + 1
    if (!existsSync(record.path)) missing += 1
  }
  return { path: registryDir(pool), total: records.length, missing, byType, byRepo }
}

function age(seconds) {
  const value = Math.max(0, now() - (seconds ?? now()))
  if (value < 60) return `${value}s ago`
  if (value < 3600) return `${Math.floor(value / 60)}m ago`
  if (value < 86400) return `${Math.floor(value / 3600)}h ago`
  return `${Math.floor(value / 86400)}d ago`
}

function applyText(result) {
  const lines = [`${result.dryRun ? 'Would apply' : 'Applied'} worktree ${result.id} (${result.mode}) to ${result.gitRoot}:`]
  for (const item of result.applied) lines.push(`  ${item.change.padEnd(8)} ${item.path}`)
  if (result.applied.length === 0) lines.push('  (no file written)')
  if (result.unchanged.length > 0) lines.push(`  ${result.unchanged.length} file(s) already match the checkout`)
  if (result.conflicts.length > 0) {
    lines.push(`Conflicts (left untouched in the checkout): ${result.conflicts.length}`)
    for (const item of result.conflicts) lines.push(`  conflict ${item.path}: ${item.reason}`)
    lines.push(`Resolve them in ${result.worktree} or the checkout, or rerun with --overwrite to take the worktree version.`)
  }
  return lines.join('\n')
}

export const HELP = `Manage git worktrees

Usage: codsh --rust worktree <COMMAND>

Commands:
  list             List tracked worktrees [aliases: ls]
  show             Show details for a specific worktree
  apply            Copy a worktree's changes into the checkout it came from
  rm               Remove worktrees
  gc               Remove expired worktrees, keeping any whose work would not survive [aliases: prune]
  detach           Convert a Grove-projected worktree into a plain git worktree (refused: none exist)
  salvage          Recover files when the source repo is gone (refused: none exist)
  clean-artifacts  Purge escape-dir artifact contents (refused: none exist)
  db               Registry maintenance (path, stats, rebuild)
  help             Print this message

list [--repo <REPO>] [--type session|subagent|untracked] [--json] [--all]
show <ID_OR_PATH> [--json]
apply <ID_OR_PATH> [--overwrite] [--dry-run] [--json]
rm <IDS>... [-f|--force] [--dry-run]
gc [--max-age <7d>] [--dry-run] [-f|--force]
db path | db stats | db rebuild

Worktrees live under $GROK_HOME/worktrees/<repo>/<label> on branch codsh/<label>.
apply merges by default: a file is written only when the checkout still holds
what the worktree started from; other files are conflicts and stay untouched.`

const GROVE_REFUSAL = 'this client creates only plain git worktrees (no Grove projection or escape directory), so there is nothing to'

function parseArgs(argv) {
  const flags = new Set()
  const values = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo' || arg === '--type' || arg === '--max-age' || arg === '--out' || arg === '--source' || arg === '--label' || arg === '--ref' || arg === '--session' || arg === '--pid' || arg === '--parent-session' || arg === '--grove') {
      if (index + 1 >= argv.length) throw new WorktreeError(`${arg} needs a value`, 2)
      values[arg.slice(2)] = argv[++index]
    } else if (arg.startsWith('-')) {
      flags.add(arg)
    } else {
      positional.push(arg)
    }
  }
  return { flags, values, positional }
}

function allowOnly(parsed, allowed) {
  for (const flag of parsed.flags) {
    if (!allowed.includes(flag)) throw new WorktreeError(`unexpected argument ${flag}; run codsh --rust worktree help`, 2)
  }
}

export function runCli(argv, out = text => process.stdout.write(`${text}\n`)) {
  const [command, ...rest] = argv
  const parsed = parseArgs(rest)
  const json = parsed.flags.has('--json')
  const emit = (value, text) => out(json ? JSON.stringify(value) : text)
  switch (command) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      out(HELP)
      return 0
    case 'list':
    case 'ls': {
      allowOnly(parsed, ['--json', '--all'])
      const result = listWorktrees({ repo: parsed.values.repo, type: parsed.values.type, all: parsed.flags.has('--all') })
      const rows = result.worktrees.map(item => `${item.id.padEnd(24)} ${item.type.padEnd(9)} ${age(item.lastAccessedAt).padEnd(9)} ${String(item.branch ?? '-').padEnd(30)} ${item.exists ? (item.dirty ? 'dirty' : 'clean') : 'missing'} ${item.changedFiles ?? '-'} changed  ${item.path}`)
      emit(result, rows.length === 0
        ? `No tracked worktrees in ${result.scope}.`
        : [`Worktrees in ${result.scope}:`, `${'ID'.padEnd(24)} ${'TYPE'.padEnd(9)} ${'AGE'.padEnd(9)} ${'BRANCH'.padEnd(30)} STATE`, ...rows].join('\n'))
      return 0
    }
    case 'show': {
      allowOnly(parsed, ['--json'])
      const record = describe(resolveRecord(poolDir(), parsed.positional[0]))
      const changed = record.exists ? changedPaths(record) : []
      emit({ ...record, changed }, [
        `Worktree ${record.id} (${record.type})`,
        `  path:     ${record.path}${record.exists ? '' : ' (missing)'}`,
        `  branch:   ${record.branch ?? '-'}`,
        `  source:   ${record.sourceRoot}`,
        `  strategy: plain git worktree${record.grove?.requested ? ` (Grove requested by ${record.grove.source}; this client has no Grove backend)` : ''}`,
        `  base:     ${String(record.baseCommit ?? '').slice(0, 12)}${record.ref ? ` (from ${record.ref})` : record.carried?.length ? ` (carried ${record.carried.length} uncommitted path(s))` : ''}`,
        `  session:  ${record.sessionId ?? '-'}${record.parentSessionId ? ` (delegated by ${record.parentSessionId})` : ''}`,
        `  created:  ${age(record.createdAt)} · last used ${age(record.lastAccessedAt)}`,
        `  state:    ${record.exists ? (record.dirty ? 'uncommitted changes' : 'clean') : 'missing'} · ${changed.length} changed file(s) since base`,
        ...changed.map(path => `    ${path}`),
        `  applied:  ${record.applied?.length ? record.applied.map(item => `${age(item.at)} ${item.files.length} file(s)${item.conflicts?.length ? `, ${item.conflicts.length} conflict(s)` : ''}`).join('; ') : 'never'}`,
      ].join('\n'))
      return 0
    }
    case 'apply': {
      allowOnly(parsed, ['--json', '--overwrite', '--dry-run'])
      if (parsed.positional.length !== 1) throw new WorktreeError('apply takes one worktree id or path', 2)
      const result = applyWorktree({ id: parsed.positional[0], mode: parsed.flags.has('--overwrite') ? 'overwrite' : 'merge', dryRun: parsed.flags.has('--dry-run') })
      emit(result, applyText(result))
      return result.status === 'conflicts' ? 5 : 0
    }
    case 'rm': {
      allowOnly(parsed, ['--json', '-f', '--force', '--dry-run'])
      if (parsed.positional.length === 0) throw new WorktreeError('rm takes at least one worktree id or path', 2)
      const results = []
      let code = 0
      for (const id of parsed.positional) {
        try {
          results.push(removeWorktree({ id, force: parsed.flags.has('-f') || parsed.flags.has('--force'), dryRun: parsed.flags.has('--dry-run') }))
        } catch (error) {
          results.push({ id, error: error.message })
          code = error.code ?? 1
        }
      }
      emit(results, results.map(item => item.error
        ? `not removed ${item.id}: ${item.error}`
        : `${item.dryRun ? 'would remove' : 'removed'} ${item.path}${item.branch ? (item.branch.deleted ? ` and branch ${item.branch.name}` : `; branch ${item.branch.name} kept at ${item.branch.tip.slice(0, 12)}`) : ''}`).join('\n'))
      return code
    }
    case 'gc':
    case 'prune': {
      allowOnly(parsed, ['--json', '-f', '--force', '--dry-run'])
      const maxAge = parsed.values['max-age'] === undefined ? undefined : parseAge(parsed.values['max-age'])
      const report = gcWorktrees({ maxAge, dryRun: parsed.flags.has('--dry-run'), force: parsed.flags.has('-f') || parsed.flags.has('--force') })
      emit(report, [
        maxAge === undefined ? 'No --max-age: nothing expires.' : `${report.dryRun ? 'Would remove' : 'Removed'} ${report.removed.length} worktree(s) idle longer than ${parsed.values['max-age']}.`,
        ...report.removed.map(item => `  ${report.dryRun ? 'would remove' : 'removed'} ${item.path}`),
        `Kept ${report.kept.length} with work that would not survive:`,
        ...report.kept.map(item => `  ${item.id}: ${item.reason}`),
        `Held back by a live process: ${report.held.length}`,
        ...report.held.map(item => `  ${item.id}: ${item.reason}`),
        `Not expired: ${report.fresh}`,
      ].join('\n'))
      return 0
    }
    case 'db': {
      const [sub] = parsed.positional
      allowOnly(parsed, ['--json'])
      if (sub === 'path') {
        out(registryDir(poolDir()))
        return 0
      }
      if (sub === 'stats') {
        const stats = registryStats({})
        emit(stats, [`Registry ${stats.path}`, `  worktrees: ${stats.total} (${stats.missing} missing on disk)`, ...Object.entries(stats.byType).map(([key, value]) => `  ${key}: ${value}`)].join('\n'))
        return 0
      }
      if (sub === 'rebuild') {
        const result = rebuildRegistry({})
        emit(result, `Rebuilt ${registryDir(poolDir())}: kept ${result.kept}, added ${result.added.length} untracked, dropped ${result.dropped.length} missing.`)
        return 0
      }
      out('Usage: codsh --rust worktree db <path|stats|rebuild>')
      return sub === undefined || sub === 'help' ? 0 : 2
    }
    case 'detach':
      throw new WorktreeError(`worktree detach: ${GROVE_REFUSAL} detach`, 2)
    case 'salvage':
      throw new WorktreeError(`worktree salvage: ${GROVE_REFUSAL} salvage; a plain worktree keeps its files on disk and its commits on the codsh/ branch`, 2)
    case 'clean-artifacts':
      throw new WorktreeError(`worktree clean-artifacts: ${GROVE_REFUSAL} clean`, 2)
    // Internal commands for the Rust client (machine output only).
    case 'create': {
      const record = createWorktree({
        source: parsed.values.source ?? process.cwd(),
        label: parsed.values.label,
        ref: parsed.values.ref,
        type: parsed.values.type,
        sessionId: parsed.values.session,
        ownerPid: parsed.values.pid ? Number(parsed.values.pid) : undefined,
        grove: parsed.values.grove ?? '',
      })
      out(JSON.stringify({ ok: true, ...record }))
      return 0
    }
    case 'attach': {
      const [id] = parsed.positional
      const fields = {}
      if (parsed.values.session) fields.sessionId = parsed.values.session
      if (parsed.values.pid) fields.ownerPid = Number(parsed.values.pid)
      if (parsed.values['parent-session']) fields.parentSessionId = parsed.values['parent-session']
      out(JSON.stringify({ ok: true, ...touchRecord(poolDir(), id, fields) }))
      return 0
    }
    case 'resolve': {
      const record = parsed.values.source ? recordForPath(poolDir(), parsed.values.source) : resolveRecord(poolDir(), parsed.positional[0])
      out(JSON.stringify(record ? { ok: true, ...describe(record) } : { ok: true, worktree: null }))
      return 0
    }
    default:
      throw new WorktreeError(`unknown worktree command ${command}; run codsh --rust worktree help`, 2)
  }
}

if (process.argv[1] && realDir(process.argv[1]) === realDir(fileURLToPath(import.meta.url))) {
  const machine = ['create', 'attach', 'resolve'].includes(process.argv[2])
  try {
    process.exitCode = runCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (machine || process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    else process.stderr.write(`codsh: ${message}\n`)
    process.exitCode = error?.code ?? 1
  }
}
