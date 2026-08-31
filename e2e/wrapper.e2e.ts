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
import { E2E_TEST_TIMEOUT_MS, bundleRoot, dshBin, fakeRegistry, overlayText } from './harness.ts'

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

  it('updates the pair from outside a session, and installs nothing when current', async () => {
    const own = JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }
    // Advertising the version in hand is the one answer that must never run an
    // install; the registry is local, so no suite ever reaches npm.
    const registry = await fakeRegistry(own.version)
    try {
      const result = await run(process.execPath, [wrapper, 'update'], {
        env: { ...process.env, CODSH_UPDATE_REGISTRY: registry.base, DSH_BIN: dshBin() },
      })

      expect(result.stdout.trim()).toBe(`codsh ${own.version} is the latest`)
      // A word that would otherwise have been passed through as a task: the
      // launcher answers it itself, without booting anything.
      expect(result.stderr).not.toContain('registering')
      expect(result.stdout).not.toContain('npm install -g')
    } finally {
      await registry.close()
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('says so, and fails, when the registry cannot be reached', async () => {
    // Port 1 answers nothing on any machine, which is the unreachable case a
    // laptop on a captive network actually has.
    const failed = await run(process.execPath, [wrapper, 'update'], {
      env: { ...process.env, CODSH_UPDATE_REGISTRY: 'http://127.0.0.1:1', DSH_BIN: dshBin() },
    }).then(() => undefined, (error: { stderr: string; code: number }) => error)

    expect(failed?.stderr).toContain('could not reach the npm registry')
    expect(failed?.code).toBe(1)
  }, E2E_TEST_TIMEOUT_MS)

  it('answers --version for the pair, not for the runtime it launches', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codsh-version-home-'))
    try {
      const profile = join(home, 'profiles', 'code')
      mkdirSync(profile, { recursive: true })
      writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-code',
        private: true,
        dependencies: { 'codsh-bundle': '^0.4.2' },
      }, null, 2)}\n`)
      const own = JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }

      const result = await run(process.execPath, [wrapper, '--version'], {
        env: { ...process.env, DSH_HOME: home, DSH_BIN: dshBin(), DSH_TELEMETRY_DISABLED: '1' },
      })

      // The launcher's own version, what the profile carries right now, and the
      // dsh this run found — the flag never reaches that dsh, which would have
      // answered with a version nobody asked about.
      const lines = result.stdout.trim().split('\n')
      expect(lines[0]).toBe(`codsh ${own.version}`)
      expect(lines[1]).toBe('codsh-bundle ^0.4.2')
      expect(lines[2]).toMatch(/^dsh \d+\.\d+\.\d+/u)
      // Asking the version must not register, install, or boot anything.
      expect(readFileSync(join(profile, 'package.json'), 'utf8')).toContain('^0.4.2')
      expect(result.stderr).not.toContain('registering')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)
})
