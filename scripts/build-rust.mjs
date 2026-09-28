import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { buildShipExtension } from './build-ship-extension.mjs'
import { NATIVE_TARGETS, binaryName, elfRequirements, keyForTarget, sniffExecutable } from '../packages/cli/bin/rust-artifact.mjs'

// `pnpm run build:rust` stages the host build. `-- --target <triple>` stages
// another target from this machine (for example x86_64-apple-darwin on an
// Apple silicon Mac); it needs that Rust target and a working linker/SDK for
// it, and fails rather than staging something that was not built.
const root = resolve(import.meta.dirname, '..')
const manifest = join(root, 'rust/Cargo.toml')
const targetFlag = process.argv.indexOf('--target')
const requested = targetFlag >= 0 ? process.argv[targetFlag + 1] : undefined
if (targetFlag >= 0 && (requested === undefined || keyForTarget(requested) === undefined)) {
  throw new Error(`--target must be one of: ${Object.values(NATIVE_TARGETS).map(value => value.target).join(', ')}`)
}
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/mu)?.[1]
if (!host) throw new Error('rustc did not identify the native target')
const target = requested ?? host
const key = keyForTarget(target) ?? `${process.platform}-${process.arch}`
const [platform, arch] = key.split('-')
const cli = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'))
// The client reports the codsh-cli version it ships in (CODSH_VERSION in
// rust/src/main.rs), not the internal crate version, so `codsh --rust
// --version`, the ACP clientInfo and artifact.json agree (#198).
// Windows (#200): link the C runtime statically, so the client needs no
// Visual C++ Redistributable (VCRUNTIME140.dll) on the user's machine.
const msvc = target.endsWith('-pc-windows-msvc') ? `CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_RUSTFLAGS` : undefined
execFileSync('cargo', ['build', '--manifest-path', manifest, '--locked', '--release', '-p', 'codsh-rust', ...(requested ? ['--target', requested] : [])], {
  stdio: 'inherit',
  env: { ...process.env, CODSH_PACKAGE_VERSION: cli.version, ...(msvc && process.env[msvc] === undefined ? { [msvc]: '-C target-feature=+crt-static' } : {}) },
})
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', manifest, '--locked', '--format-version', '1', '--filter-platform', target], { encoding: 'utf8', maxBuffer: 20_000_000 }))
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]))
const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]))
const closure = new Set()
function visit(id) {
  if (closure.has(id)) return
  closure.add(id)
  for (const dep of nodes.get(id).deps) {
    if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dep.pkg)
  }
}
visit(metadata.packages.find(pkg => pkg.name === 'codsh-rust').id)
const directory = join(root, 'packages/cli/native', key)
const filename = binaryName(platform)
const built = join(metadata.target_directory, ...(requested ? [requested] : []), 'release', filename)
// The staged directory must hold what its name says (format and CPU), so a
// wrong-target copy fails here instead of on a user's machine.
const expected = NATIVE_TARGETS[key]
const header = sniffExecutable(readFileSync(built).subarray(0, 4096))
if (expected !== undefined && (header.format !== expected.format || !header.cpus.includes(expected.cpu))) {
  throw new Error(`${built} is a ${header.format} ${header.cpus.join('+')} file, not the ${expected.format} ${expected.cpu} build ${key} needs`)
}
mkdirSync(directory, { recursive: true })
copyFileSync(built, join(directory, filename))
const records = [...closure].sort().map(id => {
  const pkg = packages.get(id)
  const base = dirname(pkg.manifest_path)
  const bundled = join(root, 'rust/upstream/licenses', `${pkg.name}-${pkg.version}`)
  const source = pkg.name === 'codsh-rust' ? root : existsSync(bundled) ? bundled : base
  const licenses = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile() && /^(LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)([.-]|$)/iu.test(entry.name))
  if (licenses.length === 0) throw new Error(`Missing license files for ${pkg.name} ${pkg.version}`)
  const dest = join(directory, 'licenses', `${pkg.name}-${pkg.version}`)
  mkdirSync(dest, { recursive: true })
  for (const license of licenses) copyFileSync(join(source, license.name), join(dest, license.name))
  const licenseFiles = licenses.map(entry => `licenses/${pkg.name}-${pkg.version}/${entry.name}`)
  // openssl-src's own files cover the crate; the OpenSSL library it compiles
  // into the Linux client (#199) is Apache-2.0 under openssl/LICENSE.txt.
  if (pkg.name === 'openssl-src' && existsSync(join(source, 'openssl', 'LICENSE.txt'))) {
    copyFileSync(join(source, 'openssl', 'LICENSE.txt'), join(dest, 'OPENSSL-LICENSE.txt'))
    licenseFiles.push(`licenses/${pkg.name}-${pkg.version}/OPENSSL-LICENSE.txt`)
  }
  return { name: pkg.name, version: pkg.version, license: pkg.license, source: pkg.source, repository: pkg.repository, licenseFiles }
})
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES', 'MODIFICATIONS', 'import.json']) {
  copyFileSync(join(root, 'rust/upstream', name), join(directory, `UPSTREAM-${name}`))
}
copyFileSync(join(root, 'LICENSE'), join(directory, 'LICENSE-codsh'))
writeFileSync(join(directory, 'dependencies.json'), `${JSON.stringify({ target, kind: 'normal and build closure; no dev dependencies', packages: records }, null, 2)}\n`)
// A binary this machine can run must name the package version it is staged for.
if (target === host) {
  const scratch = mkdtempSync(join(tmpdir(), 'codsh-build-version-'))
  let reported
  try {
    reported = execFileSync(join(directory, filename), ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: scratch, USERPROFILE: scratch } }).trim()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (!reported.startsWith(`codsh-rust ${cli.version} `)) throw new Error(`${built} reports "${reported}", not codsh-rust ${cli.version}`)
}
writeFileSync(join(directory, 'artifact.json'), `${JSON.stringify({
  platform, arch, target,
  // The launcher refuses a binary whose package version differs from its own
  // (an update that stopped halfway); requiresDsh is the runtime floor.
  version: cli.version,
  requiresDsh: cli.codsh?.requiresDsh,
  binary: filename,
  format: header.format,
  // What the system must provide (#199): glibc floor and shared libraries,
  // read from the ELF itself; the launcher checks them before starting it.
  ...(header.format === 'elf' ? { runtime: (({ glibc, needed }) => ({ libc: 'glibc', glibc, needed }))(elfRequirements(readFileSync(join(directory, filename)))) } : {}),
  sha256: createHash('sha256').update(readFileSync(join(directory, filename))).digest('hex'),
  upstream: 'a28ee2b2063426e8816e380ccea528b9de95e5da',
  behaviorReference: '1.0.34 / 3736acbc8658; exact source correspondence unproven',
}, null, 2)}\n`)
// The optional Ship extension (`plugin install bundled:ship`) ships beside the
// launcher; building it installs or enables nothing.
const ship = await buildShipExtension()
console.log(`Staged native candidate at ${directory}; no upload, install, or release performed.`)
console.log(`Built the optional Ship extension at ${ship}; nothing was installed or enabled.`)
