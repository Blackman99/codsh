/**
 * The prebuilt Rust client inside the codsh-cli package (ticket 66).
 *
 * Layout: `native/<platform>-<arch>/` holds `codsh-rust` (`.exe` on Windows),
 * `artifact.json`, `dependencies.json`, and the license/notice files. The
 * launcher verifies the staged binary before it starts anything: the right
 * directory for this Node's platform/arch, a manifest that names this package
 * version (an interrupted update leaves them apart), the SHA-256 of the binary,
 * and the executable header (Mach-O/ELF/PE and CPU). Every refusal says how to
 * get back to a working install; none of them starts the legacy runtime or
 * any other fallback.
 *
 * Also here: the dsh floor for the Rust client and the Home version stamp that
 * makes a rollback visible. Zero dependencies, like the rest of the launcher.
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

/** Staged directory → Rust target triple and executable format. */
export const NATIVE_TARGETS = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', format: 'mach-o', cpu: 'arm64' },
  'darwin-x64': { target: 'x86_64-apple-darwin', format: 'mach-o', cpu: 'x64' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', format: 'elf', cpu: 'x64' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', format: 'elf', cpu: 'arm64' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', format: 'pe', cpu: 'x64' },
  'win32-arm64': { target: 'aarch64-pc-windows-msvc', format: 'pe', cpu: 'arm64' },
}

export function nativeKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

export function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'codsh-rust.exe' : 'codsh-rust'
}

/** The staged directory name for a Rust target triple, or undefined. */
export function keyForTarget(target) {
  return Object.entries(NATIVE_TARGETS).find(([, value]) => value.target === target)?.[0]
}

const MACH_CPU = { 0x0100000c: 'arm64', 0x01000007: 'x64' }
const ELF_CPU = { 0x3e: 'x64', 0xb7: 'arm64' }
const PE_CPU = { 0x8664: 'x64', 0xaa64: 'arm64' }

/**
 * Read an executable header.
 * @param {Buffer} bytes - at least the first 4 KiB of the file.
 * @returns {{format: string, cpus: string[]}} format `unknown` when unrecognised.
 */
export function sniffExecutable(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    return { format: 'mach-o', cpus: [MACH_CPU[bytes.readUInt32LE(4)] ?? 'unknown'] }
  }
  if (bytes.length >= 8 && (bytes.readUInt32BE(0) === 0xcafebabe || bytes.readUInt32BE(0) === 0xcafebabf)) {
    // Universal binary: big-endian fat header, 20-byte (or 32-byte fat64) entries.
    const wide = bytes.readUInt32BE(0) === 0xcafebabf
    const count = bytes.readUInt32BE(4)
    // Java class files share 0xcafebabe; their "count" is a class version (>= 45).
    if (count > 0 && count < 20) {
      const size = wide ? 32 : 20
      const cpus = []
      for (let index = 0; index < count && 8 + (index + 1) * size <= bytes.length; index += 1) {
        cpus.push(MACH_CPU[bytes.readUInt32BE(8 + index * size)] ?? 'unknown')
      }
      return { format: 'mach-o', cpus }
    }
  }
  if (bytes.length >= 20 && bytes[0] === 0x7f && bytes.toString('latin1', 1, 4) === 'ELF') {
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18)
    return { format: 'elf', cpus: [ELF_CPU[machine] ?? 'unknown'] }
  }
  if (bytes.length >= 0x40 && bytes.toString('latin1', 0, 2) === 'MZ') {
    const offset = bytes.readUInt32LE(0x3c)
    if (offset + 6 <= bytes.length && bytes.toString('latin1', offset, offset + 4) === 'PE\0\0') {
      return { format: 'pe', cpus: [PE_CPU[bytes.readUInt16LE(offset + 4)] ?? 'unknown'] }
    }
  }
  return { format: 'unknown', cpus: [] }
}

