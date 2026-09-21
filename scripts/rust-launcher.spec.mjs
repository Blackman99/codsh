import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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
