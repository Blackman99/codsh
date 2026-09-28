import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  INSTALLERS, detectInstaller, installCommand, installerForPath, installerForUserAgent, newerVersion,
} from '../packages/cli/bin/installer.mjs'
import { NATIVE_TARGETS, binaryName, nativeKey } from '../packages/cli/bin/rust-artifact.mjs'

const root = resolve(import.meta.dirname, '..')
const temps = []
function temp(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop(), { recursive: true, force: true })
})

describe('installer selection (#198)', () => {
  it('knows npm, pnpm, Yarn classic and Bun and their global install commands', async () => {
    expect(INSTALLERS).toEqual(['npm', 'pnpm', 'yarn', 'bun'])
    expect(installCommand('npm', '1.2.3')).toEqual(['npm', 'install', '-g', 'codsh-cli@1.2.3'])
    expect(installCommand('pnpm', '1.2.3')).toEqual(['pnpm', 'add', '-g', 'codsh-cli@1.2.3'])
    expect(installCommand('yarn', '1.2.3')).toEqual(['yarn', 'global', 'add', 'codsh-cli@1.2.3'])
    expect(installCommand('bun', '1.2.3')).toEqual(['bun', 'add', '-g', 'codsh-cli@1.2.3'])
    expect(installCommand('unknown', '1.2.3')).toEqual(['npm', 'install', '-g', 'codsh-cli@1.2.3'])
  })

  it('reads the global directory layouts of each manager', async () => {
    expect(installerForPath('/Users/a/Library/pnpm/global/5/node_modules/codsh-cli')).toBe('pnpm')
    expect(installerForPath('/home/a/.local/share/pnpm/global/5/.pnpm/codsh-cli@1.0.0/node_modules/codsh-cli')).toBe('pnpm')
    expect(installerForPath('C:\\Users\\a\\AppData\\Local\\pnpm\\global\\5\\node_modules\\codsh-cli')).toBe('pnpm')
    expect(installerForPath('/Users/a/.bun/install/global/node_modules/codsh-cli')).toBe('bun')
    expect(installerForPath('/Users/a/.config/yarn/global/node_modules/codsh-cli')).toBe('yarn')
    expect(installerForPath('C:\\Users\\a\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\codsh-cli')).toBe('yarn')
    expect(installerForPath('/opt/homebrew/lib/node_modules/codsh-cli')).toBeUndefined()
    expect(installerForPath('/usr/local/lib/node_modules/codsh-cli')).toBeUndefined()
  })

  it('reads the manager name from npm_config_user_agent', async () => {
    expect(installerForUserAgent('npm/10.9.2 node/v24.1.0 darwin arm64 workspaces/false')).toBe('npm')
    expect(installerForUserAgent('pnpm/10.34.5 npm/? node/v24.1.0 linux x64')).toBe('pnpm')
    expect(installerForUserAgent('yarn/1.22.22 npm/? node/v22.19.0 darwin x64')).toBe('yarn')
    expect(installerForUserAgent('bun/1.2.0 npm/? node/v24.3.0 darwin arm64')).toBe('bun')
    expect(installerForUserAgent('deno/2.0')).toBeUndefined()
    expect(installerForUserAgent(undefined)).toBeUndefined()
  })

  it('takes CODSH_INSTALLER first, then the install path, then the user agent, then npm', async () => {
    const pnpmPath = '/x/pnpm/global/5/node_modules/codsh-cli'
    const npmPath = '/usr/local/lib/node_modules/codsh-cli'
    expect(detectInstaller({ env: { CODSH_INSTALLER: 'Bun', npm_config_user_agent: 'npm/10' }, packageRoot: pnpmPath }))
      .toEqual({ name: 'bun', source: 'CODSH_INSTALLER' })
    expect(detectInstaller({ env: { npm_config_user_agent: 'npm/10' }, packageRoot: pnpmPath })).toEqual({ name: 'pnpm', source: 'install path' })
    expect(detectInstaller({ env: { npm_config_user_agent: 'yarn/1.22' }, packageRoot: npmPath })).toEqual({ name: 'yarn', source: 'npm_config_user_agent' })
    expect(detectInstaller({ env: {}, packageRoot: npmPath })).toEqual({ name: 'npm', source: 'default' })
    const bad = detectInstaller({ env: { CODSH_INSTALLER: 'brew' }, packageRoot: npmPath })
    expect(bad).toMatchObject({ name: 'npm', source: 'default' })
    expect(bad.ignored).toContain('CODSH_INSTALLER=brew is not one of npm, pnpm, yarn, bun')
  })

  it('orders versions, prereleases before their release', async () => {
    expect(newerVersion('0.25.0', '0.24.0')).toBe(true)
    expect(newerVersion('0.24.0', '0.24.0')).toBe(false)
    expect(newerVersion('0.24.0', '0.25.0-rc.1')).toBe(false)
    expect(newerVersion('0.25.0', '0.25.0-rc.1')).toBe(true)
    expect(newerVersion('0.25.0-rc.10', '0.25.0-rc.9')).toBe(true)
    expect(newerVersion('1.0.0', '0.99.99')).toBe(true)
  })
})

