/**
 * The zero-dependency `codsh` launcher, end to end: it must find a dsh it did
 * not bring, migrate a pre-split profile off the old fat `codsh-cli` bundle,
 * register `codsh-bundle`, and boot — because this wrapper is the one artifact
 * a global install actually runs.
 */

import { execFileSync, execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS, bundleRoot, dshBin, overlayText } from './harness.ts'

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const wrapper = join(repoRoot, 'packages', 'cli', 'bin', 'codsh.mjs')

describe.skipIf(process.platform === 'win32')('the codsh launcher', () => {
  it('migrates a pre-split profile, registers the bundle, and boots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codsh-wrapper-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'codsh-wrapper-cwd-'))
    try {
      if (!existsSync(join(bundleRoot, 'lib', 'index.js'))) {
        throw new Error('wrapper e2e needs the built lib/ — run `pnpm run build` first')
      }
      const tarball = execFileSync('npm', ['pack', '--pack-destination', home], { cwd: bundleRoot, encoding: 'utf8' })
        .trim().split('\n').at(-1) ?? ''
      // A pre-split profile: the runtime registered under the launcher's name,
      // with the init files dsh writes (the hoisted linker is what lets the
      // profile-rooted loader resolve a bundle's transitive plugin packages).
      const profile = join(home, 'profiles', 'code')
      mkdirSync(profile, { recursive: true })
      writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
      writeFileSync(join(profile, 'cordis.yml'), '[]\n')
      writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
      writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-code',
        private: true,
        dependencies: { 'codsh-cli': 'file:/nonexistent/codsh-cli-0.2.0.tgz' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'codsh-cli'] } },
      }, null, 2)}\n`)
      const overlay = join(home, 'mock.cordis.patch.yml')
      writeFileSync(overlay, overlayText())

      const result = await run(process.execPath, [wrapper, '--patch', overlay, '-p', 'create the note'], {
        cwd,
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_BIN: dshBin(),
          CODSH_BUNDLE_SPEC: `file:${join(home, tarball)}`,
          DSH_TELEMETRY_DISABLED: '1',
          DSH_CODE_CLI_MOCK_TOOL: 'write',
          DEEPSEEK_API_KEY: '',
          CODSH_CLIPBOARD: 'osc52',
        },
        timeout: 110_000,
      })

      // The old registration is gone, the bundle is in, and the app answered.
      const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        dsh: { profile: { bundles: string[] } }
      }
      expect(Object.keys(manifest.dependencies)).toContain('codsh-bundle')
      expect(Object.keys(manifest.dependencies)).not.toContain('codsh-cli')
      expect(manifest.dsh.profile.bundles).toContain('codsh-bundle')
      expect(manifest.dsh.profile.bundles).not.toContain('codsh-cli')
      expect(result.stdout).toContain('CODE_CLI_CALL_OK')
      expect(result.stderr).toContain('migrating the profile')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)
})
