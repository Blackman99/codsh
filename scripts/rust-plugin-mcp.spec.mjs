// Plugin MCP contributions end to end (ticket 204): a real plugin directory
// with a `.mcp.json` -> `plugin install --trust` / `enable` / `disable` /
// `update` / `uninstall` -> codsh-rust MCP discovery and plan -> the same dsh
// MCP client and approval gate as configured servers -> the keyless fixture
// server's side effects. Every home is a temp dir; the mock LLM is keyless.
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'

const require = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const binary = join(repo, 'rust/target/debug/codsh-rust')
const fixture = join(repo, 'e2e/fixtures/rust-mcp-fixture.mjs')
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

function write(path, body, mode) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  if (mode) chmodSync(path, mode)
}

/**
 * A plugin that ships its own MCP server: `bin/server` (relative, so it must
 * resolve under the installed plugin root) runs the fixture copied into the
 * plugin. Side effects land in the plugin data directory.
 */
function writeMcpPlugin(root, { name = 'demo', servers = null, tools = 'write_note,echo' } = {}) {
  write(join(root, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT', description: 'fixture' }))
  mkdirSync(join(root, 'server'), { recursive: true })
  copyFileSync(fixture, join(root, 'server', 'fixture.mjs'))
  write(join(root, 'bin', 'server'), `#!/bin/sh\nexec '${process.execPath}' "$(dirname "$0")/../server/fixture.mjs" "$@"\n`, 0o755)
  const definition = (label, extra = {}) => ({
    command: './bin/server',
    args: [`--tools=${tools}`],
    env: { MCP_FIXTURE_DIR: '${GROK_PLUGIN_DATA}', MCP_FIXTURE_LABEL: label, ROOT_SEEN: '${CLAUDE_PLUGIN_ROOT}' },
    ...extra,
  })
  write(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers ? servers(definition) : { pfx: definition('pfx') } }))
}

