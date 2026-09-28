/**
 * Which package manager owns this codsh-cli install, and the commands that
 * move it to another version (#198). codsh ships only through the npm
 * registry, as one `codsh-cli` package that carries every platform's Rust
 * client, so an "installer" here is the package manager that put it on this
 * machine: npm, pnpm, Yarn classic or Bun. Zero dependencies, like the rest of
 * the launcher.
 *
 * Precedence: `CODSH_INSTALLER` (explicit), then the layout the package sits
 * in (a pnpm, Yarn or Bun global directory), then `npm_config_user_agent`
 * (set by a package manager for the processes it starts), then npm. The
 * reference (`xai-grok-update` `env_installer`) reads the user agent before
 * the install path because its only package-manager installer is npm; here
 * the path names the manager that can actually replace these files, so it
 * wins over the environment a caller happened to inherit.
 */
import { realpathSync } from 'node:fs'

export const PACKAGE = 'codsh-cli'

const COMMANDS = {
  npm: spec => ['npm', 'install', '-g', spec],
  pnpm: spec => ['pnpm', 'add', '-g', spec],
  yarn: spec => ['yarn', 'global', 'add', spec],
  bun: spec => ['bun', 'add', '-g', spec],
}

export const INSTALLERS = Object.keys(COMMANDS)

/** The package manager a global install directory belongs to, or undefined. */
export function installerForPath(path) {
  if (typeof path !== 'string' || path === '') return undefined
  const normal = path.replaceAll('\\', '/').toLowerCase()
  if (normal.includes('/pnpm/global/') || normal.includes('/.pnpm/') || normal.includes('/pnpm-global/')) return 'pnpm'
  if (normal.includes('/.bun/install/global/')) return 'bun'
  if (normal.includes('/yarn/global/') || normal.includes('/.yarn-global/') || normal.includes('/yarn/data/global/')) return 'yarn'
  return undefined
}

/** `npm/10.9.0 node/v24 …` → `npm`; undefined for anything unrecognised. */
export function installerForUserAgent(agent) {
  const name = /^([a-z]+)\//u.exec(String(agent ?? '').trim())?.[1]
  return name !== undefined && name in COMMANDS ? name : undefined
}

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.packageRoot] - this codsh-cli package directory.
 * @returns {{name: string, source: string, ignored?: string}}
 */
export function detectInstaller({ env = process.env, packageRoot } = {}) {
  let ignored
  const explicit = env.CODSH_INSTALLER?.trim().toLowerCase()
  if (explicit) {
    if (explicit in COMMANDS) return { name: explicit, source: 'CODSH_INSTALLER' }
    ignored = `CODSH_INSTALLER=${env.CODSH_INSTALLER} is not one of ${INSTALLERS.join(', ')}; ignored`
  }
  let real = packageRoot
  try {
    if (packageRoot) real = realpathSync(packageRoot)
  } catch {
    // Keep the spelling we were given.
  }
  const byPath = installerForPath(real)
  if (byPath !== undefined) return { name: byPath, source: 'install path', ...(ignored ? { ignored } : {}) }
  const byAgent = installerForUserAgent(env.npm_config_user_agent)
  if (byAgent !== undefined) return { name: byAgent, source: 'npm_config_user_agent', ...(ignored ? { ignored } : {}) }
  return { name: 'npm', source: 'default', ...(ignored ? { ignored } : {}) }
}

/** The argv that installs `codsh-cli@<version>` globally with this installer. */
export function installCommand(installer, version) {
  const build = COMMANDS[installer] ?? COMMANDS.npm
  return build(`${PACKAGE}@${version}`)
}

/** `a > b` for x.y.z[-pre]; a prerelease sorts before its release. */
export function newerVersion(a, b) {
  const parse = value => {
    const [core, pre] = String(value).split('-', 2)
    return { parts: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index += 1) {
    const x = left.parts[index] ?? 0
    const y = right.parts[index] ?? 0
    if (x !== y) return x > y
  }
  if (left.pre === right.pre) return false
  if (left.pre === undefined) return true
  if (right.pre === undefined) return false
  return left.pre.localeCompare(right.pre, 'en', { numeric: true }) > 0
}

/**
 * The newest published codsh-cli, as the registry tags it.
 * @returns {Promise<string | undefined>} undefined when the registry cannot say.
 */
export async function publishedVersion(env = process.env) {
  const base = (env.CODSH_UPDATE_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/u, '')
  try {
    const response = await fetch(`${base}/-/package/${PACKAGE}/dist-tags`, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body?.latest === 'string' && body.latest !== '' ? body.latest : undefined
  } catch {
    return undefined
  }
}
