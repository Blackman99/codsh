import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { MARK } from '../packages/cli/bin/rust-acp-subagents.mjs'
import { evaluateForAgent, policyViews } from '../packages/cli/bin/rust-acp-file-approval.mjs'
import {
  applyWorktree,
  createWorktree,
  gcWorktrees,
  listWorktrees,
  parseAge,
  readRecord,
  rebuildRegistry,
  removeWorktree,
  repoSlug,
  sanitizeLabel,
  writeRecord,
} from '../packages/cli/bin/rust-worktree.mjs'

const require = createRequire(import.meta.url)
const HELPER = fileURLToPath(new URL('../packages/cli/bin/rust-worktree.mjs', import.meta.url))
const roots = []
const agents = []

afterEach(async () => {
  // Wait for dsh to exit before deleting its home, so a late session write
  // cannot race the removal.
  await Promise.all(agents.splice(0).map(agent => new Promise(resolve => {
    if (agent.child.exitCode !== null || agent.child.signalCode !== null) return resolve()
    const timer = setTimeout(() => { agent.child.kill('SIGKILL'); resolve() }, 5000)
    agent.child.once('exit', () => { clearTimeout(timer); resolve() })
    agent.child.stdin.end()
    agent.child.kill('SIGTERM')
  })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A temp root with a real git repo (two commits) and an empty pool. */
function fixture() {
  const root = realpathSync(mkdtempSync(join('/tmp', 'codsh-worktree-')))
  roots.push(root)
  const repo = join(root, 'src', 'demo')
  const pool = join(root, 'grok', 'worktrees')
  mkdirSync(join(repo, 'sub'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  writeFileSync(join(repo, 'sub', 'keep.txt'), 'keep\n')
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(join(repo, 'run.sh'), 0o755)
  writeFileSync(join(repo, '.gitignore'), 'target/\nlocal.env\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'one')
  writeFileSync(join(repo, 'second.txt'), 'second\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'two')
  return { root, repo, pool }
}

function status(repo) {
  return git(repo, 'status', '--porcelain=v1', '--untracked-files=all')
}

function helper(env, cwd, ...args) {
  return spawnSync(process.execPath, [HELPER, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' })
}

describe('rust-worktree labels', () => {
  it('sanitizes labels and derives the repo slug from the last two components', () => {
    expect(sanitizeLabel('My  Feature_Branch!')).toBe('my-feature-branch')
    expect(sanitizeLabel('---')).toBe('')
    expect(sanitizeLabel('x'.repeat(80))).toHaveLength(48)
    expect(repoSlug('/home/alice/code/My Repo')).toBe('code-my-repo')
    expect(repoSlug('/Users/bob/.hidden/app')).toBe('bob-app')
    expect(parseAge('7d')).toBe(604800)
    expect(() => parseAge('soon')).toThrow(/invalid --max-age/u)
  })
})

describe('rust-worktree create', () => {
  it('carries uncommitted and untracked changes into a new branch without touching the source', () => {
    const { repo, pool } = fixture()
    writeFileSync(join(repo, 'shared.txt'), 'dirty edit\n')
    git(repo, 'add', 'shared.txt')
    writeFileSync(join(repo, 'second.txt'), 'unstaged\n')
    writeFileSync(join(repo, 'new.txt'), 'untracked\n')
    writeFileSync(join(repo, 'local.env'), 'ignored secret\n')
    const before = status(repo)
    const headBefore = git(repo, 'rev-parse', 'HEAD')
    const record = createWorktree({ pool, source: join(repo, 'sub'), label: 'Fix Bug' })
    expect(record).toMatchObject({ id: 'fix-bug', branch: 'codsh/fix-bug', copyMode: 'dirty', type: 'session', sourceRoot: repo })
    expect(record.path).toBe(join(pool, 'src-demo', 'fix-bug'))
    expect(record.sessionCwd).toBe(join(record.path, 'sub'))
    expect(readFileSync(join(record.path, 'shared.txt'), 'utf8')).toBe('dirty edit\n')
    expect(readFileSync(join(record.path, 'second.txt'), 'utf8')).toBe('unstaged\n')
    expect(readFileSync(join(record.path, 'new.txt'), 'utf8')).toBe('untracked\n')
    expect(existsSync(join(record.path, 'local.env'))).toBe(false)
    expect(record.carried).toEqual(['new.txt', 'second.txt', 'shared.txt'])
    // The snapshot is a commit on the new branch; the worktree starts clean.
    expect(status(record.path)).toBe('')
    expect(git(record.path, 'log', '-1', '--format=%s')).toMatch(/^codsh: carry uncommitted changes/u)
    // Source: same status, same HEAD, same branch, index untouched.
    expect(status(repo)).toBe(before)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main')
    expect(readRecord(pool, 'fix-bug')).toMatchObject({ path: record.path })
  })

  it('checks out a named ref clean and never reuses an existing branch or directory', () => {
    const { repo, pool } = fixture()
    writeFileSync(join(repo, 'shared.txt'), 'dirty\n')
    git(repo, 'branch', 'codsh/taken', 'HEAD~1')
    const tipBefore = git(repo, 'rev-parse', 'codsh/taken')
    const record = createWorktree({ pool, source: repo, label: 'taken', ref: 'HEAD~1' })
    expect(record.id).toBe('taken-2')
    expect(record.copyMode).toBe('clean')
    expect(readFileSync(join(record.path, 'shared.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(join(record.path, 'second.txt'))).toBe(false)
    expect(git(repo, 'rev-parse', 'codsh/taken')).toBe(tipBefore)
    mkdirSync(join(pool, 'src-demo', 'occupied'), { recursive: true })
    writeFileSync(join(pool, 'src-demo', 'occupied', 'mine.txt'), 'user file\n')
    const next = createWorktree({ pool, source: repo, label: 'occupied' })
    expect(next.id).toBe('occupied-2')
    expect(readFileSync(join(pool, 'src-demo', 'occupied', 'mine.txt'), 'utf8')).toBe('user file\n')
  })

  it('refuses a non-git directory, an unborn repo, and a bad ref without leaving anything behind', () => {
    const { root, repo, pool } = fixture()
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(() => createWorktree({ pool, source: plain })).toThrow(/not inside a git repository/u)
    const unborn = join(root, 'unborn')
    mkdirSync(unborn)
    git(unborn, 'init', '-q')
    expect(() => createWorktree({ pool, source: unborn })).toThrow(/no commit yet/u)
    expect(() => createWorktree({ pool, source: repo, label: 'bad', ref: 'no-such-ref' })).toThrow(/does not name a commit/u)
    expect(git(repo, 'branch', '--list', 'codsh/*')).toBe('')
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1)
    expect(existsSync(join(pool, '.registry')) ? readdirSync(join(pool, '.registry')) : []).toEqual([])
  })

  it('refuses a pool inside the repository', () => {
    const { repo } = fixture()
    expect(() => createWorktree({ pool: join(repo, '.grok', 'worktrees'), source: repo })).toThrow(/inside the repository/u)
  })
})

describe('rust-worktree apply', () => {
  it('merges changed, added, deleted, executable, and binary files into an unchanged checkout', () => {
    const { repo, pool } = fixture()
    const record = createWorktree({ pool, source: repo, label: 'apply' })
    writeFileSync(join(record.path, 'shared.txt'), 'from worktree\n')
    mkdirSync(join(record.path, 'deep', 'dir'), { recursive: true })
    writeFileSync(join(record.path, 'deep', 'dir', 'added.bin'), Buffer.from([0, 1, 2, 255]))
    rmSync(join(record.path, 'second.txt'))
    writeFileSync(join(record.path, 'tool.sh'), '#!/bin/sh\n')
    chmodSync(join(record.path, 'tool.sh'), 0o755)
    const dry = applyWorktree({ pool, id: 'apply', dryRun: true })
    expect(dry.status).toBe('success')
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('base\n')
    const result = applyWorktree({ pool, id: record.path })
    expect(result.status).toBe('success')
    expect(result.applied.map(item => `${item.change}:${item.path}`).sort()).toEqual([
      'added:deep/dir/added.bin', 'added:tool.sh', 'deleted:second.txt', 'modified:shared.txt',
    ])
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('from worktree\n')
    expect([...readFileSync(join(repo, 'deep', 'dir', 'added.bin'))]).toEqual([0, 1, 2, 255])
    expect(existsSync(join(repo, 'second.txt'))).toBe(false)
    expect(statSync(join(repo, 'tool.sh')).mode & 0o111).not.toBe(0)
    // Applying writes files only; the checkout's index and HEAD stay.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('')
    expect(readRecord(pool, 'apply').applied).toHaveLength(1)
    // A second apply finds everything already in place.
    const again = applyWorktree({ pool, id: 'apply' })
    expect(again.applied).toEqual([])
    expect(again.unchanged.length).toBeGreaterThan(0)
  })

  it('reports conflicts and leaves the user checkout untouched unless --overwrite', () => {
    const { repo, pool } = fixture()
    const record = createWorktree({ pool, source: repo, label: 'conflict' })
    writeFileSync(join(record.path, 'shared.txt'), 'theirs\n')
    writeFileSync(join(record.path, 'second.txt'), 'theirs second\n')
    writeFileSync(join(record.path, 'fresh.txt'), 'theirs fresh\n')
    rmSync(join(record.path, 'sub', 'keep.txt'))
    // The user keeps working in the checkout meanwhile.
    writeFileSync(join(repo, 'shared.txt'), 'ours\n')
    writeFileSync(join(repo, 'fresh.txt'), 'ours fresh\n')
    writeFileSync(join(repo, 'sub', 'keep.txt'), 'ours keep\n')
    const result = applyWorktree({ pool, id: 'conflict' })
    expect(result.status).toBe('conflicts')
    expect(result.conflicts.map(item => item.path).sort()).toEqual(['fresh.txt', 'shared.txt', 'sub/keep.txt'])
    expect(result.applied.map(item => item.path)).toEqual(['second.txt'])
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('ours\n')
    expect(readFileSync(join(repo, 'fresh.txt'), 'utf8')).toBe('ours fresh\n')
    expect(readFileSync(join(repo, 'sub', 'keep.txt'), 'utf8')).toBe('ours keep\n')
    expect(readFileSync(join(repo, 'second.txt'), 'utf8')).toBe('theirs second\n')
    const cli = helper({ CODSH_WORKTREE_HOME: pool }, repo, 'apply', 'conflict')
    expect(cli.status).toBe(5)
    expect(cli.stdout).toContain('conflict shared.txt: changed in the checkout since the worktree was created')
    const forced = applyWorktree({ pool, id: 'conflict', mode: 'overwrite' })
    expect(forced.status).toBe('success')
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('theirs\n')
    expect(existsSync(join(repo, 'sub', 'keep.txt'))).toBe(false)
  })

  it('merges against the carried snapshot, so carried edits are not conflicts', () => {
    const { repo, pool } = fixture()
    writeFileSync(join(repo, 'shared.txt'), 'wip\n')
    const record = createWorktree({ pool, source: repo, label: 'wip' })
    writeFileSync(join(record.path, 'shared.txt'), 'wip done\n')
    const result = applyWorktree({ pool, id: 'wip' })
    expect(result.status).toBe('success')
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('wip done\n')
  })

  it('refuses symlinks and writes through a symlinked checkout directory', () => {
    const { root, repo, pool } = fixture()
    const record = createWorktree({ pool, source: repo, label: 'links' })
    symlinkSync('/etc/passwd', join(record.path, 'link'))
    mkdirSync(join(record.path, 'out'))
    writeFileSync(join(record.path, 'out', 'x.txt'), 'x\n')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(repo, 'out'))
    const result = applyWorktree({ pool, id: 'links' })
    expect(result.status).toBe('conflicts')
    expect(Object.fromEntries(result.conflicts.map(item => [item.path, item.reason]))).toMatchObject({
      link: 'symlink in the worktree is not applied',
      'out/x.txt': 'a parent directory in the checkout is a symlink or not a directory',
    })
    expect(existsSync(join(repo, 'link'))).toBe(false)
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('rust-worktree list, rm, gc, db', () => {
  it('lists the current repository by default and everything with --all', () => {
    const { root, repo, pool } = fixture()
    const other = join(root, 'src', 'other')
    mkdirSync(other, { recursive: true })
    git(other, 'init', '-q')
    git(other, 'commit', '-q', '--allow-empty', '-m', 'x')
    createWorktree({ pool, source: repo, label: 'mine' })
    createWorktree({ pool, source: other, label: 'theirs', type: 'subagent' })
    expect(listWorktrees({ pool, cwd: repo }).worktrees.map(item => item.id)).toEqual(['mine'])
    expect(listWorktrees({ pool, all: true }).worktrees.map(item => item.id)).toEqual(['mine', 'theirs'])
    expect(listWorktrees({ pool, all: true, type: 'subagent' }).worktrees.map(item => item.id)).toEqual(['theirs'])
    const cli = helper({ CODSH_WORKTREE_HOME: pool }, repo, 'list', '--json')
    expect(JSON.parse(cli.stdout).worktrees).toHaveLength(1)
    const inside = helper({ CODSH_WORKTREE_HOME: pool }, join(pool, 'src-demo', 'mine'), 'list')
    expect(inside.stdout).toContain('mine')
    expect(inside.stdout).not.toContain('theirs')
  })

  it('refuses to remove a worktree with work unless forced, and keeps branches that hold commits', () => {
    const { repo, pool } = fixture()
    const record = createWorktree({ pool, source: repo, label: 'rm-me' })
    writeFileSync(join(record.path, 'draft.txt'), 'unsaved\n')
    expect(() => removeWorktree({ pool, id: 'rm-me' })).toThrow(/still holds work/u)
    expect(existsSync(join(record.path, 'draft.txt'))).toBe(true)
    const dry = removeWorktree({ pool, id: 'rm-me', force: true, dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(existsSync(record.path)).toBe(true)
    removeWorktree({ pool, id: 'rm-me', force: true })
    expect(existsSync(record.path)).toBe(false)
    expect(git(repo, 'branch', '--list', 'codsh/rm-me')).toBe('')
    const kept = createWorktree({ pool, source: repo, label: 'kept' })
    writeFileSync(join(kept.path, 'done.txt'), 'x\n')
    git(kept.path, 'add', '.')
    git(kept.path, 'commit', '-q', '-m', 'work')
    const removed = removeWorktree({ pool, id: 'kept' })
    expect(removed.branch).toMatchObject({ name: 'codsh/kept', deleted: false })
    expect(git(repo, 'log', '-1', '--format=%s', 'codsh/kept').trim()).toBe('work')
    expect(() => removeWorktree({ pool, id: repo })).toThrow(/no tracked worktree/u)
  })

  it('gc expires nothing without --max-age and keeps worktrees whose work would not survive', () => {
    const { repo, pool } = fixture()
    const clean = createWorktree({ pool, source: repo, label: 'clean' })
    const dirty = createWorktree({ pool, source: repo, label: 'dirty' })
    writeFileSync(join(dirty.path, 'wip.txt'), 'x\n')
    const cache = createWorktree({ pool, source: repo, label: 'cache' })
    mkdirSync(join(cache.path, 'target'))
    writeFileSync(join(cache.path, 'target', 'out.o'), 'x')
    const orphan = createWorktree({ pool, source: repo, label: 'orphan' })
    writeFileSync(join(orphan.path, 'o.txt'), 'x\n')
    git(orphan.path, 'add', '.')
    git(orphan.path, 'commit', '-q', '-m', 'orphan')
    git(orphan.path, 'checkout', '-q', '--detach')
    git(repo, 'branch', '-D', 'codsh/orphan')
    const live = createWorktree({ pool, source: repo, label: 'live', ownerPid: process.ppid })
    const old = Math.floor(Date.now() / 1000) - 30 * 86400
    for (const id of ['clean', 'dirty', 'cache', 'orphan', 'live']) writeRecord(pool, { ...readRecord(pool, id), createdAt: old, lastAccessedAt: old })
    expect(gcWorktrees({ pool }).removed).toEqual([])
    const dry = gcWorktrees({ pool, maxAge: parseAge('7d'), dryRun: true })
    expect(dry.removed.map(item => item.id).sort()).toEqual(['cache', 'clean'])
    expect(existsSync(clean.path)).toBe(true)
    const report = gcWorktrees({ pool, maxAge: parseAge('7d') })
    expect(report.removed.map(item => item.id).sort()).toEqual(['cache', 'clean'])
    expect(Object.fromEntries(report.kept.map(item => [item.id, item.reason]))).toMatchObject({
      dirty: expect.stringContaining('uncommitted or untracked'),
      orphan: expect.stringContaining('held by no branch or tag'),
    })
    expect(report.held.map(item => item.id)).toEqual(['live'])
    expect(existsSync(clean.path)).toBe(false)
    expect(existsSync(dirty.path)).toBe(true)
    expect(existsSync(live.path)).toBe(true)
  })

  it('db rebuild adds untracked checkouts in the pool and drops missing records', () => {
    const { repo, pool } = fixture()
    const gone = createWorktree({ pool, source: repo, label: 'gone' })
    rmSync(gone.path, { recursive: true, force: true })
    git(repo, 'worktree', 'add', '-q', '-b', 'manual', join(pool, 'src-demo', 'manual'))
    const result = rebuildRegistry({ pool })
    expect(result).toMatchObject({ dropped: ['gone'], added: ['manual'] })
    expect(readRecord(pool, 'manual')).toMatchObject({ type: 'untracked', sourceRoot: repo, branch: 'manual' })
    const stats = JSON.parse(helper({ CODSH_WORKTREE_HOME: pool }, repo, 'db', 'stats', '--json').stdout)
    expect(stats).toMatchObject({ total: 1, byType: { untracked: 1 } })
  })

  it('refuses Grove-only commands and unknown flags', () => {
    const { repo, pool } = fixture()
    for (const command of ['detach', 'salvage', 'clean-artifacts']) {
      const result = helper({ CODSH_WORKTREE_HOME: pool }, repo, command, 'x')
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('plain git worktrees')
    }
    expect(helper({ CODSH_WORKTREE_HOME: pool }, repo, 'rm', '--bogus', 'x').stderr).toContain('unexpected argument --bogus')
  })
})

describe('rust-worktree permissions', () => {
  it('checks a worktree path under the worktree and under the checkout it maps to', () => {
    const { repo, pool } = fixture()
    const record = createWorktree({ pool, source: repo, label: 'perm' })
    const policy = { cwd: repo, mode: 'always-approve', rules: [{ action: 'deny', tool: 'edit', pattern: `${repo}/secret.txt`, patternMode: 'glob' }] }
    expect(policyViews(policy, repo, pool)).toHaveLength(1)
    const views = policyViews(policy, record.path, pool)
    expect(views).toHaveLength(2)
    expect(views[1].map(join(record.path, 'sub', 'a.txt'))).toBe(join(repo, 'sub', 'a.txt'))
    expect(views[1].map('secret.txt')).toBe(join(repo, 'secret.txt'))
    expect(evaluateForAgent(policy, { kind: 'edit', path: 'secret.txt' }, undefined, record.path, pool).kind).toBe('deny')
    expect(evaluateForAgent(policy, { kind: 'edit', path: 'other.txt' }, undefined, record.path, pool).kind).toBe('allow')
    // A file about to be created in a missing directory, reached through a
    // symlinked path to the worktree, maps to the checkout path too.
    const deep = { ...policy, rules: [{ action: 'deny', tool: 'edit', pattern: `${repo}/new/dir/secret.txt`, patternMode: 'glob' }] }
    const alias = join(dirname(pool), 'alias')
    symlinkSync(record.path, alias)
    expect(evaluateForAgent(deep, { kind: 'edit', path: join(alias, 'new', 'dir', 'secret.txt') }, undefined, record.path, pool).kind).toBe('deny')
    expect(evaluateForAgent(deep, { kind: 'edit', path: 'new/dir/secret.txt' }, undefined, alias, pool).kind).toBe('deny')
    // Outside any worktree the policy is evaluated exactly as before (policy cwd).
    expect(policyViews(policy, '/tmp', pool)).toEqual([expect.objectContaining({ policy })])
    expect(evaluateForAgent(policy, { kind: 'edit', path: 'other.txt' }, undefined, '/tmp', pool).kind).toBe('allow')
  })
})

// ---- subagent isolation through a real dsh process ----

const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
function dshPath() {
  const manifest = JSON.parse(readFileSync(dshManifest, 'utf8'))
  return join(dirname(dshManifest), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh)
}

function startAgent({ permission = { mode: 'always-approve' }, control = false } = {}) {
  const { root, repo, pool } = fixture()
  const home = join(root, 'home')
  mkdirSync(home)
  const controlDir = join(root, 'control')
  if (control) mkdirSync(controlDir, { mode: 0o700 })
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const permissionPath = join(root, 'permission-policy.json')
  writeFileSync(permissionPath, JSON.stringify({ cwd: repo, ...permission }))
  const child = spawn(process.execPath, [dshPath(), '--profile', 'acp', '--patch', overlay], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      DSH_CODE_CLI_MOCK_TOOL: 'subagents',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      CODSH_WORKTREE_HOME: pool,
      ...control ? { CODSH_SUBAGENT_CONTROL: controlDir } : {},
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  const events = []
  const stderr = []
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.method === 'session/request_permission') {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } })}\n`)
    }
    if (msg.id != null && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
    }
  })
  createInterface({ input: child.stderr }).on('line', line => {
    stderr.push(line)
    if (line.startsWith(MARK)) events.push(JSON.parse(line.slice(MARK.length)))
  })
  let nextId = 1
  const send = (method, params, timeout = 60000) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.join('\n')}`)), timeout)
    })
  }
  const cancelChild = id => {
    const path = join(controlDir, `${Date.now()}.json`)
    writeFileSync(`${path}.tmp`, JSON.stringify({ action: 'cancel', id }))
    renameSync(`${path}.tmp`, path)
  }
  const agent = { root, repo, pool, home, child, send, updates, events, stderr, cancelChild }
  agents.push(agent)
  return agent
}

async function waitForEvent(agent, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = agent.events.find(predicate)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timeout waiting for a subagent event: ${agent.stderr.join('\n')}`)
}

async function runPrompt(agent, text) {
  await agent.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-worktree-test', version: '0' } })
  const { sessionId } = await agent.send('session/new', { cwd: agent.repo, mcpServers: [] })
  await agent.send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  return {
    sessionId,
    answer: agent.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk').map(update => update.update.content.text).join(''),
  }
}

describe('subagent worktree isolation (real dsh)', () => {
  it('runs the child in its own worktree and keeps its edit out of the checkout until applied', async () => {
    const agent = startAgent()
    writeFileSync(join(agent.repo, 'wip.txt'), 'user wip\n')
    const before = status(agent.repo)
    const { sessionId, answer } = await runPrompt(agent, 'SPAWN:general-purpose:EDIT:wt SPAWN:general-purpose:PWD:wt')
    expect(answer).toContain('[0:ok] CHILD_EDIT_DONE ok')
    expect(answer).toContain('Worktree isolation: the subagent\'s changes stay in')
    expect(answer).toContain('/worktree apply')
    // The checkout is exactly as the user left it.
    expect(status(agent.repo)).toBe(before)
    expect(readFileSync(join(agent.repo, 'shared.txt'), 'utf8')).toBe('base\n')
    const records = listWorktrees({ pool: agent.pool, all: true }).worktrees
    expect(records).toHaveLength(1)
    const [kept] = records
    expect(kept).toMatchObject({ type: 'subagent', parentSessionId: sessionId, sourceRoot: agent.repo })
    expect(readFileSync(join(kept.path, 'shared.txt'), 'utf8')).toBe('CHILD_EDIT_CONTENT\n')
    expect(readFileSync(join(kept.path, 'wip.txt'), 'utf8')).toBe('user wip\n')
    // The PWD child ran in its own worktree, changed nothing, and it was removed.
    expect(answer).toMatch(/\[1:ok\] CHILD_PWD_DONE ok:\S*\/src-demo\/general-purpose-pwd-prob/u)
    expect(answer).toContain('The subagent changed no file; its worktree')
    const pwdEnd = agent.events.filter(event => event.event === 'end')[1]
    expect(pwdEnd).toMatchObject({ isolation: 'worktree', worktreeKept: false, changedFiles: 0 })
    const editEnd = agent.events.find(event => event.event === 'end')
    expect(editEnd).toMatchObject({ worktree: kept.path, branch: kept.branch, worktreeKept: true, changedFiles: 1 })
    // Explicit apply lands the edit.
    expect(applyWorktree({ pool: agent.pool, id: kept.id }).status).toBe('success')
    expect(readFileSync(join(agent.repo, 'shared.txt'), 'utf8')).toBe('CHILD_EDIT_CONTENT\n')
  }, 90000)

  it('applies checkout deny rules to the worktree copy of the path', async () => {
    const agent = startAgent({ permission: { mode: 'always-approve', rules: [] } })
    writeFileSync(join(agent.root, 'permission-policy.json'), JSON.stringify({
      cwd: agent.repo,
      mode: 'always-approve',
      rules: [{ action: 'deny', tool: 'edit', pattern: `${agent.repo}/secret.txt`, patternMode: 'glob' }],
    }))
    const { answer } = await runPrompt(agent, 'SPAWN:general-purpose:SECRET:wt')
    expect(answer).toContain('CHILD_SECRET_DONE error')
    expect(answer).toContain('Denied by permission policy')
    expect(listWorktrees({ pool: agent.pool, all: true }).worktrees).toEqual([])
  }, 90000)

  it('removes an unchanged worktree when the isolated child is cancelled, and keeps the checkout', async () => {
    const agent = startAgent({ control: true })
    writeFileSync(join(agent.repo, 'shared.txt'), 'user edit\n')
    const before = status(agent.repo)
    const running = runPrompt(agent, 'SPAWN:general-purpose:SLOW:wt')
    const start = await waitForEvent(agent, event => event.event === 'start')
    expect(existsSync(start.worktree)).toBe(true)
    agent.cancelChild(start.id)
    const { answer } = await running
    expect(answer).toContain('[0:error]')
    expect(answer).toContain('cancelled by the user')
    expect(answer).toContain('The subagent changed no file; its worktree')
    expect(agent.events.find(event => event.event === 'end')).toMatchObject({ status: 'cancelled', worktreeKept: false })
    expect(existsSync(start.worktree)).toBe(false)
    expect(listWorktrees({ pool: agent.pool, all: true }).worktrees).toEqual([])
    expect(git(agent.repo, 'branch', '--list', 'codsh/*')).toBe('')
    expect(status(agent.repo)).toBe(before)
    expect(readFileSync(join(agent.repo, 'shared.txt'), 'utf8')).toBe('user edit\n')
  }, 90000)

  it('refuses isolation outside a git repository and starts no child', async () => {
    const agent = startAgent()
    rmSync(join(agent.repo, '.git'), { recursive: true, force: true })
    const { answer } = await runPrompt(agent, 'SPAWN:general-purpose:EDIT:wt')
    expect(answer).toContain('[0:error]')
    expect(answer).toContain('worktree isolation failed, so the subagent did not start')
    expect(existsSync(join(agent.repo, 'shared.txt')) && readFileSync(join(agent.repo, 'shared.txt'), 'utf8')).toBe('base\n')
    expect(agent.events.some(event => event.event === 'start')).toBe(false)
  }, 90000)
})
