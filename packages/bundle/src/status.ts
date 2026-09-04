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
import type { Plan, ShipStatus } from './plan.ts'
import { displayWidth, truncate } from './theme.ts'
import type { Theme } from './theme.ts'

/**
 * The MetaBar `/ship` orientation chip.
 *
 * Gate chips already shipped via {@link StatusFacts.shipGate}; the rest of the
 * workflow (grill, landing k/n, verify, done) uses this union so one paint
 * path owns the label and the theme role.
 */
export type ShipChip =
  | { readonly kind: 'grill' }
  | { readonly kind: 'gate'; readonly gate: 1 | 2 }
  | { readonly kind: 'land'; readonly k: number; readonly n: number; readonly flashOk?: true }
  | { readonly kind: 'verify' }
  | { readonly kind: 'done' }

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
  /**
   * Open /ship gate number, when a GateModal owns the screen.
   * Shown as a warn chip ahead of plan mode. Ignored when {@link StatusFacts.shipChip}
   * is set; when only this field is present it is treated as a gate chip.
   */
  shipGate?: 1 | 2
  /**
   * /ship orientation chip. When omitted, {@link StatusFacts.shipGate} still
   * paints as `ship · gate1|gate2` so existing callers keep working.
   */
  shipChip?: ShipChip
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
 * Abbreviate an elapsed time the way a running clock wants it.
 *
 * A live figure has to keep moving, so this never collapses to one unit the
 * way a timestamp's age does: an hour-long run reading `1h` for the whole
 * hour looks like a clock that stopped. Each band shows the finest unit that
 * still changes visibly — a decimal while a turn is quick, then seconds, then
 * seconds under minutes, then minutes under hours.
 * @param ms - milliseconds elapsed.
 * @returns e.g. `3.4s`, `42s`, `9m 05s`, `1h 37m`.
 */
