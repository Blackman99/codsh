import { compare, maxSatisfying, valid, validRange } from 'semver'

/** Compare two valid SemVer release strings. */
export const compareVersions = compare

/**
 * Pick the harness target from registry metadata.
 *
 * The promoted `latest` tag is an explicit opt-in to a new release line. An
 * untagged version is eligible only when a lockfile-free install of the current
 * range could resolve it; this keeps catching same-core RC drift without
 * silently opting into an unrelated alpha line.
 * @param {{ versions: Record<string, unknown>, 'dist-tags': Record<string, string> }} metadata - npm registry metadata.
 * @param {string} currentRange - current @deepseek-ai/dsh manifest range.
 * @returns {string} selected harness version.
 */
export function selectDshTarget(metadata, currentRange) {
  const range = validRange(currentRange)
  if (range === null) throw new Error(`invalid @deepseek-ai/dsh range: ${currentRange}`)

  const versions = Object.keys(metadata.versions)
  if (versions.length === 0) throw new Error('@deepseek-ai/dsh registry has no versions')
  const latest = metadata['dist-tags'].latest
  if (valid(latest) === null || !versions.includes(latest)) {
    throw new Error(`invalid @deepseek-ai/dsh latest tag: ${latest}`)
  }

  const installable = maxSatisfying(versions, range)
  return installable !== null && compare(latest, installable) < 0 ? installable : latest
}
