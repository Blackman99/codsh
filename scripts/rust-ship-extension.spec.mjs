// The optional Ship extension as shipped (ticket 195): scripts/build-ship-extension.mjs
// builds a first-party plugin from the legacy Ship modules. The generated
// command is the legacy first-turn contract, the hook script is self-contained,
// and running it without a /ship prompt leaves no Ship state anywhere.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function runHook(hook, { event, payload, dataDir }) {
  const env = { PATH: process.env.PATH, GROK_HOOK_EVENT: event }
  if (dataDir !== undefined) env.GROK_PLUGIN_DATA = dataDir
  return spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), env, encoding: 'utf8' })
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
    expect(readdirSync(out).sort()).toEqual(['.grok-plugin', 'README.md', 'commands', 'hooks'])
    expect(readdirSync(join(out, 'commands'))).toEqual(['ship.md'])
    expect(readFileSync(join(out, 'commands', 'ship.md'), 'utf8')).toBe(shipExtensionCommand())

    const hooks = JSON.parse(readFileSync(join(out, 'hooks', 'hooks.json'), 'utf8')).hooks
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'UserPromptSubmit'])
    expect(hooks.PostToolUse[0].matcher).toBe('^(ask_user_question|write|edit|multi_edit|bash)$')

    const script = readFileSync(join(out, 'hooks', 'ship-hook.mjs'), 'utf8')
    const imports = [...script.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map(match => match[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter(name => !name.startsWith('node:'))).toEqual([])
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
})
