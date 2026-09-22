import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const requireFromHere = createRequire(import.meta.url)

function hostDshHome() {
  // Match released dsh-home-paths: blank is unset; only these tilde prefixes expand.
  const value = process.env.DSH_HOME
  let dsh = value !== undefined && value.trim().length > 0 ? value : join(homedir(), '.dsh')
  if (dsh === '~') dsh = homedir()
  else if (dsh.startsWith('~/') || dsh.startsWith('~\\')) dsh = join(homedir(), dsh.slice(2))
  return resolve(dsh)
}

function hostGrokHome() {
  const grok = process.env.GROK_HOME
  if (grok?.split(process.platform === 'win32' ? /[\\/]/u : '/').includes('..')) {
    throw new Error('refusing GROK_HOME with .. components; use an unambiguous path without parent traversal')
  }
  return grok && grok.length > 0 ? grok : join(realpathSync.native(homedir()), '.grok')
}

function legacyHomes() {
  // Grok keeps nonempty overrides verbatim; lexical .. collapse can hide symlinks.
  const grok = process.env.GROK_HOME
  if (grok?.split(process.platform === 'win32' ? /[\\/]/u : '/').includes('..')) {
    throw new Error('refusing GROK_HOME with .. components; use an unambiguous path without parent traversal')
  }
  return [hostDshHome(), join(homedir(), '.dsh'), grok, join(realpathSync.native(homedir()), '.grok')]
}

function canonicalPath(path) {
  const absolute = resolve(path)
  try {
    // Native realpath resolves filesystem case aliases; the JS fallback preserves spelling.
    return { path: realpathSync.native(absolute), suffix: [] }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // ENOENT can hide a dangling link; do not reconstruct it as a missing directory.
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`refusing unresolved symlink in Home path: ${absolute}`)
    }
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    // Unicode folding cannot establish the filesystem identity of a missing name.
    const name = basename(absolute)
    if (/[^\x00-\x7f]/u.test(name)) throw new Error('refusing unresolved non-ASCII Home component; use an existing separate directory or ASCII missing components')
    const ancestor = canonicalPath(parent)
    return { path: ancestor.path, suffix: [...ancestor.suffix, name] }
  }
}

function directoryAncestry(home) {
  const ancestors = []
  let path = home.path
  let suffix = home.suffix
  while (true) {
    let stat
    try {
      stat = statSync(path, { bigint: true })
    } catch {
      throw new Error('cannot establish Home directory identity; refusing to write')
    }
    if (!stat.isDirectory() || stat.ino === 0n) throw new Error('cannot establish Home directory identity; refusing to write')
    ancestors.push({ device: stat.dev, inode: stat.ino, suffix })
    const parent = dirname(path)
    if (parent === path) return ancestors
    suffix = [basename(path), ...suffix]
    path = parent
  }
}

function overlaps(a, b) {
  const left = directoryAncestry(a)
  const right = directoryAncestry(b)
  const missing = a.suffix.length > 0 || b.suffix.length > 0
  const prefix = (parent, child) => parent.length <= child.length && parent.every((name, index) =>
    name === child[index] || (missing && name.toLowerCase() === child[index].toLowerCase()))
  // Firmlinks can retain different realpath strings for the same directory identity.
  return left.some(x => right.some(y => x.device === y.device && x.inode === y.inode
    && (prefix(x.suffix, y.suffix) || prefix(y.suffix, x.suffix))))
}

function findDsh() {
  const pinned = process.env.DSH_BIN
  if (pinned !== undefined && pinned !== '') return pinned
  try {
    const manifest = requireFromHere.resolve('@deepseek-ai/dsh/package.json')
    const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin
    return join(dirname(manifest), typeof bin === 'string' ? bin : bin.dsh)
  } catch {
    return 'dsh'
  }
}

