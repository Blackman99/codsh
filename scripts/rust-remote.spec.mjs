// Remote workspace over SSH (ticket 190) against a real OpenSSH server and
// real dsh. A local unprivileged sshd on 127.0.0.1 (temp host key, one
// authorized public key, no forwarding) stands in for the remote host; the
// remote end runs `codsh-rust agent --leader stdio` with its own home,
// config, and the keyless mock LLM. Nothing here uses a paid service.
//
// OpenSSH: CODSH_TEST_OPENSSH=<prefix> (usr/bin/ssh, usr/sbin/sshd,
// usr/bin/ssh-keygen, optional usr/lib/openssh helpers) or ssh/sshd on PATH.
// Without them the suite is skipped with that reason.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, openSync } from 'node:fs'
import { join, dirname, resolve, delimiter } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'

const require = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const binary = join(repo, 'rust/target/debug/codsh-rust')

function findOpenssh() {
  const prefix = process.env.CODSH_TEST_OPENSSH
  if (prefix) {
    const tools = {
      ssh: join(prefix, 'usr/bin/ssh'),
      sshd: join(prefix, 'usr/sbin/sshd'),
      keygen: join(prefix, 'usr/bin/ssh-keygen'),
      extra: [],
      libs: existsSync(join(prefix, 'usr/lib/x86_64-linux-gnu')) ? join(prefix, 'usr/lib/x86_64-linux-gnu') : null,
    }
    for (const [key, name] of [['SshdSessionPath', 'sshd-session'], ['SshdAuthPath', 'sshd-auth']]) {
      const helper = join(prefix, 'usr/lib/openssh', name)
      if (existsSync(helper)) tools.extra.push(`${key} ${helper}`)
    }
    return existsSync(tools.ssh) && existsSync(tools.sshd) && existsSync(tools.keygen) ? tools : null
  }
  const dirs = [...String(process.env.PATH ?? '').split(delimiter), '/usr/sbin', '/usr/local/sbin']
  const which = name => dirs.map(dir => join(dir, name)).find(path => existsSync(path))
  const tools = { ssh: which('ssh'), sshd: which('sshd'), keygen: which('ssh-keygen'), extra: [], libs: null }
  return tools.ssh && tools.sshd && tools.keygen ? tools : null
}

const openssh = process.platform === 'win32' ? null : findOpenssh()
const skipReason = openssh ? '' : 'no OpenSSH ssh/sshd/ssh-keygen (set CODSH_TEST_OPENSSH=<prefix>)'
if (!openssh) console.warn(`rust-remote.spec: skipped: ${skipReason}`)

function dshPath() {
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin
  return join(dirname(manifest), typeof bin === 'string' ? bin : bin.dsh)
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
    server.on('error', reject)
  })
}

async function until(predicate, what, timeout = 30000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(done => setTimeout(done, 50))
  }
}

let root
let sshd
let port
const keys = {}
const remotes = []

beforeAll(async () => {
  if (!openssh) return
  root = mkdtempSync(join('/tmp', 'codsh-remote-'))
  const dir = join(root, 'ssh')
  mkdirSync(dir)
  for (const name of ['host_key', 'client_key', 'wrong_key']) {
    execFileSync(openssh.keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)])
    keys[name] = join(dir, name)
  }
  writeFileSync(join(dir, 'authorized_keys'), readFileSync(`${keys.client_key}.pub`))
  port = await freePort()
  const hostPub = readFileSync(`${keys.host_key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
  keys.known_hosts = join(dir, 'known_hosts')
  writeFileSync(keys.known_hosts, `[127.0.0.1]:${port} ${hostPub}\n`)
  keys.empty_known_hosts = join(dir, 'empty_known_hosts')
  writeFileSync(keys.empty_known_hosts, '')
  writeFileSync(join(dir, 'sshd_config'), [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${keys.host_key}`, `PidFile ${join(dir, 'sshd.pid')}`,
    `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`, 'StrictModes no', 'UsePAM no',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
    'AllowTcpForwarding no', 'AllowAgentForwarding no', 'X11Forwarding no', 'PermitTunnel no',
    ...openssh.extra, '',
  ].join('\n'))
  const log = join(dir, 'sshd.log')
  sshd = spawn(openssh.sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], {
    env: { ...process.env, ...(openssh.libs ? { LD_LIBRARY_PATH: openssh.libs } : {}) },
    stdio: ['ignore', 'ignore', openSync(log, 'w')],
  })
  await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('Server listening'), 'sshd listening', 10000)
}, 30000)

afterAll(async () => {
  for (const remote of remotes) {
    spawnSync(binary, ['leader', 'kill'], { env: remote.env, encoding: 'utf8', timeout: 30000 })
  }
  if (sshd && sshd.exitCode == null) sshd.kill('SIGTERM')
  if (root) rmSync(root, { recursive: true, force: true })
})

