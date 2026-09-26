import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NATIVE_TARGETS, availableKeys, dshFloorProblem, dshPackage, keyForTarget, nativeKey,
  sniffExecutable, stampTransition, verifyArtifact, versionAtLeast, whichOnPath,
} from '../packages/cli/bin/rust-artifact.mjs'

const root = resolve(import.meta.dirname, '..')
const cliBin = join(root, 'packages/cli/bin')
const temps = []
function temp(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop(), { recursive: true, force: true })
})

/** A minimal executable header for a staged key, padded like a real file. */
function header(format, cpu) {
  const bytes = Buffer.alloc(4096)
  if (format === 'mach-o') {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(cpu === 'arm64' ? 0x0100000c : 0x01000007, 4)
  } else if (format === 'elf') {
    bytes.write('\x7fELF', 0, 'latin1')
    bytes[4] = 2
    bytes[5] = 1
    bytes.writeUInt16LE(cpu === 'arm64' ? 0xb7 : 0x3e, 18)
  } else {
    bytes.write('MZ', 0, 'latin1')
    bytes.writeUInt32LE(0x80, 0x3c)
    bytes.write('PE\0\0', 0x80, 'latin1')
    bytes.writeUInt16LE(cpu === 'arm64' ? 0xaa64 : 0x8664, 0x84)
  }
  return bytes
}

function fat(cpus) {
  const bytes = Buffer.alloc(4096)
  bytes.writeUInt32BE(0xcafebabe, 0)
  bytes.writeUInt32BE(cpus.length, 4)
  cpus.forEach((cpu, index) => bytes.writeUInt32BE(cpu === 'arm64' ? 0x0100000c : 0x01000007, 8 + index * 20))
  return bytes
}

function stage(nativeRoot, key, { bytes, manifest = {} } = {}) {
  const [platform, arch] = key.split('-')
  const target = NATIVE_TARGETS[key]
  const directory = join(nativeRoot, key)
  mkdirSync(directory, { recursive: true })
  const content = bytes ?? header(target.format, target.cpu)
  const binary = join(directory, platform === 'win32' ? 'codsh-rust.exe' : 'codsh-rust')
  writeFileSync(binary, content, { mode: 0o755 })
  writeFileSync(join(directory, 'artifact.json'), JSON.stringify({
    platform, arch, target: target.target, version: '0.24.0',
    sha256: createHash('sha256').update(content).digest('hex'), ...manifest,
  }))
  return binary
}

describe('executable headers', () => {
  it('names the format and CPUs of Mach-O (thin and universal), ELF, and PE files', () => {
    expect(sniffExecutable(header('mach-o', 'arm64'))).toEqual({ format: 'mach-o', cpus: ['arm64'] })
    expect(sniffExecutable(header('mach-o', 'x64'))).toEqual({ format: 'mach-o', cpus: ['x64'] })
    expect(sniffExecutable(fat(['x64', 'arm64']))).toEqual({ format: 'mach-o', cpus: ['x64', 'arm64'] })
    expect(sniffExecutable(header('elf', 'x64'))).toEqual({ format: 'elf', cpus: ['x64'] })
    expect(sniffExecutable(header('elf', 'arm64'))).toEqual({ format: 'elf', cpus: ['arm64'] })
    expect(sniffExecutable(header('pe', 'x64'))).toEqual({ format: 'pe', cpus: ['x64'] })
    const javaClass = Buffer.alloc(64)
    javaClass.writeUInt32BE(0xcafebabe, 0)
    javaClass.writeUInt32BE(0x00000034, 4)
    expect(sniffExecutable(javaClass).format).toBe('unknown')
    expect(sniffExecutable(Buffer.from('#!/bin/sh\necho hi\n'))).toEqual({ format: 'unknown', cpus: [] })
  })

  it('reads the staged host binary when one is built', () => {
    const key = nativeKey()
    const binary = join(root, 'packages/cli/native', key, process.platform === 'win32' ? 'codsh-rust.exe' : 'codsh-rust')
    if (!existsSync(binary) || !(key in NATIVE_TARGETS)) return
    const found = sniffExecutable(readFileSync(binary).subarray(0, 4096))
    expect(found.format).toBe(NATIVE_TARGETS[key].format)
    expect(found.cpus).toContain(NATIVE_TARGETS[key].cpu)
  })

  it('maps every staged key to one Rust target and back', () => {
    for (const [key, value] of Object.entries(NATIVE_TARGETS)) expect(keyForTarget(value.target)).toBe(key)
    expect(keyForTarget('riscv64gc-unknown-linux-gnu')).toBeUndefined()
    expect(NATIVE_TARGETS['darwin-arm64'].target).toBe('aarch64-apple-darwin')
    expect(NATIVE_TARGETS['darwin-x64'].target).toBe('x86_64-apple-darwin')
  })
})