/**
 * What a Linux (ELF64 little-endian) executable needs from the system it runs
 * on: its DT_NEEDED shared libraries and the newest GLIBC_* symbol version it
 * references (#199). Reads section headers only; nothing is executed.
 * @param {Buffer} bytes - the whole file.
 * @returns {{needed: string[], glibc: string | undefined, versions: Record<string, string[]>} | undefined}
 */
export function elfRequirements(bytes) {
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes.toString('latin1', 1, 4) !== 'ELF' || bytes[4] !== 2 || bytes[5] !== 1) return undefined
  const big = value => Number(value)
  const shoff = big(bytes.readBigUInt64LE(0x28))
  const shentsize = bytes.readUInt16LE(0x3a)
  const shnum = bytes.readUInt16LE(0x3c)
  if (shoff === 0 || shentsize < 64 || shoff + shnum * shentsize > bytes.length) return undefined
  const sections = []
  for (let index = 0; index < shnum; index += 1) {
    const at = shoff + index * shentsize
    sections.push({
      type: bytes.readUInt32LE(at + 4),
      offset: big(bytes.readBigUInt64LE(at + 0x18)),
      size: big(bytes.readBigUInt64LE(at + 0x20)),
      link: bytes.readUInt32LE(at + 0x28),
      info: bytes.readUInt32LE(at + 0x2c),
    })
  }
  const cString = (table, offset) => {
    if (table === undefined || offset >= table.size) return ''
    const start = table.offset + offset
    const end = bytes.indexOf(0, start)
    return bytes.toString('latin1', start, end < 0 ? start : end)
  }
  const needed = []
  const dynamic = sections.find(section => section.type === 6)
  if (dynamic !== undefined) {
    const strings = sections[dynamic.link]
    for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.size && at + 16 <= bytes.length; at += 16) {
      const tag = bytes.readBigUInt64LE(at)
      if (tag === 0n) break
      if (tag === 1n) needed.push(cString(strings, big(bytes.readBigUInt64LE(at + 8))))
    }
  }
  const versions = {}
  let glibc
  const verneed = sections.find(section => section.type === 0x6ffffffe)
  if (verneed !== undefined) {
    const strings = sections[verneed.link]
    let entry = verneed.offset
    for (let count = 0; count < verneed.info && entry + 16 <= bytes.length; count += 1) {
      const file = cString(strings, bytes.readUInt32LE(entry + 4))
      const auxCount = bytes.readUInt16LE(entry + 2)
      let aux = entry + bytes.readUInt32LE(entry + 8)
      const names = []
      for (let index = 0; index < auxCount && aux + 16 <= bytes.length; index += 1) {
        const name = cString(strings, bytes.readUInt32LE(aux + 8))
        names.push(name)
        const match = /^GLIBC_(\d+\.\d+(?:\.\d+)?)$/u.exec(name)
        if (match !== null && (glibc === undefined || versionAtLeast(padVersion(match[1]), padVersion(glibc)) === true)) glibc = match[1]
        const next = bytes.readUInt32LE(aux + 12)
        if (next === 0) break
        aux += next
      }
      versions[file] = names
      const next = bytes.readUInt32LE(entry + 12)
      if (next === 0) break
      entry += next
    }
  }
  return { needed, glibc, versions }
}

/** `2.35` → `2.35.0`, for the x.y.z comparison. */
function padVersion(version) {
  const parts = String(version).split('.')
  while (parts.length < 3) parts.push('0')
  return parts.slice(0, 3).join('.')
}

/** Which staged key an executable header can serve, for messages. */
function describeHeader(header) {
  const platform = { 'mach-o': 'macOS', elf: 'Linux', pe: 'Windows' }[header.format]
  return platform === undefined ? 'an unrecognised file' : `a ${platform} ${header.cpus.join('+')} executable`
}

