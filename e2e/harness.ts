/**
 * End-to-end launch plumbing: these suites drive the INSTALLED dsh launcher —
 * the exact artifact a user runs — with this repository packed and registered
 * into a dsh code profile, and a keyless mock adapter standing in for the
 * model.
 *
 * The profile install is expensive (a pnpm install), so it happens once per
 * run into a template home; each test gets a fresh home whose `profiles`
 * directory is a symlink into the template, keeping sessions, history, and
 * installed presets test-local while the heavyweight profile is shared.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/** Generous ceiling for one whole scenario, profile boot included. */
export const E2E_TEST_TIMEOUT_MS = 120_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

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

let template: string | undefined

/**
 * Pack this repository and register it into a template code profile, once.
 *
 * Packing rather than `file:`-linking the working tree is deliberate: the
 * tarball is the release artifact, so the suite proves what a user installs —
 * `files` filtering, exports, and the shipped preset included.
 * @returns the template home directory.
 */
export function ensureTemplateHome(): string {
  if (template !== undefined) return template
  const cache = join(repoRoot, 'node_modules', '.cache', 'codsh-e2e')
  const home = join(cache, 'home')
  rmSync(cache, { recursive: true, force: true })
  mkdirSync(cache, { recursive: true })
  const packed = execFileSync('npm', ['pack', '--pack-destination', cache], { cwd: bundleRoot, encoding: 'utf8' })
    .trim().split('\n').at(-1) ?? ''
  execFileSync(process.execPath, [dshBin(), 'plugin', '--profile', 'code', 'add', join(cache, packed)], {
    env: { ...process.env, DSH_HOME: home },
    stdio: 'pipe',
  })
  template = home
  return home
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
