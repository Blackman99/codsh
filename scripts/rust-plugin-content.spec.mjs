// Plugin contributions end to end: `plugin install --trust` / `enable` /
// `update` / `disable` / `uninstall` -> codsh-rust asset discovery and
// CODSH_PLUGIN_HOOKS -> real dsh with the keyless mock LLM. Every home is a
// temp dir; nothing reads the user's real ~/.grok or dsh profile.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { discoverHooks, pluginHookSources } from '../packages/cli/bin/rust-acp-hooks.mjs'

const require = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const binary = join(repo, 'rust/target/debug/codsh-rust')
const cleanups = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
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

function tempRoot(prefix) {
  const root = mkdtempSync(join('/tmp', prefix))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

/** A plugin with a rule, a skill, a command, an agent, and two hooks. */
function writePlugin(root, { name = 'demo', version = '1.0.0', skill = 'PLUGIN_SKILL_BODY' } = {}) {
  write(join(root, 'plugin.json'), JSON.stringify({ name, version, license: 'MIT', description: 'fixture' }))
  write(join(root, 'rules', 'style.md'), 'Always mention PLUGIN_RULE_BODY.\n')
  write(join(root, 'skills', 'greet', 'SKILL.md'), `---\ndescription: greet\n---\n${skill} greet the user\n`)
  write(join(root, 'commands', 'deploy.md'), '---\ndescription: deploy\n---\nPLUGIN_COMMAND_BODY deploy it\n')
  write(join(root, 'agents', 'reviewer.md'), '---\ndescription: reviews\n---\nPLUGIN_AGENT_BODY review carefully\n')
  write(join(root, 'scripts', 'guard.sh'), [
    '#!/bin/sh',
    'cat >/dev/null',
    'printf "GUARD root=%s data=%s event=%s\\n" "$GROK_PLUGIN_ROOT" "$GROK_PLUGIN_DATA" "$GROK_HOOK_EVENT" >> "$PWD/plugin-hook.log"',
    `printf '{"decision":"deny","reason":"PLUGIN_HOOK_BLOCKED by ${name}"}\\n'`,
    'exit 2',
    '',
  ].join('\n'), 0o755)
  write(join(root, 'scripts', 'prompt.sh'), [
    '#!/bin/sh',
    'cat >/dev/null',
    'printf "PROMPT %s\\n" "$CLAUDE_PLUGIN_ROOT" >> "$PWD/plugin-hook.log"',
    'exit 0',
    '',
  ].join('\n'), 0o755)
  write(join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${GROK_PLUGIN_ROOT}/scripts/guard.sh', timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/prompt.sh', timeout: 5 }] }],
    },
  }))
}

function sandbox() {
  const root = tempRoot('codsh-plugin-content-')
  const isolated = join(root, 'isolated')
  const cwd = join(root, 'workspace')
  mkdirSync(join(isolated, 'dsh'), { recursive: true })
  mkdirSync(join(isolated, '.grok'), { recursive: true })
  mkdirSync(join(cwd, '.git'), { recursive: true })
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, rustAcpOverlay())
  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: isolated,
    USERPROFILE: isolated,
    DSH_HOME: join(isolated, 'dsh'),
    GROK_HOME: join(isolated, '.grok'),
    DSH_BIN: dshPath(),
    CODSH_NODE: process.execPath,
    CODSH_ACP_PATCH: overlay,
    DSH_CODE_CLI_MOCK_TOOL: 'echo',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'OFF',
    DEEPSEEK_API_KEY: '',
    CODSH_UPDATE_CHECK: 'off',
    ...extra,
  })
  const run = (args, extra = {}, dir = cwd) => {
    const result = spawnSync(binary, args, { cwd: dir, env: env(extra), encoding: 'utf8', timeout: 120000 })
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  const plugin = (...args) => run(['plugin', ...args])
  const list = () => JSON.parse(plugin('list', '--json').stdout)
  // One plain dsh turn. The echo mock reports which plugin markers reached the provider.
  const turn = (prompt, extraArgs = ['--trust'], dir = cwd) => {
    const result = run([...extraArgs, '-p', prompt], {}, dir)
    const markers = (result.stdout.match(/markers=([A-Z0-9_,]+)/) ?? [])[1]?.split(',') ?? []
    return { ...result, markers }
  }
  const bashTurn = (dir = cwd, extraArgs = ['--trust']) => run([...extraArgs, '--always-approve', '-p', 'run the fixture'], { DSH_CODE_CLI_MOCK_TOOL: 'hook-bash' }, dir)
  const hookLog = (dir = cwd) => (existsSync(join(dir, 'plugin-hook.log')) ? readFileSync(join(dir, 'plugin-hook.log'), 'utf8') : '')
  return { root, isolated, cwd, run, plugin, list, turn, bashTurn, hookLog }
}

