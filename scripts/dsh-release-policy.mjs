import { compare, maxSatisfying, minVersion, valid, validRange } from 'semver'

/** Compare two valid SemVer release strings. */
export const compareVersions = compare

/**
 * npm abbreviated metadata for one package.
 * @typedef {object} RegistryMetadata
 * @property {Record<string, { dependencies?: Record<string, string> }>} versions
 * @property {Record<string, string>} dist-tags
 */

/**
 * Pick the harness target from registry metadata.
 *
 * The promoted `latest` tag is an explicit opt-in to a new release line. An
 * untagged version is eligible only when a lockfile-free install of the current
 * range could resolve it; this keeps catching same-core RC drift without
 * silently opting into an unrelated alpha line.
 *
 * A newer candidate is installable only when every required `@deepseek-ai/*`
 * range in its dependency closure has a published version. The harness has
 * shipped a meta-package whose dependency was never published; selecting that
 * version makes the sync install fail before CI can open a PR. A broken newer
 * release leaves the manifest's current version in place: ranges such as
 * `^0.1.5-rc.2` can float onto that broken release, while the committed
 * lockfile still installs.
 * @param {RegistryMetadata} metadata - npm registry metadata for `@deepseek-ai/dsh`.
 * @param {string} currentRange - current @deepseek-ai/dsh manifest range.
 * @param {(name: string) => Promise<RegistryMetadata>} [loadMetadata] - registry lookup used while walking the closure. Required when a candidate might pull in packages other than `@deepseek-ai/dsh`.
 * @returns {Promise<string>} selected harness version.
 */
export async function selectDshTarget(metadata, currentRange, loadMetadata) {
  const range = validRange(currentRange)
  if (range === null) throw new Error(`invalid @deepseek-ai/dsh range: ${currentRange}`)

  const versions = Object.keys(metadata.versions)
  if (versions.length === 0) throw new Error('@deepseek-ai/dsh registry has no versions')
  const latest = metadata['dist-tags'].latest
  if (valid(latest) === null || !versions.includes(latest)) {
    throw new Error(`invalid @deepseek-ai/dsh latest tag: ${latest}`)
  }

  const installable = maxSatisfying(versions, range)
  const candidate = installable !== null && compare(latest, installable) < 0 ? installable : latest
  if (await closureResolves(metadata, candidate, loadMetadata)) return candidate

  const pinned = minVersion(range)?.version
  if (pinned && versions.includes(pinned) && compare(pinned, candidate) < 0) return pinned
  throw new Error(`no installable @deepseek-ai/dsh release at or below ${candidate}`)
}

/**
 * @param {RegistryMetadata} rootMetadata
 * @param {string} version
 * @param {(name: string) => Promise<RegistryMetadata>} [loadMetadata]
 */
async function closureResolves(rootMetadata, version, loadMetadata) {
  /** @type {Map<string, RegistryMetadata>} */
  const cache = new Map([['@deepseek-ai/dsh', rootMetadata]])
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Array<[string, string]>} */
  const pending = [['@deepseek-ai/dsh', version]]

  while (pending.length > 0) {
    const [name, wanted] = pending.pop()
    const key = `${name}@${wanted}`
    if (seen.has(key)) continue
    seen.add(key)

    const metadata = cache.get(name) ?? await load(name, loadMetadata)
    cache.set(name, metadata)
    const published = Object.keys(metadata.versions)
    const resolved = maxSatisfying(published, wanted)
    if (resolved === null) return false

    const manifest = metadata.versions[resolved]
    for (const [dependency, dependencyRange] of Object.entries(manifest.dependencies ?? {})) {
      if (!dependency.startsWith('@deepseek-ai/')) continue
      if (validRange(dependencyRange) === null) return false
      pending.push([dependency, dependencyRange])
    }
  }
  return true
}

/**
 * @param {string} name
 * @param {(name: string) => Promise<RegistryMetadata>} [loadMetadata]
 * @returns {Promise<RegistryMetadata>}
 */
function load(name, loadMetadata) {
  if (loadMetadata === undefined) {
    throw new Error(`registry lookup required to resolve ${name}`)
  }
  return loadMetadata(name)
}