describe('staged artifact verification', () => {
  it('accepts matching macOS arm64 and x64 artifacts and refuses each on the other CPU', () => {
    const nativeRoot = join(temp('codsh-artifact-'), 'native')
    stage(nativeRoot, 'darwin-arm64')
    stage(nativeRoot, 'darwin-x64')
    const arm = verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'darwin', arch: 'arm64' })
    expect(arm.ok).toBe(true)
    expect(arm.manifest.target).toBe('aarch64-apple-darwin')
    expect(verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'darwin', arch: 'x64' }).ok).toBe(true)
    expect(availableKeys(nativeRoot)).toEqual(['darwin-arm64', 'darwin-x64'])
    // A universal binary serves either directory.
    stage(nativeRoot, 'darwin-arm64', { bytes: fat(['x64', 'arm64']) })
    expect(verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'darwin', arch: 'arm64' }).ok).toBe(true)
    // An x64 build copied into the arm64 directory, even with a matching hash.
    stage(nativeRoot, 'darwin-arm64', { bytes: header('mach-o', 'x64') })
    const wrong = verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'darwin', arch: 'arm64' })
    expect(wrong).toMatchObject({ ok: false, code: 'target' })
    expect(wrong.message).toContain('integrity/platform mismatch')
    expect(wrong.message).toContain('a macOS x64 executable, not a mach-o arm64 build')
    // A Linux binary in a macOS directory.
    stage(nativeRoot, 'darwin-x64', { bytes: header('elf', 'x64') })
    expect(verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'darwin', arch: 'x64' }).message).toContain('a Linux x64 executable')
  })

  it('names what the package carries when this platform is missing, with the Rosetta hint', () => {
    const nativeRoot = join(temp('codsh-artifact-'), 'native')
    const none = verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'darwin', arch: 'arm64' })
    expect(none).toMatchObject({ ok: false, code: 'missing', available: [] })
    expect(none.message).toContain('Rust client artifact is not installed for darwin-arm64')
    expect(none.message).toContain('carries no prebuilt Rust client')
    expect(none.message).toContain('ordinary codsh remains available')
    stage(nativeRoot, 'darwin-arm64')
    const rosetta = verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'darwin', arch: 'x64' })
    expect(rosetta.available).toEqual(['darwin-arm64'])
    expect(rosetta.message).toContain('This package carries: darwin-arm64.')
    expect(rosetta.message).toContain('Rosetta')
    expect(rosetta.recovery[0]).toContain('npm install -g codsh-cli@0.24.0')
    expect(rosetta.recovery.join('\n')).toContain('codsh-cli@<previous version>')
  })

  it('refuses damaged binaries, unreadable or foreign manifests, and a half-finished update', () => {
    const nativeRoot = join(temp('codsh-artifact-'), 'native')
    const binary = stage(nativeRoot, 'linux-x64')
    const ok = verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'linux', arch: 'x64' })
    expect(ok.ok).toBe(true)
    const bytes = readFileSync(binary)
    bytes[100] ^= 0xff
    writeFileSync(binary, bytes)
    const corrupt = verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'linux', arch: 'x64' })
    expect(corrupt).toMatchObject({ ok: false, code: 'corrupt' })
    expect(corrupt.message).toContain('damaged or incomplete download')
    stage(nativeRoot, 'linux-x64', { manifest: { version: '0.23.0' } })
    const partial = verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'linux', arch: 'x64' })
    expect(partial).toMatchObject({ ok: false, code: 'version', artifactVersion: '0.23.0' })
    expect(partial.message).toBe('Rust client 0.23.0 does not match this codsh-cli 0.24.0: an update did not finish.')
    stage(nativeRoot, 'linux-x64', { manifest: { arch: 'arm64' } })
    expect(verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'linux', arch: 'x64' }).code).toBe('target')
    // A local candidate staged before the version field is still accepted.
    stage(nativeRoot, 'linux-x64', { manifest: { version: undefined } })
    expect(verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'linux', arch: 'x64' }).ok).toBe(true)
    writeFileSync(join(nativeRoot, 'linux-x64', 'artifact.json'), '{truncated')
    expect(verifyArtifact({ nativeRoot, version: '0.24.0', platform: 'linux', arch: 'x64' }).code).toBe('manifest')
  })
})

