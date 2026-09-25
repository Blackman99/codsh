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
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
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
 * @returns ok with `binary`, `directory`, `manifest`; or a problem with `code`, `message`, `recovery`.
 */
export function verifyArtifact({ nativeRoot, version, platform = process.platform, arch = process.arch }) {
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
  const bytes = readFileSync(binary)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (manifest.sha256 !== digest) {
    return problem('corrupt', `Rust client artifact integrity/platform mismatch: the ${key} binary does not match its SHA-256 (damaged or incomplete download).`, version, { key, expected: manifest.sha256, actual: digest })
  }
  const expected = NATIVE_TARGETS[key]
  const header = sniffExecutable(bytes.subarray(0, 4096))
  if (expected !== undefined && (header.format !== expected.format || !header.cpus.includes(expected.cpu))) {
    return problem('target', `Rust client artifact integrity/platform mismatch: ${key} contains ${describeHeader(header)}, not a ${expected.format} ${expected.cpu} build.`, version, { key, header })
  }
  // Manifests staged before the version field are local candidates; a
  // packaged manifest names its codsh-cli version and must match this launcher.
  if (manifest.version !== undefined && version !== undefined && manifest.version !== version) {
    return problem('version', `Rust client ${manifest.version} does not match this codsh-cli ${version}: an update did not finish.`, version, { key, artifactVersion: manifest.version })
  }
  return { ok: true, key, directory, binary, manifest, header, sha256: digest }
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
 * Whether a dsh is new enough for this launcher. A dsh whose version cannot be
 * read (a DSH_BIN test double, a custom build) is let through, as the legacy
 * launcher does; a readable version below the floor is refused.
 */
export function dshFloorProblem(entry, need, version) {
  if (typeof need !== 'string' || need === '') return undefined
  const found = dshPackage(entry)
  if (found === undefined) return undefined
  if (versionAtLeast(found.version, need) !== false) return undefined
  return {
    ok: false,
    code: 'dsh-too-old',
    message: `dsh ${found.version} at ${found.root} is too old — the Rust client needs @deepseek-ai/dsh ${need} or newer.`,
    recovery: [
      `install one:      npm install -g @deepseek-ai/dsh   (${need} or newer)`,
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