/** The steps that get a person back to a working install. */
export function recoverySteps(version) {
  const pinned = version ? `codsh-cli@${version}` : 'codsh-cli'
  return [
    `reinstall this version:   npm install -g ${pinned}`,
    'or return to an earlier:  npm install -g codsh-cli@<previous version>',
    `with pnpm, Yarn or Bun:    codsh --rust update --to ${version ?? '<version>'}   (uses the package manager that installed codsh)`,
    'Your Rust Home (~/.codsh-rust) and the legacy ~/.dsh and ~/.grok are not touched by this check; plain `codsh` keeps working.',
  ]
}

function problem(code, message, version, extra = {}) {
  return { ok: false, code, message, recovery: recoverySteps(version), ...extra }
}

/** Staged native directories present in a package, for "missing" messages. */
export function availableKeys(nativeRoot) {
  if (!existsSync(nativeRoot)) return []
  return readdirSync(nativeRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(nativeRoot, entry.name, 'artifact.json')))
    .map(entry => entry.name)
    .sort()
}

/**
 * Verify the staged Rust client for this machine without running it.
 * @param {object} options
 * @param {string} options.nativeRoot - the package's `native/` directory.
 * @param {string} options.version - this codsh-cli package version.
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {string} [options.cacheFile] - where a verified binary's file identity is remembered, so a
 *   launch of the same unchanged file skips re-hashing it (#202); install-check never passes one.
 * @returns ok with `binary`, `directory`, `manifest`; or a problem with `code`, `message`, `recovery`.
 */
export function verifyArtifact({ nativeRoot, version, platform = process.platform, arch = process.arch, cacheFile }) {
  const key = nativeKey(platform, arch)
  const directory = join(nativeRoot, key)
  const binary = join(directory, binaryName(platform))
  if (!existsSync(binary)) {
    const available = availableKeys(nativeRoot)
    let hint = available.length > 0
      ? ` This package carries: ${available.join(', ')}.`
      : ' This package carries no prebuilt Rust client.'
    if (platform === 'darwin' && arch === 'x64' && available.includes('darwin-arm64')) {
      hint += ' On Apple silicon, an x64 Node.js runs under Rosetta; install the arm64 Node.js (`node -p process.arch` should print arm64).'
    }
    return problem('missing', `Rust client artifact is not installed for ${key}.${hint} Maintainers stage a local candidate with pnpm run build:rust; ordinary codsh remains available.`, version, { key, available })
  }
  if (lstatSync(binary).isSymbolicLink() || !statSync(binary).isFile()) {
    return problem('corrupt', `Rust client artifact integrity/platform mismatch: ${binary} is not a regular file.`, version, { key })
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'artifact.json'), 'utf8'))
  } catch (error) {
    return problem('manifest', `Rust client artifact integrity/platform mismatch: artifact.json is unreadable (${error.code ?? error.message}).`, version, { key })
  }
  if (manifest?.platform !== platform || manifest?.arch !== arch) {
    return problem('target', `Rust client artifact integrity/platform mismatch: ${key} holds a manifest for ${manifest?.platform}-${manifest?.arch}.`, version, { key })
  }
  const identity = fileIdentity(binary)
  const remembered = cacheFile !== undefined && identity !== undefined && typeof manifest.sha256 === 'string'
    && sameVerified(readVerified(cacheFile), binary, identity, manifest.sha256)
  let digest = manifest.sha256
  let head
  if (remembered) {
    head = readHead(binary)
  } else {
    const bytes = readFileSync(binary)
    digest = createHash('sha256').update(bytes).digest('hex')
    if (manifest.sha256 !== digest) {
      return problem('corrupt', `Rust client artifact integrity/platform mismatch: the ${key} binary does not match its SHA-256 (damaged or incomplete download).`, version, { key, expected: manifest.sha256, actual: digest })
    }
    head = bytes.subarray(0, 4096)
  }
  const expected = NATIVE_TARGETS[key]
  const header = sniffExecutable(head)
  if (expected !== undefined && (header.format !== expected.format || !header.cpus.includes(expected.cpu))) {
    return problem('target', `Rust client artifact integrity/platform mismatch: ${key} contains ${describeHeader(header)}, not a ${expected.format} ${expected.cpu} build.`, version, { key, header })
  }
  // Manifests staged before the version field are local candidates; a
  // packaged manifest names its codsh-cli version and must match this launcher.
  if (manifest.version !== undefined && version !== undefined && manifest.version !== version) {
    return problem('version', `Rust client ${manifest.version} does not match this codsh-cli ${version}: an update did not finish.`, version, { key, artifactVersion: manifest.version })
  }
  if (cacheFile !== undefined && identity !== undefined && !remembered) rememberVerified(cacheFile, binary, identity, digest)
  return { ok: true, key, directory, binary, manifest, header, sha256: digest }
}

