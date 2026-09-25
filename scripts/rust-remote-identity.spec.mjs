// Organization identity for remote workspaces (ticket 207), end to end:
// a real Ory Hydra (OAuth 2.0 / OpenID Connect, sqlite) with the
// organization's login and consent app as the identity service, a real
// OpenSSH server as the org-shared remote host, and real dsh with the
// keyless mock LLM. The org key is restricted to a forced command, so the
// only thing it reaches is `codsh-rust agent --leader stdio`, whose proxy
// checks every request with Hydra's RFC 7662 introspection.
//
// Hydra: CODSH_TEST_HYDRA=<binary or dir> (github.com/ory/hydra releases,
// sqlite build) or `hydra` on PATH. OpenSSH: CODSH_TEST_OPENSSH=<prefix> or
// ssh/sshd on PATH. Without either the suite is skipped with that reason.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { findOpenssh, startSshd, until } from './rust-clone-fixtures.mjs'
import { findHydra, startIdentity } from './rust-identity-fixtures.mjs'

const require = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const binary = join(repo, 'rust/target/debug/codsh-rust')

const openssh = process.platform === 'win32' ? null : findOpenssh()
const hydra = process.platform === 'win32' ? null : findHydra()
const skipReason = !openssh
  ? 'no OpenSSH ssh/sshd/ssh-keygen (set CODSH_TEST_OPENSSH=<prefix>)'
  : !hydra ? 'no Ory Hydra (set CODSH_TEST_HYDRA=<hydra binary>)' : ''
if (skipReason) console.warn(`rust-remote-identity.spec: skipped: ${skipReason}`)

const ALPHA = 'codsh-remote:alpha'
const BETA = 'codsh-remote:beta'

function dshPath() {
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin
  return join(dirname(manifest), typeof bin === 'string' ? bin : bin.dsh)
}

let root
let sshd
let idp
let remote

beforeAll(async () => {
  if (skipReason) return
  root = mkdtempSync(join('/tmp', 'codsh-identity-'))
  idp = await startIdentity(hydra, mkdtempSync(join(root, 'idp-')), {
    users: { alice: { team: 'team-a' }, bob: { team: 'team-b' }, carol: { team: 'team-a' } },
  })
  await idp.createClient({ id: 'codsh-cli', audience: [ALPHA, BETA] })
  await idp.createClient({ id: 'codsh-short', audience: [ALPHA], accessLifespan: '6s' })
  sshd = await startSshd(openssh, join(root, 'ssh'))
  remote = orgHost()
}, 90000)

