import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
const manifest = join(root, 'rust/Cargo.toml')
execFileSync('cargo', ['build', '--manifest-path', manifest, '--locked', '--release', '-p', 'codsh-rust'], { stdio: 'inherit' })
const target = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/mu)?.[1]
if (!target) throw new Error('rustc did not identify the native target')
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
const directory = join(root, 'packages/cli/native', `${process.platform}-${process.arch}`)
mkdirSync(directory, { recursive: true })
const filename = process.platform === 'win32' ? 'codsh-rust.exe' : 'codsh-rust'
copyFileSync(join(metadata.target_directory, 'release', filename), join(directory, filename))
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
  return { name: pkg.name, version: pkg.version, license: pkg.license, source: pkg.source, repository: pkg.repository, licenseFiles: licenses.map(entry => `licenses/${pkg.name}-${pkg.version}/${entry.name}`) }
})
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES', 'MODIFICATIONS', 'import.json']) {
  copyFileSync(join(root, 'rust/upstream', name), join(directory, `UPSTREAM-${name}`))
}
copyFileSync(join(root, 'LICENSE'), join(directory, 'LICENSE-codsh'))
writeFileSync(join(directory, 'dependencies.json'), `${JSON.stringify({ target, kind: 'normal and build closure; no dev dependencies', packages: records }, null, 2)}\n`)
writeFileSync(join(directory, 'artifact.json'), `${JSON.stringify({
  platform: process.platform, arch: process.arch, target,
  sha256: createHash('sha256').update(readFileSync(join(directory, filename))).digest('hex'),
  upstream: 'a28ee2b2063426e8816e380ccea528b9de95e5da',
  behaviorReference: '1.0.34 / 3736acbc8658; exact source correspondence unproven',
}, null, 2)}\n`)
console.log(`Staged native candidate at ${directory}; no upload, install, or release performed.`)
