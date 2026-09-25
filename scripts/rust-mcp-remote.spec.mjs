// Remote MCP servers end to end (ticket 168): config -> codsh-rust plan ->
// codsh remote proxy (streamable HTTP / legacy SSE, OAuth, elicitation,
// content projection) -> real dsh MCP client -> ACP / plain output.
// Servers are keyless loopback processes: the repo fixture
// (e2e/fixtures/rust-mcp-remote-fixture.mjs) and the MCP TypeScript SDK's
// own example servers with their demo OAuth authorization server. The
// "browser" is a script that fetches the authorization URL and follows the
// redirect to codsh's loopback callback. dsh executes with the mock model.
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'

const require = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const binary = join(repo, 'rust/target/debug/codsh-rust')
const fixture = join(repo, 'e2e/fixtures/rust-mcp-remote-fixture.mjs')
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

// The MCP TypeScript SDK that dsh's own MCP client ships (lockfile-pinned).
function sdkExamples() {
  const client = createRequire(require.resolve('@deepseek-ai/dsh/package.json')).resolve('@deepseek-ai/dsh-mcp-client/package.json')
  const main = createRequire(client).resolve('@modelcontextprotocol/sdk/server/mcp.js')
  return join(main.slice(0, main.lastIndexOf('/dist/') + 6), 'esm/examples/server')
}

function sandbox(config = '') {
  const root = mkdtempSync(join('/tmp', 'codsh-mcp-remote-'))
  const isolated = join(root, 'isolated')
  const cwd = join(root, 'workspace')
  mkdirSync(join(isolated, 'dsh'), { recursive: true })
  mkdirSync(join(isolated, '.grok'), { recursive: true })
  mkdirSync(cwd)
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const browser = join(root, 'browser.mjs')
  const browserLog = join(root, 'browser.log')
  writeFileSync(browser, [
    "import { appendFileSync } from 'node:fs'",
    'const url = process.argv[2]',
    `appendFileSync(${JSON.stringify(browserLog)}, url + '\\n')`,
    "const res = await fetch(url, { redirect: 'follow' })",
    `appendFileSync(${JSON.stringify(browserLog)}, 'status ' + res.status + ' ' + (await res.text()).slice(0, 200).replace(/\\s+/g, ' ') + '\\n')`,
  ].join('\n'))
  const configPath = join(isolated, '.grok', 'config.toml')
  writeFileSync(configPath, config)
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: isolated,
    USERPROFILE: isolated,
    DSH_HOME: join(isolated, 'dsh'),
    GROK_HOME: join(isolated, '.grok'),
    DSH_BIN: dshPath(),
    CODSH_NODE: process.execPath,
    CODSH_ACP_PATCH: overlay,
    DSH_CODE_CLI_MOCK_TOOL: 'mcp',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'OFF',
    DEEPSEEK_API_KEY: '',
    CODSH_UPDATE_CHECK: 'off',
    CODSH_SESSION_READ: sessionRead,
    BROWSER: `${process.execPath} ${browser}`,
    ...extra,
  })
  const browsed = () => existsSync(browserLog) ? readFileSync(browserLog, 'utf8') : ''
  return { root, isolated, cwd, configPath, env, browsed, grokHome: join(isolated, '.grok') }
}

