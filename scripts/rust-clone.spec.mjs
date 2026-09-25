// `codsh --rust clone` and the Grove gates (ticket 191) with real git.
//
// Clone sources are local bare repositories reached over file://, a loopback
// smart-HTTP server (git http-backend behind Basic auth), and an unprivileged
// OpenSSH server on 127.0.0.1. `--remote` clones run the real client on the
// "remote" account through that sshd, and real dsh (keyless mock LLM) edits a
// file in the fresh clone. Nothing here uses a paid service or a real remote.
//
// OpenSSH: CODSH_TEST_OPENSSH=<prefix> or ssh/sshd on PATH; without it the
// SSH cases are skipped with that reason.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { findOpenssh, git, makeBareRepo, startGitHttp, startSshd, until } from './rust-clone-fixtures.mjs'

const require = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const binary = join(repo, 'rust/target/debug/codsh-rust')
const openssh = findOpenssh()
if (!openssh) console.warn('rust-clone.spec: SSH cases skipped: no OpenSSH ssh/sshd/ssh-keygen (set CODSH_TEST_OPENSSH=<prefix>)')

function dshPath() {
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin
  return join(dirname(manifest), typeof bin === 'string' ? bin : bin.dsh)
}

let root
let bare
let http
let sshd
const remotes = []

beforeAll(async () => {
  root = mkdtempSync(join('/tmp', 'codsh-clone-'))
  const sources = join(root, 'sources')
  mkdirSync(sources)
  bare = makeBareRepo(sources)
  http = await startGitHttp(sources, { token: 'fixture-token-191' })
  if (openssh) sshd = await startSshd(openssh, join(root, 'ssh'))
}, 60000)