// One remote host account: its own home, config, leader, and workspace.
function remoteHost(name, { mode = 'file-edit', policy = 'always-approve', extra = {} } = {}) {
  const home = join(root, name)
  mkdirSync(join(home, 'dsh'), { recursive: true })
  mkdirSync(join(home, '.grok'))
  writeFileSync(join(home, '.grok', 'config.toml'), `[ui]\npermission_mode = "${policy}"\n`)
  const ws = join(root, `${name}-ws`)
  mkdirSync(ws)
  writeFileSync(join(ws, 'note.txt'), 'alpha\n')
  const overlay = join(root, `${name}-overlay.yml`)
  writeFileSync(overlay, rustAcpOverlay())
  const env = {
    PATH: process.env.PATH, HOME: home, DSH_HOME: join(home, 'dsh'), GROK_HOME: join(home, '.grok'),
    DSH_BIN: dshPath(), CODSH_NODE: process.execPath, CODSH_ACP_PATCH: overlay,
    DSH_CODE_CLI_MOCK_TOOL: mode, DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'OFF',
    CODSH_UPDATE_CHECK: 'off', ...extra,
  }
  const loginEnv = join(home, 'login-env.txt')
  const command = `env > ${loginEnv}; env -i ${Object.entries(env).map(([key, value]) => `${key}=${value}`).join(' ')} ${binary}`
  const remote = { home, ws, env, command, loginEnv, url: `ssh://127.0.0.1:${port}${ws}` }
  remotes.push(remote)
  return remote
}

// The local machine: a different home and a different directory, with
// credentials that must never reach the remote.
function localMachine() {
  const home = mkdtempSync(join(root, 'local-'))
  const cwd = join(home, 'ws')
  mkdirSync(join(home, 'dsh'), { recursive: true })
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'note.txt'), 'local alpha\n')
  const env = {
    PATH: process.env.PATH, HOME: home, DSH_HOME: join(home, 'dsh'), GROK_HOME: join(home, '.grok'),
    DSH_TELEMETRY_DISABLED: '1', CODSH_UPDATE_CHECK: 'off',
    DEEPSEEK_API_KEY: 'local-secret-190', XAI_API_KEY: 'local-xai-190', GROK_CODE_XAI_API_KEY: 'local-grok-190',
  }
  return { home, cwd, env }
}

function remoteFlags(remote, { identity = keys.client_key, knownHosts = keys.known_hosts } = {}) {
  return ['--remote', remote.url, '--remote-identity', identity, '--remote-known-hosts', knownHosts,
    '--remote-command', remote.command, '--remote-ssh', openssh.ssh]
}

function run(local, args, timeout = 60000) {
  return spawnSync(binary, args, { cwd: local.cwd, env: local.env, encoding: 'utf8', timeout })
}

