/**
 * Adjacent `/ship` run snapshot: the frozen original requirement and sealed
 * Main Track for one bound spec. The sidecar is derived from the spec path,
 * never from markdown, and is immutable once sealed.
 * @module codsh-bundle/src/ship-snapshot
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import { parseAcceptanceCriteria, parseLegacyRequirement, parseMainTrack, parseOriginalRequirement, parseShipStatus } from './plan.ts'
import type { ShipStatus } from './plan.ts'

/** Versioned snapshot schema; unknown versions are corrupt, not upgraded in place. */
export const SHIP_SNAPSHOT_VERSION = 1

/** Durable freeze the runner writes beside a spec. */
export interface ShipSnapshot {
  version: typeof SHIP_SNAPSHOT_VERSION
  /** Filename of the adjacent spec, stable across checkout locations. */
  specPath: string
  /** Recovered original wording; empty only for a limited-history legacy spec. */
  originalRequirement: string
  /** True when a dedicated `## Original Requirement` (or first ledger) sealed it. */
  originalSealed: boolean
  /** Headed Main Track captured at Confirm or later. */
  mainTrack?: string
  /** True once Gate 1 Confirm (or a later status) froze the track. */
  trackSealed: boolean
  /** Acceptance criteria captured with the track, when present. */
  acceptanceCriteria?: string
  /** True when the snapshot was inferred, not a historical seal. */
  limitedHistory?: boolean
}

/** Why a snapshot or freeze check refused to continue. */
export interface ShipSnapshotError {
  error: string
}

const VERSION = SHIP_SNAPSHOT_VERSION

/** Statuses at or after Gate 1 Confirm, where the Main Track is freezeable. */
const CONFIRMED: ReadonlySet<ShipStatus> = new Set(['confirmed', 'planned', 'landing', 'shipped'])

/**
 * Adjacent sidecar for a spec: `widget.md` → `widget.ship.json`.
 * @param specPath - absolute spec path.
 */
export function snapshotPathFor(specPath: string): string {
  const absolute = resolve(specPath)
  const base = absolute.split(sep).pop() ?? absolute
  const stem = base.replace(/\.md$/iu, '')
  return join(dirname(absolute), `${stem}.ship.json`)
}

/** True when a status has passed Gate 1 Confirm. */
export function isConfirmedStatus(status: ShipStatus | undefined): boolean {
  return status !== undefined && CONFIRMED.has(status)
}

/** Head the compact track so later phases prepend a real section. */
export function headedMainTrack(body: string): string {
  return `## Main Track\n\n${body}`
}

/** Canonical comparison form: newlines and surrounding whitespace. */
export function freezeText(text: string): string {
  return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').trim()
}

/** Whether two frozen texts still match. */
export function freezeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return freezeText(a) === freezeText(b)
}

/**
 * Parse a snapshot file's JSON. Corrupt or wrong-version payloads are errors,
 * never a silent empty freeze.
 */
/** True when a read or parse refused the sidecar. */
export function isShipSnapshotError(
  value: ShipSnapshot | ShipSnapshotError | undefined,
): value is ShipSnapshotError {
  return value !== undefined && 'error' in value
}

