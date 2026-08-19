/**
 * The status readout shown with the prompt: what model and composition answer,
 * where the session is, and how much context is left.
 *
 * Every figure is read from a durable projection or a logged fold rather than
 * tracked here, so a resumed session reports the same numbers it ended with.
 * @module codsh-bundle/src/status
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { truncate } from './theme.ts'
import type { Theme } from './theme.ts'

/** Everything one status line reports. */
export interface StatusFacts {
  /** Model route answering this session. */
  model: string
  /** Composed preset, absent when the deployment composes no roster. */
  preset?: string | undefined
  /** Permission preset name, absent when none is composed. */
  permission?: string | undefined
  /** Whether plan mode is holding. */
  planMode: boolean
  /** Session workspace. */
  cwd: string
  /** Checked-out branch, absent outside a repository. */
  branch?: string | undefined
  /** Cumulative provider usage, absent before the first reported request. */
  usage?: TokenUsageProjection | undefined
  /** Context occupancy, absent before the first reported request. */
  context?: ContextPressureProjection | undefined
}

/**
 * Abbreviate a token count the way a status line wants it: exact while small,
 * one decimal at thousands, whole at millions.
 * @param tokens - the count to render.
 * @returns the abbreviated figure.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/**
 * Total tokens a session has spent across every bucket.
 *
 * The four buckets are disjoint by contract — reasoning already sits inside
 * output — so a plain sum is the session total.
 * @param usage - cumulative usage, or undefined before any request.
 * @returns the total, or undefined when nothing is recorded.
 */
export function totalTokens(usage: TokenUsageProjection | undefined): number | undefined {
  if (usage === undefined) return undefined
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * Percentage of the context window still free for the next request.
 *
 * `projectedTokens` is what the NEXT prompt would cost, which is the figure a
 * person deciding whether to keep going needs; it also moves the instant a
 * compaction shadows a span, where the raw sample cannot.
 * @param context - the occupancy projection.
 * @returns whole percent remaining, or undefined without both figures.
 */
export function contextLeftPercent(context: ContextPressureProjection | undefined): number | undefined {
  const window = context?.contextWindow
  const used = context?.projectedTokens ?? context?.pressureTokens
  if (window === undefined || used === undefined || window <= 0) return undefined
  return Math.max(0, Math.min(100, Math.round((1 - used / window) * 100)))
}

/**
 * Shorten a path for display, collapsing the home directory to `~`.
 * @param path - the absolute path.
 * @param home - the home directory to collapse; defaults to the real one.
 * @returns the display path.
 */
export function displayPath(path: string, home: string = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * Read the checked-out branch by walking up to the repository's `HEAD`.
 *
 * Read rather than shelled out: `git` may be absent, slow, or blocked by the
 * sandbox, and a status line must never be the reason a prompt stalls. A
 * detached head reports no branch rather than a bare revision, which would read
 * as a branch named after a hash.
 * @param cwd - directory to start from.
 * @returns the branch name, or undefined outside a repository or when detached.
 */
export async function gitBranch(cwd: string): Promise<string | undefined> {
  const root = parse(cwd).root
  for (let dir = cwd; ; dir = dirname(dir)) {
    const marker = join(dir, '.git')
    // A worktree and a submodule carry a `gitdir:` pointer file instead of a
    // directory, so the marker is read either way and the pointer followed.
    const pointer = await readFile(marker, 'utf8').catch(() => undefined)
    const gitDir = pointer === undefined
      ? marker
      : pointer.startsWith('gitdir:') ? pointer.slice('gitdir:'.length).trim() : undefined
    if (gitDir !== undefined) {
      const head = await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => undefined)
      const ref = head?.trim().match(/^ref: refs\/heads\/(.+)$/)
      if (ref?.[1] !== undefined) return ref[1]
      if (head !== undefined) return undefined
    }
    if (dir === root) return undefined
  }
}

/**
 * Render the status line.
 *
 * Segments that have nothing to report are dropped rather than shown empty, so
 * a fresh session reads as short rather than as broken.
 * @param facts - what to report.
 * @param theme - styling for the segments.
 * @param columns - display columns available; a longer line is cut, never wrapped.
 * @returns the line, unstyled when the theme is plain.
 */
export function statusLine(facts: StatusFacts, theme: Theme, columns: number): string {
  const left = contextLeftPercent(facts.context)
  const total = totalTokens(facts.usage)
  // Styled per segment, never as one wrapped line: an inner reset would end an
  // outer style at the first coloured segment. The hierarchy is deliberate —
  // the model keeps its identity colour, plan mode warns, a shrinking context
  // escalates, and everything routine sits in the secondary gray.
  const headroom = left === undefined
    ? []
    : [left <= 10
      ? theme.error(`${left}% context left`)
      : left <= 25 ? theme.pending(`${left}% context left`) : theme.dim(`${left}% context left`)]
  // Ordered by what a narrow terminal should keep: truncation cuts from the
  // right, and the workspace is both the longest segment and the one the banner
  // already stated, so it goes last while spend and headroom stay visible.
  const segments = [
    theme.tool(facts.model),
    ...facts.preset === undefined ? [] : [theme.dim(facts.preset)],
    ...facts.permission === undefined ? [] : [theme.dim(facts.permission)],
    ...facts.planMode ? [theme.pending('plan')] : [],
    ...total === undefined ? [] : [theme.dim(`${formatTokens(total)} tokens`)],
    ...headroom,
    theme.dim(facts.branch === undefined ? displayPath(facts.cwd) : `${displayPath(facts.cwd)} (${facts.branch})`),
  ]
  // A status line that wraps costs two rows above every prompt and stops being
  // glanceable, so it is cut instead; truncation keeps the styling it can.
  return truncate(segments.join(theme.dim(' · ')), columns)
}

/**
 * Render the fuller readout `/status` answers with.
 *
 * The status line is a glance; this is the place a person looks when the glance
 * raised a question, so it names each usage bucket rather than one total.
 * @param facts - what to report.
 * @param session - the session identity, which `--resume` takes.
 * @returns the report, one `label: value` per line.
 */
export function statusReport(facts: StatusFacts, session: string): string {
  const left = contextLeftPercent(facts.context)
  const window = facts.context?.contextWindow
  const next = facts.context?.projectedTokens ?? facts.context?.pressureTokens
  const usage = facts.usage
  const rows: [string, string][] = [
    ['session', session],
    ['model', facts.model],
    ...facts.preset === undefined ? [] : [['preset', facts.preset] as [string, string]],
    ...facts.permission === undefined ? [] : [['permissions', facts.permission] as [string, string]],
    ['plan mode', facts.planMode ? 'on' : 'off'],
    ['workspace', facts.branch === undefined
      ? displayPath(facts.cwd)
      : `${displayPath(facts.cwd)} (${facts.branch})`],
    ...usage === undefined ? [] : [
      ['input', formatTokens(usage.uncachedInputTokens)] as [string, string],
      ['output', formatTokens(usage.outputTokens)] as [string, string],
      ['cache read', formatTokens(usage.cacheReadTokens)] as [string, string],
      ['cache write', formatTokens(usage.cacheWriteTokens)] as [string, string],
      ['total', formatTokens(totalTokens(usage) ?? 0)] as [string, string],
    ],
    ...next === undefined || window === undefined ? [] : [
      ['next request', `${formatTokens(next)} of ${formatTokens(window)}${left === undefined ? '' : ` (${left}% left)`}`] as [string, string],
    ],
  ]
  const label = Math.max(...rows.map(([name]) => name.length))
  return rows.map(([name, value]) => `${name.padEnd(label)}  ${value}`).join('\n')
}