export function formatElapsed(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Format a finished turn's time summary, optionally breaking out individual thinking durations.
 * @param elapsedMs - milliseconds the entire turn took.
 * @param thinkingMs - milliseconds each thinking block took, oldest first.
 * @returns e.g. `12.3s`, `12.3s (thought 3.2s)`, `12.3s (thought 2.1s, 4.3s)`.
 */
export function formatTurnTime(elapsedMs: number, thinkingMs: readonly number[] = []): string {
  const base = formatElapsed(elapsedMs)
  if (thinkingMs.length === 0) return base
  const thoughts = thinkingMs.map(ms => formatElapsed(ms)).join(', ')
  return `${base} (thought ${thoughts})`
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
 * The MetaBar label for a `/ship` chip. Spaces around the middot are part of
 * the contract: `ship · land 2/3`, never `ship·land`.
 * @param chip - the orientation chip.
 * @returns the unstyled label.
 */
export function shipChipLabel(chip: ShipChip): string {
  switch (chip.kind) {
    case 'grill':
      return 'ship · grill'
    case 'gate':
      return `ship · gate${String(chip.gate)}`
    case 'land':
      return `ship · land ${String(chip.k)}/${String(chip.n)}`
    case 'verify':
      return 'ship · verify'
    case 'done':
      return 'ship · done'
  }
}

/**
 * Paint a `/ship` chip in its theme role.
 *
 * Grill is muted, an open gate is warn (already shipped), landing is agent
 * except the brief ok flash when a ticket turns green, verify is muted, and
 * done is ok.
 * @param chip - the orientation chip.
 * @param theme - styling for the label.
 * @returns the painted label.
 */
export function paintShipChip(chip: ShipChip, theme: Theme): string {
  const label = shipChipLabel(chip)
  switch (chip.kind) {
    case 'grill':
      return theme.muted(label)
    case 'gate':
      return theme.warn(label)
    case 'land':
      return chip.flashOk === true ? theme.ok(label) : theme.agent(label)
    case 'verify':
      return theme.muted(label)
    case 'done':
      return theme.ok(label)
  }
}

/**
 * The landing chip for a plan that still has a current ticket: k is
 * `done + 1`, n is the ticket count.
 * @param plan - the plan read from the spec.
 * @param flashOk - when true, the next paint flashes ok for a landed ticket.
 * @returns the land chip, or undefined once every ticket is ticked.
 */
export function landChip(plan: Plan, flashOk = false): Extract<ShipChip, { kind: 'land' }> | undefined {
  if (plan.current === undefined || plan.tickets.length === 0) return undefined
  return flashOk
    ? { kind: 'land', k: plan.done + 1, n: plan.tickets.length, flashOk: true }
    : { kind: 'land', k: plan.done + 1, n: plan.tickets.length }
}

/**
 * Derive the MetaBar chip from a spec's Status line and its plan.
 *
 * interviewing/confirmed/planned → grill; landing with a current ticket →
 * land k/n; every ticket ticked → verify; shipped → done.
 * @param status - the spec's Status phase, if the file named one.
 * @param plan - the plan, or undefined before tickets exist.
 * @param flashOk - when true, a land chip flashes ok.
 * @returns the chip, or undefined when the spec does not name a phase yet.
 */
export function shipChipFromSpec(
  status: ShipStatus | undefined,
  plan: Plan | undefined,
  flashOk = false,
): ShipChip | undefined {
  if (status === 'shipped') return { kind: 'done' }
  if (plan !== undefined && plan.tickets.length > 0 && plan.current === undefined) return { kind: 'verify' }
  if (status === 'landing' && plan !== undefined) {
    const land = landChip(plan, flashOk)
    if (land !== undefined) return land
  }
  if (status === 'interviewing' || status === 'confirmed' || status === 'planned') return { kind: 'grill' }
  return undefined
}

/**
 * The chip a status line should paint: `shipChip` wins; a bare `shipGate`
 * is treated as a gate chip so existing callers keep working.
 * @param facts - what to report.
 * @returns the chip, or undefined when /ship is not showing one.
 */
export function resolveShipChip(facts: StatusFacts): ShipChip | undefined {
  return facts.shipChip ?? (facts.shipGate === undefined ? undefined : { kind: 'gate', gate: facts.shipGate })
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
 * @param columns - display columns available; a longer line is cut, never
 *   wrapped. Omit to keep the full line, so a later paint can re-fit it.
 * @returns the line, unstyled when the theme is plain.
 */
export function statusLine(facts: StatusFacts, theme: Theme, columns?: number): string {
  const left = contextLeftPercent(facts.context)
  // Glance MetaBar: mode · model · cwd. Preset, permission, token totals, and
  // routine context stay in `/status`; only alarming headroom surfaces here.
  // Never accent on this line — accent is reserved for focus/selection.
  const sep = theme.muted(' · ')
  const chip = resolveShipChip(facts)
  const shipChip = chip === undefined ? undefined : paintShipChip(chip, theme)
  const mode = facts.planMode ? theme.warn('plan') : undefined
  const model = theme.muted(facts.model)
  const cwd = theme.muted(
    facts.branch === undefined ? displayPath(facts.cwd) : `${displayPath(facts.cwd)} (${facts.branch})`,
  )
  const context = left === undefined || left > 25
    ? undefined
    : left <= 10 ? theme.err(`${left}%`) : theme.warn(`${left}%`)
  // Drop whole segments until the line fits: cwd first, then model; keep
  // the ship chip, mode, and alarming context. Never drop the ship chip
  // first — same priority the gate chip already had. Omit columns => full
  // line for a later re-fit.
  const tagged: { key: 'shipChip' | 'mode' | 'model' | 'context' | 'cwd'; text: string }[] = [
    ...shipChip === undefined ? [] : [{ key: 'shipChip' as const, text: shipChip }],
    ...mode === undefined ? [] : [{ key: 'mode' as const, text: mode }],
    { key: 'model', text: model },
    ...context === undefined ? [] : [{ key: 'context' as const, text: context }],
    { key: 'cwd', text: cwd },
  ]
  if (columns === undefined) return tagged.map(part => part.text).join(sep)
  const join = (parts: string[]): string => parts.join(sep)
  let kept = tagged
  for (const drop of ['cwd', 'model'] as const) {
    if (displayWidth(join(kept.map(part => part.text))) <= columns) break
    kept = kept.filter(part => part.key !== drop)
  }
  const line = join(kept.map(part => part.text))
  return displayWidth(line) <= columns ? line : truncate(line, columns)
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