export function parseShipSnapshot(raw: string): ShipSnapshot | ShipSnapshotError {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return { error: 'Ship snapshot is not valid JSON. Refusing to overwrite it; restore the sidecar or the spec.' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Ship snapshot is corrupt. Refusing to overwrite it; restore the sidecar or the spec.' }
  }
  const record = value as Record<string, unknown>
  if (record.version !== VERSION) {
    return { error: `Ship snapshot version ${String(record.version)} is unsupported. Refusing to overwrite it.` }
  }
  if (typeof record.specPath !== 'string' || record.specPath.trim() === '') {
    return { error: 'Ship snapshot is missing specPath. Refusing to overwrite it; restore the sidecar or the spec.' }
  }
  if (typeof record.originalRequirement !== 'string') {
    return { error: 'Ship snapshot is missing originalRequirement. Refusing to overwrite it; restore the sidecar or the spec.' }
  }
  if (typeof record.originalSealed !== 'boolean' || typeof record.trackSealed !== 'boolean') {
    return { error: 'Ship snapshot seal flags are corrupt. Refusing to overwrite it; restore the sidecar or the spec.' }
  }
  if (record.mainTrack !== undefined && typeof record.mainTrack !== 'string') {
    return { error: 'Ship snapshot mainTrack is corrupt. Refusing to overwrite it; restore the sidecar or the spec.' }
  }
  if (record.acceptanceCriteria !== undefined && typeof record.acceptanceCriteria !== 'string') {
    return { error: 'Ship snapshot acceptanceCriteria is corrupt. Refusing to overwrite it; restore the sidecar or the spec.' }
  }
  if (record.trackSealed === true && (typeof record.mainTrack !== 'string' || record.mainTrack.trim() === '')) {
    return { error: 'Ship snapshot has a sealed but missing Main Track. Stopped; restore the snapshot.' }
  }
  if (record.originalSealed === true && record.originalRequirement.trim() === '') {
    return { error: 'Ship snapshot has a sealed but empty original requirement. Stopped; restore the snapshot.' }
  }
  if (record.limitedHistory !== undefined && typeof record.limitedHistory !== 'boolean') {
    return { error: 'Ship snapshot limitedHistory is corrupt. Refusing to overwrite it; restore the sidecar or the spec.' }
  }
  return {
    version: VERSION,
    specPath: record.specPath,
    originalRequirement: record.originalRequirement,
    originalSealed: record.originalSealed,
    ...(record.mainTrack !== undefined ? { mainTrack: record.mainTrack } : {}),
    trackSealed: record.trackSealed,
    ...(record.acceptanceCriteria !== undefined ? { acceptanceCriteria: record.acceptanceCriteria } : {}),
    ...(record.limitedHistory === true ? { limitedHistory: true } : {}),
  }
}

/**
 * Read the sidecar beside a spec. Absent is undefined; unreadable or corrupt
 * is an error that must not be overwritten.
 */
export function readShipSnapshot(specPath: string): ShipSnapshot | undefined | ShipSnapshotError {
  const path = snapshotPathFor(specPath)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    return { error: `Ship snapshot is unreadable at ${path}. Refusing to overwrite it; restore the sidecar or the spec.` }
  }
  return parseShipSnapshot(raw)
}

/**
 * Atomically write the sidecar beside the spec. The path is always derived
 * from the spec, never from markdown contents.
 */
export function writeShipSnapshot(snapshot: ShipSnapshot, specPath: string): void {
  const path = snapshotPathFor(specPath)
  const body = `${JSON.stringify(snapshot, null, 2)}\n`
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* leftover tmp is not the sidecar */ }
    throw error
  }
}

/** Recovered original plus how it was obtained. */
export interface RecoveredOriginal {
  text: string
  sealed: boolean
  limitedHistory: boolean
  fromTrack: boolean
}

/**
 * Recover the original requirement: dedicated section, else typed idea, else
 * Main Track as limited history. Empty means nothing could be recovered.
 */
export function recoverOriginal(
  markdown: string,
  typedIdea: string,
): RecoveredOriginal | undefined {
  const section = parseOriginalRequirement(markdown)
  if (section !== undefined) return { text: section, sealed: true, limitedHistory: false, fromTrack: false }
  const legacy = parseLegacyRequirement(markdown)
  if (legacy !== undefined) return { text: legacy, sealed: false, limitedHistory: true, fromTrack: false }
  const typed = freezeText(typedIdea)
  if (typed !== '') return { text: typed, sealed: false, limitedHistory: true, fromTrack: false }
  const track = parseMainTrack(markdown)
  if (track !== undefined) return { text: track, sealed: false, limitedHistory: true, fromTrack: true }
  return undefined
}

/**
 * Build the first snapshot for a spec. Legacy files without a dedicated
 * original or seal are inferred with limitedHistory, never claimed as a
 * historical freeze.
 */
export function initialShipSnapshot(
  specPath: string,
  markdown: string,
  typedIdea: string,
): ShipSnapshot | undefined {
  const absolute = resolve(specPath)
  const recovered = recoverOriginal(markdown, typedIdea)
  const status = parseShipStatus(markdown)
  const track = parseMainTrack(markdown)
  const acceptance = parseAcceptanceCriteria(markdown)
  const sealTrack = isConfirmedStatus(status) && track !== undefined
  if (recovered === undefined && !sealTrack && status === undefined) return undefined
  return {
    version: VERSION,
    specPath: basename(absolute),
    originalRequirement: recovered?.text ?? '',
    originalSealed: recovered?.sealed === true,
    ...(track === undefined ? {} : { mainTrack: headedMainTrack(track) }),
    trackSealed: sealTrack,
    ...(acceptance === undefined ? {} : { acceptanceCriteria: acceptance }),
    ...(recovered?.limitedHistory === true || recovered === undefined ? { limitedHistory: true } : {}),
  }
}

