/**
 * Mission Contract: the sealed, machine-checkable control-plane memory for
 * a `/ship` run.
 *
 * Gate 1 Confirm compiles this from the Markdown spec (Main Track +
 * acceptance + Out of Scope). The human-readable spec stays the projection;
 * the runner owns the JSON and refuses to let a later Main Track rewrite
 * replace the sealed snapshot. Phase A stops at compile / seal / load /
 * immutability — Alignment Gate, Drift Detector, and independent Verifier
 * are later phases.
 * @module codsh-bundle/src/mission
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseMainTrack } from './plan.ts'

/** One positive requirement compiled from a Track-N decision (or Idea). */
export interface MissionRequirement {
  /** Stable id, e.g. `REQ-001`. */
  id: string
  /** Decision text. */
  text: string
  /** Track-N numbers this requirement aliases, when present. */
  track?: number[]
}

/** One negative boundary compiled from Out of Scope. */
export interface MissionExcluded {
  /** Stable id, e.g. `NEG-001`. */
  id: string
  /** Boundary text. */
  text: string
}

/** One acceptance criterion with an optional proving command. */
export interface MissionAcceptance {
  /** Stable id, e.g. `ACC-001`. */
  id: string
  /** Criterion text as written in the spec. */
  text: string
  /** Exact command that proves the criterion, when named. */
  command?: string
  /** What counts as passing, when named. */
  expect?: string
}

/** Authority tiers the control plane enforces after seal. */
export interface MissionAuthority {
  user_requirements: 'immutable'
  plan: 'mutable'
  world: 'mutable'
}

/** Sealed Mission Contract persisted beside the scratch spec. */
export interface MissionContract {
  /** Schema version. */
  version: 1
  /** Contract id (usually the ship slug). */
  id: string
  /** One-sentence objective from Main Track Idea (or Requirement). */
  objective: string
  /** Positive requirements. */
  requirements: MissionRequirement[]
  /** Negative boundaries. */
  excluded: MissionExcluded[]
  /** Acceptance criteria with proof commands when present. */
  acceptance: MissionAcceptance[]
  /** Write authority after seal. */
  authority: MissionAuthority
  /** ISO timestamp when Confirm sealed this contract. */
  sealedAt: string
  /** Exact Main Track body sealed with the contract (no heading). */
  mainTrackMarkdown: string
}

/** Default authority block every sealed contract carries. */
export const MISSION_AUTHORITY: MissionAuthority = {
  user_requirements: 'immutable',
  plan: 'mutable',
  world: 'mutable',
}

/** A `**Track-N.**` decision line inside Main Track. */
const TRACK_LINE = /^\*\*Track-(\d+)\.\*\*\s*(.+)$/iu

/** Idea line inside Main Track. */
const IDEA_LINE = /^\*\*Idea\.\*\*\s*(.+)$/imu

