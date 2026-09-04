/**
 * Whether a newer codsh is published, and what installs it.
 *
 * The `codsh-cli` launcher and this runtime publish in lockstep, so the version
 * this bundle carries is the version a person has installed, and the launcher's
 * `latest` dist-tag is what they would install to move. An update installs the
 * launcher and moves the code profile's runtime to match, so nothing here
 * installs anything on its own: the check is one cached read, and the commands
 * this module names are run by the caller — an update is the person's
 * decision, not a side effect of boot.
 * @module codsh-bundle/src/update
 */

import { readFile, writeFile } from 'node:fs/promises'

/** The package a person installs; this runtime ships in lockstep with it. */
export const LAUNCHER = 'codsh-cli'

/** The dsh profile codsh installs its runtime into. */
export const PROFILE = 'code'

/** The runtime a code profile carries; an update moves it with the launcher. */
export const RUNTIME = 'codsh-bundle'

/** How long a registry answer stands before the registry is asked again. */
export const CACHE_MS = 6 * 60 * 60 * 1000

/** Budget for the read: a slow or captive network must not cost the boot. */
const TIMEOUT_MS = 2_000

/** What the check found, once it found anything at all. */
export interface UpdateStatus {
  /** The version this session is running. */
  current: string
  /** The newest version the registry advertises. */
  latest: string
  /** Whether `latest` is ahead of `current`. */
  available: boolean
}

/** Everything the check reads, so a test never reaches a network or a clock. */
export interface UpdateOptions {
  /** The running version, normally this bundle's own. */
  current: string
  /** Where the answer is remembered between sessions; omit to skip the cache. */
  cachePath?: string | undefined
  /** Environment carrying the registry override and the opt-out. */
  env?: NodeJS.ProcessEnv
  /** Now, in epoch milliseconds. */
  now?: number
  /** The fetch to use; the global one by default. */
  fetchImpl?: typeof fetch
  /** Ask the registry even when the person silenced the automatic check. */
  force?: boolean
}

/** One version's comparable parts: the release triple and its prerelease tag. */
function parse(version: string): { release: number[]; prerelease: string } {
  const [release = '', prerelease = ''] = version.trim().replace(/^v/u, '').split('-')
  return { release: release.split('.').map(part => Number.parseInt(part, 10) || 0), prerelease }
}

/**
 * Whether one published version is ahead of another.
 *
 * The pair publishes plain `x.y.z`, so the triple decides; a prerelease of the
 * same triple is behind its release, which keeps an `-rc` from ever being
 * offered as an upgrade over the release it precedes.
 * @param candidate - the version being offered.
 * @param current - the version in hand.
 * @returns true when `candidate` is newer.
 */
export function newerVersion(candidate: string, current: string): boolean {
  const left = parse(candidate)
  const right = parse(current)
  for (let index = 0; index < 3; index += 1) {
    const a = left.release[index] ?? 0
    const b = right.release[index] ?? 0
    if (a !== b) return a > b
  }
  if (left.prerelease === right.prerelease) return false
  return left.prerelease === ''
}

/**
 * The command that installs a version, as a person would type it.
 * @param version - the version to install.
 * @returns the executable and its arguments.
 */
export function updateCommand(version: string): readonly string[] {
  return ['npm', 'install', '-g', `${LAUNCHER}@${version}`]
}

/**
 * The spec that moves a profile's runtime to a version, as `dsh plugin add`
 * takes it.
 * @param version - the version to move the runtime to.
 * @returns the package spec to register.
 */
export function runtimeSpec(version: string): string {
  return `${RUNTIME}@^${version}`
}

/** A dsh to drive: its executable and the prefix that reaches its entry. */
export interface Dsh {
  command: string
  prefix: readonly string[]
}

/**
 * Resolve the dsh running this process, so an in-session update can drive it
 * the way the launcher's next boot would.
 *
 * `DSH_BIN` names the pinned dsh when there is one; otherwise the running
 * process's own entry — this runtime is loaded by that dsh — is the dsh the
 * next boot would have used.
 * @param env - the environment carrying the pin; the real one by default.
 * @param argv - this process's arguments; the real ones by default.
 * @returns how to spawn the dsh, or undefined when none can be found.
 */
export function runningDsh(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): Dsh | undefined {
  const pinned = env.DSH_BIN?.trim()
  if (pinned !== undefined && pinned !== '') {
    // A JS entry runs through this Node; anything else is an executable.
    return /\.[cm]?js$/.test(pinned)
      ? { command: process.execPath, prefix: [pinned] }
      : { command: pinned, prefix: [] }
  }
  const entry = argv[1]
  if (entry === undefined || entry === '') return undefined
  return { command: process.execPath, prefix: [entry] }
}