/**
 * Seal Main Track (and acceptance criteria when present) at Confirm+.
 * Frozen fields are never rewritten; missing freezeable track is unchanged.
 */
export function sealTrackIfNeeded(snapshot: ShipSnapshot, markdown: string): ShipSnapshot {
  if (snapshot.trackSealed) return snapshot
  if (!isConfirmedStatus(parseShipStatus(markdown))) return snapshot
  const track = parseMainTrack(markdown)
  if (track === undefined) return snapshot
  const acceptance = parseAcceptanceCriteria(markdown)
  return {
    ...snapshot,
    mainTrack: headedMainTrack(track),
    trackSealed: true,
    ...(acceptance === undefined ? {} : { acceptanceCriteria: acceptance }),
  }
}

/**
 * Seal a dedicated original section when it first appears and matches, or
 * when this is the first ledger write of that section.
 */
export function sealOriginalIfNeeded(snapshot: ShipSnapshot, markdown: string): ShipSnapshot {
  if (snapshot.originalSealed) return snapshot
  const section = parseOriginalRequirement(markdown)
  if (section === undefined) return snapshot
  if (snapshot.originalRequirement !== '' && !freezeEqual(section, snapshot.originalRequirement)) return snapshot
  return {
    ...snapshot,
    originalRequirement: section,
    originalSealed: true,
  }
}

/**
 * Check a snapshot against the spec now on disk. Frozen original, Main Track,
 * and captured acceptance criteria must still be present and unchanged.
 * @returns an actionable error, or undefined when the freeze still holds.
 */
export function validateSnapshotAgainstSpec(
  snapshot: ShipSnapshot,
  specPath: string,
  markdown: string,
): string | undefined {
  if (snapshot.specPath !== basename(specPath) && resolve(snapshot.specPath) !== resolve(specPath)) {
    return `Ship snapshot is bound to ${snapshot.specPath}, not ${specPath}. Stopped; restore the approved spec or sidecar.`
  }
  if (snapshot.trackSealed && !isConfirmedStatus(parseShipStatus(markdown))) {
    return `Sealed ship spec regressed to an unconfirmed phase at ${posixPath(specPath)}. Stopped; restore the last approved phase.`
  }
  const original = parseOriginalRequirement(markdown)
  if (snapshot.originalSealed) {
    if (original === undefined) {
      return `Frozen ## Original Requirement is missing from ${posixPath(specPath)}. Stopped; restore the approved content.`
    }
    if (!freezeEqual(original, snapshot.originalRequirement)) {
      return `Frozen ## Original Requirement no longer matches ${posixPath(specPath)}. Stopped; restore the approved content.`
    }
  } else if (original !== undefined && snapshot.originalRequirement !== ''
    && !freezeEqual(original, snapshot.originalRequirement)) {
    return `Frozen ## Original Requirement no longer matches ${posixPath(specPath)}. Stopped; restore the approved content.`
  }
  if (snapshot.originalSealed && isConfirmedStatus(parseShipStatus(markdown)) && parseMainTrack(markdown) === undefined) {
    return `## Main Track is missing from confirmed spec ${posixPath(specPath)}. Stopped; restore the approved content.`
  }
  if (snapshot.trackSealed) {
    const track = parseMainTrack(markdown)
    const headed = track === undefined ? undefined : headedMainTrack(track)
    if (snapshot.mainTrack !== undefined) {
      if (track === undefined) {
        return `Frozen ## Main Track is missing from ${posixPath(specPath)}. Stopped; restore the approved content.`
      }
      if (!freezeEqual(headed, snapshot.mainTrack) && !freezeEqual(track, snapshot.mainTrack)) {
        return `Frozen ## Main Track no longer matches ${posixPath(specPath)}. Stopped; restore the approved content.`
      }
    }
    if (snapshot.acceptanceCriteria !== undefined) {
      const live = parseAcceptanceCriteria(markdown)
      if (live === undefined) {
        return `Frozen acceptance criteria are missing from ${posixPath(specPath)}. Stopped; restore the approved content.`
      }
      if (!freezeEqual(live, snapshot.acceptanceCriteria)) {
        return `Frozen acceptance criteria no longer match ${posixPath(specPath)}. A later edit must not weaken proofs. Stopped; restore the approved content.`
      }
    }
  }
  return undefined
}

/** Display a spec path with posix separators in user-facing flashes. */
function posixPath(path: string): string {
  return path.split(sep).join(posix.sep)
}