afterAll(async () => {
  for (const remote of remotes) spawnSync(binary, ['leader', 'kill'], { env: remote.env, encoding: 'utf8', timeout: 30000 })
  await http?.close()
  sshd?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

/** A user account: isolated HOME/GROK_HOME, a working directory, clone on. */
function account(name, extra = {}) {
  const home = join(root, name)
  const cwd = join(home, 'work')
  mkdirSync(join(home, 'dsh'), { recursive: true })
  mkdirSync(join(home, '.grok'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const overlay = join(home, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const env = {
    PATH: process.env.PATH, HOME: home, DSH_HOME: join(home, 'dsh'), GROK_HOME: join(home, '.grok'),
    XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1',
    DSH_BIN: dshPath(), CODSH_NODE: process.execPath, CODSH_ACP_PATCH: overlay,
    DSH_CODE_CLI_MOCK_TOOL: 'file-edit', DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'OFF',
    CODSH_UPDATE_CHECK: 'off', GROK_CLONE: '1', ...extra,
  }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  return { name, home, cwd, env }
}

function run(who, args, { env = {}, cwd = who.cwd, timeout = 60000 } = {}) {
  const merged = { ...who.env, ...env }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  return spawnSync(binary, args, { cwd, env: merged, encoding: 'utf8', timeout })
}

// The fixture HTTP server lives in this process, so a clone that talks to it must not block the event loop.
function runAsync(who, args, { env = {}, cwd = who.cwd, timeout = 60000 } = {}) {
  const merged = { ...who.env, ...env }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  return new Promise(done => {
    const child = spawn(binary, args, { cwd, env: merged, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('close', status => { clearTimeout(timer); done({ status, stdout, stderr }) })
  })
}

// Remote-tracking branches, without the origin/HEAD symref that newer git records.
const branches = dir => git(dir, ['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes'])
  .split('\n').filter(line => line && !line.trim().includes(' ')).map(line => line.trim()).join('\n')

const fileUrl = () => `file://${bare}`
const partials = dir => readdirSync(dir).filter(name => name.includes('.codsh-clone-'))

describe('codsh --rust clone with git', () => {
  it('is off until a reference gate turns it on, and refuses what it cannot honour', () => {
    expect(existsSync(binary), 'cargo build -p codsh-rust first').toBe(true)
    const me = account('gate', { GROK_CLONE: undefined })
    const off = run(me, ['clone', fileUrl(), 'a'])
    expect(off.status).toBe(2)
    expect(off.stderr).toContain('codsh --rust clone is off (no gate is set)')
    expect(off.stderr).toContain('no Grove daemon or mount')
    expect(existsSync(join(me.cwd, 'a'))).toBe(false)
    // The specific knob wins over enable-all; the worktree knob does not enable clone.
    expect(run(me, ['clone', fileUrl(), 'a'], { env: { GROK_CLONE: '0', GROK_GROVE: '1' } }).stderr).toContain('env GROK_CLONE is off')
    expect(run(me, ['clone', fileUrl(), 'a'], { env: { GROK_WORKTREE_TYPE: 'grove' } }).status).toBe(2)
    expect(run(me, ['clone', fileUrl(), 'b'], { env: { GROVE_CLONE: '1' } }).status).toBe(0)
    writeFileSync(join(me.home, '.grok', 'config.toml'), '[cli]\ngrove = true\n')
    expect(run(me, ['clone', fileUrl(), 'c']).status).toBe(0)
    writeFileSync(join(me.home, '.grok', 'config.toml'), '')
    mkdirSync(join(me.home, '.config', 'grove'), { recursive: true })
    writeFileSync(join(me.home, '.config', 'grove', 'config.toml'), '[clone]\nenabled = true\n')
    const grove = run(me, ['clone', '--debug', fileUrl(), 'd'])
    expect(grove.status, grove.stderr).toBe(0)
    expect(grove.stderr).toContain('gate: on (grove config [clone] enabled)')

    const help = run(me, ['clone', '--help'])
    for (const flag of ['--branch', '--cone', '--full-history', '--remote', '--debug-file']) expect(help.stdout).toContain(flag)
    const socket = run(me, ['clone', '--leader-socket', '/tmp/x.sock', fileUrl()])
    expect(socket.status).toBe(2)
    expect(socket.stderr).toContain('no Grove daemon or leader')
    const password = run(me, ['clone', 'https://user:hunter2@127.0.0.1/repo.git', 'p'])
    expect(password.status).toBe(2)
    expect(password.stderr).toContain('carries a password')
    expect(run(me, ['clone', 'ext::sh -c touch% /tmp/pwn', 'x']).status).toBe(2)
    expect(existsSync('/tmp/pwn')).toBe(false)
  }, 60000)

  it('bootstraps depth 1 of one branch, and full history, branches, and cones on request', () => {
    const me = account('depth')
    const quick = run(me, ['clone', fileUrl()])
    expect(quick.status, quick.stderr).toBe(0)
    const dir = join(me.cwd, 'repo')
    expect(quick.stdout).toContain(`Cloned ${fileUrl()} into ${dir}`)
    expect(quick.stdout).toContain('history:     depth 1 (shallow')
    expect(quick.stdout).toContain('blobs:       fetched on demand (partial clone, filter blob:none)')
    expect(quick.stdout).toContain(`Next: cd ${dir} && codsh --rust`)
    expect(git(dir, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    expect(git(dir, ['rev-list', '--count', 'HEAD'])).toBe('1')
    expect(branches(dir)).toBe('refs/remotes/origin/main')
    expect(git(dir, ['tag', '--list'])).toBe('')
    expect(git(dir, ['config', 'remote.origin.promisor'])).toBe('true')
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('alpha\n')
    // Deepening affects only the selected branch, as the reference documents.
    git(dir, ['fetch', '-q', '--deepen=1', 'origin'])
    expect(git(dir, ['rev-list', '--count', 'HEAD'])).toBe('2')
    expect(branches(dir)).toBe('refs/remotes/origin/main')

    const full = run(me, ['clone', '--full-history', '-b', 'dev', fileUrl(), 'full'])
    expect(full.status, full.stderr).toBe(0)
    const fullDir = join(me.cwd, 'full')
    expect(full.stdout).toMatch(/history: +full \(3 commits, 2 remote branch\(es\), 1 tag\(s\)\)/)
    expect(git(fullDir, ['rev-parse', '--is-shallow-repository'])).toBe('false')
    expect(git(fullDir, ['symbolic-ref', '--short', 'HEAD'])).toBe('dev')
    expect(git(fullDir, ['tag', '--list'])).toBe('v1')

    const sparse = run(me, ['clone', '--cone', 'app', fileUrl(), 'sparse'])
    expect(sparse.status, sparse.stderr).toBe(0)
    expect(sparse.stdout).toContain('sparse cones: app')
    const sparseDir = join(me.cwd, 'sparse')
    expect(existsSync(join(sparseDir, 'app', 'main.txt'))).toBe(true)
    expect(existsSync(join(sparseDir, 'note.txt'))).toBe(true)
    expect(existsSync(join(sparseDir, 'docs'))).toBe(false)

    // A local path makes git ignore depth and filter; the report says so.
    const local = run(me, ['clone', bare, 'local'])
    expect(local.status, local.stderr).toBe(0)
    expect(local.stdout).toContain('git does not shorten history for this source')
    expect(local.stdout).toContain('blobs:       all fetched')
  }, 60000)

  it('never writes an existing directory, reports a finished clone again, and leaves nothing after a failure', () => {
    const me = account('conflict')
    mkdirSync(join(me.cwd, 'busy'))
    writeFileSync(join(me.cwd, 'busy', 'mine.txt'), 'keep\n')
    const busy = run(me, ['clone', fileUrl(), 'busy'])
    expect(busy.status).toBe(3)
    expect(busy.stderr).toContain('already exists and is not empty; nothing was changed')
    expect(readdirSync(join(me.cwd, 'busy'))).toEqual(['mine.txt'])
    writeFileSync(join(me.cwd, 'file'), 'x')
    expect(run(me, ['clone', fileUrl(), 'file']).status).toBe(3)
    symlinkSync(join(me.cwd, 'busy'), join(me.cwd, 'link'))
    expect(run(me, ['clone', fileUrl(), 'link']).stderr).toContain('is a symbolic link')
    mkdirSync(join(me.cwd, 'empty'))
    expect(run(me, ['clone', fileUrl(), 'empty']).status).toBe(0)
    expect(readFileSync(join(me.cwd, 'empty', 'note.txt'), 'utf8')).toBe('alpha\n')

    // Rerun (a reconnect after a lost report): reported, nothing fetched or changed.
    writeFileSync(join(me.cwd, 'empty', 'note.txt'), 'edited\n')
    const head = git(join(me.cwd, 'empty'), ['rev-parse', 'HEAD'])
    const again = run(me, ['clone', fileUrl(), 'empty'])
    expect(again.status, again.stderr).toBe(0)
    expect(again.stdout).toContain('is already a clone of')
    expect(again.stdout).toContain('nothing was fetched or changed')
    expect(readFileSync(join(me.cwd, 'empty', 'note.txt'), 'utf8')).toBe('edited\n')
    expect(git(join(me.cwd, 'empty'), ['rev-parse', 'HEAD'])).toBe(head)
    expect(run(me, ['clone', '-b', 'dev', fileUrl(), 'empty']).status).toBe(3)

    const branch = run(me, ['clone', '-b', 'nope', fileUrl(), 'nob'])
    expect(branch.status).toBe(1)
    expect(branch.stderr).toContain('Branch or ref nope was not found on the remote.')
    expect(existsSync(join(me.cwd, 'nob'))).toBe(false)
    const missing = run(me, ['clone', `file://${root}/sources/missing.git`, 'gone'])
    expect(missing.status).toBe(1)
    const failure = missing.stderr.split('\n').slice(1).join('\n')
    expect(failure).toContain('Repository not found.')
    expect(failure).not.toContain('missing.git')
    expect(existsSync(join(me.cwd, 'gone'))).toBe(false)
    expect(partials(me.cwd)).toEqual([])
  }, 60000)

  it('uses git credentials or GROVE_AUTH_TOKEN, never codsh login, and keeps the token out of the clone', async () => {
    const me = account('https')
    writeFileSync(join(me.home, '.grok', 'auth.json'), JSON.stringify({ token: 'codsh-login-secret' }))
    const url = http.url('repo.git')
    const denied = await runAsync(me, ['clone', url, 'denied'])
    expect(denied.status).toBe(4)
    const message = denied.stderr.split('\n').slice(1).join('\n')
    expect(message).toContain('Git credentials rejected (unavailable).')
    expect(message).toContain('not `codsh --rust login`')
    expect(message).not.toContain(url)
    expect(existsSync(join(me.cwd, 'denied'))).toBe(false)
    expect(http.state.seen.some(entry => String(entry.auth).includes('codsh-login-secret'))).toBe(false)
    expect((await runAsync(me, ['clone', url, 'wrong'], { env: { GROVE_AUTH_TOKEN: 'not-it' } })).status).toBe(4)

    const ok = await runAsync(me, ['clone', url, 'ok'], { env: { GROVE_AUTH_TOKEN: 'fixture-token-191' } })
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toContain('credentials: GROVE_AUTH_TOKEN')
    const dir = join(me.cwd, 'ok')
    expect(git(dir, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    const config = readFileSync(join(dir, '.git', 'config'), 'utf8')
    expect(config).not.toContain('fixture-token-191')
    expect(config).not.toContain(Buffer.from('x-access-token:fixture-token-191').toString('base64'))
    expect(config).not.toMatch(/extraHeader/i)
  }, 60000)

  it('cancels on Ctrl-C without touching an existing repository or leaving a partial clone', async () => {
    const me = account('cancel')
    const keep = run(me, ['clone', fileUrl(), 'keep'])
    expect(keep.status, keep.stderr).toBe(0)
    mkdirSync(join(me.cwd, 'target'))
    http.state.hold = 20000
    try {
      const child = spawn(binary, ['clone', http.url('repo.git'), 'target'], {
        cwd: me.cwd, env: { ...me.env, GROVE_AUTH_TOKEN: 'fixture-token-191' }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk })
      await until(() => partials(me.cwd).length === 1 && http.state.seen.some(entry => entry.method === 'POST'), 'clone mid-transfer', 20000)
      const exited = new Promise(done => child.on('exit', code => done(code)))
      child.kill('SIGINT')
      expect(await exited).toBe(130)
      expect(stderr).toContain(`Clone cancelled; ${join(me.cwd, 'target')} is still empty.`)
    } finally {
      http.state.hold = 0
    }
    expect(readdirSync(join(me.cwd, 'target'))).toEqual([])
    expect(partials(me.cwd)).toEqual([])
    expect(git(join(me.cwd, 'keep'), ['status', '--porcelain'])).toBe('')
    git(join(me.cwd, 'keep'), ['fsck', '--connectivity-only'])
  }, 60000)

  it('records a Grove worktree request and falls back to a plain git worktree, also in a shallow partial clone', () => {
    const me = account('worktree', { DSH_CODE_CLI_MOCK_TOOL: 'echo' })
    expect(run(me, ['clone', fileUrl(), 'proj']).status).toBe(0)
    const proj = join(me.cwd, 'proj')
    const grove = run(me, ['-w', 'grovey', '-p', 'hello', '--output-format', 'json'], { cwd: proj, env: { GROK_WORKTREE_TYPE: 'grove' } })
    expect(grove.status, grove.stderr).toBe(0)
    expect(grove.stderr).toContain('Grove was requested (env GROK_WORKTREE_TYPE); this client has no Grove backend, so this is a plain git worktree')
    const shown = JSON.parse(run(me, ['worktree', 'show', 'grovey', '--json'], { cwd: proj }).stdout)
    expect(shown.strategy).toBe('git')
    expect(shown.grove).toMatchObject({ requested: true, source: 'env GROK_WORKTREE_TYPE', used: false })
    expect(existsSync(join(shown.path, 'note.txt'))).toBe(true)
    expect(git(shown.path, ['rev-parse', '--git-common-dir'])).toBe(join(proj, '.git'))
    const text = run(me, ['worktree', 'show', 'grovey'], { cwd: proj }).stdout
    expect(text).toContain('strategy: plain git worktree (Grove requested by env GROK_WORKTREE_TYPE; this client has no Grove backend)')

    // [cli] grove_worktree = "copy" beats enable-all; no request is recorded.
    writeFileSync(join(me.home, '.grok', 'config.toml'), '[cli]\ngrove_worktree = "copy"\n')
    const copy = run(me, ['-w', 'copyish', '-p', 'hello'], { cwd: proj, env: { GROK_GROVE: '1' } })
    expect(copy.status, copy.stderr).toBe(0)
    expect(copy.stderr).not.toContain('Grove was requested')
    expect(JSON.parse(run(me, ['worktree', 'show', 'copyish', '--json'], { cwd: proj }).stdout).grove).toBeNull()
    writeFileSync(join(me.home, '.grok', 'config.toml'), '[cli]\ngrove = true\n')
    const all = run(me, ['-w', 'allon', '-p', 'hello'], { cwd: proj })
    expect(all.stderr).toContain('Grove was requested (config [cli] grove)')
  }, 90000)

  it('lets real dsh edit a file in the fresh clone, in the clone directory', () => {
    const me = account('demo')
    expect(run(me, ['clone', fileUrl(), 'proj']).status).toBe(0)
    const proj = join(me.cwd, 'proj')
    const turn = run(me, ['-p', 'edit the note', '--output-format', 'json', '--always-approve'], { cwd: proj })
    expect(turn.status, turn.stderr).toBe(0)
    const result = JSON.parse(turn.stdout)
    expect(result.text).toContain('RUST_ACP_FILE_DONE')
    expect(result.text).toContain(join(proj, 'note.txt'))
    expect(readFileSync(join(proj, 'note.txt'), 'utf8')).toBe('ALPHA\n')
    expect(git(proj, ['status', '--porcelain'])).toBe('M note.txt')
  }, 90000)
})

describe.skipIf(!openssh)('clone over SSH and on a remote host', () => {
  it('clones over ssh with an explicit key and pinned host key, and classifies refusals', () => {
    const me = account('ssh')
    const url = `ssh://127.0.0.1:${sshd.port}${bare}`
    const ok = run(me, ['clone', url, 'viassh'], { env: { GIT_SSH_COMMAND: sshd.gitSsh() } })
    expect(ok.status, ok.stderr).toBe(0)
    expect(git(join(me.cwd, 'viassh'), ['rev-parse', '--is-shallow-repository'])).toBe('true')
    const wrong = run(me, ['clone', url, 'wrongkey'], { env: { GIT_SSH_COMMAND: sshd.gitSsh({ identity: sshd.keys.wrong_key }) } })
    expect(wrong.status).toBe(4)
    expect(wrong.stderr).toContain('Git credentials rejected (unavailable).')
    const unknown = run(me, ['clone', url, 'unknownhost'], { env: { GIT_SSH_COMMAND: sshd.gitSsh({ knownHosts: sshd.keys.empty_known_hosts }) } })
    expect(unknown.status).toBe(4)
    expect(unknown.stderr).toContain('host key is not trusted')
    expect(readFileSync(sshd.keys.empty_known_hosts, 'utf8')).toBe('')
    const token = run(me, ['clone', url, 'tok'], { env: { GIT_SSH_COMMAND: sshd.gitSsh(), GROVE_AUTH_TOKEN: 'fixture-token-191' } })
    expect(token.status, token.stderr).toBe(0)
    expect(token.stderr).toContain('GROVE_AUTH_TOKEN applies to https remotes only')
    expect(partials(me.cwd)).toEqual([])
  }, 90000)

  function remoteAccount(name, { gate = '1' } = {}) {
    const there = account(name, { GROK_CLONE: gate, DSH_CODE_CLI_MOCK_TOOL: 'file-edit' })
    writeFileSync(join(there.home, '.grok', 'config.toml'), '[ui]\npermission_mode = "always-approve"\n')
    const base = join(there.home, 'projects')
    mkdirSync(base)
    const envs = Object.entries(there.env).map(([key, value]) => `${key}=${value}`).join(' ')
    there.command = `env -i ${envs} ${binary}`
    there.base = base
    there.url = `ssh://127.0.0.1:${sshd.port}${base}`
    remotes.push(there)
    return there
  }

  const remoteFlags = (there, url = there.url) => ['--remote', url, '--remote-identity', sshd.keys.client_key,
    '--remote-known-hosts', sshd.keys.known_hosts, '--remote-command', there.command, '--remote-ssh', openssh.ssh]

  it('clones on the remote host into the remote path, then a remote session edits the clone', () => {
    const there = remoteAccount('remote-a')
    const me = account('remote-local', { GROVE_AUTH_TOKEN: 'local-token-191' })
    const cloned = run(me, ['clone', ...remoteFlags(there), fileUrl(), 'proj'])
    expect(cloned.status, cloned.stderr).toBe(0)
    const proj = join(there.base, 'proj')
    expect(cloned.stdout).toContain(`Cloned ${fileUrl()} into ${proj}`)
    expect(cloned.stdout).toContain(`Next: codsh --rust --remote ssh://127.0.0.1:${sshd.port}${proj}`)
    expect(cloned.stderr).toContain('GROVE_AUTH_TOKEN is not sent to the remote host')
    expect(existsSync(join(me.cwd, 'proj'))).toBe(false)
    expect(git(proj, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    const again = run(me, ['clone', ...remoteFlags(there), fileUrl(), 'proj'])
    expect(again.status, again.stderr).toBe(0)
    expect(again.stdout).toContain('is already a clone of')

    const turn = run(me, [...remoteFlags(there, `ssh://127.0.0.1:${sshd.port}${proj}`), '-p', 'edit the note', '--output-format', 'json'])
    expect(turn.status, turn.stderr).toBe(0)
    const result = JSON.parse(turn.stdout)
    expect(result.text).toContain(join(proj, 'note.txt'))
    expect(readFileSync(join(proj, 'note.txt'), 'utf8')).toBe('ALPHA\n')
    expect(git(proj, ['status', '--porcelain'])).toBe('M note.txt')

    // The remote host's own gate applies there.
    const closed = remoteAccount('remote-off', { gate: '0' })
    const refused = run(me, ['clone', ...remoteFlags(closed), fileUrl(), 'nope'])
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('env GROK_CLONE is off')
    expect(existsSync(join(closed.base, 'nope'))).toBe(false)
  }, 120000)

  it('a closed connection cancels the remote clone and removes its partial directory', async () => {
    const there = remoteAccount('remote-cancel', { gate: '1' })
    // The remote host reaches the loopback HTTP server with its own token.
    there.command = there.command.replace(' GROK_CLONE=1', ' GROK_CLONE=1 GROVE_AUTH_TOKEN=fixture-token-191')
    const me = account('remote-cancel-local')
    http.state.hold = 20000
    try {
      const child = spawn(binary, ['clone', ...remoteFlags(there), http.url('repo.git'), 'slow'], {
        cwd: me.cwd, env: me.env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk })
      await until(() => partials(there.base).length === 1 && http.state.seen.some(entry => entry.method === 'POST'), 'remote clone mid-transfer', 30000)
      const exited = new Promise(done => child.on('exit', code => done(code)))
      child.kill('SIGINT')
      expect(await exited).toBe(130)
      expect(stderr).toContain('the connection closed, so the clone on')
      await until(() => partials(there.base).length === 0, 'remote partial clone removed', 15000)
    } finally {
      http.state.hold = 0
    }
    expect(existsSync(join(there.base, 'slow'))).toBe(false)
    expect(lstatSync(there.base).isDirectory()).toBe(true)
  }, 90000)
})