const key = nativeKey()
const expected = NATIVE_TARGETS[key]

/** A synthetic executable header that verifies as this machine's client. */
function hostBinary() {
  const bytes = Buffer.alloc(4096)
  if (expected.format === 'mach-o') {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(expected.cpu === 'arm64' ? 0x0100000c : 0x01000007, 4)
  } else {
    bytes.write('\x7fELF', 0, 'latin1')
    bytes[4] = 2
    bytes[5] = 1
    bytes.writeUInt16LE(expected.cpu === 'arm64' ? 0xb7 : 0x3e, 18)
  }
  return bytes
}

function stage(pkg, version, withNative = true) {
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
  manifest.version = version
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  rmSync(join(pkg, 'native'), { recursive: true, force: true })
  if (!withNative) return
  const directory = join(pkg, 'native', key)
  mkdirSync(directory, { recursive: true })
  const bytes = hostBinary()
  writeFileSync(join(directory, binaryName()), bytes, { mode: 0o755 })
  const [platform, arch] = key.split('-')
  writeFileSync(join(directory, 'artifact.json'), JSON.stringify({
    platform, arch, target: expected.target, version, binary: binaryName(), format: expected.format,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }))
}

let registry
let latest = '0.51.0'
beforeAll(async () => {
  registry = createServer((request, response) => {
    if (request.url === '/-/package/codsh-cli/dist-tags') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ latest }))
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise(done => registry.listen(0, '127.0.0.1', done))
})
afterAll(() => registry?.close())

/**
 * A codsh-cli copied into a pnpm-style global directory, a fake `pnpm` that
 * records its argv and does what FAKE_MODE says, a fake dsh, and a HOME.
 */
function fixture() {
  const base = temp('codsh-update-')
  const pkg = join(base, 'pnpm/global/5/node_modules/codsh-cli')
  mkdirSync(pkg, { recursive: true })
  cpSync(join(root, 'packages/cli/bin'), join(pkg, 'bin'), { recursive: true })
  cpSync(join(root, 'packages/cli/package.json'), join(pkg, 'package.json'))
  stage(pkg, '0.50.0')
  const bin = join(base, 'bin')
  mkdirSync(bin)
  const log = join(base, 'installer.log')
  const fake = join(bin, 'pnpm')
  writeFileSync(fake, `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')
const mode = process.env.FAKE_MODE
if (mode === 'fail') { console.error('ERR_PNPM_FAKE'); process.exit(3) }
if (mode === 'stay') process.exit(0)
const version = process.argv[4].split('@')[1]
const pkg = ${JSON.stringify(pkg)}
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
manifest.version = version
writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest, null, 2))
if (mode === 'nonative') { rmSync(join(pkg, 'native'), { recursive: true, force: true }); process.exit(0) }
const artifact = join(pkg, 'native', ${JSON.stringify(key)}, 'artifact.json')
const fields = { version }
if (mode === 'repair') {
  const bytes = Buffer.from(process.env.FAKE_BINARY, 'hex')
  writeFileSync(join(pkg, 'native', ${JSON.stringify(key)}, ${JSON.stringify(binaryName())}), bytes)
  fields.sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
}
writeFileSync(artifact, JSON.stringify({ ...JSON.parse(readFileSync(artifact, 'utf8')), ...fields }))
`)
  chmodSync(fake, 0o755)
  const dsh = join(base, 'dsh.js')
  writeFileSync(dsh, 'process.exit(0)\n')
  const home = join(base, 'home')
  mkdirSync(home)
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, DSH_BIN: dsh,
    CODSH_UPDATE_REGISTRY: `http://127.0.0.1:${registry.address().port}`,
  }
  // Asynchronous: the fixture registry answers from this process's event loop.
  const run = (args, extra = {}) => new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(pkg, 'bin/codsh.mjs'), '--rust', 'update', ...args], { env: { ...env, ...extra } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('error', fail)
    child.on('close', status => {
      clearTimeout(timer)
      done({ status, stdout, stderr })
    })
  })
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  const version = () => JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
  return { pkg, home, run, calls, version }
}

