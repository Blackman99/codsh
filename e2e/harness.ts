/**
 * End-to-end launch plumbing: these suites drive the INSTALLED dsh launcher —
 * the exact artifact a user runs — with this repository packed and registered
 * into a dsh code profile, and a keyless mock adapter standing in for the
 * model.
 *
 * The profile install is expensive (a pnpm install), so it happens once per
 * run into a template home — and once across parallel files, behind a lock.
 * Each test gets a fresh home whose `profiles` directory is a symlink into
 * the template, keeping sessions, history, and installed presets test-local
 * while the heavyweight profile is shared.
 */

import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/** Generous ceiling for one whole scenario, profile boot included. */
export const E2E_TEST_TIMEOUT_MS = 120_000

export const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** The bundle package — what profiles install and these suites pack. */
export const bundleRoot = join(repoRoot, 'packages', 'bundle')

/** Absolute path of the mock adapter, for `--patch` overlays. */
export const MOCK_LLM_URL = new URL('./fixtures/mock-llm.mjs', import.meta.url).href

const require = createRequire(import.meta.url)

/** The installed dsh launcher's bin script. */
export function dshBin(): string {
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const bin: unknown = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin: string | Record<string, string> }).bin
  return join(dirname(manifest), typeof bin === 'string' ? bin : (bin as Record<string, string>)['dsh'] ?? '')
}

/**
 * A registry that answers one dist-tag, so no suite reaches npm.
 *
 * The update check is a network read the surface makes on its own; pointing it
 * at a local server is what lets a test drive both answers — current, and one
 * version behind — without ever installing anything.
 * @param latest - the version to advertise for `codsh-cli`.
 * @returns its base URL and how to stop it.
 */
export async function fakeRegistry(latest: string): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url !== '/-/package/codsh-cli/dist-tags') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ latest }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

let template: string | undefined

/** Where the shared packed profile lives, so parallel e2e workers can reuse it. */
const templateCache = join(repoRoot, 'node_modules', '.cache', 'codsh-e2e')
const templateHome = join(templateCache, 'home')
const templateStamp = join(templateCache, '.stamp')
const templateLock = join(templateCache, '.lock')

/** How long a worker waits for another to finish packing the profile. */
const TEMPLATE_WAIT_MS = 180_000

/**
 * Pack this repository and register it into a template code profile, once.
 *
 * Packing rather than `file:`-linking the working tree is deliberate: the
 * tarball is the release artifact, so the suite proves what a user installs —
 * `files` filtering, exports, and the shipped preset included.
 *
 * Parallel e2e files share this through a directory lock and a stamp: the
 * profile install is the expensive part, and the tests themselves are mostly
 * waiting on a PTY, so overlapping files cuts the suite roughly in half.
 * @returns the template home directory.
 */
export function ensureTemplateHome(): string {
  if (template !== undefined) return template
  mkdirSync(templateCache, { recursive: true })
  const stamp = currentTemplateStamp()
  if (templateMatches(stamp)) {
    template = templateHome
    return template
  }
  const deadline = Date.now() + TEMPLATE_WAIT_MS
  while (Date.now() < deadline) {
    if (templateMatches(stamp)) {
      template = templateHome
      return template
    }
    try {
      mkdirSync(templateLock)
    } catch {
      if (lockAgeMs() > TEMPLATE_WAIT_MS) rmSync(templateLock, { recursive: true, force: true })
      else sleepSync(100)
      continue
    }
    try {
      if (templateMatches(stamp)) {
        template = templateHome
        return template
      }
      installTemplate()
      writeFileSync(templateStamp, stamp)
      template = templateHome
      return template
    } finally {
      rmSync(templateLock, { recursive: true, force: true })
    }
  }
  throw new Error('timed out waiting for the e2e profile template')
}

/** Fingerprint of what `npm pack` would put in the profile. */
function currentTemplateStamp(): string {
  return [
    join(bundleRoot, 'lib', 'index.js'),
    join(bundleRoot, 'package.json'),
    join(bundleRoot, 'cordis.patch.yml'),
    join(bundleRoot, 'agent-presets'),
  ].map(stampPath).join('\n')
}

/**
 * A path's identity for the stamp: files by size and mtime, directories by
 * their children, so a preset change rebuilds the template without a full tree
 * walk of node_modules.
 */
