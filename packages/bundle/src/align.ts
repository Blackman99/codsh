/**
 * Alignment Gate: cheap pre-action checks against the sealed Mission Contract.
 *
 * An action must name which requirement / ticket it supports. Writes that hit
 * immutable control-plane memory, or that support nothing while a sealed
 * contract is live, are refused. This is deterministic — not a model reminder.
 * @module codsh-bundle/src/align
 */

import { classifyPath, classifySpecHeading, writeAllowed } from './mission.ts'
import type { MissionContract } from './mission.ts'
import type { PlanTicket } from './plan.ts'

/** What the executor claims an action is for. */
export interface ActionDescriptor {
  /** Short action label, e.g. `modify src/x.ts` or a tool summary. */
  action: string
  /** Active ticket title / id, when known. */
  task?: string
  /** Requirement ids this action claims to support (`REQ-001`). */
  supports?: string[]
  /** Primary path being written, when known. */
  path?: string
  /** Tool name, when this came from an approval / tool call. */
  toolName?: string
  /** Markdown heading targeted inside a spec, when known. */
  section?: string
}

/** Gate decision for one action. */
export interface AlignVerdict {
  /** Whether the controller should allow the action. */
  allow: boolean
  /** First matched requirement id, if any. */
  supportsRequirement: string | null
  /** Task id/title the action mapped to, if any. */
  taskId: string | null
  /** True when the action hits an excluded / immutable boundary. */
  violatesScope: boolean
  /** Human-readable reasons (deny or caution). */
  reasons: string[]
}

/** Options the ship runner passes when a contract is sealed. */
export interface AlignOptions {
  /** Sealed Mission Contract; absent means the gate is inactive. */
  contract?: MissionContract
  /** Current unticked ticket, when landing. */
  activeTicket?: PlanTicket
  /** True after Gate 1 Confirm. */
  sealed?: boolean
}

/**
 * Align one action against the sealed contract and active ticket.
 *
 * Fail closed on immutable paths/sections and on land actions that name no
 * requirement while a contract exists. Read-ish tools without a path still
 * pass when they are not writes.
 */
export function alignAction(descriptor: ActionDescriptor, opts: AlignOptions = {}): AlignVerdict {
  const reasons: string[] = []
  const contract = opts.contract
  const sealed = opts.sealed === true || contract !== undefined
  let supportsRequirement: string | null = null
  let taskId: string | null = descriptor.task ?? null
  let violatesScope = false

  if (descriptor.path !== undefined) {
    const tier = classifyPath(descriptor.path)
    if (!writeAllowed(tier)) {
      violatesScope = true
      reasons.push(`path ${descriptor.path} is ${tier}`)
    }
  }

  if (sealed && descriptor.section !== undefined) {
    const tier = classifySpecHeading(descriptor.section)
    if (!writeAllowed(tier)) {
      violatesScope = true
      reasons.push(`section ${descriptor.section} is ${tier}`)
    }
  }

  if (contract !== undefined) {
    for (const neg of contract.excluded) {
      if (mentions(descriptor, neg.text)) {
        violatesScope = true
        reasons.push(`hits excluded ${neg.id}: ${neg.text}`)
      }
    }

    const supports = descriptor.supports ?? []
    for (const id of supports) {
      const req = contract.requirements.find(item => item.id === id)
      if (req === undefined) {
        reasons.push(`unknown requirement ${id}`)
        continue
      }
      supportsRequirement ??= req.id
    }

    if (opts.activeTicket !== undefined) {
      taskId ??= opts.activeTicket.title
      const track = opts.activeTicket.trackIds ?? []
      if (track.length > 0 && supports.length > 0) {
        const allowed = new Set(
          contract.requirements
            .filter(req => req.track?.some(n => track.includes(n)))
            .map(req => req.id),
        )
        for (const id of supports) {
          if (!allowed.has(id)) {
            reasons.push(`${id} is outside active ticket Track: ${track.join(',')}`)
            violatesScope = true
          }
        }
      }
    }

    const looksLikeWrite = descriptor.path !== undefined
      || /\b(modify|write|edit|create|delete|overwrite)\b/iu.test(descriptor.action)
    if (looksLikeWrite && supports.length === 0 && opts.activeTicket !== undefined) {
      reasons.push('write has no requirement mapping (supports)')
      violatesScope = true
    }
  }

  const allow = !violatesScope && reasons.every(r => !r.startsWith('unknown requirement'))
  // Unknown REQ alone should deny.
  const unknown = reasons.some(r => r.startsWith('unknown requirement'))
  return {
    allow: allow && !unknown,
    supportsRequirement,
    taskId,
    violatesScope,
    reasons,
  }
}

function mentions(descriptor: ActionDescriptor, text: string): boolean {
  const needle = text.toLowerCase()
  if (needle.length < 8) return false
  const hay = `${descriptor.action} ${descriptor.path ?? ''} ${descriptor.section ?? ''}`.toLowerCase()
  // Use a distinctive token from the exclusion (first 4+ letter word).
  const token = needle.split(/\W+/u).find(part => part.length >= 6)
  return token !== undefined && hay.includes(token)
}
