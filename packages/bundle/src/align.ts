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

  const mutating = isMutatingTool(descriptor.toolName)
    || /\b(modify|write|edit|create|delete|overwrite)\b/iu.test(descriptor.action)

  // Immutable paths/sections only bind writes — reading mission.contract.json
  // is required by land prompts.
  if (mutating && descriptor.path !== undefined) {
    const tier = classifyPath(descriptor.path)
    if (!writeAllowed(tier)) {
      violatesScope = true
      reasons.push(`path ${descriptor.path} is ${tier}`)
    }
  }

  if (mutating && sealed && descriptor.section !== undefined) {
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

    // Path alone is not a write — reads carry paths too. Only mutating tools
    // (or explicitly write-shaped actions) need a requirement mapping on land.
    const looksLikeWrite = isMutatingTool(descriptor.toolName)
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

/**
 * True when the tool name is a filesystem / edit mutation.
 * Used so Alignment Gate does not demand `supports` for reads.
 */
export function isMutatingTool(toolName: string | undefined): boolean {
  if (toolName === undefined || toolName === '') return false
  const n = toolName.toLowerCase().replace(/_/gu, '-')
  return /(?:^|-)(write|edit|create|delete|remove|move|rename|apply|patch|str-replace)(?:-|$)/u.test(n)
    || n.includes('str-replace')
    || n.includes('apply-patch')
}

/**
 * Build an ActionDescriptor from a tool call. When the model omitted
 * `supports`, land turns inherit the Active Ticket's Track→REQ mapping so
 * legitimate ticket work is not fail-closed as "unmapped".
 */
export function descriptorFromToolCall(
  toolName: string,
  args: unknown,
  opts: { supports?: string[]; task?: string } = {},
): ActionDescriptor {
  const path = toolPath(args)
  const fromArgs = toolSupports(args)
  const supports = fromArgs ?? opts.supports
  const task = toolTask(args) ?? opts.task
  const action = path === undefined ? toolName : `${toolName} ${path}`
  return {
    action,
    toolName,
    ...(path === undefined ? {} : { path }),
    ...(supports === undefined || supports.length === 0 ? {} : { supports }),
    ...(task === undefined ? {} : { task }),
  }
}


/** Extract the written body from write/edit tool args, when present. */
export function toolWriteContent(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  for (const key of ['content', 'contents', 'file_text', 'fileText', 'new_string', 'newString']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** old_string for edit tools. */
export function toolOldString(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  for (const key of ['old_string', 'oldString']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Propose the post-edit markdown for a spec write/edit.
 * Returns undefined when the call does not carry enough content to compare.
 */
export function proposeSpecMarkdown(args: unknown, current: string | undefined): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const content = record.content ?? record.contents ?? record.file_text ?? record.fileText
  if (typeof content === 'string') return content
  const oldString = toolOldString(args)
  const newString = typeof record.new_string === 'string'
    ? record.new_string
    : typeof record.newString === 'string'
      ? record.newString
      : undefined
  if (oldString !== undefined && newString !== undefined && current !== undefined) {
    if (!current.includes(oldString)) return undefined
    return current.replace(oldString, newString)
  }
  return undefined
}

function toolPath(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  for (const key of ['file_path', 'filePath', 'path', 'target', 'filename']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function toolSupports(args: unknown): string[] | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const raw = record.supports ?? record.requirement_ids ?? record.requirementIds
  if (Array.isArray(raw)) {
    const ids = raw.filter((item): item is string => typeof item === 'string' && item !== '')
    return ids.length === 0 ? undefined : ids
  }
  if (typeof raw === 'string' && raw !== '') {
    const ids = raw.split(/[\s,]+/u).filter(Boolean)
    return ids.length === 0 ? undefined : ids
  }
  return undefined
}

function toolTask(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  for (const key of ['task', 'ticket', 'active_ticket', 'activeTicket']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}


function mentions(descriptor: ActionDescriptor, text: string): boolean {
  const needle = text.toLowerCase()
  if (needle.length < 8) return false
  const hay = `${descriptor.action} ${descriptor.path ?? ''} ${descriptor.section ?? ''}`.toLowerCase()
  // Use a distinctive token from the exclusion (first 4+ letter word).
  const token = needle.split(/\W+/u).find(part => part.length >= 6)
  return token !== undefined && hay.includes(token)
}