function privateDirectory(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing non-directory or symlink: ${path}`)
  } else mkdirSync(path, { mode: 0o700 })
}

export async function launchRust(args) {
  try {
    const native = fileURLToPath(new URL(`../native/${process.platform}-${process.arch}/`, import.meta.url))
    const binary = join(native, process.platform === 'win32' ? 'codsh-rust.exe' : 'codsh-rust')
    if (!existsSync(binary)) {
      throw new Error(`Rust client artifact is not installed for ${process.platform}-${process.arch}. Use a locally staged candidate (pnpm run build:rust); ordinary codsh remains available.`)
    }
    const manifest = JSON.parse(readFileSync(join(native, 'artifact.json'), 'utf8'))
    const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
    if (manifest.sha256 !== digest || manifest.platform !== process.platform || manifest.arch !== process.arch) {
      throw new Error('Rust client artifact integrity/platform mismatch; rebuild the candidate')
    }
    const parent = realpathSync(homedir())
    const root = join(parent, '.codsh-rust')
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refusing symlink: ${root}`)
    const canonicalRoot = canonicalPath(root)
    for (const oldHome of legacyHomes()) {
      if (!oldHome) continue
      if (overlaps(canonicalRoot, canonicalPath(oldHome))) throw new Error('Rust Home overlaps a legacy Home; refusing to access legacy data')
    }
    const helpOnly = (args.length === 1 && ['--help', '-h', '--version', '-V'].includes(args[0]))
      || (['inspect', 'import'].includes(args[0]) && args.length > 1 && args.slice(1).every(flag => flag === '--help' || flag === '-h'))
      || (args[0] === 'plugin' && args.slice(1).every(flag => flag === '--help' || flag === '-h'))
    if (!helpOnly) {
      privateDirectory(root)
      privateDirectory(join(root, 'dsh'))
      privateDirectory(join(root, 'dsh', 'profiles'))
      privateDirectory(join(root, 'dsh', 'profiles', 'rust'))
      const profile = join(root, 'dsh', 'profiles', 'rust', 'package.json')
      if (existsSync(profile) && lstatSync(profile).isSymbolicLink()) throw new Error('refusing symlinked Rust Profile')
      if (!existsSync(profile)) writeFileSync(profile, `${JSON.stringify({
        name: 'dsh-profile-rust', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
      }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
    const hostHome = realpathSync(homedir())
    const env = {
      HOME: root,
      USERPROFILE: root,
      DSH_HOME: join(root, 'dsh'),
      DSH_PROFILE: 'rust',
      DSH_BIN: findDsh(),
      CODSH_NODE: process.execPath,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      CODSH_UPDATE_CHECK: 'off',
      CODSH_HOST_HOME: hostHome,
      CODSH_HOST_DSH_HOME: hostDshHome(),
      CODSH_HOST_GROK_HOME: hostGrokHome(),
    }
    for (const key of ['PATH', 'TERM', 'TERM_PROGRAM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'SystemRoot', 'WINDIR', 'CODSH_ACP_PATCH', 'CODSH_SESSION_READ', 'CODSH_SESSION_FORK', 'DSH_CODE_CLI_MOCK_TOOL', 'DSH_CODE_CLI_MOCK_DELAY_MS', 'DSH_CODE_CLI_MOCK_CONTEXT_WINDOW', 'DSH_CODE_CLI_TOOL_DELAY_MS', 'FAKE_ACP_MODE', 'FAKE_ACP_VERSION', 'FAKE_ACP_DELAY_MS', 'FAKE_ACP_TARGET', 'FAKE_ACP_WRITES', 'FAKE_ACP_STORE', 'FAKE_ACP_OWNED', 'FAKE_ACP_STALE_OWNER', 'GROK_CONFIG', 'GROK_CONFIG_PATH', 'GROK_TELEMETRY_ENABLED', 'GROK_FEEDBACK_ENABLED', 'GROK_TRACE_UPLOAD', 'GROK_TELEMETRY_TRACE_UPLOAD', 'GROK_SETTINGS_CACHE', 'GROK_AUTO_COMPACT_THRESHOLD_PERCENT', 'GROK_COMPACTION_WALL_CLOCK_SECS', 'CODSH_TEST_COMPACT_THRESHOLD', 'CODSH_TEST_PRUNE_DISABLED', 'CODSH_TEST_PRUNE_HEAD', 'CODSH_TEST_PRUNE_TAIL', 'CODSH_TEST_PRUNE_THRESHOLD', 'GROK_FOLDER_TRUST', 'GROK_MANAGED_CONFIG', 'GROK_MANAGED_CONFIG_FAIL_CLOSED', 'GROK_MANAGED_CONFIG_URL', 'GROK_REQUIRED_MINIMUM_VERSION', 'GROK_REQUIRED_MAXIMUM_VERSION', 'GROK_SCREEN_MODE', 'GROK_SCREEN_MODE_SWITCH', 'GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER', 'GROK_MARKETPLACE_REQUIRE_SHA', 'CODSH_HOST_HOME', 'CODSH_HOST_DSH_HOME', 'CODSH_HOST_GROK_HOME']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && (key === 'XAI_API_KEY' || key.endsWith('_API_KEY'))) env[key] = value
    }
    env.GROK_HOME = join(root, '.grok')
    if (!helpOnly && env.CODSH_ACP_PATCH === undefined) {
      const approval = fileURLToPath(new URL('./rust-acp-file-approval.mjs', import.meta.url))
      const compact = fileURLToPath(new URL('./rust-acp-compact.mjs', import.meta.url))
      const overlay = join(root, 'dsh', 'rust-file-approval.yml')
      writeFileSync(overlay, [
        '- insert:',
        `    - id: rust-acp-file-approval`,
        `      name: '${pathToFileURL(approval).href}'`,
        `    - id: rust-acp-compact`,
        `      name: '${pathToFileURL(compact).href}'`,
        '',
      ].join('\n'))
      env.CODSH_ACP_PATCH = overlay
    }
    if (env.CODSH_SESSION_READ === undefined) {
      env.CODSH_SESSION_READ = fileURLToPath(new URL('./rust-acp-session-read.mjs', import.meta.url))
    }
    if (env.CODSH_SESSION_FORK === undefined) {
      env.CODSH_SESSION_FORK = fileURLToPath(new URL('./rust-acp-session-fork.mjs', import.meta.url))
    }
    return await new Promise(resolveExit => {
      const child = spawn(binary, args, { env, stdio: 'inherit', shell: false })
      const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => { child.kill(signal) }]))
      for (const [signal, handler] of handlers) process.on(signal, handler)
      const finish = code => {
        for (const [signal, handler] of handlers) process.off(signal, handler)
        resolveExit(code)
      }
      child.once('error', error => { console.error(`codsh: Rust startup failed: ${error.message}`); finish(1) })
      child.once('exit', (code, signal) => { finish(code ?? (signal === 'SIGINT' ? 130 : 1)) })
    })
  } catch (error) {
    console.error(`codsh: ${error.message}`)
    return 1
  }
}