describe.skipIf(!openssh)('remote workspace over SSH', () => {
  it('authenticates with a key and a pinned host key, and reports the real remote', () => {
    expect(existsSync(binary), 'cargo build -p codsh-rust first').toBe(true)
    const remote = remoteHost('check')
    const local = localMachine()
    const [, url, ...rest] = remoteFlags(remote)
    const ok = run(local, ['remote', 'check', url, ...rest, '--json'])
    expect(ok.status, ok.stderr).toBe(0)
    const report = JSON.parse(ok.stdout)
    expect(report).toMatchObject({ target: remote.url, transport: 'ssh' })
    expect(report.server).toMatchObject({ transport: 'leader', shared: true })
    expect(report.server.sandbox.profile).toBe('off')
    expect(report.reattach).toMatch(/^yes/)
    expect(report.agentInfo.name).toBe('codsh-rust')
    expect(report.promptCapabilities.image).toBe(false)
    expect(report.auth).toContain('StrictHostKeyChecking=yes')
    expect(report.needsOfficialInfrastructure.map(entry => entry.feature).join(' ')).toContain('--hub-url')

    // An unknown host key is refused, not accepted on first use.
    const unknown = run(local, ['remote', 'check', url, ...remoteFlags(remote, { knownHosts: keys.empty_known_hosts }).slice(2)])
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr).toMatch(/Host key verification failed/)
    expect(readFileSync(keys.empty_known_hosts, 'utf8')).toBe('')
    // A key the remote does not authorize is refused; there is no password prompt.
    const wrong = run(local, ['remote', 'check', url, ...remoteFlags(remote, { identity: keys.wrong_key }).slice(2)])
    expect(wrong.status).not.toBe(0)
    expect(wrong.stderr).toMatch(/Permission denied \(publickey\)/)
  }, 90000)

  it('runs a turn on remote files under the remote policy and forwards nothing local', () => {
    const remote = remoteHost('turn')
    const local = localMachine()
    const turn = run(local, [...remoteFlags(remote), '-p', 'edit the note', '--output-format', 'json'])
    expect(turn.status, turn.stderr).toBe(0)
    const result = JSON.parse(turn.stdout)
    expect(result.text).toContain('RUST_ACP_FILE_DONE')
    expect(result.text).toContain(join(remote.ws, 'note.txt'))
    expect(readFileSync(join(remote.ws, 'note.txt'), 'utf8')).toBe('ALPHA\n')
    // The same-named local file is not the remote file.
    expect(readFileSync(join(local.cwd, 'note.txt'), 'utf8')).toBe('local alpha\n')
    const login = readFileSync(remote.loginEnv, 'utf8')
    for (const secret of ['local-secret-190', 'local-xai-190', 'local-grok-190', local.home]) {
      expect(login).not.toContain(secret)
    }
    expect(login).not.toMatch(/SSH_AUTH_SOCK=/)

    // The session lives on the remote: --continue and a --resume prefix
    // find it there, not in this machine's catalog.
    const again = run(local, [...remoteFlags(remote), '--continue', '-p', 'edit the note', '--output-format', 'json'])
    expect(again.status, again.stderr).toBe(0)
    expect(JSON.parse(again.stdout).sessionId).toBe(result.sessionId)
    const byPrefix = run(local, [...remoteFlags(remote), '--resume', result.sessionId.slice(0, 8), '-p', 'edit the note', '--output-format', 'json'])
    expect(byPrefix.status, byPrefix.stderr).toBe(0)
    expect(JSON.parse(byPrefix.stdout).sessionId).toBe(result.sessionId)
    expect(existsSync(join(local.home, 'dsh', 'sessions'))).toBe(false)
  }, 120000)

  it('obeys a stricter remote policy and refuses local policy, files, and official-only commands', () => {
    const remote = remoteHost('strict', { policy: 'ask' })
    const local = localMachine()
    const denied = run(local, [...remoteFlags(remote), '-p', 'edit the note'])
    expect(denied.status).not.toBe(0)
    expect(denied.stderr + denied.stdout).toMatch(/non-interactive approval/)
    expect(readFileSync(join(remote.ws, 'note.txt'), 'utf8')).toBe('alpha\n')

    for (const flags of [['--always-approve'], ['--permission-mode', 'always-approve'], ['--model', 'x'], ['--sandbox', 'off'], ['--allow', 'Bash(*)']]) {
      const refused = run(local, [...remoteFlags(remote), ...flags, '-p', 'edit the note'])
      expect(refused.status, flags.join(' ')).toBe(2)
      expect(refused.stderr).toContain(`--remote refuses ${flags[0]}`)
    }
    expect(readFileSync(join(remote.ws, 'note.txt'), 'utf8')).toBe('alpha\n')

    const image = JSON.stringify([{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }])
    const attached = run(local, [...remoteFlags(remote), '--prompt-json', image])
    expect(attached.status).not.toBe(0)
    expect(attached.stderr).toMatch(/text/)

    const companion = run(local, ['--remote-identity', keys.client_key, '-p', 'x'])
    expect(companion.status).toBe(2)
    expect(companion.stderr).toMatch(/need --remote/)
    for (const bad of ['https://example.org/x', `ssh://-oProxyCommand=x/tmp`, 'ssh://host/tmp/../etc']) {
      const refused = run(local, ['--remote', bad, '-p', 'x'])
      expect(refused.status, bad).toBe(2)
    }
    const hub = run(local, ['workspace', 'start', '--hub-url', 'https://example.invalid'])
    expect(hub.status).toBe(2)
    expect(hub.stderr).toMatch(/official Computer Hub/)
  }, 120000)

  it('reports a remote restart as an interrupted turn with unknown effects and never retries it', async () => {
    const remote = remoteHost('restart', { mode: 'shell-count', extra: { CODSH_SHELL_SLEEP: '3' } })
    const local = localMachine()
    const child = spawn(binary, [...remoteFlags(remote), '-p', 'count then restart'], { cwd: local.cwd, env: local.env })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += chunk })
    child.stderr.on('data', chunk => { output.stderr += chunk })
    const exited = new Promise(done => child.on('exit', code => done(code)))
    await until(() => existsSync(join(remote.ws, 'shell-count.txt')), 'remote command started')
    const listed = JSON.parse(spawnSync(binary, ['leader', 'list', '--json'], { env: remote.env, encoding: 'utf8' }).stdout)
    expect(listed).toHaveLength(1)
    process.kill(listed[0].pid, 'SIGTERM')
    const code = await exited
    expect(code).not.toBe(0)
    expect(output.stderr).toMatch(/unknown/)
    expect(output.stderr).toMatch(/not retried|not re-?tried/)
    await new Promise(done => setTimeout(done, 4000))
    expect(readFileSync(join(remote.ws, 'shell-count.txt'), 'utf8')).toBe('RAN\n')
  }, 120000)
})

describe.skipIf(!!openssh)('remote workspace over SSH (skipped)', () => {
  it.skip(`needs OpenSSH: ${skipReason}`, () => {})
})