describe('dsh floor and version stamps', () => {
  it('compares dsh versions with prerelease ranks', () => {
    expect(versionAtLeast('0.1.5-rc.3', '0.1.5-rc.2')).toBe(true)
    expect(versionAtLeast('0.1.5-rc.2', '0.1.5-rc.2')).toBe(true)
    expect(versionAtLeast('0.1.5-alpha.9', '0.1.5-rc.2')).toBe(false)
    expect(versionAtLeast('0.1.5', '0.1.5-rc.2')).toBe(true)
    expect(versionAtLeast('0.1.4', '0.1.5-rc.2')).toBe(false)
    expect(versionAtLeast('0.2.0', '0.1.9')).toBe(true)
    expect(versionAtLeast('custom', '0.1.5')).toBeUndefined()
  })

  it('refuses a dsh package below the floor and lets unreadable versions through', () => {
    const dir = temp('codsh-dsh-floor-')
    const make = version => {
      const pkg = join(dir, version, 'node_modules/@deepseek-ai/dsh')
      mkdirSync(join(pkg, 'lib'), { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
      writeFileSync(join(pkg, 'lib/bin.js'), '')
      return join(pkg, 'lib/bin.js')
    }
    const old = make('0.1.4')
    expect(dshPackage(old)).toMatchObject({ version: '0.1.4' })
    const refused = dshFloorProblem(old, '0.1.5-rc.2', '0.24.0')
    expect(refused).toMatchObject({ ok: false, code: 'dsh-too-old' })
    expect(refused.message).toContain('dsh 0.1.4')
    expect(refused.recovery[0]).toBe('install one:      npm install -g @deepseek-ai/dsh   (0.1.5-rc.2 or newer)')
    expect(dshFloorProblem(make('0.1.5-rc.3'), '0.1.5-rc.2', '0.24.0')).toBeUndefined()
    const fake = join(dir, 'fake-dsh.mjs')
    writeFileSync(fake, '')
    expect(dshFloorProblem(fake, '0.1.5-rc.2', '0.24.0')).toBeUndefined()
    expect(dshFloorProblem('dsh', '0.1.5-rc.2', '0.24.0')).toBeUndefined()
  })

  it('finds dsh on PATH as an absolute real path', () => {
    if (process.platform === 'win32') return
    const dir = temp('codsh-which-')
    mkdirSync(join(dir, 'real'))
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'real', 'bin.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    symlinkSync(join(dir, 'real', 'bin.js'), join(dir, 'bin', 'dsh'))
    expect(whichOnPath('dsh', `relative:${join(dir, 'bin')}`)).toBe(join(dir, 'real', 'bin.js'))
    expect(whichOnPath('dsh', join(dir, 'real'))).toBeUndefined()
  })

  it('reports updates and rollbacks once and keeps the newest version seen', () => {
    expect(stampTransition(undefined, '0.24.0', 't').notice).toBeUndefined()
    expect(stampTransition({ lastVersion: '0.24.0' }, '0.24.0', 't').notice).toBeUndefined()
    const up = stampTransition({ lastVersion: '0.24.0', newestVersion: '0.24.0' }, '0.25.0', 't')
    expect(up.notice).toBe('codsh: Rust client updated 0.24.0 → 0.25.0. Go back with: npm install -g codsh-cli@0.24.0')
    expect(up.next).toEqual({ lastVersion: '0.25.0', newestVersion: '0.25.0', previousVersion: '0.24.0', updatedAt: 't' })
    const down = stampTransition(up.next, '0.24.0', 'u')
    expect(down.notice).toContain('last used by codsh 0.25.0; now running 0.24.0 (an earlier version)')
    expect(down.notice).toContain('npm install -g codsh-cli@0.25.0')
    expect(down.next).toMatchObject({ lastVersion: '0.24.0', newestVersion: '0.25.0', previousVersion: '0.25.0' })
  })
})

/** A dsh install laid out as `npm install -g` does: harness packages under dsh's own node_modules. */
function globalDsh(dir, { packages = {}, version = '0.1.5-rc.3' } = {}) {
  const pkg = join(dir, 'prefix/lib/node_modules/@deepseek-ai/dsh')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, type: 'module', bin: { dsh: 'lib/bin.js' } }))
  for (const [name, target] of Object.entries(packages)) {
    const destination = join(pkg, 'node_modules', name)
    mkdirSync(dirname(destination), { recursive: true })
    if (typeof target === 'string') symlinkSync(target, destination)
    else {
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(destination, 'package.json'), JSON.stringify({ name, type: 'module', exports: { '.': { default: './index.js' } } }))
      writeFileSync(join(destination, 'index.js'), target.source)
    }
  }
  return pkg
}

