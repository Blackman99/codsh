import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

function legacyHomes() {
  // Match released dsh-home-paths: blank is unset; only these tilde prefixes expand.
  const value = process.env.DSH_HOME
  let dsh = value !== undefined && value.trim().length > 0 ? value : join(homedir(), '.dsh')
  if (dsh === '~') dsh = homedir()
  else if (dsh.startsWith('~/') || dsh.startsWith('~\\')) dsh = join(homedir(), dsh.slice(2))
  // Grok keeps nonempty overrides verbatim; lexical .. collapse can hide symlinks.
  const grok = process.env.GROK_HOME
  if (grok?.split(process.platform === 'win32' ? /[\\/]/u : '/').includes('..')) {
    throw new Error('refusing GROK_HOME with .. components; use an unambiguous path without parent traversal')
  }
  return [resolve(dsh), join(homedir(), '.dsh'), grok, join(realpathSync.native(homedir()), '.grok')]
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
    const helpOnly = args.length === 1 && ['--help', '-h', '--version', '-V'].includes(args[0])
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
    const env = { HOME: root, USERPROFILE: root, DSH_HOME: join(root, 'dsh'), DSH_PROFILE: 'rust' }
    for (const key of ['PATH', 'TERM', 'TERM_PROGRAM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'SystemRoot', 'WINDIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
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