/** Out of Scope heading or bold lead-in. */
const OUT_OF_SCOPE_HEADING = /^(?:#{1,6}\s+out\s+of\s+scope\b|\*\*Out of Scope\.\*\*)(.*)$/imu

/** Bullet under Out of Scope. */
const BULLET = /^\s*[-*]\s+(.+)$/u

/** Numbered acceptance criterion. */
const ACCEPTANCE_ITEM = /^\s*(\d+)\.\s+(.+)$/u

/** Command named in backticks inside an acceptance line. */
const BACKTICK_COMMAND = /`([^`]+)`/u

/** Exit / expect phrase after a command. */
const EXPECT_PHRASE = /\b(?:exits?\s+0|exit\s+code\s+0|prints?\s+.+|zero new failures[^.]*|passes?)\b/iu

/**
 * Compile a Mission Contract from a `/ship` spec's Markdown.
 *
 * Main Track decisions become REQ-* (Track-N kept as aliases). Out of Scope
 * becomes NEG-*. Numbered acceptance criteria become ACC-* with optional
 * proof commands. The runner calls this at Confirm; the model does not
 * hand-author the JSON.
 * @param markdown - full spec file contents.
 * @param opts - optional id/slug and sealedAt override (tests).
 */
export function compileMissionContract(
  markdown: string,
  opts: { id?: string; sealedAt?: string } = {},
): MissionContract {
  const trackBody = parseMainTrack(markdown) ?? ''
  const objective = parseIdea(trackBody) ?? parseRequirementLine(markdown) ?? ''
  const requirements = parseTrackRequirements(trackBody)
  if (requirements.length === 0 && objective !== '') {
    requirements.push({ id: 'REQ-001', text: objective })
  }
  const excluded = parseExcluded(markdown, trackBody)
  const acceptance = parseAcceptance(markdown)
  const id = opts.id ?? 'mission'
  return {
    version: 1,
    id,
    objective,
    requirements,
    excluded,
    acceptance,
    authority: { ...MISSION_AUTHORITY },
    sealedAt: opts.sealedAt ?? new Date().toISOString(),
    mainTrackMarkdown: trackBody.trim(),
  }
}

/** JSON serialize with a trailing newline for disk writes. */
export function serializeMissionContract(contract: MissionContract): string {
  return `${JSON.stringify(contract, null, 2)}\n`
}

/** Parse a Mission Contract JSON document. */
export function parseMissionContract(json: string): MissionContract {
  const value = JSON.parse(json) as MissionContract
  if (value?.version !== 1 || typeof value.id !== 'string') {
    throw new Error('invalid mission contract')
  }
  return value
}

/**
 * Disk path for the sealed contract under `.scratch/<slug>/`.
 * @param cwd - workspace root.
 * @param slug - ship slug (from Branch or spec basename).
 */
export function missionContractPath(cwd: string, slug: string): string {
  return join(cwd, '.scratch', slug, 'mission.contract.json')
}

/**
 * Write the sealed contract to disk, creating `.scratch/<slug>/` as needed.
 * @returns the path written.
 */
export function writeMissionContract(cwd: string, slug: string, contract: MissionContract): string {
  const path = missionContractPath(cwd, slug)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeMissionContract(contract))
  return path
}

/**
 * Compact summary prepended on later `/ship` turns so the model sees REQ/NEG
 * ids without dumping the full JSON into context.
 */
export function missionContractSummary(contract: MissionContract, path?: string): string {
  const lines = [
    '## Mission Contract',
    '',
    'Sealed control-plane memory (immutable after Gate 1 Confirm). Do not rewrite `## Main Track` or this contract; a needed contradiction is a blocker. Progress (Status, checkboxes, proof logs) remains writable.',
  ]
  if (path !== undefined) lines.push(`Path: \`${path}\``)
  lines.push(`Objective: ${contract.objective || '(none)'}`)
  if (contract.requirements.length > 0) {
    lines.push('Requirements:')
    for (const req of contract.requirements) {
      const track = req.track?.length ? ` (Track: ${req.track.join(',')})` : ''
      lines.push(`- ${req.id}${track}: ${req.text}`)
    }
  }
  if (contract.excluded.length > 0) {
    lines.push('Excluded:')
    for (const neg of contract.excluded) {
      lines.push(`- ${neg.id}: ${neg.text}`)
    }
  }
  if (contract.acceptance.length > 0) {
    lines.push('Acceptance:')
    for (const acc of contract.acceptance) {
      const cmd = acc.command === undefined ? '' : ` — \`${acc.command}\``
      lines.push(`- ${acc.id}: ${acc.text}${cmd}`)
    }
  }
  return lines.join('\n')
}

/**
 * True when the live spec's Main Track body no longer matches the sealed
 * snapshot — the runner must keep the seal and ignore the rewrite.
 */
export function mainTrackDrifted(sealedBody: string, liveMarkdown: string): boolean {
  const live = (parseMainTrack(liveMarkdown) ?? '').trim()
  return live !== '' && live !== sealedBody.trim()
}

/** Slug from `Branch: ship/<slug>` or the spec file basename. */
export function slugFromSpec(markdown: string, specPath?: string): string {
  const branch = /^Branch:\s*ship\/(\S+)/imu.exec(markdown)?.[1]
  if (branch !== undefined && branch !== '') return branch
  if (specPath !== undefined) {
    const base = basename(specPath, '.md')
    if (base !== '') return base
  }
  return 'mission'
}

