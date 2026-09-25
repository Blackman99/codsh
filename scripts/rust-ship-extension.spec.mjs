// The optional Ship extension as shipped (ticket 195): scripts/build-ship-extension.mjs
// builds a first-party plugin from the legacy Ship modules. The generated
// command is the legacy first-turn contract, the hook script is self-contained,
// and running it without a /ship prompt leaves no Ship state anywhere.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildShipExtension } from './build-ship-extension.mjs'
import { SHIP_CONTRACT_OPENING, shipExtensionCommand } from '../packages/bundle/src/ship-extension.ts'

const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function tempRoot(prefix) {
  const root = mkdtempSync(join('/tmp', prefix))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function runHook(hook, { event, payload, dataDir, owner }) {
  const env = { PATH: process.env.PATH, GROK_HOOK_EVENT: event }
  if (dataDir !== undefined) env.GROK_PLUGIN_DATA = dataDir
  if (owner !== undefined) env.CODSH_HOOK_HOST_PID = String(owner)
  return spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), env, encoding: 'utf8' })
}

/** GET with an explicit Host header; resolves the status (0 when refused). */
function httpGet(url, host) {
  return new Promise(resolve => {
    const target = new URL(url)
    const req = request({ host: target.hostname, port: target.port, path: target.pathname, headers: host ? { host } : {} }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.end()
  })
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return check()
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function systemMessage(result) {
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout).systemMessage
}

const shipPrompt = idea =>
  `Run the custom command \`ship:ship\` from /x/commands/ship.md. Arguments: ${idea}\n\n${SHIP_CONTRACT_OPENING} and ...`

describe('Ship extension build', () => {
  it('builds a plugin whose command is the legacy contract and whose hook needs only node builtins', { timeout: 60_000 }, async () => {
    const out = join(tempRoot('codsh-ship-build-'), 'ship')
    await buildShipExtension(out)
    const manifest = JSON.parse(readFileSync(join(out, '.grok-plugin', 'plugin.json'), 'utf8'))
    expect(manifest).toMatchObject({ name: 'ship', license: 'MIT' })
    // Default layout only: no custom command/hook paths, no keybindings.
    expect(Object.keys(manifest).sort()).toEqual(['description', 'license', 'name', 'version'])
    expect(readdirSync(out).sort()).toEqual(['.grok-plugin', 'README.md', 'commands', 'hooks', 'web'])
    expect(readdirSync(join(out, 'web')).sort()).toEqual(['ship-web.css', 'ship-web.js'])
    expect(readdirSync(join(out, 'commands'))).toEqual(['ship.md'])
    expect(readFileSync(join(out, 'commands', 'ship.md'), 'utf8')).toBe(shipExtensionCommand())

    const hooks = JSON.parse(readFileSync(join(out, 'hooks', 'hooks.json'), 'utf8')).hooks
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    expect(hooks.PostToolUse[0].matcher).toBe('^(ask_user_question|write|edit|multi_edit|bash|subagent)$')
    expect(hooks.PreToolUse[0].matcher).toBe('^ask_user_question$')
    expect(hooks.PostToolUseFailure[0].matcher).toBe('^subagent$')

    for (const name of ['ship-hook.mjs', 'ship-web.mjs']) {
      const script = readFileSync(join(out, 'hooks', name), 'utf8')
      const imports = [...script.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map(match => match[1])
      expect(imports.length).toBeGreaterThan(0)
      expect(imports.filter(name => !name.startsWith('node:'))).toEqual([])
    }
    const printed = spawnSync(process.execPath, [join(out, 'hooks', 'ship-hook.mjs'), '--print-command'], { encoding: 'utf8' })
    expect(printed.status).toBe(0)
    expect(printed.stdout).toBe(shipExtensionCommand())
  })

  it('runs the built hook: no data dir fails closed, ordinary prompts leave nothing, a conflicting /ship blocks', { timeout: 60_000 }, async () => {
    const root = tempRoot('codsh-ship-hook-')
    const out = await buildShipExtension(join(root, 'ship'))
    const hook = join(out, 'hooks', 'ship-hook.mjs')
    const cwd = join(root, 'workspace')
    const dataDir = join(root, 'data')
    mkdirSync(cwd)

    const missing = runHook(hook, { event: 'user_prompt_submit', payload: { cwd, prompt: shipPrompt('X') } })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('GROK_PLUGIN_DATA is not set')

    const plain = runHook(hook, { event: 'user_prompt_submit', dataDir, payload: { cwd, session_id: 's', prompt: 'hello' } })
    expect(plain.status).toBe(0)
    expect(plain.stdout).toBe('')
    const tool = runHook(hook, {
      event: 'post_tool_use', dataDir,
      payload: { cwd, session_id: 's', tool_name: 'write', tool_input: { path: 'a.txt' } },
    })
    expect(tool.status).toBe(0)
    expect(tool.stdout).toBe('')
    expect(readdirSync(cwd)).toEqual([])
    expect(existsSync(join(dataDir, 'runs'))).toBe(false)

    mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
    writeFileSync(join(cwd, 'docs', 'specs', 'a.md'), '# A\n\nStatus: wayfinding\n\n## Original Requirement\n\nAAA\n')
    const conflict = runHook(hook, { event: 'user_prompt_submit', dataDir, payload: { cwd, session_id: 's', prompt: shipPrompt('BBB') } })
    expect(conflict.status).toBe(0)
    const decision = JSON.parse(conflict.stdout)
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('Ship: Typed idea conflicts with the saved original requirement.')
    expect(readdirSync(join(cwd, 'docs', 'specs'))).toEqual(['a.md'])
  })

  it('serves the browser graph for the session that ran /ship and stops with it', { timeout: 90_000 }, async () => {
    const root = tempRoot('codsh-ship-web-')
    const out = await buildShipExtension(join(root, 'ship'))
    const hook = join(out, 'hooks', 'ship-hook.mjs')
    const cwd = join(root, 'workspace')
    const dataDir = join(root, 'data')
    mkdirSync(cwd)
    const owner = spawn('sleep', ['600'], { stdio: 'ignore' })
    cleanups.push(() => owner.kill('SIGKILL'))
    const recordPath = () => join(dataDir, 'web', readdirSync(join(dataDir, 'web')).find(name => name.endsWith('.json')))
    const record = () => JSON.parse(readFileSync(recordPath(), 'utf8'))
    cleanups.push(() => { try { process.kill(record().pid, 'SIGKILL') } catch { /* stopped */ } })

    // Session start without a run: nothing starts.
    expect(runHook(hook, { event: 'session_start', dataDir, owner: owner.pid, payload: { cwd, session_id: 's' } }).stdout).toBe('')
    expect(existsSync(join(dataDir, 'web'))).toBe(false)

    const line = systemMessage(runHook(hook, { event: 'user_prompt_submit', dataDir, owner: owner.pid, payload: { cwd, session_id: 's', prompt: shipPrompt('BROWSER_IDEA') } }))
    const url = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\//u.exec(line)?.[0]
    expect(url).toBeDefined()
    expect(line).toBe(`Ship graph · Waiting for a Ship specification · 待认领 0 · 已认领 0 · 已关闭 0 · 0 of 0 decision answers recorded · ${url}`)
    expect(statSync(recordPath()).mode & 0o777).toBe(0o600)
    const port = new URL(url).port
    const graph = await httpGet(`${url}graph.json`, `127.0.0.1:${port}`)
    expect(graph.status).toBe(200)
    expect(JSON.parse(graph.body)).toMatchObject({ specPath: '', originalRequirement: 'BROWSER_IDEA', nodes: [] })
    expect((await httpGet(`${url}index.html`, `127.0.0.1:${port}`)).status).toBe(200)
    expect((await httpGet(`http://127.0.0.1:${port}/graph.json`, `127.0.0.1:${port}`)).status).toBe(404)
    expect((await httpGet(`${url}graph.json`, `attacker.example:${port}`)).status).toBe(421)

    // The ledger appears: the next tool hook rebuilds the cache and prints a changed summary once.
    mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
    writeFileSync(join(cwd, 'docs', 'specs', 'b.md'), '# B\n\nStatus: wayfinding\n\n## Original Requirement\n\nBROWSER_IDEA\n')
    const written = systemMessage(runHook(hook, { event: 'post_tool_use', dataDir, owner: owner.pid, payload: { cwd, session_id: 's', tool_name: 'write', tool_input: {} } }))
    expect(written).toBe(`Ship graph · b.md · Status: wayfinding · 待认领 0 · 已认领 0 · 已关闭 0 · 0 of 0 decision answers recorded · ${url}`)
    expect(JSON.parse(readFileSync(join(cwd, 'docs', 'specs', 'b.ship.graph.json'), 'utf8'))).toMatchObject({ specPath: 'b.md', status: 'wayfinding' })
    expect(runHook(hook, { event: 'post_tool_use', dataDir, owner: owner.pid, payload: { cwd, session_id: 's', tool_name: 'bash', tool_input: {} } }).stdout).toBe('')

    // SessionEnd stops it; the port is closed and the record keeps port and token.
    const pid = record().pid
    expect(runHook(hook, { event: 'session_end', dataDir, owner: owner.pid, payload: { cwd, session_id: 's' } }).status).toBe(0)
    expect(await until(() => !alive(pid))).toBe(true)
    expect((await httpGet(`${url}graph.json`, `127.0.0.1:${port}`)).status).toBe(0)
    expect(record().pid).toBeUndefined()

    // Resuming the same session reopens the same URL; another session does not.
    expect(runHook(hook, { event: 'session_start', dataDir, owner: owner.pid, payload: { cwd, session_id: 'other' } }).stdout).toBe('')
    const resumed = systemMessage(runHook(hook, { event: 'session_start', dataDir, owner: owner.pid, payload: { cwd, session_id: 's' } }))
    expect(resumed).toBe(written)
    expect((await httpGet(`${url}graph.json`, `127.0.0.1:${port}`)).status).toBe(200)

    // Uninstall removes the plugin data: the server notices and exits.
    const second = record().pid
    rmSync(dataDir, { recursive: true, force: true })
    expect(await until(() => !alive(second))).toBe(true)
    expect((await httpGet(`${url}graph.json`, `127.0.0.1:${port}`)).status).toBe(0)

    // The owning dsh process exits: so does the server.
    const again = systemMessage(runHook(hook, { event: 'user_prompt_submit', dataDir, owner: owner.pid, payload: { cwd, session_id: 's', prompt: shipPrompt('') } }))
    expect(again).toContain('b.md · Status: wayfinding')
    const third = record().pid
    expect(alive(third)).toBe(true)
    owner.kill('SIGKILL')
    expect(await until(() => !alive(third))).toBe(true)
  })
})