/** Copy codsh-cli's bin/ and package.json somewhere with no node_modules above it. */
function isolatedCli(dir) {
  const pkg = join(dir, 'prefix/lib/node_modules/codsh-cli')
  cpSync(cliBin, join(pkg, 'bin'), { recursive: true })
  cpSync(join(root, 'packages/cli/package.json'), join(pkg, 'package.json'))
  return pkg
}

describe('dsh plugins in a clean global install', () => {
  it('load harness packages from the running dsh, not from the codsh-cli directory', () => {
    const dir = temp('codsh-clean-plugin-')
    const requireFromRoot = createRequire(join(root, 'package.json'))
    const real = name => dirname(realpathSync(requireFromRoot.resolve(`${name}/package.json`)))
    const dsh = globalDsh(dir, { packages: { '@deepseek-ai/dsh-llm': real('@deepseek-ai/dsh-llm'), '@deepseek-ai/dsh-tools': real('@deepseek-ai/dsh-tools') } })
    const cli = isolatedCli(dir)
    // Nothing above codsh-cli can resolve a harness package, as after `npm install -g`.
    expect(() => createRequire(join(cli, 'bin', 'rust-acp-plan.mjs')).resolve('@deepseek-ai/dsh-llm')).toThrow()
    const plugins = ['rust-acp-plan.mjs', 'rust-acp-file-approval.mjs', 'rust-acp-hooks.mjs', 'rust-acp-subagents.mjs', 'rust-acp-background.mjs', 'rust-acp-control.mjs', 'rust-acp-mcp.mjs', 'rust-acp-goal.mjs', 'rust-acp-compact.mjs', 'rust-acp-web.mjs', 'rust-acp-plain.mjs', 'rust-acp-image.mjs']
    writeFileSync(join(dsh, 'lib/bin.js'), [
      `const names = ${JSON.stringify(plugins)}`,
      `for (const name of names) { const mod = await import(${JSON.stringify(pathToFileURL(join(cli, 'bin')).href)} + '/' + name); if (!mod.name && !mod.apply) throw new Error('no plugin export in ' + name) }`,
      "process.stdout.write('PLUGINS_LOADED\\n')",
    ].join('\n'))
    const result = spawnSync(process.execPath, [join(dsh, 'lib/bin.js')], { encoding: 'utf8', timeout: 30000, cwd: dir, env: { PATH: process.env.PATH } })
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('PLUGINS_LOADED\n')
  }, 40000)

  it('prefers the running dsh copy and names a dsh that lacks the package', () => {
    const dir = temp('codsh-clean-shim-')
    const dsh = globalDsh(dir, { packages: { '@deepseek-ai/dsh-llm': { source: "export const marker = 'FROM_RUNNING_DSH'\n" } } })
    const shim = pathToFileURL(join(cliBin, 'rust-acp-dsh.mjs')).href
    writeFileSync(join(dsh, 'lib/bin.js'), `const { importFromDsh } = await import(${JSON.stringify(shim)}); const m = await importFromDsh('@deepseek-ai/dsh-llm'); process.stdout.write(m.marker)`)
    const preferred = spawnSync(process.execPath, [join(dsh, 'lib/bin.js')], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH } })
    expect(preferred.stderr).toBe('')
    expect(preferred.stdout).toBe('FROM_RUNNING_DSH')
    const cli = isolatedCli(dir)
    const empty = globalDsh(join(dir, 'empty'))
    writeFileSync(join(empty, 'lib/bin.js'), `await import(${JSON.stringify(pathToFileURL(join(cli, 'bin', 'rust-acp-hooks.mjs')).href)})`)
    const missing = spawnSync(process.execPath, [join(empty, 'lib/bin.js')], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH } })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('codsh: cannot load @deepseek-ai/dsh-llm from the running dsh')
    expect(missing.stderr).toContain('npm install -g @deepseek-ai/dsh')
  }, 30000)
})

