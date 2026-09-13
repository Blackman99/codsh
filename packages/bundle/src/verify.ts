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
 * Parse evidence blocks from a ship spec's Verification / Baseline sections.
 *
 * Looks for fenced commands, `exit 0` / `exit code 0`, and `ACC-xxx` mentions.
 */
export function parseEvidenceFromSpec(markdown: string): Evidence[] {
  const evidence: Evidence[] = []
  let inside = false
  let pendingCommand: string | undefined
  for (const raw of markdown.split(/\r\n|[\r\n]/u)) {
    if (/^#{1,6}\s+(verification|baseline|proof)\b/iu.test(raw)) {
      inside = true
      continue
    }
    if (inside && /^#{1,6}\s+/u.test(raw) && !/^#{1,6}\s+(verification|baseline|proof)\b/iu.test(raw)) {
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
    const item: Evidence = {}
    if (inline !== null) item.command = inline[1]
    if (exit !== null) item.exitCode = Number(exit[1])
    if (acc !== null) item.acceptanceId = acc[1]
    if (/\b(passed|ok|green|exits?\s+0)\b/iu.test(raw) && item.exitCode === undefined) {
      item.exitCode = 0
    }
    evidence.push(item)
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
    const hit = evidence.find(item => evidenceMatches(criterion, item))
    if (hit === undefined) {
      missing.push(criterion.id)
      notes.push(`${criterion.id}: no evidence`)
      continue
    }
    if (hit.exitCode !== undefined && hit.exitCode !== 0) {
      missing.push(criterion.id)
      notes.push(`${criterion.id}: evidence exit ${String(hit.exitCode)}`)
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
export function reconcilePlanTicks(markdown: string, verdict: VerifyVerdict): string | undefined {
  if (verdict.satisfied || verdict.missing.length === 0) return undefined
  const plan = parsePlan(markdown)
  if (plan.tickets.every(ticket => !ticket.done)) return undefined
  // Only untick when the mission acceptance set is incomplete — world progress
  // that already has evidence can stay; this is a coarse safety net.
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