describe('plugin hook sources', () => {
  it('parses CODSH_PLUGIN_HOOKS and skips only the bad entries', () => {
    const warnings = []
    expect(pluginHookSources('not json', warnings)).toEqual([])
    expect(warnings[0]).toMatch(/plugin hooks unreadable/)
    const sources = pluginHookSources(JSON.stringify([
      { plugin: 'demo', scope: 'user', root: '/p/demo', data: '/d/demo', file: '/p/demo/hooks/hooks.json' },
      { plugin: 'inline', scope: 'project', root: '/p/inline', data: '/d/inline', body: '{"hooks":{}}' },
      { root: '/p/nameless', file: '/x.json' },
      { plugin: 'empty', root: '/p/empty' },
    ]), warnings)
    expect(sources.map(item => item.plugin)).toEqual(['demo', 'inline'])
    expect(sources[0].env).toEqual({ GROK_PLUGIN_ROOT: '/p/demo', CLAUDE_PLUGIN_ROOT: '/p/demo', GROK_PLUGIN_DATA: '/d/demo', CLAUDE_PLUGIN_DATA: '/d/demo' })
    expect(sources[1].scope).toBe('project')
    expect(warnings.some(item => item.includes('without plugin and root'))).toBe(true)
    expect(pluginHookSources(undefined)).toEqual([])
  })

  it('loads plugin hooks under the hook contract, with plugin-owned env', () => {
    const root = tempRoot('codsh-plugin-hooks-')
    const pluginRoot = join(root, 'demo')
    writePlugin(pluginRoot)
    write(join(root, 'broken', 'hooks', 'hooks.json'), '{ nope')
    const hooksFile = JSON.stringify(JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')))
    // A plugin cannot repoint its own root through a hook's env.
    write(join(pluginRoot, 'hooks', 'hooks.json'), hooksFile.replace('"timeout":5}', '"timeout":5,"env":{"GROK_PLUGIN_ROOT":"/elsewhere"}}'))
    const raw = JSON.stringify([
      { plugin: 'demo', scope: 'user', root: pluginRoot, data: join(root, 'data'), file: join(pluginRoot, 'hooks', 'hooks.json') },
      { plugin: 'broken', scope: 'user', root: join(root, 'broken'), data: '', file: join(root, 'broken', 'hooks', 'hooks.json') },
      { plugin: 'proj', scope: 'project', root: join(root, 'proj'), data: '', body: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }) },
    ])
    const untrusted = discoverHooks({ cwd: root, grokHome: join(root, 'grok'), trusted: false, env: {}, plugins: pluginHookSources(raw) })
    expect(untrusted.groups.map(group => `${group.source}:${group.event}`)).toEqual(['plugin:demo:PreToolUse', 'plugin:demo:UserPromptSubmit'])
    const pre = untrusted.groups[0].hooks[0]
    expect(pre.command).toBe(join(pluginRoot, 'scripts', 'guard.sh'))
    expect(pre.env.GROK_PLUGIN_ROOT).toBe(pluginRoot)
    expect(pre.env.GROK_PLUGIN_DATA).toBe(join(root, 'data'))
    expect(untrusted.warnings.some(item => item.includes('hook config unreadable') && item.includes('broken'))).toBe(true)
    const trusted = discoverHooks({ cwd: root, grokHome: join(root, 'grok'), trusted: true, env: {}, plugins: pluginHookSources(raw) })
    expect(trusted.groups.map(group => group.source)).toContain('plugin:proj')
  })
})

