// Keyless local substitutes for ticket 191 clone tests: bare git repositories,
// a loopback HTTP git server (git http-backend behind Basic auth), and an
// unprivileged OpenSSH server on 127.0.0.1. Nothing here reaches a network
// service or needs a paid account.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'

export function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
  }).trim()
}

/**
 * A bare repository with main (2 commits, tag v1), dev (one more commit),
 * note.txt = "alpha" on main, and app/ plus docs/ for sparse cones. Partial
 * clone is allowed, as on common hosts.
 */
export function makeBareRepo(root, name = 'repo') {
  const work = join(root, `${name}-src`)
  mkdirSync(join(work, 'app'), { recursive: true })
  mkdirSync(join(work, 'docs'))
  git(root, ['init', '-q', '-b', 'main', work])
  const id = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false']
  writeFileSync(join(work, 'note.txt'), 'first\n')
  writeFileSync(join(work, 'app', 'main.txt'), 'app\n')
  writeFileSync(join(work, 'docs', 'guide.txt'), 'docs\n')
  git(work, ['add', '-A'])
  git(work, [...id, 'commit', '-qm', 'one'])
  writeFileSync(join(work, 'note.txt'), 'alpha\n')
  git(work, [...id, 'commit', '-qam', 'two'])
  git(work, [...id, 'tag', 'v1'])
  git(work, ['checkout', '-qb', 'dev'])
  writeFileSync(join(work, 'dev.txt'), 'dev\n')
  git(work, ['add', 'dev.txt'])
  git(work, [...id, 'commit', '-qm', 'dev'])
  git(work, ['checkout', '-q', 'main'])
  const bare = join(root, `${name}.git`)
  git(root, ['clone', '-q', '--bare', work, bare])
  git(bare, ['config', 'uploadpack.allowFilter', 'true'])
  git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
  git(bare, ['config', 'http.receivepack', 'false'])
  return bare
}

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
    server.on('error', reject)
  })
}

export async function until(predicate, what, timeout = 30000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(done => setTimeout(done, 50))
  }
}

/**
 * Smart-HTTP git over loopback. `token` is the only accepted credential
 * (Basic `x-access-token:<token>`); `hold` delays pack responses so a clone
 * can be cancelled mid-transfer. `seen` records each request's auth header.
 */
export async function startGitHttp(projectRoot, { token = null } = {}) {
  const state = { seen: [], hold: 0, children: new Set() }
  const server = createHttpServer((req, res) => {
    const auth = req.headers.authorization ?? null
    state.seen.push({ url: req.url, method: req.method, auth })
    if (token !== null) {
      const wanted = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
      if (auth !== wanted) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' })
        res.end('unauthorized\n')
        return
      }
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    const serve = () => {
      const child = spawn('git', ['http-backend'], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          GIT_CONFIG_NOSYSTEM: '1',
          REQUEST_METHOD: req.method,
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
          GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
          REMOTE_ADDR: '127.0.0.1',
        },
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      state.children.add(child)
      child.on('exit', () => state.children.delete(child))
      req.pipe(child.stdin)
      let head = Buffer.alloc(0)
      let started = false
      child.stdout.on('data', chunk => {
        if (started) {
          res.write(chunk)
          return
        }
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end < 0) return
        const headers = {}
        let status = 200
        for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
          const colon = line.indexOf(':')
          if (colon < 0) continue
          const key = line.slice(0, colon).trim()
          const value = line.slice(colon + 1).trim()
          if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10)
          else headers[key] = value
        }
        res.writeHead(status, headers)
        started = true
        res.write(head.subarray(end + 4))
      })
      child.stdout.on('end', () => res.end())
    }
    if (state.hold > 0 && req.method === 'POST') setTimeout(serve, state.hold)
    else serve()
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  return {
    url: name => `http://127.0.0.1:${port}/${name}`,
    state,
    close: () => new Promise(done => {
      for (const child of state.children) child.kill('SIGKILL')
      server.closeAllConnections?.()
      server.close(() => done())
    }),
  }
}

export function findOpenssh() {
  if (process.platform === 'win32') return null
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

/** An unprivileged sshd on 127.0.0.1 with one authorized key, no forwarding. */
export async function startSshd(openssh, dir) {
  mkdirSync(dir, { recursive: true })
  const keys = {}
  for (const name of ['host_key', 'client_key', 'wrong_key']) {
    execFileSync(openssh.keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)])
    keys[name] = join(dir, name)
  }
  writeFileSync(join(dir, 'authorized_keys'), readFileSync(`${keys.client_key}.pub`))
  const port = await freePort()
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
  const sshd = spawn(openssh.sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], {
    env: { ...process.env, ...(openssh.libs ? { LD_LIBRARY_PATH: openssh.libs } : {}) },
    stdio: ['ignore', 'ignore', openSync(log, 'w')],
  })
  await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('Server listening'), 'sshd listening', 10000)
  return {
    port,
    keys,
    stop: () => {
      if (sshd.exitCode == null) sshd.kill('SIGTERM')
    },
    /** GIT_SSH_COMMAND for git over this server with an explicit key. */
    gitSsh: ({ identity = keys.client_key, knownHosts = keys.known_hosts } = {}) =>
      `${openssh.ssh} -F /dev/null -i ${identity} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts} -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR`,
  }
}
