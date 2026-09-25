// Local MCP servers end to end: config -> codsh-rust plan -> real dsh MCP
// client -> keyless fixture server side effect -> ACP / plain output.
// dsh executes with the deterministic mock (mode `mcp`); homes are temp dirs.
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { capOutput, catalogOf, resolveToolName, searchResponse, splitPublicName, truncateUtf8 } from '../packages/cli/bin/rust-acp-mcp.mjs'
import { hookToolName } from '../packages/cli/bin/rust-acp-hooks.mjs'
import { accessFromTool } from '../packages/cli/bin/rust-acp-file-approval.mjs'

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

function toml(value) {
  return JSON.stringify(value)
}

function sandbox(servers = '') {
  const root = mkdtempSync(join('/tmp', 'codsh-mcp-'))
  const isolated = join(root, 'isolated')
  const cwd = join(root, 'workspace')
  mkdirSync(join(isolated, 'dsh'), { recursive: true })
  mkdirSync(join(isolated, '.grok'), { recursive: true })
  mkdirSync(cwd)
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const config = join(isolated, '.grok', 'config.toml')
  writeFileSync(config, servers)
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
    ...extra,
  })
  return { root, isolated, cwd, config, env }
}

function fixtureServer(name, dir, extraArgs = [], label = name) {
  return [
    `[mcp_servers.${name}]`,
    `command = ${toml(process.execPath)}`,
    `args = ${toml([fixture, ...extraArgs])}`,
    `env = { MCP_FIXTURE_DIR = ${toml(dir)}, MCP_FIXTURE_LABEL = ${toml(label)} }`,
    '',
  ].join('\n')
}