function parseIdea(trackBody: string): string | undefined {
  const match = IDEA_LINE.exec(trackBody)
  const text = match?.[1]?.trim()
  return text === undefined || text === '' ? undefined : text
}

function parseRequirementLine(markdown: string): string | undefined {
  const match = /^##\s+Requirement\s*$/imu.exec(markdown)
  if (match === null || match.index === undefined) return undefined
  const after = markdown.slice(match.index + match[0].length)
  const lines = after.split(/\r\n|[\r\n]/u)
  for (const line of lines) {
    if (/^#{1,6}\s+/u.test(line)) break
    const text = line.trim()
    if (text !== '') return text
  }
  return undefined
}

function parseTrackRequirements(trackBody: string): MissionRequirement[] {
  const requirements: MissionRequirement[] = []
  for (const line of trackBody.split(/\r\n|[\r\n]/u)) {
    const match = TRACK_LINE.exec(line.trim())
    if (match === null) continue
    const n = Number(match[1])
    const text = (match[2] ?? '').trim()
    if (text === '') continue
    requirements.push({
      id: `REQ-${String(requirements.length + 1).padStart(3, '0')}`,
      text,
      track: [n],
    })
  }
  return requirements
}

function parseExcluded(markdown: string, trackBody: string): MissionExcluded[] {
  const fromTrack = excludedFromTrack(trackBody)
  if (fromTrack.length > 0) return fromTrack
  return excludedFromSection(markdown)
}

function excludedFromTrack(trackBody: string): MissionExcluded[] {
  const excluded: MissionExcluded[] = []
  let inside = false
  for (const raw of trackBody.split(/\r\n|[\r\n]/u)) {
    const line = raw.trim()
    const head = OUT_OF_SCOPE_HEADING.exec(line)
    if (head !== null) {
      inside = true
      const rest = (head[1] ?? '').replace(/^\s*[—–:-]\s*/u, '').trim()
      if (rest !== '') {
        excluded.push({ id: `NEG-${String(excluded.length + 1).padStart(3, '0')}`, text: rest })
      }
      continue
    }
    if (!inside) continue
    if (/^\*\*Track-\d+\.\*\*/iu.test(line) || IDEA_LINE.test(line)) {
      inside = false
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet !== null) {
      const text = (bullet[1] ?? '').trim()
      if (text !== '') {
        excluded.push({ id: `NEG-${String(excluded.length + 1).padStart(3, '0')}`, text })
      }
    }
  }
  return excluded
}

function excludedFromSection(markdown: string): MissionExcluded[] {
  const excluded: MissionExcluded[] = []
  let inside = false
  for (const raw of markdown.split(/\r\n|[\r\n]/u)) {
    if (/^#{1,6}\s+out\s+of\s+scope\b/iu.test(raw)) {
      inside = true
      continue
    }
    if (inside && /^#{1,6}\s+/u.test(raw)) break
    if (!inside) continue
    const bullet = BULLET.exec(raw)
    if (bullet === null) continue
    const text = (bullet[1] ?? '').trim()
    if (text === '') continue
    excluded.push({ id: `NEG-${String(excluded.length + 1).padStart(3, '0')}`, text })
  }
  return excluded
}

function parseAcceptance(markdown: string): MissionAcceptance[] {
  const acceptance: MissionAcceptance[] = []
  let inside = false
  for (const raw of markdown.split(/\r\n|[\r\n]/u)) {
    if (/^#{1,6}\s+acceptance\s+criteria\b/iu.test(raw)) {
      inside = true
      continue
    }
    if (inside && /^#{1,6}\s+/u.test(raw)) break
    if (!inside) continue
    const item = ACCEPTANCE_ITEM.exec(raw)
    if (item === null) continue
    const text = (item[2] ?? '').trim()
    if (text === '') continue
    const command = BACKTICK_COMMAND.exec(text)?.[1]
    const expect = EXPECT_PHRASE.exec(text)?.[0]
    acceptance.push({
      id: `ACC-${String(acceptance.length + 1).padStart(3, '0')}`,
      text,
      ...(command === undefined ? {} : { command }),
      ...(expect === undefined ? {} : { expect }),
    })
  }
  return acceptance
}
