/**
 * Bring the machine's custom models into the isolated `.dev-home` used by
 * `pnpm run dev`. The scratch profile is still a real install; this only
 * copies the files that name providers, the default model, and credentials,
 * and returns the machine profile patch as a `--patch` overlay.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Files under `$DSH_HOME` that a custom model route actually needs. */
const MACHINE_MODEL_FILES = Object.freeze([
  'settings.yaml',
  '.credentials.yaml',
  '.env',
  'code-cli-thinking.json',
])

const MOCK_DEFAULT_MODEL = [
  'agent-default-model:',
  '  provider: cli-mock',
  '  model: cli-mock',
  '',
].join('\n')

/**
 * The dsh home that already carries a person's custom providers.
 *
 * `CODSH_DEV_USER_HOME` wins so a scratch `DSH_HOME` can still point at the
 * real machine home. A `DSH_HOME` that *is* the isolated `.dev-home` is
 * skipped. Blank values fall through to `~/.dsh`.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env - process environment.
 * @param {string} homeDir - `os.homedir()` (injected for tests).
 * @param {string} [isolatedHome] - the repo `.dev-home`; never treated as the machine.
 */
export function resolveMachineHome(env, homeDir, isolatedHome) {
  const fallback = join(homeDir, '.dsh')
  for (const value of [env.CODSH_DEV_USER_HOME, env.DSH_HOME, fallback]) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const trimmed = value.trim()
    if (isolatedHome !== undefined && resolve(trimmed) === resolve(isolatedHome)) continue
    return trimmed
  }
  return fallback
}

/**
 * True when a profile `cordis.patch.yml` actually names a row. The empty
 * template dsh writes on first install is comments plus `[]`.
 * @param {string} text - file contents.
 */
export function isUsablePatch(text) {
  const trimmed = text.replace(/^\s*#.*$/gm, '').trim()
  if (trimmed === '' || trimmed === '[]') return false
  return /^- (id:|insert:)/m.test(trimmed)
}

/**
 * Copy machine model config into the isolated dev home and list extra
 * `--patch` overlays. `MOCK=` skips the import and pins the keyless default
 * so a leftover custom `settings.yaml` cannot win over the mock overlay.
 * @param {{ machineHome: string, devHome: string, mock: boolean }} options - homes and mock flag.
 */
export function prepareDevModelConfig({ machineHome, devHome, mock }) {
  mkdirSync(devHome, { recursive: true })
  if (mock) {
    writeFileSync(join(devHome, 'settings.yaml'), MOCK_DEFAULT_MODEL)
    return { extraPatches: [], imported: [] }
  }
  if (resolve(machineHome) === resolve(devHome)) {
    return { extraPatches: [], imported: [] }
  }

  const extraPatches = []
  const patchPath = join(machineHome, 'profiles', 'code', 'cordis.patch.yml')
  if (existsSync(patchPath) && isUsablePatch(readFileSync(patchPath, 'utf8'))) {
    extraPatches.push(patchPath)
  }

  const imported = []
  for (const name of MACHINE_MODEL_FILES) {
    const from = join(machineHome, name)
    const to = join(devHome, name)
    if (!existsSync(from)) {
      if (existsSync(to)) rmSync(to)
      continue
    }
    copyFileSync(from, to)
    imported.push(name)
  }
  return { extraPatches, imported }
}