afterAll(async () => {
  if (remote) spawnSync(binary, ['leader', 'kill'], { env: remote.env, encoding: 'utf8', timeout: 30000 })
  sshd?.stop()
  await idp?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

// The org-shared remote host. Its administrator restricts the org key to a
// forced command: whatever the client asks ssh to run, it gets the agent.
function orgHost() {
  const home = join(root, 'org-host')
  mkdirSync(join(home, 'dsh'), { recursive: true })
  mkdirSync(join(home, '.grok'))
  writeFileSync(join(home, '.grok', 'config.toml'), '[ui]\npermission_mode = "always-approve"\n')
  const ws = join(root, 'org-ws')
  mkdirSync(ws)
  const overlay = join(root, 'org-overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const env = {
    PATH: process.env.PATH, HOME: home, DSH_HOME: join(home, 'dsh'), GROK_HOME: join(home, '.grok'),
    DSH_BIN: dshPath(), CODSH_NODE: process.execPath, CODSH_ACP_PATCH: overlay,
    DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'OFF', CODSH_UPDATE_CHECK: 'off', CODSH_SHELL_SLEEP: '12',
  }
  const mode = join(home, 'mock-mode')
  writeFileSync(mode, 'file-edit')
  const wrapper = join(home, 'org-agent.sh')
  writeFileSync(wrapper, [
    '#!/bin/sh',
    `echo "$SSH_ORIGINAL_COMMAND" >> ${join(home, 'asked.txt')}`,
    `exec env -i ${Object.entries(env).map(([key, value]) => `${key}='${value}'`).join(' ')} DSH_CODE_CLI_MOCK_TOOL="$(cat ${mode})" SSH_CONNECTION="$SSH_CONNECTION" ${binary} agent --leader stdio`,
    '',
  ].join('\n'))
  chmodSync(wrapper, 0o755)
  const key = readFileSync(`${sshd.keys.client_key}.pub`, 'utf8').trim()
  writeFileSync(join(root, 'ssh', 'authorized_keys'), `restrict,command="${wrapper}" ${key}\n`)
  return { home, ws, env, mode, url: `ssh://127.0.0.1:${sshd.port}${ws}` }
}

// The mock LLM mode is read when the leader starts.
function restartLeader(mode) {
  spawnSync(binary, ['leader', 'kill'], { env: remote.env, encoding: 'utf8', timeout: 30000 })
  writeFileSync(remote.mode, mode)
}

function policy(extra = '', { issuer = idp.issuer, audience = ALPHA, teams = ['team-a'] } = {}) {
  return [
    '[remote_access]',
    'identity = "required"',
    `issuer = "${issuer}"`,
    `audience = "${audience}"`,
    `introspection_url = "${idp.introspection}"`,
    `teams = [${teams.map(team => `"${team}"`).join(', ')}]`,
    'recheck_secs = 5',
    extra,
    '',
  ].join('\n')
}

function setRequirements(text) {
  const path = join(remote.env.GROK_HOME, 'requirements.toml')
  if (text == null) rmSync(path, { force: true })
  else writeFileSync(path, text)
}

function resetNote() {
  writeFileSync(join(remote.ws, 'note.txt'), 'alpha\n')
}
const note = () => readFileSync(join(remote.ws, 'note.txt'), 'utf8')

// A developer machine: its own GROK_HOME, logged in (or not) with the org
// identity provider, and a config that says which remotes get the identity.
function developer({ client = 'codsh-cli', audience = ALPHA, destination = ALPHA, extra = {} } = {}) {
  const home = mkdtempSync(join(root, 'dev-'))
  const cwd = join(home, 'ws')
  mkdirSync(join(home, '.grok'), { recursive: true })
  mkdirSync(join(home, 'dsh'))
  mkdirSync(cwd)
  if (destination) {
    writeFileSync(join(home, '.grok', 'config.toml'), `[[remote_identity]]\ntarget = "ssh://127.0.0.1:${sshd.port}"\naudience = "${destination}"\n`)
  }
  const env = {
    PATH: process.env.PATH, HOME: home, GROK_HOME: join(home, '.grok'), DSH_HOME: join(home, 'dsh'),
    DSH_TELEMETRY_DISABLED: '1', CODSH_UPDATE_CHECK: 'off',
    GROK_OIDC_ISSUER: idp.issuer, GROK_OIDC_CLIENT_ID: client, GROK_OIDC_AUDIENCE: audience,
    ...extra,
  }
  return { home, cwd, env, auth: join(home, '.grok', 'auth.json') }
}

// `codsh --rust login` through Hydra, with this test acting as the browser.
async function login(dev, user) {
  idp.state.nextUser = user
  const child = spawn(binary, ['login'], { cwd: dev.cwd, env: dev.env })
  let stderr = ''
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  const url = await new Promise((done, fail) => {
    child.stderr.on('data', chunk => {
      stderr += chunk
      const match = stderr.match(/(http\S+\/oauth2\/auth\S+)/)
      if (match) done(match[1])
    })
    child.on('close', code => fail(new Error(`login exited ${code}: ${stderr}`)))
  })
  await idp.browse(url)
  const code = await new Promise(done => child.on('close', done))
  if (code !== 0) throw new Error(`login failed (${code}): ${stdout}${stderr}`)
  return JSON.parse(readFileSync(dev.auth, 'utf8'))
}

function flags({ command = '/nonexistent/codsh-not-run' } = {}) {
  return ['--remote', remote.url, '--remote-identity', sshd.keys.client_key, '--remote-known-hosts', sshd.keys.known_hosts,
    '--remote-command', command, '--remote-ssh', openssh.ssh]
}

function run(dev, args, timeout = 90000) {
  return spawnSync(binary, args, { cwd: dev.cwd, env: dev.env, encoding: 'utf8', timeout })
}

function turn(dev, extra = []) {
  return run(dev, [...flags(), ...extra, '-p', 'edit the note', '--output-format', 'json'])
}

function check(dev) {
  const [, url, ...rest] = flags()
  return run(dev, ['remote', 'check', url, ...rest, '--json'])
}

// A raw ACP client on the org key, for what a modified client could send.
function rawAcp() {
  const child = spawn(openssh.ssh, ['-F', '/dev/null', '-i', sshd.keys.client_key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${sshd.keys.known_hosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR', '-p', String(sshd.port), '127.0.0.1', 'echo shell-reached'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = []
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      lines.push(line)
    }
  })
  let next = 1
  const closed = new Promise(done => child.on('close', done))
  return {
    lines,
    closed,
    async request(method, params = {}) {
      const id = next++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return until(() => lines.map(line => { try { return JSON.parse(line) } catch { return null } })
        .find(message => message && message.id === id && !message.method), `${method} answer`, 30000)
    },
    async authenticate(token) {
      return this.request('authenticate', { methodId: 'codsh-org-identity', _meta: { 'codsh/identity': { accessToken: token } } })
    },
    end() { child.stdin.end() },
    kill() { child.kill('SIGTERM') },
  }
}

async function rawTry(token) {
  const acp = rawAcp()
  try {
    const init = await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const auth = token ? await acp.authenticate(token) : null
    const created = await acp.request('session/new', { cwd: remote.ws, mcpServers: [] })
    return { init, auth, created, lines: acp.lines }
  } finally {
    acp.end()
    setTimeout(() => acp.kill(), 2000)
    await acp.closed
  }
}

const serverLog = () => {
  const path = join(remote.env.GROK_HOME, 'remote-access.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
const clientLog = dev => {
  const path = join(dev.env.GROK_HOME, 'remote-identity.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe.skipIf(!!skipReason)('organization identity for remote workspaces', () => {
  it('leaves a plain remote without a policy as it was (ticket 190)', () => {
    expect(existsSync(binary), 'cargo build -p codsh-rust first').toBe(true)
    setRequirements(null)
    resetNote()
    const dev = developer({ destination: null })
    const result = turn(dev)
    expect(result.status, result.stderr).toBe(0)
    expect(note()).toBe('ALPHA\n')
    const report = JSON.parse(check(dev).stdout)
    expect(report.identity).toEqual({ required: false })
    // The forced command ran, not the client's --remote-command.
    expect(readFileSync(join(remote.home, 'asked.txt'), 'utf8')).toContain('/nonexistent/codsh-not-run agent --leader stdio')
  }, 120000)

  it('admits a logged-in team member only after the identity is sent to a configured destination', async () => {
    setRequirements(policy())
    resetNote()

    // Not logged in: nothing is sent, the reason is clear.
    const fresh = developer()
    const none = turn(fresh)
    expect(none.status).not.toBe(0)
    expect(none.stderr).toMatch(/codsh --rust login/)
    expect(note()).toBe('alpha\n')

    // Logged in, but this remote is not a configured destination: the
    // login state alone grants nothing and the token stays local.
    const undecided = developer({ destination: null })
    const record = await login(undecided, 'alice')
    expect(record.team_id).toBe('team-a')
    const refused = turn(undecided)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toMatch(/\[\[remote_identity\]\]/)
    expect(refused.stderr).not.toContain(record.access_token)
    expect(serverLog()).not.toContain('"method":"authenticate"')
    expect(note()).toBe('alpha\n')

    // A client that does not authenticate gets nothing but the refusal.
    const raw = await rawTry(null)
    expect(raw.init.result.authMethods[0]).toMatchObject({ id: 'codsh-org-identity' })
    expect(raw.init.result.authMethods[0]._meta['codsh/identity']).toMatchObject({ issuer: idp.issuer, audience: ALPHA, teams: ['team-a'] })
    expect(raw.init.result.agentCapabilities?._meta?.['codsh/server']?.liveSessions).toBeUndefined()
    expect(raw.created.error).toMatchObject({ code: -32000, data: { reason: 'auth_required' } })
    // ssh reached the forced agent, not a shell.
    expect(raw.lines.join('\n')).not.toContain('shell-reached')

    // Configured: the turn runs on the remote as alice.
    const dev = developer()
    const alice = await login(dev, 'alice')
    const ok = turn(dev)
    expect(ok.status, ok.stderr).toBe(0)
    expect(note()).toBe('ALPHA\n')
    const report = JSON.parse(check(dev).stdout)
    expect(report.identity).toMatchObject({ required: true, status: 'accepted', subject: 'alice', team: 'team-a', audience: ALPHA, issuer: idp.issuer })

    // Audit: purpose and destination are recorded with a fingerprint, never the token.
    for (const log of [serverLog(), clientLog(dev)]) {
      expect(log).not.toContain(alice.access_token)
      expect(log).not.toContain(alice.refresh_token)
    }
    const accepted = clientLog(dev).trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.outcome === 'accepted')
    expect(accepted).toMatchObject({ event: 'authenticate', target: remote.url, audience: ALPHA, issuer: idp.issuer, subject: 'alice' })
    expect(accepted.destination).toContain('config.toml')
    expect(accepted.token).toMatch(/^[0-9a-f]{12}$/)
    expect(serverLog()).toContain(`"token":"${accepted.token}"`)
    expect(serverLog()).toMatch(/"outcome":"allowed".*"subject":"alice"/)
  }, 240000)

  it('refuses another team, another audience, and another issuer on the remote itself', async () => {
    setRequirements(policy())
    resetNote()
    const bobDev = developer()
    const bob = await login(bobDev, 'bob')
    const team = turn(bobDev)
    expect(team.status).not.toBe(0)
    expect(team.stderr).toMatch(/team-b.*team-a|admits teams/)
    expect(team.stderr).not.toContain(bob.access_token)
    expect(note()).toBe('alpha\n')

    // A token for beta: this client does not send it to alpha...
    const betaDev = developer({ audience: BETA })
    const beta = await login(betaDev, 'carol')
    const local = turn(betaDev)
    expect(local.status).not.toBe(0)
    expect(local.stderr).toMatch(/requires a token for codsh-remote:alpha/)
    // ...and a client that sends it anyway is refused by the remote.
    const reused = await rawTry(beta.access_token)
    expect(reused.auth.error).toMatchObject({ code: -32000, data: { reason: 'audience' } })
    expect(JSON.stringify(reused.auth)).not.toContain(beta.access_token)
    expect(reused.created.error.data.reason).toBe('auth_required')

    // The remote trusts another issuer: nothing is sent, and a sent token is refused.
    setRequirements(policy('', { issuer: 'http://127.0.0.1:9/' }))
    const aliceDev = developer()
    const alice = await login(aliceDev, 'alice')
    const other = turn(aliceDev)
    expect(other.status).not.toBe(0)
    expect(other.stderr).toMatch(/requires an identity from http:\/\/127\.0\.0\.1:9/)
    const forged = await rawTry(alice.access_token)
    expect(forged.auth.error.data.reason).toBe('issuer')
    expect(note()).toBe('alpha\n')
    expect(serverLog()).not.toContain(alice.access_token)
  }, 240000)

  it('applies administrator locks from requirements.toml, which user config cannot turn off', async () => {
    const dev = developer()
    await login(dev, 'alice')
    resetNote()
    // A user-writable remote config.toml cannot switch the requirement off.
    writeFileSync(join(remote.env.GROK_HOME, 'config.toml'), '[ui]\npermission_mode = "always-approve"\n\n[remote_access]\nidentity = "off"\n')
    setRequirements(policy())
    const raw = await rawTry(null)
    expect(raw.created.error.data.reason).toBe('auth_required')

    setRequirements(policy('deny_subjects = ["alice"]'))
    const denied = turn(dev)
    expect(denied.status).not.toBe(0)
    expect(denied.stderr).toMatch(/locked remote access for alice/)

    setRequirements(`${policy()}locked = true\nlock_message = "incident 207: remote access paused"\n`)
    const locked = turn(dev)
    expect(locked.status).not.toBe(0)
    expect(locked.stderr).toMatch(/incident 207: remote access paused/)
    expect(check(dev).status).not.toBe(0)
    expect(note()).toBe('alpha\n')
    expect(serverLog()).toMatch(/"reason":"locked"/)

    // An unreadable policy fails closed.
    setRequirements('[remote_access]\nidentity = "required"\n')
    const invalid = turn(dev)
    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr).toMatch(/fails closed/)
    expect(serverLog()).toMatch(/"reason":"invalid_policy"/)
    writeFileSync(join(remote.env.GROK_HOME, 'config.toml'), '[ui]\npermission_mode = "always-approve"\n')
    setRequirements(policy())
    const ok = turn(dev)
    expect(ok.status, ok.stderr).toBe(0)
    expect(note()).toBe('ALPHA\n')
  }, 240000)

  it('refreshes an expiring identity, and refuses it once expired, logged out, or revoked', async () => {
    setRequirements(policy())
    resetNote()
    const dev = developer({ client: 'codsh-short', extra: { GROK_AUTH_EARLY_INVALIDATION_SECS: '2' } })
    const first = await login(dev, 'alice')
    await new Promise(done => setTimeout(done, 7000))
    // The old access token has expired at Hydra, so the remote refuses it.
    const expired = await rawTry(first.access_token)
    expect(['expired', 'inactive']).toContain(expired.auth.error.data.reason)
    // The client refreshes before sending, so the turn runs.
    const refreshed = turn(dev)
    expect(refreshed.status, refreshed.stderr).toBe(0)
    expect(note()).toBe('ALPHA\n')
    const second = JSON.parse(readFileSync(dev.auth, 'utf8'))
    expect(second.access_token).not.toBe(first.access_token)

    // Logout revokes at Hydra: a copy of the old session is refused by the remote.
    resetNote()
    const logoutDev = developer()
    const kept = await login(logoutDev, 'carol')
    copyFileSync(logoutDev.auth, `${logoutDev.auth}.kept`)
    const out = run(logoutDev, ['logout'])
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout + out.stderr).toMatch(/revoked/)
    copyFileSync(`${logoutDev.auth}.kept`, logoutDev.auth)
    chmodSync(logoutDev.auth, 0o600)
    expect((await idp.introspect(kept.access_token)).active).toBe(false)
    const afterLogout = turn(logoutDev)
    expect(afterLogout.status).not.toBe(0)
    expect(afterLogout.stderr).toMatch(/Organization identity refused/)
    expect(afterLogout.stderr).not.toContain(kept.access_token)
    expect(note()).toBe('alpha\n')

    // An administrator revokes alice at Hydra: the refresh fails and
    // nothing is sent.
    await idp.revokeSubject('alice')
    await new Promise(done => setTimeout(done, 5000))
    const revoked = turn(dev)
    expect(revoked.status).not.toBe(0)
    expect(note()).toBe('alpha\n')
  }, 240000)

  it('drops a connected session when the identity is revoked mid-session', async () => {
    setRequirements(policy())
    resetNote()
    const dev = developer()
    const record = await login(dev, 'carol')
    const acp = rawAcp()
    try {
      await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const auth = await acp.authenticate(record.access_token)
      expect(auth.result._meta['codsh/identity']).toMatchObject({ subject: 'carol', team: 'team-a' })
      const created = await acp.request('session/new', { cwd: remote.ws, mcpServers: [] })
      expect(created.result.sessionId).toBeTruthy()
      await idp.revokeSubject('carol')
      // The periodic check (recheck_secs = 5) finds the revocation without
      // any request from the client, tells it why, and closes.
      const notice = await until(() => acp.lines.map(line => JSON.parse(line)).find(message => message.method === '_codsh/remote_access_revoked'), 'revocation notice', 20000)
      expect(notice.params.reason).toBe('inactive')
      await acp.closed
    } finally {
      acp.kill()
    }
    expect(serverLog()).toMatch(/"event":"recheck".*"outcome":"denied"/)

    // The same through the codsh client during a running turn: the remote
    // cancels the turn and the client reports why.
    restartLeader('shell-count')
    try {
      const dave = developer()
      await login(dave, 'alice')
      const child = spawn(binary, [...flags(), '-p', 'count slowly'], { cwd: dave.cwd, env: dave.env })
      const output = { stdout: '', stderr: '' }
      child.stdout.on('data', chunk => { output.stdout += chunk })
      child.stderr.on('data', chunk => { output.stderr += chunk })
      const exited = new Promise(done => child.on('exit', code => done(code)))
      await until(() => existsSync(join(remote.ws, 'shell-count.txt')), 'remote command started', 60000)
      await idp.revokeSubject('alice')
      const code = await exited
      expect(code, JSON.stringify(output) + serverLog().split('\n').slice(-8).join('\n') + existsSync(join(remote.ws, 'shell-done.txt'))).not.toBe(0)
      expect(output.stderr).toMatch(/Organization identity refused/)
      await new Promise(done => setTimeout(done, 13000))
      expect(existsSync(join(remote.ws, 'shell-done.txt'))).toBe(false)
    } finally {
      restartLeader('file-edit')
    }
    // A remote clone cannot carry the identity, so the host refuses it.
    const clone = spawnSync(binary, ['clone', '--codsh-remote-lifeline', '--', 'https://example.invalid/r.git', join(remote.ws, 'r')], {
      env: { ...remote.env, SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22' }, encoding: 'utf8', timeout: 30000,
    })
    expect(clone.status).toBe(2)
    expect(clone.stderr).toMatch(/cannot carry/)
  }, 180000)
})

describe.skipIf(!skipReason)('organization identity for remote workspaces (skipped)', () => {
  it.skip(`needs Hydra and OpenSSH: ${skipReason}`, () => {})
})
