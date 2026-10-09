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
 * A newer harness release the policy passed over, and the `name@range`
 * requirements npm cannot satisfy for it.
 * @typedef {{ version: string, unresolved: string[] }} SkippedRelease
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
 * version makes the sync install fail before CI can open a PR.
 *
 * `required` names the harness packages codsh itself depends on. The sync
 * bumps each of them to `^<target>`, so a candidate is installable only when
 * every one is published there too. A release line that renames or drops one
 * (0.1.7 replaced `dsh-agent-presets` with `dsh-agent-preset`) is a manual
 * migration, not a range bump.
 *
 * Candidates are tried newest first: the promoted `latest`, then the highest
 * version the current range resolves, then the manifest's own pin, which the
 * committed lockfile still installs.
 * @param {RegistryMetadata} metadata - npm registry metadata for `@deepseek-ai/dsh`.
 * @param {string} currentRange - current @deepseek-ai/dsh manifest range.
 * @param {(name: string) => Promise<RegistryMetadata>} [loadMetadata] - registry lookup used while walking the closure. Required when a candidate might pull in packages other than `@deepseek-ai/dsh`.
 * @param {Iterable<string>} [required] - harness package names codsh's manifests depend on.
 * @returns {Promise<{ version: string, skipped: SkippedRelease[] }>} selected harness version, and the newer releases passed over.
 */
export async function selectDshTarget(metadata, currentRange, loadMetadata, required = []) {
  const range = validRange(currentRange)
  if (range === null) throw new Error(`invalid @deepseek-ai/dsh range: ${currentRange}`)

  const versions = Object.keys(metadata.versions)
  if (versions.length === 0) throw new Error('@deepseek-ai/dsh registry has no versions')
  const latest = metadata['dist-tags'].latest
  if (valid(latest) === null || !versions.includes(latest)) {
    throw new Error(`invalid @deepseek-ai/dsh latest tag: ${latest}`)
  }

  const installable = maxSatisfying(versions, range)
  const pinned = minVersion(range)?.version
  const fallback = pinned !== undefined && versions.includes(pinned) ? pinned : undefined
  const newer = [latest, installable]
    .filter((version) => version !== null)
    .sort((a, b) => compare(b, a))
    .filter((version, index, sorted) => sorted.indexOf(version) === index)
    .filter((version) => fallback === undefined || compare(fallback, version) < 0)
  // With nothing newer, the pin itself is the candidate and must still resolve.
  const candidates = newer.length > 0 ? newer : [fallback]

  /** @type {Map<string, RegistryMetadata>} */
  const cache = new Map([['@deepseek-ai/dsh', metadata]])
  /** @type {SkippedRelease[]} */
  const skipped = []
  for (const candidate of candidates) {
    const unresolved = await unresolvedClosure(cache, candidate, [...required], loadMetadata)
    if (unresolved.length === 0) return { version: candidate, skipped }
    skipped.push({ version: candidate, unresolved })
  }

  if (fallback !== undefined && !candidates.includes(fallback)) return { version: fallback, skipped }
  throw new Error(`no installable @deepseek-ai/dsh release at or below ${candidates[0]}`)
}

/**
 * Walk `@deepseek-ai/dsh@version`, plus `^version` of every required package,
 * through their `@deepseek-ai/*` dependencies.
 * @param {Map<string, RegistryMetadata>} cache - metadata shared across candidates.
 * @param {string} version
 * @param {string[]} required
 * @param {(name: string) => Promise<RegistryMetadata>} [loadMetadata]
 * @returns {Promise<string[]>} the `name@range` requirements no published version satisfies.
 */
async function unresolvedClosure(cache, version, required, loadMetadata) {
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {string[]} */
  const unresolved = []
  /** @type {Array<[string, string]>} */
  const pending = [
    ['@deepseek-ai/dsh', version],
    ...required
      .filter((name) => name !== '@deepseek-ai/dsh')
      .map((name) => /** @type {[string, string]} */ ([name, `^${version}`])),
  ]

  while (pending.length > 0) {
    const [name, wanted] = pending.pop()
    const key = `${name}@${wanted}`
    if (seen.has(key)) continue
    seen.add(key)

    const metadata = cache.get(name) ?? await load(name, loadMetadata)
    cache.set(name, metadata)
    const published = Object.keys(metadata.versions)
    const resolved = validRange(wanted) === null ? null : maxSatisfying(published, wanted)
    if (resolved === null) {
      unresolved.push(key)
      continue
    }

    const manifest = metadata.versions[resolved]
    for (const [dependency, dependencyRange] of Object.entries(manifest.dependencies ?? {})) {
      if (!dependency.startsWith('@deepseek-ai/')) continue
      pending.push([dependency, dependencyRange])
    }
  }
  return unresolved.sort()
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