function run(box, args, extra = {}) {
  const result = spawnSync(binary, args, { cwd: box.cwd, env: box.env(extra), encoding: 'utf8', timeout: 120000 })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function toolsLine(box, extraArgs = []) {
  const result = run(box, [...extraArgs, '-p', 'MCP_TOOLS'])
  const line = result.stdout.split('\n').find(item => item.startsWith('RUST_ACP_MCP_TOOLS')) ?? ''
  return { ...result, tools: line.replace('RUST_ACP_MCP_TOOLS ', '').split(',').filter(Boolean) }
}

function calls(box, label = 'fx') {
  const path = join(box.cwd, `${label}.calls.log`)
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

function acpClient(box, args = ['--permission-mode', 'ask', 'agent', 'stdio']) {
  const child = spawn(binary, args, { cwd: box.cwd, env: box.env(), stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const updates = []
  const permissions = []
  const stderr = []
  let answer = null
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.method === 'session/request_permission') {
      permissions.push(msg.params)
      const optionId = typeof answer === 'function' ? answer(msg.params) : 'reject-once'
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
  const send = (method, params, timeout = 60000) => new Promise((resolvePromise, reject) => {
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
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  cleanups.push(async () => {
    if (child.exitCode == null) {
      child.stdin.end()
      child.kill('SIGTERM')
      await new Promise(done => { child.once('exit', done); setTimeout(done, 5000) })
    }
  })
  return {
    child,
    send,
    notify,
    updates,
    permissions,
    stderr,
    onPermission(fn) { answer = fn },
  }
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
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('rust-acp-mcp plugin units', () => {
  it('keeps Grok server__tool names and finds tools by keyword', () => {
    expect(splitPublicName('mcp__fx__write_note', ['fx'])).toEqual({ server: 'fx', tool: 'write_note' })
    expect(splitPublicName('mcp__a__b__c', ['a__b'])).toEqual({ server: 'a__b', tool: 'c' })
    expect(splitPublicName('read_file', ['fx'])).toBeNull()
    const catalog = catalogOf([
      { name: 'mcp__fx__write_note', description: 'Write text to a note file.', parameters: { type: 'object', properties: { name: { type: 'string' } } } },
      { name: 'mcp__fx__echo', description: 'Return the given value.', parameters: { type: 'object' } },
      { name: 'read_file', description: 'not mcp', parameters: {} },
    ], ['fx', 'idle'])
    expect([...catalog.keys()].sort()).toEqual(['fx', 'idle'])
    expect(resolveToolName(catalog, 'fx__echo')?.publicName).toBe('mcp__fx__echo')
    expect(resolveToolName(catalog, 'mcp__fx__echo')?.name).toBe('fx__echo')
    expect(resolveToolName(catalog, 'fx__missing')).toBeNull()
    const found = searchResponse(catalog, 'note write', 5)
    expect(found.results[0].server).toBe('fx')
    expect(found.results[0].tools[0].tool_name).toBe('fx__write_note')
    expect(found.results[0].tools[0].input_schema.properties.name.type).toBe('string')
    expect(found.total_hidden_tools).toBe(2)
    expect(searchResponse(new Map(), 'x', 5).note).toMatch(/No MCP tools/)
  })

  it('caps output on a UTF-8 boundary and spills the full text', () => {
    expect(truncateUtf8('ab中文', 4)).toBe('ab')
    const dir = mkdtempSync(join('/tmp', 'codsh-mcp-cap-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const text = 'y'.repeat(5000)
    const capped = capOutput(text, 1000, dir, 'call/1')
    expect(capped.startsWith('y'.repeat(1000))).toBe(true)
    expect(capped).toMatch(/\[MCP output truncated: showing first 1000 B of 4\.9 KB\. Full output written to: .*call_1\.txt\.\]/)
    expect(readFileSync(join(dir, 'call_1.txt'), 'utf8')).toBe(text)
    expect(capOutput('short', 1000, dir, 'x')).toBeNull()
  })

  it('names MCP tools server__tool for rules and hooks, and skips the dispatcher', () => {
    expect(accessFromTool('mcp__fx__write_note', {})).toEqual({ kind: 'mcp', name: 'fx__write_note' })
    expect(accessFromTool('use_tool', { tool_name: 'fx__write_note' }).kind).toBe('read')
    expect(hookToolName('mcp__fx__write_note')).toBe('fx__write_note')
    expect(hookToolName('use_tool')).toBeNull()
    expect(hookToolName('bash')).toBe('bash')
  })
})

describe('codsh-rust local MCP with real dsh', () => {
  it('runs a configured server tool once through ACP approval, use_tool and search_tool, and cancels', async () => {
    const box = sandbox()
    writeFileSync(box.config, fixtureServer('fx', join(box.root, 'workspace')))
    const client = acpClient(box)
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const editorDir = join(box.root, 'editor')
    mkdirSync(editorDir)
    const created = await client.send('session/new', {
      cwd: box.cwd,
      mcpServers: [{
        name: 'ed',
        command: process.execPath,
        args: [fixture, '--tools=echo'],
        env: [{ name: 'MCP_FIXTURE_DIR', value: editorDir }, { name: 'MCP_FIXTURE_LABEL', value: 'ed' }],
      }],
    })
    const sessionId = created.sessionId
    const prompt = async text => {
      const since = client.updates.length
      const result = await client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 90000)
      return { result, text: agentText(client.updates, since), since }
    }

    const listed = await prompt('MCP_TOOLS')
    expect(listed.text).toContain('mcp__fx__write_note')
    expect(listed.text).toContain('mcp__ed__echo')
    expect(listed.text).not.toContain('mcp__ed__write_note')
    expect(listed.text).toContain('search_tool')
    expect(listed.text).toContain('use_tool')

    // Approved: the side effect happens exactly once with the model's arguments.
    client.onPermission(() => 'allow-once')
    const wrote = await prompt('MCP_CALL mcp__fx__write_note {"name":"a.txt","text":"héllo MCP"}')
    expect(wrote.result.stopReason).toBe('end_turn')
    expect(wrote.text).toContain('RUST_ACP_MCP_DONE OK:wrote a.txt (9 chars)')
    expect(readFileSync(join(box.cwd, 'a.txt'), 'utf8')).toBe('héllo MCP')
    expect(calls(box)).toEqual(['write_note {"name":"a.txt","text":"héllo MCP"}'])
    expect(client.permissions.at(-1).toolCall.toolCallId).toBe('rust-acp-mcp-1')
    const started = client.updates.slice(wrote.since).find(item => item.update?.sessionUpdate === 'tool_call')
    expect(JSON.stringify(started)).toContain('mcp__fx__write_note')
    expect(started.update.rawInput).toEqual({ name: 'a.txt', text: 'héllo MCP' })
    const toolUpdates = client.updates.slice(wrote.since).filter(item => item.update?.sessionUpdate === 'tool_call_update' && item.update.status === 'completed')
    expect(JSON.stringify(toolUpdates)).toContain('wrote a.txt')

    // Rejected: no side effect.
    client.onPermission(() => 'reject-once')
    const rejected = await prompt('MCP_CALL mcp__fx__write_note {"name":"b.txt","text":"no"}')
    expect(rejected.text).toMatch(/RUST_ACP_MCP_DONE ERR:/)
    expect(existsSync(join(box.cwd, 'b.txt'))).toBe(false)
    expect(calls(box)).toHaveLength(1)

    // use_tool re-enters the permission gate as the real tool.
    const asked = []
    client.onPermission(params => { asked.push(JSON.stringify(params)); return 'allow-once' })
    const used = await prompt('MCP_CALL use_tool {"tool_name":"fx__echo","tool_input":{"value":"via-use","count":2}}')
    expect(used.text).toContain('RUST_ACP_MCP_DONE OK:echo:via-use')
    // The nested call is the one that asks; the dispatcher itself does not.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('"toolCallId":"rust-acp-mcp-1:use_tool"')
    expect(calls(box).at(-1)).toBe('echo {"value":"via-use","count":2}')
    client.onPermission(() => 'reject-once')
    const usedRejected = await prompt('MCP_CALL use_tool {"tool_name":"fx__write_note","tool_input":{"name":"u.txt","text":"no"}}')
    expect(usedRejected.text).toMatch(/RUST_ACP_MCP_DONE ERR:/)
    expect(existsSync(join(box.cwd, 'u.txt'))).toBe(false)
    client.onPermission(() => 'allow-once')
    const unknown = await prompt('MCP_CALL use_tool {"tool_name":"fx__nope","tool_input":{}}')
    expect(unknown.text).toContain('Unknown MCP tool "fx__nope"')
    const searched = await prompt('MCP_CALL search_tool {"query":"write note","limit":3}')
    expect(searched.text).toContain('"tool_name": "fx__write_note"')
    expect(searched.text).toContain('"input_schema"')

    // Tool errors come back as errors, not crashes.
    const failed = await prompt('MCP_CALL mcp__fx__fail {}')
    expect(failed.text).toContain('ERR:Error: fixture failure: the tool reported an error')

    // Cancellation reaches the server and the slow tool never finishes.
    client.onPermission(() => 'allow-once')
    const since = client.updates.length
    const slow = client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'MCP_CALL mcp__fx__slow {"ms":8000}' }] }, 90000)
    await until(() => calls(box).some(line => line.startsWith('slow ')), 'slow call to start')
    client.notify('session/cancel', { sessionId })
    const cancelled = await slow
    expect(cancelled.stopReason).toBe('cancelled')
    await until(() => calls(box).some(line => line.startsWith('cancelled ')), 'server to see notifications/cancelled', 10000)
    await new Promise(done => setTimeout(done, 9000))
    expect(existsSync(join(box.cwd, 'slow.done'))).toBe(false)
    expect(client.updates.length).toBeGreaterThan(since)
  }, 240000)

  it('applies deny rules and PreToolUse hooks to MCP tools by server__tool name', () => {
    const box = sandbox()
    writeFileSync(box.config, fixtureServer('fx', join(box.root, 'workspace')))
    const denied = run(box, ['--deny', 'mcp__fx__write_note', '--allow', 'mcp__fx', '-p', 'MCP_CALL mcp__fx__write_note {"name":"d.txt","text":"x"} THEN MCP_CALL mcp__fx__echo {"value":"ok"}'])
    expect(denied.stdout).toMatch(/RUST_ACP_MCP_DONE ERR:.*\| OK:echo:ok/)
    expect(existsSync(join(box.cwd, 'd.txt'))).toBe(false)
    expect(calls(box)).toEqual(['echo {"value":"ok"}'])

    const hooksDir = join(box.isolated, '.grok', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    const script = join(box.root, 'guard.sh')
    const seen = join(box.root, 'hook-input.jsonl')
    writeFileSync(script, `#!/bin/sh\ncat >> '${seen}'\necho >> '${seen}'\necho 'blocked by MCP hook' >&2\nexit 2\n`)
    chmodSync(script, 0o755)
    writeFileSync(join(hooksDir, 'mcp.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'fx__write_note', hooks: [{ type: 'command', command: script }] }] },
    }))
    const hooked = run(box, ['--allow', 'mcp__fx', '-p', 'MCP_CALL use_tool {"tool_name":"fx__write_note","tool_input":{"name":"h.txt","text":"x"}} THEN MCP_CALL mcp__fx__write_note {"name":"h2.txt","text":"x"}'])
    expect(hooked.stdout).toMatch(/RUST_ACP_MCP_DONE ERR:.*blocked by MCP hook.* \| ERR:.*blocked by MCP hook/)
    expect(existsSync(join(box.cwd, 'h.txt'))).toBe(false)
    expect(existsSync(join(box.cwd, 'h2.txt'))).toBe(false)
    const inputs = readFileSync(seen, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(inputs.map(item => item.tool_name)).toEqual(['fx__write_note', 'fx__write_note'])
    expect(inputs[0].tool_input).toEqual({ name: 'h.txt', text: 'x' })
  }, 240000)

  it('reports missing programs and startup crashes while the session still starts, and recovers after a crash mid-call', () => {
    const box = sandbox()
    writeFileSync(box.config, [
      fixtureServer('fx', join(box.root, 'workspace')),
      '[mcp_servers.gone]',
      'command = "codsh-mcp-no-such-program"',
      '',
      fixtureServer('boom', join(box.root, 'workspace'), ['--exit-on-start']),
      fixtureServer('badinit', join(box.root, 'workspace'), ['--bad-init']),
    ].join('\n'))
    const listed = toolsLine(box)
    expect(listed.code).toBe(0)
    expect(listed.tools.filter(name => name.startsWith('mcp__')).every(name => name.startsWith('mcp__fx__'))).toBe(true)
    expect(listed.tools).toContain('mcp__fx__echo')
    expect(listed.stderr).toContain('MCP server gone failed: command not found: codsh-mcp-no-such-program')
    expect(listed.stderr).toMatch(/MCP server boom failed: exited with code 3.*fixture: exiting before initialize/)
    expect(listed.stderr).toMatch(/MCP server badinit failed: .*fixture refuses to initialize/)

    const doctor = run(box, ['mcp', 'doctor'])
    expect(doctor.stdout).toContain('✗ command not found (codsh-mcp-no-such-program)')
    expect(doctor.stdout).toMatch(/boom[\s\S]*✗ server failed to start \(exited with code 3/)
    expect(doctor.stdout).toMatch(/fx[\s\S]*✓ handshake OK[\s\S]*✓ 6 tools discovered/)
    expect(doctor.stdout).toMatch(/Found 1 healthy, 3 failing/)
    const doctorJson = JSON.parse(run(box, ['mcp', 'doctor', '--json']).stdout)
    expect(doctorJson.servers.find(server => server.name === 'fx').healthy).toBe(true)
    expect(doctorJson.servers.find(server => server.name === 'gone').healthy).toBe(false)

    const crashed = run(box, ['--allow', 'mcp__fx', '--allow', 'Bash', '-p', 'MCP_CALL mcp__fx__crash {} THEN MCP_CALL bash {"command":"sleep 3","description":"wait"} THEN MCP_CALL mcp__fx__echo {"value":"after"}'])
    expect(crashed.stdout).toMatch(/RUST_ACP_MCP_DONE ERR:.*Connection closed.*\| OK:echo:after/)
  }, 240000)

  it('caps oversized output at the configured limit and saves the full text', () => {
    const box = sandbox()
    writeFileSync(box.config, `[mcp]\nmax_output_bytes = 1000\n\n${fixtureServer('fx', join(box.root, 'workspace'))}`)
    const capped = (extra = {}) => {
      const result = run(box, ['--allow', 'mcp__fx', '--output-format', 'streaming-json', '-p', 'MCP_CALL mcp__fx__big_output {"bytes":30000}'], extra)
      expect(result.code).toBe(0)
      const match = result.stdout.match(/\[MCP output truncated: showing first ([0-9.]+ K?B) of 29\.3 KB\. Full output written to: ([^\]]+?)\.\]/)
      expect(match, result.stdout.slice(-2000)).not.toBeNull()
      const saved = readFileSync(match[2], 'utf8')
      expect(saved.length).toBe(30000)
      expect(saved.endsWith('BIG-END')).toBe(true)
      return match[1]
    }
    expect(capped()).toBe('1000 B')
    // GROK_MAX_MCP_OUTPUT_BYTES overrides config, as in Grok.
    expect(capped({ GROK_MAX_MCP_OUTPUT_BYTES: '1536' })).toBe('1.5 KB')
  }, 240000)

  it('enforces tool_timeout_sec, cancels the call on the server, and keeps the server usable', async () => {
    const box = sandbox()
    writeFileSync(box.config, `${fixtureServer('fx', join(box.root, 'workspace'))}tool_timeout_sec = 1\n`)
    const result = run(box, ['--allow', 'mcp__fx', '-p', 'MCP_CALL mcp__fx__slow {"ms":4000} THEN MCP_CALL mcp__fx__echo {"value":"next"}'])
    expect(result.stdout).toContain("RUST_ACP_MCP_DONE ERR:Error: MCP error -32001: MCP tool call 'slow' timed out after 1.0s (codsh tool timeout) | OK:echo:next")
    expect(calls(box).some(line => line.startsWith('cancelled '))).toBe(true)
    await new Promise(done => setTimeout(done, 4500))
    expect(existsSync(join(box.cwd, 'slow.done'))).toBe(false)
  }, 240000)

  it('enables, disables, adds and removes servers through the CLI and the next session follows', () => {
    const box = sandbox()
    writeFileSync(box.config, fixtureServer('fx', join(box.root, 'workspace')))
    expect(toolsLine(box).tools).toContain('mcp__fx__echo')

    const disabled = run(box, ['mcp', 'disable', 'fx'])
    expect(disabled.code).toBe(0)
    expect(readFileSync(box.config, 'utf8')).toMatch(/disabled_mcp_servers = \["fx"\]/)
    expect(run(box, ['mcp', 'list']).stdout).toMatch(/fx: .*\(disabled\)|fx[^\n]*disabled/)
    expect(toolsLine(box).tools.some(name => name.startsWith('mcp__fx__'))).toBe(false)

    expect(run(box, ['mcp', 'enable', 'fx']).code).toBe(0)
    expect(toolsLine(box).tools).toContain('mcp__fx__echo')

    const added = run(box, ['mcp', 'add', 'notes', '--env', `MCP_FIXTURE_DIR=${box.cwd}`, '--env', 'MCP_FIXTURE_LABEL=notes', '--', process.execPath, fixture, '--tools=write_note'])
    expect(added.code, added.stderr).toBe(0)
    const withNotes = toolsLine(box)
    expect(withNotes.tools).toContain('mcp__notes__write_note')
    expect(withNotes.tools).not.toContain('mcp__notes__echo')
    const listed = JSON.parse(run(box, ['mcp', 'list', '--json']).stdout)
    expect(JSON.stringify(listed)).toContain('notes')

    expect(run(box, ['mcp', 'remove', 'notes']).code).toBe(0)
    expect(toolsLine(box).tools.some(name => name.startsWith('mcp__notes__'))).toBe(false)
    const missing = run(box, ['mcp', 'remove', 'notes'])
    expect(missing.code).not.toBe(0)
  }, 240000)

  it('starts repo-local servers only for a trusted folder and stops after trust is revoked', () => {
    const box = sandbox()
    mkdirSync(join(box.cwd, '.grok'))
    writeFileSync(join(box.cwd, '.grok', 'config.toml'), fixtureServer('proj', join(box.root, 'workspace')))
    writeFileSync(join(box.cwd, '.mcp.json'), JSON.stringify({
      mcpServers: { repojson: { command: process.execPath, args: [fixture, '--tools=echo'], env: { MCP_FIXTURE_DIR: box.cwd, MCP_FIXTURE_LABEL: 'repojson' } } },
    }))
    const untrusted = toolsLine(box)
    expect(untrusted.tools.some(name => name.startsWith('mcp__proj__') || name.startsWith('mcp__repojson__'))).toBe(false)
    expect(calls(box, 'proj')).toEqual([])
    const trusted = toolsLine(box, ['--trust'])
    expect(trusted.tools).toContain('mcp__proj__write_note')
    expect(trusted.tools).toContain('mcp__repojson__echo')
    expect(toolsLine(box).tools).toContain('mcp__proj__write_note')
    const revoked = toolsLine(box, ['--revoke-trust'])
    expect(revoked.tools.some(name => name.startsWith('mcp__proj__'))).toBe(false)
    expect(toolsLine(box).tools.some(name => name.startsWith('mcp__proj__'))).toBe(false)
  }, 240000)
})