/**
 * The command that moves a profile's runtime to a version, as the caller runs
 * it in the open.
 * @param dsh - the dsh to drive, from {@link runningDsh}.
 * @param version - the launcher version just installed.
 * @returns the executable and its arguments.
 */
export function runtimeRegisterCommand(dsh: Dsh, version: string): readonly string[] {
  return [dsh.command, ...dsh.prefix, 'plugin', '--profile', PROFILE, 'add', runtimeSpec(version)]
}

/**
 * Whether an update should also move the profile's runtime.
 *
 * An update installs the launcher and moves the profile's runtime to match —
 * unless the profile pins a development build an update must never clobber, or
 * already carries a runtime at or past the installed version.
 * @param version - the launcher version being installed.
 * @param dependencies - the code profile's declared dependencies.
 * @returns 'register' when the runtime should move to `version`, 'pinned' when
 *   the profile's runtime is a development pin, and 'current' when the profile
 *   already carries a matching or newer runtime.
 */
export function runtimeMove(version: string, dependencies: Record<string, string> | undefined): 'register' | 'pinned' | 'current' {
  const current = dependencies?.[RUNTIME]
  if (current !== undefined) {
    const registered = /^\^?(\d+\.\d+\.\d+)$/u.exec(current)?.[1]
    if (registered === undefined) return 'pinned'
    if (!newerVersion(version, registered)) return 'current'
  }
  return 'register'
}

/** Registry the dist-tag is read from; the override is what tests point away. */
function registryBase(env: NodeJS.ProcessEnv): string {
  const configured = env['CODSH_UPDATE_REGISTRY']?.trim()
  return (configured === undefined || configured === '' ? 'https://registry.npmjs.org' : configured).replace(/\/+$/u, '')
}

/** The remembered answer of an earlier check. */
interface Cached {
  checkedAt: number
  latest: string
}

/** Read the remembered answer, treating anything unreadable as no answer. */
async function readCache(path: string | undefined): Promise<Cached | undefined> {
  if (path === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { checkedAt, latest } = parsed as Partial<Cached>
    if (typeof checkedAt !== 'number' || typeof latest !== 'string') return undefined
    return { checkedAt, latest }
  } catch {
    return undefined
  }
}

/**
 * Whether a newer codsh is published.
 *
 * Silent about everything that is not an answer: an unreachable registry, a
 * captive portal answering HTML, a malformed body, and a machine with no
 * network all come back the same way — as nothing to say.
 * @param options - the running version and the seams a test replaces.
 * @returns what was found, or undefined when there is nothing to report.
 */
export async function checkForUpdate(options: UpdateOptions): Promise<UpdateStatus | undefined> {
  const env = options.env ?? process.env
  const force = options.force === true
  // Silencing the check silences the boot, never the person who typed /update.
  if (!force && env['CODSH_UPDATE_CHECK']?.trim().toLowerCase() === 'off') return undefined
  const now = options.now ?? Date.now()
  const cached = force ? undefined : await readCache(options.cachePath)
  if (cached !== undefined && now - cached.checkedAt < CACHE_MS) {
    return { current: options.current, latest: cached.latest, available: newerVersion(cached.latest, options.current) }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  let latest: string
  try {
    const response = await fetchImpl(`${registryBase(env)}/-/package/${LAUNCHER}/dist-tags`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    const tag = (body as { latest?: unknown } | null)?.latest
    if (typeof tag !== 'string' || tag === '') return undefined
    latest = tag
  } catch {
    return undefined
  }
  if (options.cachePath !== undefined) {
    try {
      await writeFile(options.cachePath, `${JSON.stringify({ checkedAt: now, latest })}\n`)
    } catch {
      // A cache that cannot be written costs a request next time, nothing else.
    }
  }
  return { current: options.current, latest, available: newerVersion(latest, options.current) }
}

/**
 * The version this bundle was published as.
 *
 * Read from the manifest beside the built entry rather than baked in, so a
 * release never has to remember to update a constant.
 * @param manifest - the manifest to read; the bundle's own by default.
 * @returns the version, or undefined when the manifest is unreadable.
 */
export async function bundleVersion(manifest = new URL('../package.json', import.meta.url)): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifest, 'utf8'))
    const version = (parsed as { version?: unknown } | null)?.version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}