// A launch re-hashed the whole client (tens of MB) every time: most of the
// launcher's start-up. The same file, unchanged since it was hashed, keeps its
// verdict: a replaced, rewritten or damaged-and-rewritten file has a new
// inode, size, mtime or ctime and is hashed again.
function fileIdentity(file) {
  try {
    const stat = statSync(file, { bigint: true })
    return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }
  } catch {
    return undefined
  }
}

function readVerified(cacheFile) {
  try {
    if (lstatSync(cacheFile).isSymbolicLink()) return undefined
    return JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch {
    return undefined
  }
}

function sameVerified(record, binary, identity, sha256) {
  return record?.schema === 'codsh.artifact-verified.v1' && record.binary === binary && record.sha256 === sha256
    && Object.entries(identity).every(([field, value]) => record.identity?.[field] === value)
}

function rememberVerified(cacheFile, binary, identity, sha256) {
  try {
    // Only into a real directory that already exists (lstat: a symlinked Home is refused later).
    if (!lstatSync(dirname(cacheFile), { throwIfNoEntry: false })?.isDirectory()) return
    if (lstatSync(cacheFile, { throwIfNoEntry: false })?.isSymbolicLink()) return
    writeFileSync(cacheFile, `${JSON.stringify({ schema: 'codsh.artifact-verified.v1', binary, sha256, identity })}\n`, { mode: 0o600 })
  } catch {
    // Only a cache: the next launch hashes again.
  }
}

function readHead(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(4096)
    return head.subarray(0, readSync(fd, head, 0, head.length, 0))
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Linux runtime (#199)

/** Distribution packages that provide a shared library, for the fix line. */
const LIBRARY_PACKAGES = {
  'libgcc_s.so.1': { apt: 'libgcc-s1', dnf: 'libgcc', zypper: 'libgcc_s1', pacman: 'gcc-libs' },
  'libssl.so.3': { apt: 'libssl3', dnf: 'openssl-libs', zypper: 'libopenssl3', pacman: 'openssl' },
  'libcrypto.so.3': { apt: 'libssl3', dnf: 'openssl-libs', zypper: 'libopenssl3', pacman: 'openssl' },
  'libz.so.1': { apt: 'zlib1g', dnf: 'zlib', zypper: 'libz1', pacman: 'zlib' },
  'libzstd.so.1': { apt: 'libzstd1', dnf: 'libzstd', zypper: 'libzstd1', pacman: 'zstd' },
}

/** Libraries glibc itself provides; present wherever glibc is. */
const GLIBC_LIBRARIES = /^(libc|libm|libdl|libpthread|librt|libutil|ld-linux(-x86-64|-aarch64)?)\.so\.\d+$/u

/** The C library this Node runs on: glibc and its version, or not glibc. */
export function linuxLibc(report = () => process.report?.getReport?.()) {
  let header
  try {
    header = report()?.header
  } catch {
    header = undefined
  }
  const glibc = typeof header?.glibcVersionRuntime === 'string' ? header.glibcVersionRuntime : undefined
  return glibc === undefined ? { family: 'other' } : { family: 'glibc', version: glibc }
}

/** Whether the dynamic loader can find a library: LD_LIBRARY_PATH, ld.so.cache, the usual directories. */
export function libraryPresent(name, { env = process.env, arch = process.arch, cache = '/etc/ld.so.cache' } = {}) {
  const multiarch = arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu'
  const directories = [
    ...String(env.LD_LIBRARY_PATH ?? '').split(':').filter(dir => dir !== '' && isAbsolute(dir)),
    `/lib/${multiarch}`, `/usr/lib/${multiarch}`, '/lib64', '/usr/lib64', '/lib', '/usr/lib', '/usr/local/lib',
  ]
  if (directories.some(dir => existsSync(join(dir, name)))) return true
  try {
    return readFileSync(cache).includes(Buffer.from(`${name}\0`, 'latin1'))
  } catch {
    return false
  }
}

/**
 * Whether this Linux can load the staged client, from the requirements the
 * build recorded in artifact.json (`runtime.glibc`, `runtime.needed`). A
 * manifest without them (an older local candidate) is let through.
 */
export function linuxRuntimeProblem(manifest, { libc = linuxLibc(), present = libraryPresent } = {}) {
  const runtime = manifest?.runtime
  if (manifest?.platform !== 'linux' || runtime === undefined || runtime === null) return undefined
  const need = typeof runtime.glibc === 'string' ? runtime.glibc : undefined
  const keep = 'plain `codsh` (the Node.js runtime) keeps working on this machine.'
  if (need !== undefined && libc.family !== 'glibc') {
    return {
      ok: false, code: 'libc',
      message: `the prebuilt Linux Rust client needs glibc ${need} or newer, and this system has no glibc (musl, as on Alpine, is not supported).`,
      recovery: ['run codsh --rust on a glibc distribution or container (Ubuntu 22.04+, Debian 12+, Fedora 36+)', keep],
    }
  }
  if (need !== undefined && versionAtLeast(padVersion(libc.version), padVersion(need)) === false) {
    return {
      ok: false, code: 'glibc',
      message: `this Linux has glibc ${libc.version}; the prebuilt Rust client needs glibc ${need} or newer.`,
      recovery: ['upgrade to a distribution with a newer glibc (Ubuntu 22.04+, Debian 12+, Fedora 36+, RHEL 10+), or use such a container', keep],
    }
  }
  const missing = (Array.isArray(runtime.needed) ? runtime.needed : [])
    .filter(name => typeof name === 'string' && !GLIBC_LIBRARIES.test(name) && !present(name))
  if (missing.length > 0) {
    const packages = key => [...new Set(missing.map(name => LIBRARY_PACKAGES[name]?.[key]).filter(Boolean))].join(' ')
    const known = missing.every(name => LIBRARY_PACKAGES[name] !== undefined)
    return {
      ok: false, code: 'library',
      message: `the Rust client needs ${missing.join(', ')}, which the dynamic loader cannot find on this system.`,
      recovery: known
        ? [`Debian/Ubuntu:  sudo apt install ${packages('apt')}`, `Fedora/RHEL:    sudo dnf install ${packages('dnf')}`, `openSUSE:       sudo zypper install ${packages('zypper')}`, `Arch:           sudo pacman -S ${packages('pacman')}`, keep]
        : [`install the package that provides ${missing.join(', ')} (or add its directory to LD_LIBRARY_PATH)`, `then check again: codsh --rust install-check`, keep],
      missing,
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// dsh for the Rust client

const PRE_RANK = { alpha: 0, beta: 1, rc: 2 }

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z]+)\.(\d+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(String(text ?? '').trim())
  if (match === null) return undefined
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.toLowerCase(), preN: Number(match[5] ?? 0) }
}

/** `found >= need` for x.y.z[-pre.N]; undefined when either does not parse. */
export function versionAtLeast(found, need) {
  const a = parseVersion(found)
  const b = parseVersion(need)
  if (a === undefined || b === undefined) return undefined
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index]
  }
  if (a.pre === undefined) return true
  if (b.pre === undefined) return false
  const rankA = PRE_RANK[a.pre] ?? -1
  const rankB = PRE_RANK[b.pre] ?? -1
  if (rankA !== rankB) return rankA > rankB
  return a.preN >= b.preN
}

/** Look up an executable on PATH; absolute and symlink-free, or undefined. */
export function whichOnPath(name, pathValue = process.env.PATH ?? '', platform = process.platform) {
  const extensions = platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '' || !isAbsolute(directory)) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      try {
        if (statSync(candidate).isFile()) return realpathSync(candidate)
      } catch {
        // Not here.
      }
    }
  }
  return undefined
}

