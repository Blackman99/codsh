/**
 * Drift Detector: compare sealed Mission Contract, current plan, and recent
 * actions for goal drift. Cheap, deterministic heuristics — not a second planner.
 * @module codsh-bundle/src/drift
 */

import type { ActionDescriptor } from './align.ts'
import type { MissionContract } from './mission.ts'
import type { Plan } from './plan.ts'

/** One drift scan result. */
export interface DriftReport {
  /** 0..1 score; >= 0.4 is worth flashing, >= 0.7 should block land. */
  driftScore: number
  /** Suspected drift items for the controller / UI. */
  suspected: string[]
}

/** Inputs for one drift scan. */
export interface DriftInput {
  contract: MissionContract
  plan: Plan
  recentActions?: readonly ActionDescriptor[]
}

/**
 * Score drift between the sealed mission, the live plan, and recent actions.
 */
export function detectDrift(input: DriftInput): DriftReport {
  const suspected: string[] = []
  let score = 0

  for (const ticket of input.plan.tickets) {
    if (ticket.done) continue
    if (ticket.trackIds === undefined || ticket.trackIds.length === 0) {
      suspected.push(`ticket "${ticket.title}" has no Track mapping`)
      score += 0.15
    }
  }

  for (const req of input.contract.requirements) {
    const tracks = req.track ?? []
    if (tracks.length === 0) continue
    const covered = input.plan.tickets.some(ticket =>
      ticket.trackIds?.some(n => tracks.includes(n)))
    if (!covered) {
      suspected.push(`${req.id} has disappeared from current plan`)
      score += 0.25
    }
  }

  for (const neg of input.contract.excluded) {
    for (const ticket of input.plan.tickets) {
      const raw = `${ticket.title} ${ticket.raw ?? ''}`.toLowerCase()
      const token = neg.text.toLowerCase().split(/\W+/u).find(part => part.length >= 6)
      if (token !== undefined && raw.includes(token)) {
        suspected.push(`ticket "${ticket.title}" may violate ${neg.id}`)
        score += 0.25
      }
    }
  }

  for (const action of input.recentActions ?? []) {
    if ((action.supports?.length ?? 0) === 0 && action.path !== undefined) {
      suspected.push(`action "${action.action}" has no requirement mapping`)
      score += 0.1
    }
  }

  return {
    driftScore: Math.min(1, Math.round(score * 100) / 100),
    suspected,
  }
}

/** Thresholds the ship runner uses when acting on a report. */
export const DRIFT_FLASH_AT = 0.4
export const DRIFT_BLOCK_AT = 0.7