function sandbox() {
  const root = mkdtempSync(join('/tmp', 'codsh-plugin-mcp-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const isolated = join(root, 'isolated')
  const grokHome = join(isolated, '.grok')
  const cwd = join(root, 'workspace')
  mkdirSync(join(isolated, 'dsh'), { recursive: true })
  mkdirSync(grokHome, { recursive: true })
  mkdirSync(join(cwd, '.git'), { recursive: true })
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: isolated,
    USERPROFILE: isolated,
    DSH_HOME: join(isolated, 'dsh'),
    GROK_HOME: grokHome,
    DSH_BIN: dshPath(),
    CODSH_NODE: process.execPath,
    CODSH_ACP_PATCH: overlay,
    DSH_CODE_CLI_MOCK_TOOL: 'mcp',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'OFF',
    DEEPSEEK_API_KEY: '',
    CODSH_UPDATE_CHECK: 'off',
    CODSH_SESSION_READ: sessionRead,
    ...extra,
  })
  const run = (args, extra = {}) => {
    const result = spawnSync(binary, args, { cwd, env: env(extra), encoding: 'utf8', timeout: 120000 })
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  const plugin = (...args) => run(['plugin', ...args])
  const list = () => JSON.parse(plugin('list', '--json').stdout)
  const servers = name => list().find(item => item.name === name)?.contributions?.mcpServers ?? []
  const toolsLine = (extraArgs = []) => {
    const result = run([...extraArgs, '-p', 'MCP_TOOLS'])
    const line = result.stdout.split('\n').find(item => item.startsWith('RUST_ACP_MCP_TOOLS')) ?? ''
    return { ...result, tools: line.replace('RUST_ACP_MCP_TOOLS ', '').split(',').filter(Boolean) }
  }
  const dataDir = name => join(grokHome, 'plugin-data', name)
  const calls = (dir, label) => {
    const path = join(dir, `${label}.calls.log`)
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
  }
  // The project's remembered approvals, where the terminal's "a=always
  // this project" answer writes them (sessions/<encoded git root>/permission.toml).
  const grantsPath = join(grokHome, 'sessions', [...Buffer.from(cwd)].map(byte => (/[A-Za-z0-9._-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)).join(''), 'permission.toml')
  const grants = () => (existsSync(grantsPath) ? readFileSync(grantsPath, 'utf8') : '')
  return { root, isolated, grokHome, cwd, env, run, plugin, list, servers, toolsLine, dataDir, calls, grants, grantsPath }
}

function acpClient(box, args = ['--permission-mode', 'ask', 'agent', 'stdio']) {
  const child = spawn(binary, args, { cwd: box.cwd, env: box.env(), stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const updates = []
  const permissions = []
  const stderr = []
  let answer = () => 'reject-once'
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.method === 'session/request_permission') {
      permissions.push(msg.params)
      const optionId = answer(msg.params)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId } } })}\n`)
    }
    if (msg.id != null && pending.has(String(msg.id))) {
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
      child.kill('SIGTERM')
      await new Promise(done => { child.once('exit', done); setTimeout(done, 5000) })
    }
  })
  return { child, send, updates, permissions, stderr, onPermission(fn) { answer = fn } }
}

function agentText(updates, since = 0) {
  return updates.slice(since)
    .filter(item => item.update?.sessionUpdate === 'agent_message_chunk')
    .map(item => item.update.content?.text ?? '')
    .join('')
}

const pluginTools = tools => tools.filter(name => name.startsWith('mcp__pfx__'))

describe('codsh-rust plugin MCP servers with real dsh', () => {
  it('mounts only a trusted, enabled plugin, asks before every tool, and withdraws tools and grants on disable and uninstall', async () => {
    const box = sandbox()
    const source = join(box.root, 'src-demo')
    writeMcpPlugin(source)

    // Installing without trust installs nothing and mounts nothing.
    const refused = box.plugin('install', source)
    expect(refused.code).not.toBe(0)
    expect(box.list()).toEqual([])
    expect(pluginTools(box.toolsLine().tools)).toEqual([])

    // Installed and trusted is not enabled: the view lists the server, nothing mounts.
    expect(box.plugin('install', source, '--trust').code).toBe(0)
    expect(box.servers('demo').map(server => server.name)).toEqual(['pfx'])
    expect(box.servers('demo')[0].state).not.toBe('ready')
    expect(pluginTools(box.toolsLine().tools)).toEqual([])

    const enabled = box.plugin('enable', 'demo')
    expect(enabled.code, enabled.stderr).toBe(0)
    expect(box.servers('demo')).toMatchObject([{ name: 'pfx', state: 'ready' }])
    const listed = box.toolsLine()
    expect(pluginTools(listed.tools).sort()).toEqual(['mcp__pfx__echo', 'mcp__pfx__write_note'])
    const mcpList = box.run(['mcp', 'list'])
    expect(mcpList.stdout).toMatch(/pfx[^\n]*plugin: demo/)
    const mcpJson = JSON.parse(box.run(['mcp', 'list', '--json']).stdout)
    expect(JSON.stringify(mcpJson)).toContain('"plugin":"demo"')

    // Enabling granted no execution permission: a headless call without a
    // rule is refused and the server never ran the tool.
    const headless = box.run(['-p', 'MCP_CALL mcp__pfx__write_note {"name":"h.txt","text":"no"}'])
    expect(headless.stdout).toMatch(/RUST_ACP_MCP_DONE ERR:/)
    expect(existsSync(join(box.dataDir('demo'), 'h.txt'))).toBe(false)

    // Through ACP the call goes through the same approval gate.
    const client = acpClient(box)
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await client.send('session/new', { cwd: box.cwd, mcpServers: [] })
    const prompt = async text => {
      const since = client.updates.length
      const result = await client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      return { result, text: agentText(client.updates, since) }
    }
    expect((await prompt('MCP_TOOLS')).text).toContain('mcp__pfx__write_note')
    client.onPermission(() => 'reject-once')
    const rejected = await prompt('MCP_CALL mcp__pfx__write_note {"name":"r.txt","text":"no"}')
    expect(rejected.text).toMatch(/RUST_ACP_MCP_DONE ERR:/)
    expect(client.permissions).toHaveLength(1)
    expect(existsSync(join(box.dataDir('demo'), 'r.txt'))).toBe(false)

    client.onPermission(() => 'allow-once')
    const wrote = await prompt('MCP_CALL mcp__pfx__write_note {"name":"a.txt","text":"from plugin"}')
    expect(wrote.text).toContain('RUST_ACP_MCP_DONE OK:wrote a.txt')
    expect(client.permissions).toHaveLength(2)
    expect(readFileSync(join(box.dataDir('demo'), 'a.txt'), 'utf8')).toBe('from plugin')
    expect(box.calls(box.dataDir('demo'), 'pfx')).toEqual(['write_note {"name":"a.txt","text":"from plugin"}'])

    // A remembered project approval (what "a=always this project" writes)
    // covers the plugin's tool like any other MCP tool, in a new session.
    write(box.grantsPath, [
      '# remembered permission grants (this project only)',
      'allowed_mcp_tools = ["pfx__write_note", "fx__write_note"]',
      'disallowed_mcp_tools = ["pfx__echo"]',
      '',
    ].join('\n'))
    const remembered = acpClient(box)
    await remembered.send('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const second = await remembered.send('session/new', { cwd: box.cwd, mcpServers: [] })
    const since = remembered.updates.length
    await remembered.send('session/prompt', { sessionId: second.sessionId, prompt: [{ type: 'text', text: 'MCP_CALL mcp__pfx__write_note {"name":"b.txt","text":"again"}' }] })
    expect(agentText(remembered.updates, since)).toContain('OK:wrote b.txt')
    expect(remembered.permissions).toHaveLength(0)

    // Disabling withdraws the server from the live session before the next
    // prompt and forgets the remembered approval.
    const disabled = box.plugin('disable', 'demo')
    expect(disabled.code, disabled.stderr).toBe(0)
    expect(disabled.stdout).toMatch(/withdrawn from the next prompt: pfx; forgot 1 remembered approval/)
    expect(box.grants()).not.toContain('"pfx__write_note"')
    // Other servers' approvals and every remembered denial stay.
    expect(box.grants()).toContain('"fx__write_note"')
    expect(box.grants()).toContain('disallowed_mcp_tools = ["pfx__echo"]')
    expect(box.servers('demo')[0].state).toBe('disabled')
    const after = await prompt('MCP_TOOLS')
    expect(after.text).not.toContain('mcp__pfx__')
    const stale = await prompt('MCP_CALL use_tool {"tool_name":"pfx__write_note","tool_input":{"name":"c.txt","text":"stale"}}')
    expect(stale.text).toContain('Unknown MCP tool "pfx__write_note"')
    const direct = await prompt('MCP_CALL mcp__pfx__write_note {"name":"d.txt","text":"stale"}')
    expect(direct.text).toMatch(/RUST_ACP_MCP_DONE ERR:/)
    expect(existsSync(join(box.dataDir('demo'), 'c.txt'))).toBe(false)
    expect(existsSync(join(box.dataDir('demo'), 'd.txt'))).toBe(false)

    // Enabled again: mounted on the next prompt, and the tool asks again.
    expect(box.plugin('enable', 'demo').code).toBe(0)
    expect((await prompt('MCP_TOOLS')).text).toContain('mcp__pfx__write_note')
    client.onPermission(() => 'reject-once')
    const before = client.permissions.length
    const again = await prompt('MCP_CALL mcp__pfx__write_note {"name":"e.txt","text":"ask"}')
    expect(again.text).toMatch(/RUST_ACP_MCP_DONE ERR:/)
    expect(client.permissions.length).toBe(before + 1)
    expect(existsSync(join(box.dataDir('demo'), 'e.txt'))).toBe(false)

    // Uninstalled: gone from the live session and from new ones.
    const removed = box.plugin('uninstall', 'demo')
    expect(removed.code, removed.stderr).toBe(0)
    expect((await prompt('MCP_TOOLS')).text).not.toContain('mcp__pfx__')
    expect(pluginTools(box.toolsLine().tools)).toEqual([])
    expect(box.run(['mcp', 'list']).stdout).not.toContain('plugin: demo')
  }, 300000)

  it('keeps conflicts, partial failures, mcp enable/disable and updates consistent between the plugin view and the tools', () => {
    const box = sandbox()
    const demo = join(box.root, 'src-demo')
    writeMcpPlugin(demo, { servers: def => ({ pfx: def('pfx'), shared: def('plugin-shared') }) })
    const other = join(box.root, 'src-other')
    writeMcpPlugin(other, {
      name: 'other',
      servers: def => ({ shared: def('other-shared'), gone: def('gone', { command: './bin/not-there' }) }),
    })
    writeFileSync(join(box.grokHome, 'config.toml'), [
      '[mcp_servers.shared]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([fixture, '--tools=echo'])}`,
      `env = { MCP_FIXTURE_DIR = ${JSON.stringify(box.cwd)}, MCP_FIXTURE_LABEL = "user-shared" }`,
      '',
    ].join('\n'))
    for (const [name, path] of [['demo', demo], ['other', other]]) {
      expect(box.plugin('install', path, '--trust').code).toBe(0)
      expect(box.plugin('enable', name).code).toBe(0)
    }

    // The user's `shared` wins over both plugins; the missing program is a
    // partial failure that does not stop the plugin's other servers or the session.
    const state = name => Object.fromEntries(box.servers(name).map(server => [server.name, server.state]))
    expect(state('demo')).toEqual({ pfx: 'ready', shared: 'shadowed' })
    expect(state('other')).toEqual({ shared: 'shadowed', gone: 'failed' })
    const listed = box.toolsLine()
    expect(listed.code).toBe(0)
    expect(pluginTools(listed.tools).sort()).toEqual(['mcp__pfx__echo', 'mcp__pfx__write_note'])
    expect(listed.tools.filter(name => name.startsWith('mcp__shared__'))).toEqual(['mcp__shared__echo'])
    expect(listed.tools.some(name => name.startsWith('mcp__gone__'))).toBe(false)
    expect(listed.stderr).toMatch(/MCP server gone failed: .*not-there/)
    const shared = box.run(['--allow', 'mcp__shared', '-p', 'MCP_CALL mcp__shared__echo {"value":"who"}'])
    expect(shared.stdout).toContain('OK:echo:who')
    expect(box.calls(box.cwd, 'user-shared')).toEqual(['echo {"value":"who"}'])
    expect(box.calls(box.dataDir('demo'), 'plugin-shared')).toEqual([])
    const mcpList = box.run(['mcp', 'list']).stdout
    expect(mcpList).toMatch(/shared[^\n]*plugin: demo[^\n]*shadowed|shadowed[^\n]*shared[^\n]*plugin: demo/)

    // `mcp disable` knows plugin server names; the plugin view follows.
    expect(box.run(['mcp', 'disable', 'pfx']).code).toBe(0)
    expect(state('demo').pfx).toBe('disabled')
    expect(pluginTools(box.toolsLine().tools)).toEqual([])
    expect(box.run(['mcp', 'enable', 'pfx']).code).toBe(0)
    expect(pluginTools(box.toolsLine().tools)).toHaveLength(2)
    const remove = box.run(['mcp', 'remove', 'pfx'])
    expect(remove.code).not.toBe(0)
    expect(`${remove.stdout}${remove.stderr}`).toMatch(/plugin demo/)

    // Removing the user's definition hands `shared` to the first plugin by
    // name; approvals given to the user's server do not carry over to it.
    write(box.grantsPath, 'allowed_mcp_tools = ["shared__echo", "pfx__echo"]\n')
    const handedOver = box.run(['mcp', 'remove', 'shared'])
    expect(handedOver.code, handedOver.stderr).toBe(0)
    expect(handedOver.stderr).toContain("'shared' now comes from plugin demo; 1 remembered approval(s)")
    expect(box.grants()).not.toContain('"shared__echo"')
    expect(box.grants()).toContain('"pfx__echo"')
    expect(state('demo').shared).toBe('ready')
    expect(state('other').shared).toBe('shadowed')
    const handed = box.run(['--allow', 'mcp__shared', '-p', 'MCP_CALL mcp__shared__echo {"value":"plugin"}'])
    expect(handed.stdout).toContain('OK:echo:plugin')
    expect(box.calls(box.dataDir('demo'), 'plugin-shared')).toEqual(['echo {"value":"plugin"}'])

    // Update: the new revision's server definition is what mounts.
    writeMcpPlugin(demo, { tools: 'echo' })
    const updated = box.plugin('update', 'demo')
    expect(updated.code, updated.stderr).toBe(0)
    expect(updated.stdout).toMatch(/withdrawn from the next prompt: [^\n]*pfx/)
    expect(pluginTools(box.toolsLine().tools)).toEqual(['mcp__pfx__echo'])
    expect(state('demo')).toEqual({ pfx: 'ready' })
    expect(state('other').shared).toBe('ready')
  }, 300000)
})