describe('plugin contributions through real dsh', () => {
  it('enable, update, disable, and uninstall move rules, skills, commands, agents, and hooks', () => {
    const box = sandbox()
    const source = join(box.root, 'src', 'demo')
    writePlugin(source)

    const installed = box.plugin('install', source, '--trust')
    expect(installed.code, installed.stderr).toBe(0)
    expect(box.list()[0]).toMatchObject({ name: 'demo', state: 'disabled', trusted: true, enabled: false, executionGranted: false })

    // Installed and trusted but not enabled: dsh sees none of it.
    const idle = box.turn('/demo:greet hi')
    expect(idle.code, idle.stderr).toBe(0)
    expect(idle.markers).toEqual([])
    const free = box.bashTurn()
    expect(free.stdout).toContain('RUST_ACP_HOOK_DONE HOOK_SIDE_EFFECT')
    expect(box.hookLog()).toBe('')

    const enabled = box.plugin('enable', 'demo')
    expect(enabled.code, enabled.stderr).toBe(0)
    expect(enabled.stdout).toContain('Enabled plugin: demo [active]')
    expect(enabled.stdout).toContain('does not grant tool permissions')
    const row = box.list()[0]
    expect(row).toMatchObject({ state: 'active', enabled: true, executionGranted: false })
    expect(row.contributions).toMatchObject({
      rules: ['rules/style.md'],
      skills: ['/demo:greet'],
      commands: ['/demo:deploy'],
      agents: ['demo:reviewer'],
      hooks: ['PreToolUse(Bash)', 'UserPromptSubmit'],
    })

    const plain = box.turn('hello there')
    expect(plain.markers).toEqual(['PLUGIN_RULE_BODY', 'PLUGIN_AGENT_BODY'])
    const skill = box.turn('/greet hi')
    expect(skill.markers).toContain('PLUGIN_SKILL_BODY')
    const qualified = box.turn('/demo:greet hi')
    expect(qualified.markers).toContain('PLUGIN_SKILL_BODY')
    const command = box.turn('/demo:deploy now')
    expect(command.markers).toContain('PLUGIN_COMMAND_BODY')

    const blocked = box.bashTurn()
    expect(blocked.stdout).toContain('RUST_ACP_HOOK_DENIED')
    expect(blocked.stdout).toContain('PLUGIN_HOOK_BLOCKED by demo')
    expect(blocked.stdout).not.toContain('RUST_ACP_HOOK_DONE')
    const installedRoot = row.path
    const log = box.hookLog()
    expect(log).toContain(`GUARD root=${installedRoot} data=${join(box.isolated, '.grok', 'plugin-data', 'demo')} event=pre_tool_use`)
    expect(log).toContain(`PROMPT ${installedRoot}`)

    // A version update replaces the loaded content; nothing stale stays.
    writePlugin(source, { version: '2.0.0', skill: 'PLUGIN_V2_BODY' })
    const updated = box.plugin('update', 'demo')
    expect(updated.code, updated.stderr).toBe(0)
    const v2 = box.turn('/demo:greet hi')
    expect(v2.markers).toContain('PLUGIN_V2_BODY')
    expect(v2.markers).not.toContain('PLUGIN_SKILL_BODY')
    expect(box.list()[0].state).toBe('active')

    const disabled = box.plugin('disable', 'demo')
    expect(disabled.code, disabled.stderr).toBe(0)
    expect(box.list()[0]).toMatchObject({ state: 'disabled', enabled: false })
    expect(box.turn('/demo:greet hi').markers).toEqual([])
    rmSync(join(box.cwd, 'plugin-hook.log'), { force: true })
    expect(box.bashTurn().stdout).toContain('RUST_ACP_HOOK_DONE HOOK_SIDE_EFFECT')
    expect(box.hookLog()).toBe('')

    box.plugin('enable', 'demo')
    expect(box.turn('hello').markers).toContain('PLUGIN_RULE_BODY')
    const removed = box.plugin('uninstall', 'demo')
    expect(removed.code, removed.stderr).toBe(0)
    expect(box.list()).toEqual([])
    rmSync(join(box.cwd, 'plugin-hook.log'), { force: true })
    expect(box.turn('/demo:greet hi').markers).toEqual([])
    expect(box.bashTurn().stdout).toContain('RUST_ACP_HOOK_DONE HOOK_SIDE_EFFECT')
    expect(box.hookLog()).toBe('')
  }, 240000)

  it('keeps a broken plugin from hiding others and gates project plugins on workspace trust', () => {
    const box = sandbox()
    const good = join(box.root, 'src', 'demo')
    writePlugin(good)
    const broken = join(box.root, 'src', 'broken')
    write(join(broken, 'plugin.json'), JSON.stringify({ name: 'broken', version: '0.1.0', commands: '../escape' }))
    write(join(broken, 'hooks', 'hooks.json'), '{ not json')
    write(join(broken, 'skills', 'fine', 'SKILL.md'), 'BROKEN_BUT_FINE\n')
    for (const [dir, name] of [[good, 'demo'], [broken, 'broken']]) {
      expect(box.plugin('install', dir, '--trust').code).toBe(0)
      expect(box.plugin('enable', name).code).toBe(0)
    }
    const rows = Object.fromEntries(box.list().map(item => [item.name, item]))
    expect(rows.broken.state).toBe('active')
    expect(rows.broken.contributions.skills).toEqual(['/broken:fine'])
    expect(rows.broken.contributions.problems.join('\n')).toMatch(/commands path \.\.\/escape/)
    expect(rows.broken.contributions.problems.join('\n')).toMatch(/hooks file .* unreadable/)
    // The good plugin's hook still blocks; the broken file is a warning only.
    const blocked = box.bashTurn()
    expect(blocked.stdout).toContain('PLUGIN_HOOK_BLOCKED by demo')
    const inspect = JSON.parse(box.run(['inspect', '--json']).stdout)
    const skills = inspect.assets?.skills ?? []
    expect(skills.some(item => item.invocableAs === '/fine' && item.source === 'plugin:broken')).toBe(true)

    // A project plugin needs both an explicit enable and a trusted workspace.
    const project = join(box.root, 'project')
    mkdirSync(join(project, '.git'), { recursive: true })
    writePlugin(join(project, '.grok', 'plugins', 'local-kit'), { name: 'local-kit', skill: 'PLUGIN_SKILL_BODY' })
    rmSync(join(project, '.grok', 'plugins', 'local-kit', 'rules'), { recursive: true })
    expect(box.run(['plugin', 'uninstall', 'demo'], {}, project).code).toBe(0)
    expect(box.run(['plugin', 'enable', 'local-kit'], {}, project).code).toBe(0)
    const untrusted = box.turn('/local-kit:greet hi', [], project)
    expect(untrusted.code, untrusted.stderr).toBe(0)
    expect(untrusted.markers).not.toContain('PLUGIN_SKILL_BODY')
    expect(box.bashTurn(project, []).stdout).not.toContain('PLUGIN_HOOK_BLOCKED')
    expect(box.hookLog(project)).toBe('')
    const trusted = box.turn('/local-kit:greet hi', ['--trust'], project)
    expect(trusted.markers).toContain('PLUGIN_SKILL_BODY')
    expect(box.bashTurn(project, ['--trust']).stdout).toContain('PLUGIN_HOOK_BLOCKED by local-kit')
  }, 240000)
})