function stampPath(path: string): string {
  if (!existsSync(path)) return `${path}:missing`
  const info = statSync(path)
  if (!info.isDirectory()) return `${path}:${info.size}:${info.mtimeMs}`
  return readdirSync(path).sort().map(name => stampPath(join(path, name))).join('\n')
}

function templateMatches(stamp: string): boolean {
  if (!existsSync(templateHome) || !existsSync(templateStamp)) return false
  return readFileSync(templateStamp, 'utf8') === stamp
}

function lockAgeMs(): number {
  try {
    return Date.now() - statSync(templateLock).mtimeMs
  } catch {
    return 0
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function installTemplate(): void {
  rmSync(templateHome, { recursive: true, force: true })
  const packed = execFileSync('npm', ['pack', '--pack-destination', templateCache], { cwd: bundleRoot, encoding: 'utf8' })
    .trim().split('\n').at(-1) ?? ''
  execFileSync(process.execPath, [dshBin(), 'plugin', '--profile', 'code', 'add', join(templateCache, packed)], {
    env: { ...process.env, DSH_HOME: templateHome },
    stdio: 'pipe',
  })
  // Spell the runtime as a registry version, the way a real install records
  // it. The suites drive the /update registration decision, which — like the
  // launcher — must move a registry version but never clobber a development
  // pin; boot loads the installed files either way.
  const manifestPath = join(templateHome, 'profiles', 'code', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
  const bundle = JSON.parse(readFileSync(join(bundleRoot, 'package.json'), 'utf8')) as { version: string }
  if (manifest.dependencies['codsh-bundle'] !== undefined) {
    manifest.dependencies['codsh-bundle'] = `^${bundle.version}`
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

/**
 * A fresh per-test home sharing the template's installed profile.
 * @returns the home directory, disposable with the test's workspace.
 */
export async function makeHome(): Promise<string> {
  const templateHome = ensureTemplateHome()
  const home = await mkdtemp(join(tmpdir(), 'codsh-e2e-home-'))
  await symlink(join(templateHome, 'profiles'), join(home, 'profiles'))
  return home
}

/** One resolved launch: the command line and environment to boot `codsh`. */
export interface Launch {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

/**
 * Resolve one boot of the installed launcher onto the code profile.
 * @param options - overlay path, app arguments, per-test home, and mock mode.
 * @returns what to spawn.
 */
export function resolveLaunch(options: {
  overlay: string
  args?: readonly string[] | undefined
  home: string
  mode: string
}): Launch {
  if (!existsSync(join(bundleRoot, 'lib', 'index.js'))) {
    throw new Error('codsh e2e needs the built lib/ — run `pnpm run build` first (or use `pnpm run test:e2e`)')
  }
  return {
    command: process.execPath,
    args: [dshBin(), '--profile', 'code', '--patch', options.overlay, ...options.args ?? []],
    env: {
      ...process.env,
      // Pinned: rendering assertions must not depend on the runner's TERM —
      // CI machines report no 256-color support and the palette forks on it.
      TERM: 'xterm-256color',
      DSH_HOME: options.home,
      DSH_TELEMETRY_DISABLED: '1',
      // Pinned: a suite must not depend on what npm currently publishes. The
      // update tests point the check at a local registry and turn it back on.
      CODSH_UPDATE_CHECK: 'off',
      DSH_CODE_CLI_MOCK_TOOL: options.mode,
      DEEPSEEK_API_KEY: '',
      // The escape sequence only: a test run must never overwrite the real
      // clipboard through the platform helper.
      CODSH_CLIPBOARD: 'osc52',
    },
  }
}

/** The overlay every suite writes: default onto the mock, deepseek row off. */
export function overlayText(): string {
  return [
    '- id: agent-default-model',
    '  config:',
    '    provider: cli-mock',
    '    model: cli-mock',
    // The base deepseek row lists a static catalog without any key; left on it
    // would lead the /model selector and make every index nondeterministic.
    '- id: llm-deepseek',
    '  disabled: true',
    '- insert:',
    '    - id: code-cli-mock-llm',
    `      name: '${MOCK_LLM_URL}'`,
    '',
  ].join('\n')
}
