/**
 * Tool-call category vocabulary and the merged group-header label.
 *
 * A tool call declares its render intent through the presenter seam
 * (`ToolCallView` / `ToolResultView`); this module turns that declared view —
 * never a tool-name match at render time, except for the documented subagent
 * names — into one category of a closed vocabulary, and aggregates an ordered
 * run of calls into the single header a tool group shows. Pure: no session
 * events, no I/O, no theme beyond the words below.
 * @module codsh-bundle/src/tool-group
 */

import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'

/** The closed vocabulary a tool call classifies into. */
export type ToolCategory =
  | 'command'
  | 'edit'
  | 'search'
  | 'read'
  | 'web-search'
  | 'web-fetch'
  | 'subagent'
  | 'other'

/** The three word forms one category contributes to a merged label. */
export interface ToolCategoryWords {
  /** Past-tense verb, used once every member has settled. */
  past: string
  /** Present-tense verb, used while any member is still running. */
  present: string
  /** Noun for a count of one. */
  singular: string
  /** Noun for any other count. */
  plural: string
}

/**
 * The words each category contributes to a merged header, in first-appearance
 * order when a run mixes categories.
 */
export const TOOL_CATEGORY_WORDS: Record<ToolCategory, ToolCategoryWords> = {
  command: { past: 'Ran', present: 'Running', singular: 'command', plural: 'commands' },
  edit: { past: 'Edited', present: 'Editing', singular: 'file', plural: 'files' },
  search: { past: 'Searched', present: 'Searching', singular: 'pattern', plural: 'patterns' },
  read: { past: 'Read', present: 'Reading', singular: 'file', plural: 'files' },
  'web-search': { past: 'Searched the web', present: 'Searching the web', singular: 'search', plural: 'searches' },
  'web-fetch': { past: 'Fetched', present: 'Fetching', singular: 'page', plural: 'pages' },
  subagent: { past: 'Ran', present: 'Running', singular: 'subagent', plural: 'subagents' },
  other: { past: 'Used', present: 'Using', singular: 'tool', plural: 'tools' },
}

/** One call in a run, as the label builder sees it. */
export interface ToolGroupMember {
  category: ToolCategory
  /** Whether this member's call is still in flight. */
  running?: boolean
  /** Whether this member's call failed. */
  failed?: boolean
}

/**
 * Classify a tool call from its declared presentation view.
 *
 * The subagent names are the one documented exception to view-only
 * classification: the transcript already keys its child-session door off them.
 * @param name - the tool the model called; read only for the subagent door.
 * @param view - the presenter's declared call or result view, when one exists.
 * @returns the closed-vocabulary category; `other` for an absent or throwing view.
 */
export function toolCategory(name: string, view?: ToolCallView | ToolResultView | null): ToolCategory {
  if (name === 'subagent' || name === 'subagent_fork') return 'subagent'
  try {
    if (view === undefined || view === null) return 'other'
    switch (view.card) {
      case 'terminal':
        return 'command'
      case 'diff':
        return 'edit'
      case 'search':
        return 'search'
      case 'read':
        return 'read'
      case 'web':
        return view.kind === 'fetch' ? 'web-fetch' : 'web-search'
      default:
        return 'other'
    }
  } catch {
    // A presenter whose view throws degrades this call; it never breaks the label.
    return 'other'
  }
}

/**
 * One merged header label for an ordered run of calls.
 *
 * Categories appear in first-appearance order with their counts; the verb is
 * present tense while any member is still in flight, past once all settle; a
 * trailing segment names the failure count when any member failed.
 * @param members - the run in call order.
 * @returns the label, or `''` for an empty run.
 */
export function toolGroupLabel(members: readonly ToolGroupMember[]): string {
  if (members.length === 0) return ''
  const running = members.some(member => member.running === true)
  const order: ToolCategory[] = []
  const counts = new Map<ToolCategory, number>()
  for (const member of members) {
    const seen = counts.get(member.category)
    if (seen === undefined) order.push(member.category)
    counts.set(member.category, (seen ?? 0) + 1)
  }
  const parts = order.map((category) => {
    const words = TOOL_CATEGORY_WORDS[category]
    const count = counts.get(category) ?? 0
    const verb = running ? words.present : words.past
    return `${verb} ${String(count)} ${count === 1 ? words.singular : words.plural}`
  })
  const failed = members.filter(member => member.failed === true).length
  return failed === 0 ? parts.join(', ') : `${parts.join(', ')} · ${String(failed)} failed`
}