/**
 * The `@deepseek-ai/dsh` package that owns a dsh entry, when it is one.
 * @returns {{root: string, version: string} | undefined}
 */
export function dshPackage(entry) {
  if (typeof entry !== 'string' || !isAbsolute(entry)) return undefined
  let current
  try {
    current = dirname(realpathSync(entry))
  } catch {
    return undefined
  }
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed?.name === '@deepseek-ai/dsh' && typeof parsed.version === 'string') return { root: current, version: parsed.version }
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * The dsh install line a recovery message gives (#198). `npm install -g
 * @deepseek-ai/dsh` alone takes the registry's latest, which this codsh-cli
 * was not tested with, and a bare floor such as 0.1.5-rc.2 resolves its own
 * `^` dependencies to newer prereleases (a mixed tree that fails to boot), so
 * the line names the exact dsh the release was tested with when there is one.
 * @param {string | undefined} need - `codsh.requiresDsh` (the floor).
 * @param {string | undefined} tested - `codsh.testedDsh`.
 */
export function dshInstallLine(need, tested) {
  if (typeof tested === 'string' && tested !== '') {
    return `install one:      npm install -g @deepseek-ai/dsh@${tested}   (tested with this codsh-cli${need ? `; ${need} or newer required` : ''})`
  }
  return `install one:      npm install -g @deepseek-ai/dsh${need ? `   (${need} or newer)` : ''}`
}

/**
 * Whether a dsh is new enough for this launcher. A dsh whose version cannot be
 * read (a DSH_BIN test double, a custom build) is let through, as the legacy
 * launcher does; a readable version below the floor is refused.
 */
export function dshFloorProblem(entry, need, version, tested) {
  if (typeof need !== 'string' || need === '') return undefined
  const found = dshPackage(entry)
  if (found === undefined) return undefined
  if (versionAtLeast(found.version, need) !== false) return undefined
  return {
    ok: false,
    code: 'dsh-too-old',
    message: `dsh ${found.version} at ${found.root} is too old — the Rust client needs @deepseek-ai/dsh ${need} or newer.`,
    recovery: [
      dshInstallLine(need, tested),
      'or point at one:  DSH_BIN=/path/to/dsh codsh --rust',
      `or return to the codsh-cli that matched it (this is ${version ?? 'unknown'}): npm install -g codsh-cli@<previous version>`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Home version stamp

/**
 * Compare the running version with the one recorded in the Rust Home.
 * @returns {{notice?: string, next: object}} `next` is what to record.
 */
export function stampTransition(previous, version, now = new Date().toISOString()) {
  const last = typeof previous?.lastVersion === 'string' ? previous.lastVersion : undefined
  const newest = typeof previous?.newestVersion === 'string' ? previous.newestVersion : last
  const next = {
    lastVersion: version,
    newestVersion: newest !== undefined && versionAtLeast(newest, version) === true ? newest : version,
    previousVersion: last !== undefined && last !== version ? last : previous?.previousVersion,
    updatedAt: now,
  }
  if (last === undefined || last === version) return { next }
  const newer = versionAtLeast(version, last)
  if (newer === false) {
    return {
      next,
      notice: `codsh: this Rust Home was last used by codsh ${last}; now running ${version} (an earlier version). Sessions and settings are kept; anything added after ${version} is not read. Return with: npm install -g codsh-cli@${last}`,
    }
  }
  return { next, notice: `codsh: Rust client updated ${last} → ${version}. Go back with: npm install -g codsh-cli@${last}` }
}