function run(box, args, extra = {}) {
  const result = spawnSync(binary, args, { cwd: box.cwd, env: box.env(extra), encoding: 'utf8', timeout: 150000 })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function done(result) {
  const at = result.stdout.indexOf('RUST_ACP_MCP_DONE')
  return at < 0 ? `(no summary) ${result.stdout}\n${result.stderr}` : result.stdout.slice(at).trim()
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

async function stopChild(child) {
  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGTERM')
    await new Promise(finish => { child.once('exit', finish); setTimeout(finish, 5000) })
  }
}

// The repo fixture on a loopback port; resolves with its base URL.
async function startFixture(box, flags = []) {
  const dir = join(box.root, `fixture-${cleanups.length}`)
  mkdirSync(dir)
  const child = spawn(process.execPath, [fixture, ...flags], { env: { ...process.env, MCP_REMOTE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => stopChild(child))
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not start')), 10000)
    createInterface({ input: child.stdout }).on('line', line => {
      const match = /^LISTENING (\d+)$/.exec(line)
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
    })
    child.once('exit', code => reject(new Error(`fixture exited ${code}`)))
  })
  const lines = file => existsSync(join(dir, file))
    ? readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  return { base: `http://127.0.0.1:${port}`, dir, lines }
}

// A MCP TypeScript SDK example server; resolves once it listens.
async function startSdkExample(script, flags, env, ready) {
  const child = spawn(process.execPath, [join(sdkExamples(), script), ...flags], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => stopChild(child))
  const output = []
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} did not start: ${output.join('')}`)), 20000)
    const onData = chunk => {
      output.push(String(chunk))
      if (ready.test(output.join(''))) { clearTimeout(timer); resolveReady() }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', code => reject(new Error(`${script} exited ${code}: ${output.join('')}`)))
  })
  return { child, output }
}

// An editor on `agent stdio`: answers permission prompts and MCP
// elicitations with the test's callbacks and records every message.
function acpClient(box, args = ['--permission-mode', 'ask', 'agent', 'stdio']) {
  const child = spawn(binary, args, { cwd: box.cwd, env: box.env(), stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const updates = []
  const inbound = []
  const stderr = []
  let onElicit = () => ({ result: { outcome: 'decline' } })
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    inbound.push(msg)
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.method === 'session/request_permission') {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })}\n`)
    }
    if (msg.method === 'x.ai/mcp/elicit' && msg.id != null) {
      Promise.resolve(onElicit(msg.params)).then(answer => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...answer })}\n`)
      })
    }
    if (msg.method == null && msg.id != null && pending.has(String(msg.id))) {
      const waiter = pending.get(String(msg.id))
      pending.delete(String(msg.id))
      if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message), { error: msg.error }))
      else waiter.resolve(msg.result)
    }
  })
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  let next = 1
  const send = (method, params, timeout = 90000) => new Promise((resolvePromise, reject) => {
    const id = next++
    pending.set(String(id), { resolve: resolvePromise, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => {
      if (pending.has(String(id))) {
        pending.delete(String(id))
        reject(new Error(`timeout ${method}: ${stderr.join('')}`))
      }
    }, timeout)
  })
  cleanups.push(async () => {
    if (child.exitCode == null) {
      child.stdin.end()
      await stopChild(child)
    }
  })
  return { child, send, updates, inbound, stderr, onElicitation(fn) { onElicit = fn } }
}

function agentText(updates, since = 0) {
  return updates.slice(since)
    .filter(item => item.update?.sessionUpdate === 'agent_message_chunk')
    .map(item => item.update.content?.text ?? '')
    .join('')
}

async function until(predicate, what, timeout = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await new Promise(finish => setTimeout(finish, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const remote = (name, url, extra = '') => `[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\n${extra}`

describe('codsh-rust remote MCP (loopback fixture, real dsh)', () => {
  it('signs in with OAuth + PKCE, refreshes an expired token, survives session loss, projects images and signs out', async () => {
    const box = sandbox()
    const server = await startFixture(box, ['--oauth'])
    writeFileSync(box.configPath, remote('rem', `${server.base}/mcp`))

    const before = run(box, ['--always-approve', '-p', 'MCP_TOOLS'])
    expect(before.stderr + before.stdout).toContain('authentication required: run /mcps auth rem (or `codsh --rust mcp login rem`)')
    expect(before.stdout).not.toContain('mcp__rem__')

    const login = run(box, ['mcp', 'login', 'rem'])
    expect(login.code, login.stderr).toBe(0)
    expect(login.stderr + login.stdout).toContain(`${server.base}/authorize?`)
    expect(login.stdout + login.stderr).toContain("Signed in to MCP server 'rem'")
    await until(() => /status 200 .*Authorization Complete/.test(box.browsed()), 'the browser to see the callback page', 10000)
    const events = server.lines('oauth.log')
    expect(events.map(event => event.event)).toEqual(['register', 'authorize', 'token'])
    expect(events[0].token_endpoint_auth_method).toBe('none')
    expect(events[1].resource).toBe(`${server.base}/mcp`)
    const store = join(box.grokHome, 'mcp_credentials.json')
    expect(statSync(store).mode & 0o777).toBe(0o600)
    expect(readFileSync(box.configPath, 'utf8')).not.toContain('token')
    expect(run(box, ['mcp', 'list']).stdout).toContain('OAuth signed in')

    const calls = run(box, ['--always-approve', '-p', [
      'MCP_CALL mcp__rem__echo {"text":"hi"}',
      'MCP_CALL mcp__rem__picture {}',
      'MCP_CALL mcp__rem__ask_name {}',
      'MCP_CALL mcp__rem__expire_tokens {}',
      'MCP_CALL mcp__rem__echo {"text":"after refresh"}',
      'MCP_CALL mcp__rem__forget_session {}',
      'MCP_CALL mcp__rem__echo {"text":"new session"}',
    ].join(' THEN ')], { DSH_CODE_CLI_MOCK_IMAGE: '1' })
    const summary = done(calls)
    expect(summary).toContain('OK:echo:hi')
    // The image reaches dsh as an image block, not as text.
    // dsh stores it as an attachment (it may re-encode it, e.g. to WebP).
    expect(summary).toMatch(/OK:a picture\n\[image image\/\w+ 1x1\]/)
    // Headless -p has no one to ask: elicitation is not advertised.
    expect(summary).toContain('ERR:Error: client did not advertise elicitation')
    expect(server.lines('capabilities.log').every(caps => caps.elicitation === undefined)).toBe(true)
    expect(summary).toContain('OK:echo:after refresh')
    expect(summary).toContain('OK:echo:new session')
    expect(server.lines('oauth.log').filter(event => event.grant === 'refresh_token')).toHaveLength(1)
    const requests = server.lines('requests.log')
    expect(requests.every(request => request.http === 'DELETE' || request.bearer)).toBe(true)
    // Session loss (404) re-initialized once, then the call went through.
    const inits = requests.filter(request => request.rpc === 'initialize')
    expect(inits).toHaveLength(2)
    expect(new Set(requests.filter(request => request.rpc === 'tools/call').map(request => request.session)).size).toBe(2)
    expect(requests.filter(request => request.rpc && request.rpc !== 'initialize' && request.http === 'POST').every(request => request.session && request.protocol)).toBe(true)
    // The same call is never sent twice.
    expect(server.lines('calls.log').filter(entry => entry.input?.text === 'after refresh')).toHaveLength(1)

    const logout = run(box, ['mcp', 'logout', 'rem'])
    expect(logout.code, logout.stderr).toBe(0)
    expect(server.lines('oauth.log').filter(event => event.event === 'revoke').length).toBeGreaterThanOrEqual(1)
    expect(run(box, ['mcp', 'list']).stdout).not.toContain('OAuth signed in')
    const after = run(box, ['--always-approve', '-p', 'MCP_TOOLS'])
    expect(after.stderr + after.stdout).toContain('authentication required')
  }, 240000)

  it('speaks legacy SSE, fills the session placeholder header, refuses redirects and never puts headers in argv', async () => {
    const box = sandbox()
    const server = await startFixture(box)
    writeFileSync(box.configPath, [
      remote('old', `${server.base}/sse`, 'headers = { "X-Codsh-Session" = "${session_id}", "X-Api-Key" = "fixture-secret" }\n'),
      remote('moved', `${server.base}/moved`),
    ].join(''))
    const listed = run(box, ['mcp', 'list', '--json'])
    const rows = JSON.parse(listed.stdout)
    expect(JSON.stringify(rows)).toContain('"sse"')
    const result = run(box, ['--always-approve', '-p', 'MCP_CALL mcp__old__whoami {} THEN MCP_CALL mcp__old__echo {"text":"legacy"}'])
    const summary = done(result)
    const seen = JSON.parse(/OK:(\{.*?\})/.exec(summary)[1])
    expect(seen.transport).toBe('sse')
    expect(seen.codshSession).toMatch(/\S/)
    expect(seen.codshSession).not.toContain('${')
    expect(summary).toContain('OK:echo:legacy')
    expect(result.stderr + result.stdout).toMatch(/MCP server moved failed: .*HTTP 307.*redirects are not followed/)
    const runs = join(box.isolated, 'dsh', 'mcp')
    const runDir = readdirSync(runs).map(name => join(runs, name)).find(dir => existsSync(join(dir, 'plan.json')))
    expect(readFileSync(join(runDir, 'plan.json'), 'utf8')).not.toContain('fixture-secret')
    const remoteConfig = join(runDir, 'old.remote.json')
    expect(statSync(remoteConfig).mode & 0o777).toBe(0o600)
    expect(readFileSync(remoteConfig, 'utf8')).toContain('fixture-secret')
  }, 180000)

  it('forwards form and URL elicitations to the editor and serves auth_status, auth_trigger and read_resource', async () => {
    const box = sandbox()
    const server = await startFixture(box, ['--oauth'])
    writeFileSync(box.configPath, remote('rem', `${server.base}/mcp`))
    const client = acpClient(box)
    const init = await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const extensions = init.agentCapabilities._meta['codsh/extensions']
    for (const method of ['x.ai/mcp/auth_status', 'x.ai/mcp/auth_trigger', 'x.ai/mcp/read_resource', 'x.ai/mcp/elicit', 'x.ai/mcp/elicit_complete']) {
      expect(extensions[method]?.status, method).toBe('supported')
    }
    const { sessionId } = await client.send('session/new', { cwd: box.cwd, mcpServers: [] })
    let status
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await client.send('x.ai/mcp/auth_status', { session_id: sessionId })
      if (status.servers.length) break
      await new Promise(finish => setTimeout(finish, 200))
    }
    expect(status).toEqual({ servers: [{ server_name: 'rem', status: 'needs_auth' }] })
    await expect(client.send('x.ai/mcp/auth_trigger', { session_id: sessionId })).rejects.toThrow(/server_name is required/)
    expect(await client.send('x.ai/mcp/auth_trigger', { session_id: sessionId, server_name: 'nope' })).toMatchObject({ status: 'failed', error: expect.stringContaining('not found') })
    expect(await client.send('x.ai/mcp/auth_trigger', { session_id: sessionId, server_name: 'rem' }, 90000)).toEqual({ status: 'authenticated' })
    expect(box.browsed()).toContain(`${server.base}/authorize?`)
    expect(await client.send('x.ai/mcp/auth_status', { session_id: sessionId })).toEqual({ servers: [{ server_name: 'rem', status: 'authenticated' }] })

    const prompt = async text => {
      const since = client.updates.length
      const result = await client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 150000)
      return { result, text: agentText(client.updates, since) }
    }
    // The sign-in restarted the session's MCP servers: the tools are there.
    expect((await prompt('MCP_TOOLS')).text).toContain('mcp__rem__ask_name')

    const asked = []
    client.onElicitation(params => {
      asked.push(params)
      return params.mode === 'form'
        ? { result: { outcome: 'accept', content: { name: 'Ann', color: 'blue' } } }
        : { result: { outcome: 'accept' } }
    })
    const answered = await prompt('MCP_CALL mcp__rem__ask_name {} THEN MCP_CALL mcp__rem__open_link {}')
    expect(answered.text).toContain('OK:hello Ann (blue)')
    expect(answered.text).toContain('OK:url accepted')
    expect(asked[0]).toMatchObject({ sessionId, serverName: 'rem', message: 'Who is asking?', mode: 'form' })
    expect(asked[0].toolCallId).toMatch(/^mcp-elicit-\d+$/)
    expect(asked[0].requestedSchema.required).toEqual(['name'])
    expect(asked[1]).toMatchObject({ sessionId, serverName: 'rem', mode: 'url' })
    expect(asked[1].url).toBe(`${server.base}/confirm/${asked[1].elicitationId}`)
    await until(() => client.inbound.some(msg => msg.method === 'x.ai/mcp/elicit_complete' && msg.params.elicitationId === asked[1].elicitationId), 'elicit_complete')
    expect(server.lines('capabilities.log').at(-1).elicitation).toEqual({ form: {}, url: {} })

    // An editor error declines; content that breaks the schema never reaches
    // the server; cancel cancels.
    client.onElicitation(() => ({ error: { code: -32603, message: 'editor failed' } }))
    expect((await prompt('MCP_CALL mcp__rem__ask_name {}')).text).toContain('OK:declined')
    client.onElicitation(() => ({ result: { outcome: 'accept', content: { name: '', color: 'green' } } }))
    const invalid = await prompt('MCP_CALL mcp__rem__ask_name {}')
    expect(invalid.text).not.toContain('hello')
    expect(server.lines('calls.log').some(entry => entry.elicitation?.content?.color === 'green')).toBe(false)
    client.onElicitation(() => ({ result: { outcome: 'cancel' } }))
    expect((await prompt('MCP_CALL mcp__rem__ask_name {}')).text).toContain('OK:cancelled')

    const read = await client.send('x.ai/mcp/read_resource', { sessionId, server: 'rem', uri: 'fixture://readme' })
    expect(read.contents).toEqual([{ uri: 'fixture://readme', mimeType: 'text/plain', text: 'remote readme' }])
    await expect(client.send('x.ai/mcp/read_resource', { sessionId, server: 'rem', uri: 'fixture://missing' })).rejects.toThrow(/resource not found/)
    await expect(client.send('x.ai/mcp/read_resource', { sessionId, server: 'nope', uri: 'x' })).rejects.toThrow(/not mounted/)
  }, 360000)
})

describe('codsh-rust remote MCP against the MCP TypeScript SDK example server (real integration)', () => {
  it('signs in to simpleStreamableHttp --oauth-strict and answers its form elicitation from the editor', async () => {
    const box = sandbox()
    const mcpPort = await freePort()
    const authPort = await freePort()
    await startSdkExample('simpleStreamableHttp.js', ['--oauth', '--oauth-strict'], { MCP_PORT: String(mcpPort), MCP_AUTH_PORT: String(authPort) }, /MCP Streamable HTTP Server listening/)
    writeFileSync(box.configPath, remote('sdk', `http://localhost:${mcpPort}/mcp`))
    const login = run(box, ['mcp', 'login', 'sdk'])
    expect(login.code, login.stderr + login.stdout).toBe(0)
    expect(login.stdout + login.stderr).toContain(`http://localhost:${authPort}/authorize?`)
    // RFC 8707: --oauth-strict rejects tokens without this resource.
    expect(login.stdout + login.stderr).toContain(`resource=${encodeURIComponent(`http://localhost:${mcpPort}/mcp`)}`)
    expect(run(box, ['mcp', 'list']).stdout).toContain('OAuth signed in')

    const client = acpClient(box)
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await client.send('session/new', { cwd: box.cwd, mcpServers: [] })
    const asked = []
    client.onElicitation(params => {
      asked.push(params)
      return { result: { outcome: 'accept', content: { name: 'Ann Lee', email: 'ann@example.test' } } }
    })
    const since = client.updates.length
    await client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'MCP_CALL mcp__sdk__greet {"name":"Ann"} THEN MCP_CALL mcp__sdk__collect-user-info {"infoType":"contact"}' }] }, 150000)
    const text = agentText(client.updates, since)
    expect(text).toContain('OK:Hello, Ann!')
    expect(text).toContain('Collected contact information')
    expect(text).toContain('ann@example.test')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ serverName: 'sdk', mode: 'form', message: 'Please provide your contact information' })
    expect(asked[0].requestedSchema.properties.email.format).toBe('email')
    const read = await client.send('x.ai/mcp/read_resource', { sessionId, server: 'sdk', uri: 'https://example.com/greetings/default' })
    expect(read.contents).toEqual([{ uri: 'https://example.com/greetings/default', text: 'Hello, world!' }])

    const logout = run(box, ['mcp', 'logout', 'sdk'])
    expect(logout.code, logout.stderr).toBe(0)
    expect(run(box, ['mcp', 'list']).stdout).not.toContain('OAuth signed in')
  }, 240000)
})
