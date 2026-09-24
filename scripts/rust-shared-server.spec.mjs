// Shared service, multiple clients, and reconnect against real dsh.
// `agent serve` (authenticated WebSocket) and `agent leader` (local socket,
// reached through `agent --leader stdio`) route every client through one hub.
// dsh executes with a keyless deterministic mock; homes are temp dirs.
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'

const require = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const binary = join(repo, 'rust/target/debug/codsh-rust')
const sessionRead = join(repo, 'packages/cli/bin/rust-acp-session-read.mjs')
const cleanups = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function dshPath() {
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin
  return join(dirname(manifest), typeof bin === 'string' ? bin : bin.dsh)
}

function sandboxRoot() {
  const root = mkdtempSync(join('/tmp', 'codsh-shared-'))
  const isolated = join(root, 'isolated')
  const cwd = join(root, 'workspace')
  mkdirSync(join(isolated, 'dsh'), { recursive: true })
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'note.txt'), 'alpha\n')
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: isolated,
    USERPROFILE: isolated,
    DSH_HOME: join(isolated, 'dsh'),
    GROK_HOME: join(isolated, '.grok'),
    DSH_BIN: dshPath(),
    CODSH_NODE: process.execPath,
    CODSH_ACP_PATCH: overlay,
    DSH_CODE_CLI_MOCK_TOOL: 'file-edit',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'OFF',
    DEEPSEEK_API_KEY: '',
    CODSH_UPDATE_CHECK: 'off',
    CODSH_SESSION_READ: sessionRead,
    ...extra,
  })
  return { root, isolated, cwd, env }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(predicate, what, timeout = 20000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

// One JSON-RPC peer: collects every message, answers by id.
function peer(write, label) {
  const messages = []
  const pending = new Map()
  const state = { closed: false }
  return {
    label,
    messages,
    state,
    receive(line) {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      messages.push(msg)
      if (msg.method == null && msg.id != null && pending.has(String(msg.id))) {
        const waiter = pending.get(String(msg.id))
        pending.delete(String(msg.id))
        if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message), { error: msg.error }))
        else waiter.resolve(msg.result)
      }
    },
    request(id, method, params = {}) {
      return new Promise((resolve, reject) => {
        pending.set(String(id), { resolve, reject })
        write(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        setTimeout(() => {
          if (pending.has(String(id))) {
            pending.delete(String(id))
            reject(new Error(`${label}: timeout ${method}`))
          }
        }, 30000)
      })
    },
    reply(id, result) {
      write(JSON.stringify({ jsonrpc: '2.0', id, result }))
    },
    notifications(method) {
      return messages.filter(msg => msg.method === method && msg.id == null)
    },
    requests(method) {
      return messages.filter(msg => msg.method === method && msg.id != null)
    },
    updates(kind) {
      return messages
        .filter(msg => msg.method === 'session/update')
        .map(msg => msg.params)
        .filter(params => kind == null || params.update.sessionUpdate === kind)
    },
    waitFor(predicate, what) {
      return until(() => messages.find(predicate), `${label}: ${what}`)
    },
  }
}

function wsClient(url, label) {
  const socket = new WebSocket(url)
  const client = peer(line => socket.send(line), label)
  socket.addEventListener('message', event => client.receive(String(event.data)))
  socket.addEventListener('close', () => { client.state.closed = true })
  client.socket = socket
  client.opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  client.close = () => socket.close()
  cleanups.push(() => { try { socket.close() } catch {} })
  return client
}

function stdioClient(args, env, cwd, label) {
  const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const client = peer(line => child.stdin.write(`${line}\n`), label)
  const stderr = []
  createInterface({ input: child.stdout }).on('line', line => client.receive(line))
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  client.child = child
  client.stderr = stderr
  client.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  cleanups.push(() => { if (child.exitCode == null) child.kill('SIGKILL') })
  return client
}

// Raw upgrade request, so auth failures and the Bearer header are visible.
function rawUpgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    let data = ''
    socket.on('data', chunk => {
      data += String(chunk)
      if (data.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(data)
      }
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(data))
  })
}

const init = { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'shared-test', version: '0' } }
const allow = { outcome: { outcome: 'selected', optionId: 'allow-once' } }

function editPrompt(sessionId) {
  return { sessionId, prompt: [{ type: 'text', text: 'edit the note' }] }
}