describe('launcher refusals before any Home write', () => {
  function packageWithArtifact(dir, manifest = {}) {
    const cli = isolatedCli(dir)
    const key = nativeKey()
    if (!(key in NATIVE_TARGETS)) return undefined
    stage(join(cli, 'native'), key, { manifest })
    return cli
  }

  it('install-check reports the artifact, dsh, and Home without writing', () => {
    const dir = temp('codsh-install-check-')
    const cli = packageWithArtifact(dir)
    if (cli === undefined) return
    const dsh = globalDsh(dir, { version: '0.1.5-rc.3' })
    writeFileSync(join(dsh, 'lib/bin.js'), '')
    const home = join(dir, 'home')
    mkdirSync(home)
    const env = { PATH: process.env.PATH, HOME: home, DSH_BIN: join(dsh, 'lib/bin.js') }
    const ok = spawnSync(process.execPath, [join(cli, 'bin/codsh.mjs'), '--rust', 'install-check', '--json'], { encoding: 'utf8', timeout: 20000, env })
    expect(ok.status, ok.stderr).toBe(0)
    const report = JSON.parse(ok.stdout)
    expect(report).toMatchObject({ schema: 'codsh.install-check.v1', ok: true, launcher: { version: '0.24.0' }, artifact: { ok: true, key: nativeKey(), version: '0.24.0' }, dsh: { ok: true, version: '0.1.5-rc.3', requires: '0.1.5-rc.2' } })
    expect(existsSync(join(home, '.codsh-rust'))).toBe(false)
    const missing = spawnSync(process.execPath, [join(cli, 'bin/codsh.mjs'), '--rust', 'install-check'], { encoding: 'utf8', timeout: 20000, env: { ...env, DSH_BIN: join(dir, 'no-such-dsh') } })
    expect(missing.status).toBe(1)
    expect(missing.stdout).toContain('dsh: dsh-missing')
    expect(missing.stdout).toContain('npm install -g @deepseek-ai/dsh   (0.1.5-rc.2 or newer)')
    expect(existsSync(join(home, '.codsh-rust'))).toBe(false)
  }, 30000)

  it('refuses an old dsh and a half-updated package before creating the Rust Home', () => {
    const dir = temp('codsh-launch-refusal-')
    const cli = packageWithArtifact(dir)
    if (cli === undefined) return
    const dsh = globalDsh(dir, { version: '0.1.4' })
    writeFileSync(join(dsh, 'lib/bin.js'), "process.stderr.write('DSH_STARTED\\n')")
    const home = join(dir, 'home')
    mkdirSync(home)
    const env = { PATH: process.env.PATH, HOME: home, DSH_BIN: join(dsh, 'lib/bin.js') }
    const old = spawnSync(process.execPath, [join(cli, 'bin/codsh.mjs'), '--rust', '-p', 'hi'], { encoding: 'utf8', timeout: 20000, env })
    expect(old.status).toBe(1)
    expect(old.stderr).toContain('codsh: dsh 0.1.4')
    expect(old.stderr).toContain('npm install -g @deepseek-ai/dsh   (0.1.5-rc.2 or newer)')
    expect(old.stderr).not.toContain('DSH_STARTED')
    expect(existsSync(join(home, '.codsh-rust'))).toBe(false)
    const [platform, arch] = nativeKey().split('-')
    stage(join(cli, 'native'), nativeKey(), { manifest: { version: '0.23.9', platform, arch } })
    const partial = spawnSync(process.execPath, [join(cli, 'bin/codsh.mjs'), '--rust', '-p', 'hi'], { encoding: 'utf8', timeout: 20000, env })
    expect(partial.status).toBe(1)
    expect(partial.stderr).toContain('codsh: Rust client 0.23.9 does not match this codsh-cli 0.24.0: an update did not finish.')
    expect(partial.stderr).toContain('npm install -g codsh-cli@0.24.0')
    expect(existsSync(join(home, '.codsh-rust'))).toBe(false)
  }, 30000)
})
