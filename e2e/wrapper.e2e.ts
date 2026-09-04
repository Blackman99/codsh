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
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS, bundleRoot, dshBin, fakeRegistry, overlayText } from './harness.ts'

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const wrapper = join(repoRoot, 'packages', 'cli', 'bin', 'codsh.mjs')

/** A fake executable that echoes its invocation as `TAG args…`, for npm or dsh. */
function writeFake(path: string, tag: string): void {
  writeFileSync(path, `#!/usr/bin/env node
console.log(\`${tag} \${process.argv.slice(2).join(' ')}\`)
`, { mode: 0o755 })
}

/** A fake executable that echoes its invocation and fails, for a dsh that cannot register. */
function writeFailingFake(path: string, tag: string): void {
  writeFileSync(path, `#!/usr/bin/env node
console.log(\`${tag} \${process.argv.slice(2).join(' ')}\`)
process.exit(1)
`, { mode: 0o755 })
}

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

  it('upgrades an exact older registry version before booting', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codsh-wrapper-exact-home-'))
    try {
      const profile = join(home, 'profiles', 'code')
      mkdirSync(profile, { recursive: true })
      writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-code',
        private: true,
        dependencies: { 'codsh-bundle': '0.0.1' },
      }, null, 2)}\n`)
      const fakeDsh = join(home, 'fake-dsh.mjs')
      writeFileSync(fakeDsh, "process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\\n`)\n")
      const own = JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')) as { version: string }
      const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, DSH_BIN: fakeDsh }
      delete env.CODSH_BUNDLE_SPEC

      const result = await run(process.execPath, [wrapper, '-p', 'test the exact version'], {
        env,
      })

      expect(result.stderr).toContain(`registering codsh-bundle@^${own.version}`)
      expect(result.stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual([
        ['plugin', '--profile', 'code', 'add', `codsh-bundle@^${own.version}`],
        ['--profile', 'code', '-p', 'test the exact version'],
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

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

  /** A fresh home whose code profile declares exactly the given dependencies. */
  async function homeWithProfile(dependencies: Record<string, string>): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'codsh-update-home-'))
    const profile = join(home, 'profiles', 'code')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-code',
      private: true,
      dependencies,
    }, null, 2)}\n`)
    return home
  }

  it('moves the profile runtime when update finds a newer codsh', async () => {
    const home = await homeWithProfile({ 'codsh-bundle': '0.1.0' })
    const fake = await mkdtemp(join(tmpdir(), 'codsh-update-fake-bin-'))
    try {
      writeFake(join(fake, 'npm'), 'FAKE_NPM')
      writeFake(join(fake, 'dsh'), 'FAKE_DSH')
      const registry = await fakeRegistry('9.9.9')
      try {
        const result = await run(process.execPath, [wrapper, 'update'], {
          env: {
            ...process.env,
            DSH_HOME: home,
            DSH_BIN: join(fake, 'dsh'),
            PATH: `${fake}${delimiter}${process.env.PATH ?? ''}`,
            CODSH_UPDATE_REGISTRY: registry.base,
          },
        })

        // The launcher install ran in the open, and the runtime move followed
        // it in the same command — no suite reaches npm or a real profile.
        expect(result.stderr).toContain('codsh: npm install -g codsh-cli@9.9.9')
        expect(result.stdout).toContain('FAKE_NPM install -g codsh-cli@9.9.9')
        expect(result.stderr).toContain('codsh: registering codsh-bundle@^9.9.9 into the dsh code profile')
        expect(result.stdout).toContain('FAKE_DSH plugin --profile code add codsh-bundle@^9.9.9')
        expect(result.stdout).toContain('codsh 9.9.9 installed · the code profile now carries codsh-bundle@^9.9.9')
      } finally {
        await registry.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(fake, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('leaves a development-pinned runtime alone when update moves the launcher', async () => {
    const home = await homeWithProfile({ 'codsh-bundle': 'link:../codsh-bundle' })
    const fake = await mkdtemp(join(tmpdir(), 'codsh-update-pinned-bin-'))
    try {
      writeFake(join(fake, 'npm'), 'FAKE_NPM')
      writeFake(join(fake, 'dsh'), 'FAKE_DSH')
      const registry = await fakeRegistry('9.9.9')
      try {
        const result = await run(process.execPath, [wrapper, 'update'], {
          env: {
            ...process.env,
            DSH_HOME: home,
            DSH_BIN: join(fake, 'dsh'),
            PATH: `${fake}${delimiter}${process.env.PATH ?? ''}`,
            CODSH_UPDATE_REGISTRY: registry.base,
          },
        })

        expect(result.stdout).toContain('FAKE_NPM install -g codsh-cli@9.9.9')
        expect(result.stdout).toContain('the code profile pins codsh-bundle to "link:../codsh-bundle" — leaving it as-is')
        // A pinned runtime is never clobbered: the dsh is not driven at all.
        expect(result.stdout).not.toContain('FAKE_DSH')
      } finally {
        await registry.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(fake, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('says the profile is already current instead of registering again', async () => {
    const home = await homeWithProfile({ 'codsh-bundle': '^9.9.9' })
    const fake = await mkdtemp(join(tmpdir(), 'codsh-update-current-bin-'))
    try {
      writeFake(join(fake, 'npm'), 'FAKE_NPM')
      writeFake(join(fake, 'dsh'), 'FAKE_DSH')
      const registry = await fakeRegistry('9.9.9')
      try {
        const result = await run(process.execPath, [wrapper, 'update'], {
          env: {
            ...process.env,
            DSH_HOME: home,
            DSH_BIN: join(fake, 'dsh'),
            PATH: `${fake}${delimiter}${process.env.PATH ?? ''}`,
            CODSH_UPDATE_REGISTRY: registry.base,
          },
        })

        expect(result.stdout).toContain('codsh 9.9.9 installed · the code profile already carries codsh-bundle ^9.9.9')
        expect(result.stdout).not.toContain('FAKE_DSH')
      } finally {
        await registry.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(fake, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('defers a legacy pre-split profile to the next boot', async () => {
    const home = await homeWithProfile({ 'codsh-cli': '0.15.1' })
    const fake = await mkdtemp(join(tmpdir(), 'codsh-update-legacy-bin-'))
    try {
      writeFake(join(fake, 'npm'), 'FAKE_NPM')
      writeFake(join(fake, 'dsh'), 'FAKE_DSH')
      const registry = await fakeRegistry('9.9.9')
      try {
        const result = await run(process.execPath, [wrapper, 'update'], {
          env: {
            ...process.env,
            DSH_HOME: home,
            DSH_BIN: join(fake, 'dsh'),
            PATH: `${fake}${delimiter}${process.env.PATH ?? ''}`,
            CODSH_UPDATE_REGISTRY: registry.base,
          },
        })

        expect(result.stdout).toContain('codsh 9.9.9 installed · the next codsh start registers the matching runtime')
        expect(result.stdout).not.toContain('FAKE_DSH')
      } finally {
        await registry.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(fake, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('fails loudly when the runtime cannot be registered', async () => {
    const home = await homeWithProfile({ 'codsh-bundle': '0.1.0' })
    const fake = await mkdtemp(join(tmpdir(), 'codsh-update-fail-bin-'))
    try {
      writeFake(join(fake, 'npm'), 'FAKE_NPM')
      writeFailingFake(join(fake, 'dsh'), 'FAKE_DSH')
      const registry = await fakeRegistry('9.9.9')
      try {
        const failed = await run(process.execPath, [wrapper, 'update'], {
          env: {
            ...process.env,
            DSH_HOME: home,
            DSH_BIN: join(fake, 'dsh'),
            PATH: `${fake}${delimiter}${process.env.PATH ?? ''}`,
            CODSH_UPDATE_REGISTRY: registry.base,
          },
        }).then(() => undefined, (error: { stderr: string; code: number }) => error)

        expect(failed?.stderr).toContain('the launcher is installed, but codsh-bundle@^9.9.9 could not be registered into the code profile')
        expect(failed?.code).toBe(1)
      } finally {
        await registry.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(fake, { recursive: true, force: true })
    }
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
