import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SKILL = `---
name: NAME
description: Vendor skill that must stay undiscovered when its scan is off.
---
BODY
`

function writeSkill(root, vendor, name) {
  const file = join(root, `.${vendor}`, 'skills', name, 'SKILL.md')
  mkdirSync(join(root, `.${vendor}`, 'skills', name), { recursive: true })
  writeFileSync(file, SKILL.replaceAll('NAME', name).replaceAll('BODY', `${vendor.toUpperCase()}_${name.toUpperCase()}_BODY`))
}

const root = resolve(import.meta.dirname, '..')

describe('packed Rust launch selection', () => {
  it('selects the native client without probing or registering the legacy runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codsh-rust-pack-'))
    try {
      const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], {
        cwd: join(root, 'packages/cli'), encoding: 'utf8',
        env: { ...process.env, npm_config_cache: join(dir, 'cache') },
      }))[0].filename
      execFileSync('tar', ['-xzf', join(dir, pack), '-C', dir])
      rmSync(join(dir, 'package/native'), { recursive: true, force: true })
      const legacy = join(dir, 'legacy')
      mkdirSync(legacy)
      writeFileSync(join(legacy, 'canary'), 'unchanged')
      const dsh = join(dir, 'must-not-run.mjs')
      writeFileSync(dsh, "process.stderr.write('LEGACY_RUNTIME_INVOKED\\n'); process.exit(91)\n")
      const result = spawnSync(process.execPath, [join(dir, 'package/bin/codsh.mjs'), '--rust', '--version'], {
        encoding: 'utf8', timeout: 10000,
        env: { PATH: process.env.PATH, HOME: dir, DSH_HOME: legacy, DSH_BIN: dsh },
      })
      expect(result.error).toBeUndefined()
      expect(result.stderr).not.toContain('LEGACY_RUNTIME_INVOKED')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Rust client artifact is not installed')
      expect(readFileSync(join(legacy, 'canary'), 'utf8')).toBe('unchanged')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Rust import command wiring', () => {
  it('exposes host Homes for explicit import without writing on --help', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codsh-rust-import-help-'))
    try {
      const hostDsh = join(dir, '.dsh')
      mkdirSync(hostDsh)
      writeFileSync(join(hostDsh, 'settings.yaml'), 'agent-default-model:\n  provider: leftover\n  model: leftover\n')
      const result = spawnSync(process.execPath, [join(root, 'packages/cli/bin/codsh.mjs'), '--rust', 'import', '--help'], {
        encoding: 'utf8', timeout: 10000,
        env: { PATH: process.env.PATH, HOME: dir, DSH_HOME: hostDsh },
      })
      expect(result.error).toBeUndefined()
      expect(existsSync(join(dir, '.codsh-rust'))).toBe(false)
      expect(readFileSync(join(hostDsh, 'settings.yaml'), 'utf8')).toContain('leftover')
      if (result.status === 1) {
        expect(result.stderr).toContain('Rust client artifact is not installed')
      } else {
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('import')
        expect(result.stdout).toContain('settings.yaml')
        expect(result.stdout).not.toContain('leftover')
      }
      expect(resolve(hostDsh)).toBe(resolve(dir, '.dsh'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('packed vendor skill overrides', () => {
  it('forwards GROK_CLAUDE_SKILLS_ENABLED and GROK_CURSOR_SKILLS_ENABLED so off skips vendor scans', () => {
    const binary = join(root, 'packages/cli/native/darwin-arm64/codsh-rust')
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || !existsSync(binary)) return
    const dir = mkdtempSync(join(tmpdir(), 'codsh-rust-vendor-skills-'))
    try {
      const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', dir], {
        cwd: join(root, 'packages/cli'), encoding: 'utf8',
        env: {
          ...process.env,
          HOME: dir,
          npm_config_cache: join(dir, 'cache'),
          npm_config_update_notifier: 'false',
        },
      }))[0].filename
      execFileSync('tar', ['-xzf', join(dir, pack), '-C', dir])
      const launcher = join(dir, 'package/bin/codsh.mjs')
      const home = join(dir, 'home')
      const isolated = join(home, '.codsh-rust')
      const project = join(dir, 'project')
      mkdirSync(join(project, '.git'), { recursive: true })
      writeSkill(project, 'claude', 'claude-project')
      writeSkill(project, 'cursor', 'cursor-project')
      writeSkill(isolated, 'claude', 'claude-user')
      writeSkill(isolated, 'cursor', 'cursor-user')
      mkdirSync(join(project, '.grok', 'skills', 'keep'), { recursive: true })
      writeFileSync(join(project, '.grok', 'skills', 'keep', 'SKILL.md'), SKILL.replaceAll('NAME', 'keep').replaceAll('BODY', 'GROK_KEEP_BODY'))
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        TERM: 'xterm-256color',
        GROK_FOLDER_TRUST: '0',
        GROK_CLAUDE_SKILLS_ENABLED: 'false',
        GROK_CURSOR_SKILLS_ENABLED: '0',
      }
      const result = spawnSync(process.execPath, [launcher, '--rust', 'inspect', '--json'], {
        cwd: project, encoding: 'utf8', timeout: 20000, env,
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      const assets = JSON.parse(result.stdout).assets
      const names = assets.skills.map(skill => skill.name)
      const commands = assets.commands.map(command => command.name)
      expect(names).toContain('keep')
      expect(names).not.toEqual(expect.arrayContaining(['claude-project', 'cursor-project', 'claude-user', 'cursor-user']))
      expect(commands).not.toEqual(expect.arrayContaining(['claude-project', 'cursor-project', 'claude-user', 'cursor-user']))
      const paths = [...assets.skills, ...assets.commands].map(item => item.path).join('\n')
      expect(paths).not.toContain('.claude')
      expect(paths).not.toContain('.cursor')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)
})