function completedEdits(client, since = 0) {
  return client.messages.slice(since).filter(msg => msg.method === 'session/update'
    && msg.params.update.sessionUpdate === 'tool_call_update'
    && msg.params.update.toolCallId === 'rust-acp-edit'
    && msg.params.update.status === 'completed')
}

describe('shared agent service against real dsh', () => {
  it('serves several authenticated WebSocket clients with one executor per session', async () => {
    expect(existsSync(binary), 'cargo build -p codsh-rust first').toBe(true)
    const box = sandboxRoot()
    const secret = 'test-secret-148'
    const server = spawn(binary, ['--permission-mode', 'ask', 'agent', 'serve', '--bind', '127.0.0.1:0', '--secret', secret, '--debug'], {
      cwd: box.cwd,
      env: box.env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', chunk => serverErr.push(String(chunk)))
    const serverExit = new Promise(resolve => server.on('exit', (code, signal) => resolve({ code, signal })))
    cleanups.push(() => { if (server.exitCode == null) server.kill('SIGKILL') })
    const address = await until(() => serverErr.join('').match(/Address: 127\.0\.0\.1:(\d+)/), 'server address')
    const port = Number(address[1])
    const banner = serverErr.join('')
    expect(banner).toContain('Secret: (from --secret)')
    expect(banner).not.toContain(secret)

    // Authentication: nothing gets through without the secret.
    expect(await rawUpgrade(port, '/ws')).toMatch(/^HTTP\/1\.1 401/)
    expect(await rawUpgrade(port, '/ws?server-key=wrong')).toMatch(/^HTTP\/1\.1 401/)
    expect(await rawUpgrade(port, '/ws', { Authorization: 'Bearer wrong' })).toMatch(/^HTTP\/1\.1 401/)
    expect(await rawUpgrade(port, `/other?server-key=${secret}`)).toMatch(/^HTTP\/1\.1 404/)
    const bearer = await rawUpgrade(port, '/ws', { Authorization: `Bearer ${secret}` })
    expect(bearer).toMatch(/^HTTP\/1\.1 101/)
    expect(bearer).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')

    const url = `ws://127.0.0.1:${port}/ws?server-key=${secret}`
    const a = wsClient(url, 'A')
    await a.opened
    const initA = await a.request(1, 'initialize', init)
    const serverMeta = initA.agentCapabilities._meta['codsh/server']
    expect(serverMeta).toMatchObject({ transport: 'websocket', shared: true, executor: 'dsh', endpoint: `ws://127.0.0.1:${port}/ws` })
    expect(serverMeta.notifications).toEqual(expect.arrayContaining(['_codsh/prompt_complete', '_codsh/permission_resolved', '_codsh/stale_response', '_codsh/runtime_exited']))
    expect(initA.agentCapabilities._meta['codsh/upstream'].agent).toBe('dsh')
    const created = await a.request(2, 'session/new', { cwd: box.cwd, mcpServers: [] })
    const sessionId = created.sessionId

    const b = wsClient(url, 'B')
    await b.opened
    await b.request(1, 'initialize', init)
    const attached = await b.request(2, 'session/load', { sessionId, cwd: box.cwd, mcpServers: [] })
    expect(attached._meta['codsh/attached']).toBe(true)
    expect(attached._meta['codsh/turn'].running).toBe(false)
    // The same client loading its own live session is still refused.
    await expect(a.request(3, 'session/load', { sessionId, cwd: box.cwd, mcpServers: [] })).rejects.toThrow(/already active/)

    // Turn 1: A submits, both see the approval, B answers first.
    const turn = a.request(4, 'session/prompt', editPrompt(sessionId))
    const askA = await a.waitFor(msg => msg.method === 'session/request_permission', 'permission')
    const askB = await b.waitFor(msg => msg.method === 'session/request_permission', 'permission')
    expect(askA.id).toBe(askB.id)
    expect(String(askA.id)).toMatch(/^codsh-approval-/)
    // A competing prompt is refused while the turn runs; nothing is queued.
    await expect(b.request(3, 'session/prompt', editPrompt(sessionId))).rejects.toThrow(/already in flight/)
    await expect(b.request(4, 'session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'high' })).rejects.toThrow(/prompt is running/)
    b.reply(askB.id, allow)
    const resolved = await a.waitFor(msg => msg.method === '_codsh/permission_resolved', 'resolved')
    expect(resolved.params).toMatchObject({ sessionId, requestId: askA.id, outcome: 'selected', optionId: 'allow-once' })
    a.reply(askA.id, allow)
    const stale = await a.waitFor(msg => msg.method === '_codsh/stale_response', 'stale notice')
    expect(stale.params.requestId).toBe(askA.id)
    expect((await turn).stopReason).toBe('end_turn')
    const complete = await b.waitFor(msg => msg.method === '_codsh/prompt_complete', 'prompt complete')
    expect(complete.params).toMatchObject({ sessionId, stopReason: 'end_turn' })
    expect(readFileSync(join(box.cwd, 'note.txt'), 'utf8')).toBe('ALPHA\n')
    expect(completedEdits(a)).toHaveLength(1)
    expect(completedEdits(b)).toHaveLength(1)
    expect(a.requests('session/request_permission')).toHaveLength(1)
    // Both observers saw the submitter's text as the user chunk.
    expect(b.updates('user_message_chunk').some(update => update.update.content.text.includes('edit the note'))).toBe(true)

    // Option changes reach every attached client with the same list.
    const changed = await b.request(5, 'session/set_config_option', { sessionId, configId: 'permission_mode', value: 'dontAsk' })
    expect(changed.configOptions.find(option => option.id === 'permission_mode').currentValue).toBe('dontAsk')
    const broadcast = await a.waitFor(msg => msg.method === 'session/update' && msg.params.update.sessionUpdate === 'config_option_update', 'config update')
    expect(broadcast.params.update.configOptions.find(option => option.id === 'permission_mode').currentValue).toBe('dontAsk')
    expect(readFileSync(join(box.isolated, 'dsh', 'session-owners', `${sessionId}.mode`), 'utf8').trim()).toBe('dontAsk')
    await b.request(6, 'session/set_config_option', { sessionId, configId: 'permission_mode', value: 'ask' })

    // Turn 2, in a second session both clients watch: A disconnects while
    // its approval waits. The turn keeps running; a reconnect attaches and
    // gets the same request again.
    writeFileSync(join(box.cwd, 'note.txt'), 'alpha\n')
    const next = await a.request(7, 'session/new', { cwd: box.cwd, mcpServers: [] })
    const secondId = next.sessionId
    await b.request(7, 'session/load', { sessionId: secondId, cwd: box.cwd, mcpServers: [] })
    const mark = b.messages.length
    a.request(8, 'session/prompt', editPrompt(secondId)).catch(() => {})
    const pendingAsk = await until(() => b.messages.slice(mark).find(msg => msg.method === 'session/request_permission'), 'second permission')
    a.close()
    await until(() => a.state.closed, 'A closed')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(readFileSync(join(box.cwd, 'note.txt'), 'utf8')).toBe('alpha\n')
    const again = wsClient(url, 'A2')
    await again.opened
    await again.request(1, 'initialize', init)
    const reattached = await again.request(2, 'session/load', { sessionId: secondId, cwd: box.cwd, mcpServers: [] })
    expect(reattached._meta['codsh/turn'].running).toBe(true)
    // The running turn so far comes from memory, not as saved history.
    expect(again.updates('user_message_chunk').some(update => update.update.content.text.includes('edit the note')
      && !String(update.update.messageId).startsWith('restored-'))).toBe(true)
    const resent = await again.waitFor(msg => msg.method === 'session/request_permission', 'resent permission')
    expect(resent.id).toBe(pendingAsk.id)
    const info = await again.request(3, '_codsh/leader/info')
    const live = info.sessions.find(session => session.sessionId === secondId)
    expect(live).toMatchObject({ turnRunning: true, approvalPending: true })
    expect(live.attachedClients).toHaveLength(2)
    again.reply(resent.id, allow)
    await again.waitFor(msg => msg.method === '_codsh/prompt_complete', 'second completion')
    await until(() => b.messages.slice(mark).find(msg => msg.method === '_codsh/prompt_complete'), 'B second completion')
    expect(readFileSync(join(box.cwd, 'note.txt'), 'utf8')).toBe('ALPHA\n')
    expect(completedEdits(b, mark)).toHaveLength(1)
    expect(b.messages.slice(mark).filter(msg => msg.method === 'session/request_permission')).toHaveLength(1)

    // The dsh runtime dies: that is not a client disconnect. Clients are
    // told, the server keeps serving, and a later load starts a fresh dsh.
    const runtimePid = live.runtimePid
    expect(alive(runtimePid)).toBe(true)
    process.kill(runtimePid, 'SIGKILL')
    const exited = await b.waitFor(msg => msg.method === '_codsh/runtime_exited', 'runtime exited')
    expect(exited.params).toMatchObject({ sessionId: secondId, turnInterrupted: false })
    await again.waitFor(msg => msg.method === '_codsh/runtime_exited', 'runtime exited on A2')
    await expect(b.request(8, 'session/prompt', editPrompt(secondId))).rejects.toThrow(/unknown session/)
    const c = wsClient(url, 'C')
    await c.opened
    await c.request(1, 'initialize', init)
    const reloaded = await c.request(2, 'session/load', { sessionId: secondId, cwd: box.cwd, mcpServers: [] })
    expect(reloaded._meta?.['codsh/attached']).toBeUndefined()
    const after = await c.request(3, '_codsh/leader/info')
    const fresh = after.sessions.find(session => session.sessionId === secondId)
    expect(fresh.runtimePid).not.toBe(runtimePid)
    await expect(c.request(4, '_codsh/leader/shutdown')).rejects.toThrow(/only a leader/)

    server.kill('SIGTERM')
    const stopped = await serverExit
    expect(stopped.code, JSON.stringify(stopped)).toBe(143)
    await until(() => !alive(fresh.runtimePid), 'dsh stopped with the server', 5000)
  }, 180000)

  it('shares one per-user leader between stdio editors and manages it', async () => {
    expect(existsSync(binary), 'cargo build -p codsh-rust first').toBe(true)
    const box = sandboxRoot()
    const socket = join(box.isolated, '.grok', 'leader.sock')
    const run = (args, extra = {}) => spawnSync(binary, args, { cwd: box.cwd, env: box.env(extra), encoding: 'utf8', timeout: 30000 })

    expect(run(['leader', 'list']).stderr).toContain('No leader candidates found.')
    // Policy belongs to the leader: a client cannot bring its own.
    const policy = run(['--permission-mode', 'always-approve', 'agent', '--leader', 'stdio'])
    expect(policy.status).not.toBe(0)
    expect(policy.stderr).toMatch(/--permission-mode cannot be used with the shared leader/)
    expect(existsSync(socket)).toBe(false)

    const a = stdioClient(['agent', '--leader', 'stdio'], box.env(), box.cwd, 'A')
    const initA = await a.request(1, 'initialize', init)
    expect(initA.agentCapabilities._meta['codsh/server']).toMatchObject({ transport: 'leader', shared: true, endpoint: socket })
    const leaderPid = initA.agentCapabilities._meta['codsh/server'].pid
    expect(leaderPid).not.toBe(a.child.pid)
    expect(statSync(socket).mode & 0o777).toBe(0o600)
    const { sessionId } = await a.request(2, 'session/new', { cwd: box.cwd, mcpServers: [] })

    const listed = JSON.parse(run(['leader', 'list', '--json']).stdout)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ pid: leaderPid, pidFromLock: leaderPid, pidLive: true, classification: 'live', socketPath: socket })
    expect(run(['leader', 'list']).stderr).toContain(`  PID ${leaderPid} (live) -- ${socket}`)

    // `[cli] use_leader` makes plain `agent stdio` a leader client too.
    mkdirSync(join(box.isolated, '.grok'), { recursive: true })
    writeFileSync(join(box.isolated, '.grok', 'config.toml'), '[cli]\nuse_leader = true\n')
    const b = stdioClient(['agent', 'stdio'], box.env(), box.cwd, 'B')
    const initB = await b.request(1, 'initialize', init)
    expect(initB.agentCapabilities._meta['codsh/server'].pid).toBe(leaderPid)
    await b.request(2, 'session/load', { sessionId, cwd: box.cwd, mcpServers: [] })
    const infoJson = JSON.parse(run(['leader', 'info', '--json']).stdout)
    expect(infoJson.pid).toBe(leaderPid)
    expect(infoJson.sessions[0]).toMatchObject({ sessionId, turnRunning: false })
    expect(infoJson.sessions[0].attachedClients).toHaveLength(2)
    expect(run(['leader', 'info', '--pid', String(leaderPid)]).stdout).toContain(`Leader pid ${leaderPid}`)
    // --no-leader wins over the config default.
    const local = stdioClient(['agent', '--no-leader', 'stdio'], box.env(), box.cwd, 'local')
    const initLocal = await local.request(1, 'initialize', init)
    expect(initLocal.agentCapabilities._meta['codsh/server']).toMatchObject({ transport: 'stdio', shared: false })
    local.child.stdin.end()
    await local.exited

    // One approval, answered once, through the leader.
    const turn = a.request(3, 'session/prompt', editPrompt(sessionId))
    const ask = await b.waitFor(msg => msg.method === 'session/request_permission', 'permission via leader')
    b.reply(ask.id, allow)
    expect((await turn).stopReason).toBe('end_turn')
    await b.waitFor(msg => msg.method === '_codsh/prompt_complete', 'completion via leader')
    expect(readFileSync(join(box.cwd, 'note.txt'), 'utf8')).toBe('ALPHA\n')
    expect(completedEdits(a)).toHaveLength(1)

    // Editors leave; the leader stops by itself after its grace period.
    a.child.stdin.end()
    b.child.stdin.end()
    expect((await a.exited).code).toBe(0)
    expect((await b.exited).code).toBe(0)
    await until(() => !alive(leaderPid) && !existsSync(socket), 'idle leader exit', 15000)
    expect(run(['leader', 'list']).stderr).toContain('No leader candidates found.')

    // A lost leader fails the waiting request; nothing is retried.
    const slow = { DSH_CODE_CLI_MOCK_TOOL: 'echo', DSH_CODE_CLI_MOCK_DELAY_MS: '8000' }
    const c = stdioClient(['agent', '--leader', 'stdio'], box.env(slow), box.cwd, 'C')
    const initC = await c.request(1, 'initialize', init)
    const secondPid = initC.agentCapabilities._meta['codsh/server'].pid
    expect(secondPid).not.toBe(leaderPid)
    const second = await c.request(2, 'session/new', { cwd: box.cwd, mcpServers: [] })
    const lost = c.request(3, 'session/prompt', { sessionId: second.sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await until(() => {
      const state = run(['leader', 'info', '--json'])
      return state.status === 0 && JSON.parse(state.stdout).sessions.some(session => session.turnRunning)
    }, 'turn running in the leader')
    const killed = run(['leader', 'kill'])
    expect(killed.stderr).toContain('Killed 1 leader process(es).')
    await expect(lost).rejects.toThrow(/leader .* disconnected; this request's outcome is unknown and it was not retried/)
    await c.waitFor(msg => msg.method === '_codsh/leader_disconnected', 'leader disconnected notice')
    expect((await c.exited).code).toBe(1)
    await until(() => !alive(secondPid), 'killed leader gone', 10000)
    expect(existsSync(socket)).toBe(false)
    expect(run(['leader', 'kill']).stderr).toContain('No live leader processes found.')
  }, 180000)

  it('keeps a sandboxed session out of the shared leader', async () => {
    const box = sandboxRoot()
    // Apply the profile for real first. Hosts without the kernel pieces the
    // workspace profile needs refuse startup, which is the other safe outcome.
    const probe = spawnSync(binary, ['--sandbox', 'workspace', 'agent', '--no-leader', 'stdio'], { cwd: box.cwd, env: box.env(), encoding: 'utf8', input: '', timeout: 30000 })
    if (probe.status !== 0) {
      expect(probe.stderr).toMatch(/refusing sandbox profile workspace/)
      expect(existsSync(join(box.isolated, '.grok', 'leader.sock'))).toBe(false)
      console.warn(`sandbox veto not exercised on this host: ${probe.stderr.trim()}`)
      return
    }
    const client = stdioClient(['--sandbox', 'workspace', 'agent', '--leader', 'stdio'], box.env(), box.cwd, 'sandboxed')
    const initialized = await client.request(1, 'initialize', init)
    expect(initialized.agentCapabilities._meta['codsh/server']).toMatchObject({ transport: 'stdio', shared: false })
    expect(client.stderr.join('')).toContain("note: sandbox profile 'workspace' was requested, so leader mode is off for this session")
    expect(existsSync(join(box.isolated, '.grok', 'leader.sock'))).toBe(false)
    client.child.stdin.end()
    await client.exited
  }, 60000)
})
