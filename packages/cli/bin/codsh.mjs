#!/usr/bin/env node
/**
 * The `codsh` command: a zero-dependency launcher over the dsh you already
 * have.
 *
 * This package deliberately bundles NOTHING — the ~300MB dsh runtime lives
 * once on a machine, not once per tool. The wrapper finds a dsh (`DSH_BIN`,
 * then a resolvable `@deepseek-ai/dsh` install, then `dsh` on PATH), registers
 * the `codsh-bundle` runtime into the `code` profile on first run, and boots
 * `dsh --profile code` with the arguments passed through.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)
const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** The bundle package this launcher pairs with, lockstep-versioned. */
const BUNDLE = 'codsh-bundle'

/** This launcher's own npm name, which is what `codsh update` installs. */
const LAUNCHER = 'codsh-cli'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const manifestPath = join(home, 'profiles', 'code', 'package.json')

/** What the code profile currently carries, or undefined before first run. */
function profile() {
  if (!existsSync(manifestPath)) return undefined
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Locate a dsh launcher without carrying one.
 * @returns how to spawn it, or undefined when the machine has none.
 */
function findDsh() {
  const pinned = process.env.DSH_BIN
  if (pinned !== undefined && pinned !== '') {
    // A JS entry runs through this Node; anything else is an executable.
    return /\.[cm]?js$/.test(pinned)
      ? { command: process.execPath, prefix: [pinned] }
      : { command: pinned, prefix: [] }
  }
  try {
    const manifest = requireFromHere.resolve('@deepseek-ai/dsh/package.json')
    const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin
    const entry = join(dirname(manifest), typeof bin === 'string' ? bin : bin.dsh)
    return { command: process.execPath, prefix: [entry] }
  } catch {
    // Not installed beside this package; the PATH is next.
  }
  const probe = spawnSync('dsh', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
  if (probe.error === undefined && probe.status !== null) return { command: 'dsh', prefix: [] }
  return undefined
}

/**
 * The newest published launcher, as the registry tags it.
 * @returns the version, or undefined when the registry cannot say.
 */
async function published() {
  const base = (process.env.CODSH_UPDATE_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
  try {
    const response = await fetch(`${base}/-/package/codsh-cli/dist-tags`, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body?.latest === 'string' && body.latest !== '' ? body.latest : undefined
  } catch {
    // No network, a captive portal, a slow mirror: nothing to say, not a crash.
    return undefined
  }
}

// `codsh update` moves the pair from outside a session, which is where a person
// is when they are not in one. It prints the command it runs rather than
// hiding it, and installs only the launcher: the runtime is registered by the
// next boot, in lockstep, the way every other version change reaches it.
if (process.argv[2] === 'update') {
  const latest = await published()
  if (latest === undefined) {
    console.error('codsh: could not reach the npm registry')
    process.exit(1)
  }
  if (!newer(latest, own.version)) {
    console.log(`codsh ${own.version} is the latest`)
    process.exit(0)
  }
  const command = ['npm', 'install', '-g', `${LAUNCHER}@${latest}`]
  console.error(`codsh: ${command.join(' ')}`)
  const installed = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (installed.status !== 0) {
    console.error(`codsh: update failed — run ${command.join(' ')} yourself`)
    process.exit(installed.status ?? 1)
  }
  console.log(`codsh ${latest} installed · the next codsh registers the matching runtime`)
  process.exit(0)
}

// `--version` is the launcher's own question, so the launcher answers it: the
// pair a person installed, what the profile currently carries, and the dsh
// this run found. Passing the flag through would report the runtime's version
// and never mention codsh at all — and a machine whose dsh went missing still
// gets an answer for the two halves that are still there.
if (process.argv[2] === '--version' || process.argv[2] === '-V') {
  const registered = profile()?.dependencies?.[BUNDLE]
  const found = findDsh()
  const probe = found === undefined
    ? undefined
    : spawnSync(found.command, [...found.prefix, '--version'], { encoding: 'utf8' })
  const runtime = String(probe?.stdout ?? '').trim().split('\n').at(-1)
  console.log(`codsh ${own.version}`)
  console.log(`${BUNDLE} ${registered ?? 'not registered yet'}`)
  console.log(`dsh ${runtime === undefined || runtime === '' ? 'not found' : runtime}`)
  process.exit(0)
}

const dsh = findDsh()
if (dsh === undefined) {
  console.error(`codsh: no dsh runtime found. codsh launches the dsh you already have —
the runtime is not bundled, so a machine never carries a second copy.

  install one:      npm install -g @deepseek-ai/dsh
  or point at one:  DSH_BIN=/path/to/dsh codsh`)
  process.exit(1)
}

/** Run the found dsh with arguments, inheriting the terminal. */
function run(args) {
  const result = spawnSync(dsh.command, [...dsh.prefix, ...args], { stdio: 'inherit' })
  return result.status ?? 1
}

/** `a > b` for plain x.y.z versions, which is all this pair publishes. */
function newer(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if ((pa[index] ?? 0) !== (pb[index] ?? 0)) return (pa[index] ?? 0) > (pb[index] ?? 0)
  }
  return false
}

/**
 * Decide whether — and what — to register into the profile this run.
 * @returns the spec to `dsh plugin add`, or undefined when nothing is due.
 */
function registration() {
  const spec = process.env.CODSH_BUNDLE_SPEC ?? `${BUNDLE}@^${own.version}`
  const manifest = profile()
  const dependencies = manifest?.dependencies ?? {}
  // The pre-split layout carried the whole runtime under this launcher's own
  // name; migrate it out so both bundles don't fight over the terminal.
  if (manifest !== undefined && 'codsh-cli' in dependencies) {
    console.error('codsh: migrating the profile to the split codsh-bundle runtime')
    delete manifest.dependencies['codsh-cli']
    const bundles = manifest?.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      manifest.dsh.profile.bundles = bundles.filter(name => name !== 'codsh-cli')
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return spec
  }
  const current = dependencies[BUNDLE]
  if (current === undefined) return spec
  // Only registry versions belong to the launcher. A file:/link:/git/custom
  // registration is a development pin and must never be clobbered.
  const registered = /^\^?(\d+\.\d+\.\d+)$/u.exec(current)?.[1]
  if (registered === undefined) return undefined
  return newer(own.version, registered) ? spec : undefined
}

const spec = registration()
if (spec !== undefined) {
  console.error(`codsh: registering ${spec} into the dsh code profile`)
  const status = run(['plugin', '--profile', 'code', 'add', spec])
  if (status !== 0) process.exit(status)
}

process.exit(run(['--profile', 'code', ...process.argv.slice(2)]))