describe.skipIf(process.platform === 'win32' || expected === undefined)('codsh --rust update (#198)', () => {
  it('--check names the installer and the command without running it', async () => {
    latest = '0.51.0'
    const f = fixture()
    const result = await f.run(['--check', '--json'])
    expect(result.status, result.stderr).toBe(0)
    const plan = JSON.parse(result.stdout)
    expect(plan).toMatchObject({
      schema: 'codsh.rust-update.v1', current: '0.50.0', target: '0.51.0', action: 'install', ok: true,
      installer: 'pnpm', installerSource: 'install path',
      command: ['pnpm', 'add', '-g', 'codsh-cli@0.51.0'], rollback: ['pnpm', 'add', '-g', 'codsh-cli@0.50.0'],
    })
    expect(f.calls()).toEqual([])
    expect(existsSync(join(f.home, '.codsh-rust'))).toBe(false)
  })

  it('says so when this is the latest, and changes nothing', async () => {
    latest = '0.50.0'
    const f = fixture()
    const result = await f.run([])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('codsh-cli 0.50.0 is the latest (installer: pnpm, from install path)')
    expect(f.calls()).toEqual([])
  })

  it('updates with the owning package manager and verifies the new client before reporting success', async () => {
    latest = '0.51.0'
    const f = fixture()
    const result = await f.run([], { npm_config_user_agent: 'npm/10.9.2 node/v24' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(f.calls()).toEqual(['add -g codsh-cli@0.51.0'])
    expect(result.stderr).toContain('codsh: pnpm add -g codsh-cli@0.51.0')
    expect(result.stdout).toContain(`codsh-cli 0.51.0 installed with pnpm; its Rust client verifies (${key}`)
    expect(result.stdout).toContain('go back with:  pnpm add -g codsh-cli@0.50.0   (or codsh --rust update --to 0.50.0)')
    expect(f.version()).toBe('0.51.0')
    // The Rust Home is the next launch's to stamp; update never creates it.
    expect(existsSync(join(f.home, '.codsh-rust'))).toBe(false)
  })

  it('rolls back with --to, through the same package manager', async () => {
    const f = fixture()
    const result = await f.run(['--to', '0.49.3', '--json'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(f.calls()).toEqual(['add -g codsh-cli@0.49.3'])
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'install', ok: true, target: '0.49.3', onDisk: '0.49.3' })
    expect((await f.run(['--to', 'latest'])).status).toBe(2)
  })

  it('reports a failed installer and that the installed version still works', async () => {
    latest = '0.51.0'
    const f = fixture()
    const result = await f.run([], { FAKE_MODE: 'fail' })
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('codsh: update failed — pnpm exited 3')
    expect(result.stderr).toContain('codsh-cli 0.50.0 is still installed and its Rust client verifies; nothing else changed')
    expect(result.stderr).toContain('go back:  pnpm add -g codsh-cli@0.50.0')
    expect(f.version()).toBe('0.50.0')
  })

  it('does not claim success when the package manager changed a different install', async () => {
    latest = '0.51.0'
    const f = fixture()
    const result = await f.run(['--json'], { FAKE_MODE: 'stay' })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: 'not-moved', onDisk: '0.50.0' })
  })

  it('names the way back when the new package cannot run the client here', async () => {
    latest = '0.51.0'
    const f = fixture()
    const result = await f.run([], { FAKE_MODE: 'nonative' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('codsh-cli 0.51.0 is installed, but its Rust client (codsh --rust) does not verify on this machine')
    expect(result.stderr).toContain(`Rust client artifact is not installed for ${key}`)
    expect(result.stderr).toContain('go back to the version you had:  pnpm add -g codsh-cli@0.50.0')
  })

  it('honours CODSH_INSTALLER and says when the registry cannot be reached', async () => {
    const f = fixture()
    const plan = JSON.parse((await f.run(['--check', '--json'], { CODSH_INSTALLER: 'bun' })).stdout)
    expect(plan).toMatchObject({ installer: 'bun', installerSource: 'CODSH_INSTALLER' })
    const offline = await f.run([], { CODSH_UPDATE_REGISTRY: 'http://127.0.0.1:9' })
    expect(offline.status).toBe(1)
    expect(offline.stderr).toContain('could not reach the npm registry; nothing was changed')
    expect(f.calls()).toEqual([])
  })

  it('repairs an install whose client no longer verifies', async () => {
    latest = '0.51.0'
    const f = fixture()
    // A damaged download: the launcher refuses to start this client ...
    writeFileSync(join(f.pkg, 'native', key, binaryName()), Buffer.alloc(4096, 1))
    const check = spawnSync(process.execPath, [join(f.pkg, 'bin/codsh.mjs'), '--rust', 'install-check'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: f.home, DSH_BIN: join(f.pkg, 'package.json') } })
    expect(check.status).toBe(1)
    expect(check.stdout).toContain('codsh --rust update --to 0.50.0')
    // ... but update still runs, and says the repaired install verifies.
    const result = await f.run([], { FAKE_MODE: 'repair', FAKE_BINARY: hostBinary().toString('hex') })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('codsh-cli 0.51.0 installed with pnpm; its Rust client verifies')
  })
})
