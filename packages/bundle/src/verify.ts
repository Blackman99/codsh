/**
 * Independent Verifier: completion needs evidence, not the executor's word.
 *
 * Evidence is parsed from the spec's Verification / proof logs. Acceptance
 * criteria on the sealed Mission Contract are satisfied only when matching
 * evidence shows a passing command. No evidence ≠ completed.
 * @module codsh-bundle/src/verify
 */

import type { MissionAcceptance, MissionContract } from './mission.ts'
import { parsePlan } from './plan.ts'

/** One piece of recorded evidence. */
export interface Evidence {
  /** Acceptance id when known (`ACC-001`). */
  acceptanceId?: string
  /** Command that was run. */
  command?: string
  /** Process exit code, when recorded. */
  exitCode?: number
  /** Snippet of output / note. */
  output?: string
  /** Related paths. */
  paths?: string[]
}

/** Verifier decision for the sealed acceptance list. */
export interface VerifyVerdict {
  /** True only when every acceptance criterion has passing evidence. */
  satisfied: boolean
  /** Acceptance ids still missing evidence. */
  missing: string[]
  /** Acceptance ids with passing evidence. */
  matched: string[]
  /** Per-criterion notes. */
  notes: string[]
}

/**
 * Parse completion evidence from a ship spec's Verification / Proof sections.
 *
 * Baseline is excluded: it records pre-land results and must not satisfy (or
 * block) final acceptance via `find()` first-match against an older exit code.
 */
export function parseEvidenceFromSpec(markdown: string): Evidence[] {
  const evidence: Evidence[] = []
  let inside = false
  let pendingCommand: string | undefined
  for (const raw of markdown.split(/\r\n|[\r\n]/u)) {
    if (/^#{1,6}\s+(verification|proof)\b/iu.test(raw)) {
      inside = true
      continue
    }
    if (inside && /^#{1,6}\s+/u.test(raw) && !/^#{1,6}\s+(verification|proof)\b/iu.test(raw)) {
      inside = false
    }
    if (!inside) continue

    const fence = /^```(?:bash|sh|shell|zsh)?\s*$/iu.test(raw)
    if (fence) {
      pendingCommand = pendingCommand === undefined ? '' : undefined
      continue
    }
    if (pendingCommand !== undefined) {
      if (raw.startsWith('```')) {
        if (pendingCommand.trim() !== '') {
          evidence.push({ command: pendingCommand.trim() })
        }
        pendingCommand = undefined
      } else {
        pendingCommand = pendingCommand === '' ? raw : `${pendingCommand}\n${raw}`
      }
      continue
    }

    const inline = /`([^`]+)`/u.exec(raw)
    const exit = /\bexit(?:\s+code)?\s+(\d+)\b/iu.exec(raw)
    const acc = /\b(ACC-\d+)\b/iu.exec(raw)
    if (inline === null && exit === null && acc === null) continue
    const command = inline?.[1]
    const acceptanceId = acc?.[1]
    let exitCode = exit !== null ? Number(exit[1]) : undefined
    if (exitCode === undefined && /\b(passed|ok|green|exits?\s+0)\b/iu.test(raw)) exitCode = 0
    evidence.push({
      ...(command === undefined ? {} : { command }),
      ...(acceptanceId === undefined ? {} : { acceptanceId }),
      ...(exitCode === undefined ? {} : { exitCode }),
    })
  }
  return evidence
}

/**
 * Decide whether sealed acceptance criteria are satisfied by evidence.
 */
export function verifyAcceptance(
  contract: MissionContract,
  evidence: readonly Evidence[],
): VerifyVerdict {
  const missing: string[] = []
  const matched: string[] = []
  const notes: string[] = []

  for (const criterion of contract.acceptance) {
    // Last match wins: later Verification lines are the final proof, not an
    // earlier duplicate command in the same section.
    const hit = [...evidence].reverse().find(item => evidenceMatches(criterion, item))
    if (hit === undefined) {
      missing.push(criterion.id)
      notes.push(`${criterion.id}: no evidence`)
      continue
    }
    // Bare ACC ids without a recorded successful exit are not evidence.
    if (hit.exitCode !== 0) {
      missing.push(criterion.id)
      notes.push(
        hit.exitCode === undefined
          ? `${criterion.id}: evidence lacks successful exit code`
          : `${criterion.id}: evidence exit ${String(hit.exitCode)}`,
      )
      continue
    }
    matched.push(criterion.id)
    notes.push(`${criterion.id}: satisfied`)
  }

  // Specs with no compiled acceptance cannot claim mission completion via this gate.
  const satisfied = contract.acceptance.length > 0 && missing.length === 0
  return { satisfied, missing, matched, notes }
}

/**
 * If plan checkboxes claim done but acceptance evidence is incomplete, clear
 * the premature ticks so the executor cannot self-certify completion.
 * @returns updated markdown, or undefined when no change is needed.
 */
export function reconcilePlanTicks(
  markdown: string,
  verdict: VerifyVerdict,
  evidence: readonly Evidence[] = parseEvidenceFromSpec(markdown),
): string | undefined {
  if (verdict.satisfied || verdict.missing.length === 0) return undefined
  const plan = parsePlan(markdown)
  if (plan.tickets.every(ticket => !ticket.done)) return undefined
  // Global ACC incompleteness must not wipe ticket progress. Only clear
  // premature ticks when the plan claims done with ZERO acceptance evidence.
  if (evidence.length > 0) return undefined
  if (!markdown.includes('## Plan')) return undefined
  const lines = markdown.split(/\r\n|[\r\n]/u)
  let inside = false
  let changed = false
  const out = lines.map((line) => {
    if (/^#{1,6}\s+plan\s*$/iu.test(line)) {
      inside = true
      return line
    }
    if (inside && /^#{1,6}\s+/u.test(line)) {
      inside = false
      return line
    }
    if (!inside) return line
    if (/^\s*[-*]\s+\[[xX]\]\s+/u.test(line)) {
      changed = true
      return line.replace(/\[[xX]\]/u, '[ ]')
    }
    return line
  })
  return changed ? `${out.join('\n').replace(/\n+$/u, '')}\n` : undefined
}

function evidenceMatches(criterion: MissionAcceptance, item: Evidence): boolean {
  if (item.acceptanceId !== undefined && item.acceptanceId === criterion.id) return true
  if (criterion.command !== undefined && item.command !== undefined) {
    return item.command.includes(criterion.command) || criterion.command.includes(item.command)
  }
  if (criterion.command !== undefined && item.output !== undefined) {
    return item.output.includes(criterion.command)
  }
  return false
}
