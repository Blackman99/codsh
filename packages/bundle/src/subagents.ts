/**
 * The subagents a session started: what they are, how they are doing, and
 * the chrome that shows them — the pinned readout under the box, the panel a
 * person opens on it to pick one, the `/subagents` report, and the title a
 * Child view carries while it shows one.
 *
 * Grok Build keeps the same roster in its tasks pane (Ctrl+G). This
 * surface uses Ctrl+H so Graph's Panorama overlay can keep Ctrl+G: a status mark,
 * the elapsed time, the label, and Enter to open one. Here the pane is a
 * chrome panel the shape the Queue panel has, and opening one is the Child
 * view the transcript already offers on a click.
 *
 * Pure state and pure rendering, like the queue panel: events and keys in,
 * entries, rows, or an action out. Who feeds it — `subagent/start`, the
 * child's own session events — is the composition root's business.
 * @module codsh-bundle/src/subagents
 */

import { fitTrailer } from './queue-panel.ts'
import { formatElapsed } from './status.ts'
import { truncate } from './theme.ts'
import type { Key } from './keys.ts'
import type { PanelTarget } from './queue-panel.ts'
import type { Theme } from './theme.ts'

/** Where a subagent stands: still working, or how its turn ended. */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped'

/** One child the live session started, as the roster remembers it. */
export interface SubagentEntry {
  /** The child Session's id — what a click enters. */
  readonly id: string
  /** What the call said it was for: its description, else its prompt's first line. */
  readonly label: string
  /** When the child came into being, `performance.now()`-style milliseconds. */
  readonly startedAt: number
  readonly status: SubagentStatus
  /** When its last turn ended; undefined while it runs. */
  readonly endedAt: number | undefined
  /** Tool calls the child has made so far. */
  readonly calls: number
  /** The latest call, named for a row: `bash: sleep 2`. */
  readonly latest: string | undefined
}

/** The chord that opens and closes the panel, named in the readout's trailer. */
export const SUBAGENTS_KEY = 'Ctrl+H'

/** Entries shown at once before the panel windows. */
export const SUBAGENT_ROWS = 8

/** What one key or click did to the panel. */
export type SubagentsAction =
  | { kind: 'pending' }
  | { kind: 'close' }
  | { kind: 'enter'; id: string }

/** The roster's mutable record, never handed out. */
interface Record_ {
  id: string
  label: string
  startedAt: number
  status: SubagentStatus
  endedAt: number | undefined
  calls: number
  latest: string | undefined
}

/**
 * Where a turn-end reason, or a run's terminal stop reason, leaves a child.
 *
 * `completed` is done. An `error` failed, and so did `max-tokens`,
 * `refusal`, and a `blocked` turn a gate held — the runtime reports those
 * to the parent as failures, and the row says what the parent is told. An
 * `aborted` turn was stopped — by the parent's control tool or an
 * interrupt — and so was a crash-orphaned `interrupted` one. A child that
 * did not finish is never marked `✔`.
 * @param kind - the `turn/end` reason kind, or a `subagent/end` stop reason.
 * @returns the status the row shows.
 */
export function outcomeStatus(kind: string): SubagentStatus {
  if (kind === 'completed') return 'done'
  if (kind === 'aborted' || kind === 'interrupted') return 'stopped'
  return 'failed'
}

/**
 * The subagents one session started, in the order they appeared.
 *
 * Surface state fed by events, not a query over the store: a child that has
 * finished and left the store is exactly the one a roster has to keep
 * saying something about.
 */
export class SubagentRoster {
  private readonly records = new Map<string, Record_>()

  /**
   * A child exists. A second start for the same id — a continuable child
   * given another turn — puts it back to running and keeps its clock.
   * @param id - the child Session's id.
   * @param label - what the call said it was for.
   * @param at - now, in milliseconds.
   */
  start(id: string, label: string, at: number): void {
    const known = this.records.get(id)
    if (known !== undefined) {
      known.status = 'running'
      known.endedAt = undefined
      return
    }
    this.records.set(id, { id, label, startedAt: at, status: 'running', endedAt: undefined, calls: 0, latest: undefined })
  }

  /**
   * The child's own log named it: the descriptor's label replaces whatever
   * the roster guessed from the parent's pending call.
   * @param id - the child Session's id.
   * @param label - what the child's `subagent/descriptor` says it was for.
   */
  relabel(id: string, label: string): void {
    const record = this.records.get(id)
    if (record === undefined || label.trim() === '') return
    record.label = label.trim()
  }

  /**
   * The child made a tool call.
   * @param id - the child Session's id.
   * @param latest - the call named for a row, when known.
   */
  call(id: string, latest: string | undefined): void {
    const record = this.records.get(id)
    if (record === undefined) return
    record.calls += 1
    if (latest !== undefined) record.latest = latest
  }

  /**
   * The child's turn ended, or began again.
   * @param id - the child Session's id.
   * @param status - where it stands now.
   * @param at - now, in milliseconds.
   */
  settle(id: string, status: SubagentStatus, at: number): void {
    const record = this.records.get(id)
    if (record === undefined) return
    record.status = status
    record.endedAt = status === 'running' ? undefined : at
  }

  /** Whether the roster knows this child. */
  has(id: string): boolean {
    return this.records.has(id)
  }

  /** One entry, or undefined for a child that is not this session's. */
  entry(id: string): SubagentEntry | undefined {
    const record = this.records.get(id)
    return record === undefined ? undefined : { ...record }
  }

  /** Every entry, in start order. */
  entries(): SubagentEntry[] {
    return [...this.records.values()].map(record => ({ ...record }))
  }

  /** How many children the roster holds. */
  get size(): number {
    return this.records.size
  }

  /** Forget everything — a session replacement starts a new roster. */
  clear(): void {
    this.records.clear()
  }
}

/** Each status counted once. */
export function tally(entries: readonly SubagentEntry[]): { total: number; running: number; done: number; failed: number; stopped: number } {
  const counts = { total: entries.length, running: 0, done: 0, failed: 0, stopped: 0 }
  for (const entry of entries) counts[entry.status] += 1
  return counts
}

/** How long a child has run, or ran. */
function elapsed(entry: SubagentEntry, now: number): string {
  const end = entry.endedAt ?? now
  return formatElapsed(Math.max(0, end - entry.startedAt))
}

/**
 * The status mark: `▶` and `✔` are the todo readout's marks, `✗` is the
 * failed tool card's, and `■` for a stopped child is this row's own.
 */
function mark(status: SubagentStatus, theme: Theme): string {
  if (status === 'running') return theme.pending('▶')
  if (status === 'done') return theme.success('✔')
  if (status === 'failed') return theme.err('✗')
  return theme.dim('■')
}

/** Unstyled counts for a header: `2 running · 1 done`, only the states present. */
function countsText(entries: readonly SubagentEntry[]): string {
  const counts = tally(entries)
  const parts = [
    counts.running === 0 ? '' : `${String(counts.running)} running`,
    counts.done === 0 ? '' : `${String(counts.done)} done`,
    counts.failed === 0 ? '' : `${String(counts.failed)} failed`,
    counts.stopped === 0 ? '' : `${String(counts.stopped)} stopped`,
  ]
  return parts.filter(part => part !== '').join(' · ')
}

/**
 * The collapsed readout: how many children, by state, in one line under the
 * box — `subagents 3 · 2 running · 1 done · Ctrl+H`.
 *
 * One dim span, the way the queue row is, so a PTY wait can match it as raw
 * bytes; the key is cut before the counts are.
 * @param entries - the roster, in start order.
 * @param theme - styling for the row.
 * @param columns - display columns available; a longer row is cut, never wrapped.
 * @returns the row, or undefined when no child was started.
 */
export function subagentsRow(entries: readonly SubagentEntry[], theme: Theme, columns: number): string | undefined {
  if (entries.length === 0) return undefined
  const body = `  subagents ${String(entries.length)} · ${countsText(entries)}`
  return theme.dim(fitTrailer(body, ` · ${SUBAGENTS_KEY}`, columns))
}

/** The most of a latest call a title carries: the working line's own cut. */
const TITLE_CALL_COLUMNS = 32

/**
 * One child in one line: mark, label, elapsed, calls, and the latest call.
 * @param entry - the child.
 * @param theme - styling for the mark and the muted figures.
 * @param now - now, in milliseconds, for a running child's clock.
 * @param labelStyle - how to paint the label, e.g. bold for the marked row.
 * @param callColumns - the most of the latest call to keep, when a row has a budget for it.
 * @returns the line, unfitted.
 */
export function subagentLine(entry: SubagentEntry, theme: Theme, now: number, labelStyle: (text: string) => string = text => text, callColumns?: number): string {
  const latest = entry.latest === undefined || callColumns === undefined ? entry.latest : truncate(entry.latest, callColumns)
  const figures = [
    elapsed(entry, now),
    ...entry.calls === 0 ? [] : [`${String(entry.calls)} ${entry.calls === 1 ? 'call' : 'calls'}`],
    ...latest === undefined ? [] : [latest],
  ]
  return `${mark(entry.status, theme)} ${labelStyle(entry.label)}${theme.dim(` · ${figures.join(' · ')}`)}`
}

/**
 * The header the panel and the report share: how many children, by state —
 * `subagents 3 · 2 running · 1 done` — with the trailer fitted last, so the
 * counts are cut before the key is.
 * @param entries - the roster, in start order.
 * @param theme - styling.
 * @param columns - display columns available to the header.
 * @param trailer - what follows the counts: the panel's ` · Ctrl+H closes`, or nothing.
 * @returns the styled header, one row.
 */
function header(entries: readonly SubagentEntry[], theme: Theme, columns: number, trailer: string): string {
  const plain = fitTrailer(`subagents ${String(entries.length)} · ${countsText(entries)}`, trailer, columns)
  return plain.startsWith('subagents')
    ? `${theme.tool('subagents')}${theme.dim(plain.slice('subagents'.length))}`
    : theme.dim(plain)
}

/**
 * The roster as lines: the header the panel carries, then one numbered row
 * per child. What `/subagents` prints, on a terminal or a pipe.
 * @param entries - the roster, in start order.
 * @param theme - styling.
 * @param columns - display columns; longer rows are cut.
 * @param now - now, in milliseconds.
 * @returns the lines, empty when no child was started.
 */
export function subagentsReport(entries: readonly SubagentEntry[], theme: Theme, columns: number, now: number): string[] {
  if (entries.length === 0) return []
  const rows = [header(entries, theme, columns, '')]
  for (const [index, entry] of entries.entries()) {
    rows.push(truncate(`  ${theme.dim(`${String(index + 1)}.`)} ${subagentLine(entry, theme, now)}`, columns))
  }
  return rows
}

/**
 * The status row a Child view carries: which subagent this is and how it is
 * doing — the title bar Grok Build gives a subagent's view.
 *
 * The way out is the one thing the row must never lose: the label and the
 * figures are cut before ` · Esc returns to the parent` is, the way the todo
 * and queue rows keep their keys. The latest call is capped the way the
 * working line caps its activity.
 * @param entry - the child on screen.
 * @param theme - styling.
 * @param now - now, in milliseconds.
 * @param columns - display columns available to the row.
 * @param hint - how to leave; the existing `Esc returns to the parent`.
 * @returns the row, fitted to `columns`.
 */
export function subagentTitle(entry: SubagentEntry, theme: Theme, now: number, columns: number, hint = 'Esc returns to the parent'): string {
  const body = `${theme.dim('subagent ')}${subagentLine(entry, theme, now, text => theme.dim(text), TITLE_CALL_COLUMNS)}`
  return fitTrailer(body, theme.dim(` · ${hint}`), columns)
}

/**
 * The list a person opens on the roster: pick a child, Enter or click to
 * enter its view.
 *
 * State mirrors the Queue panel — a marked row, a window that follows it, a
 * wheel-scrolled window that springs back on the next key. The mark is an
 * index into the roster's start order; ids are read fresh on every call.
 */
export class SubagentsPanel {
  private mark_ = 0
  private hovered: PanelTarget | undefined
  private scrolled: number | undefined

  /** Start over: mark on the first child, no hover, window at the top. */
  reset(): void {
    this.mark_ = 0
    this.hovered = undefined
    this.scrolled = undefined
  }

  /** Index into the roster of the row Enter would open. */
  get mark(): number {
    return this.mark_
  }

  private clamp(entries: readonly SubagentEntry[]): void {
    const last = Math.max(0, entries.length - 1)
    this.mark_ = Math.min(Math.max(0, this.mark_), last)
    if (this.scrolled !== undefined) {
      this.scrolled = Math.min(Math.max(0, this.scrolled), Math.max(0, entries.length - SUBAGENT_ROWS))
    }
  }

  private windowStart(entries: readonly SubagentEntry[]): number {
    const following = Math.min(Math.max(0, this.mark_ - SUBAGENT_ROWS + 1), Math.max(0, entries.length - SUBAGENT_ROWS))
    return this.scrolled ?? following
  }

  /**
   * Move the window only, not the mark.
   * @param delta - rows to move by; negative scrolls towards the top.
   * @param entries - the roster, in start order.
   */
  scrollBy(delta: number, entries: readonly SubagentEntry[]): void {
    this.clamp(entries)
    const limit = Math.max(0, entries.length - SUBAGENT_ROWS)
    this.scrolled = Math.min(limit, Math.max(0, this.windowStart(entries) + delta))
  }

  /** Mark the row the pointer rests on, or none. */
  setHovered(target: PanelTarget | undefined): void {
    this.hovered = target
  }

  /**
   * What sits on one row of {@link view}'s output.
   * @param row - a row index within this panel's own rows, header at zero.
   * @param entries - the roster, in start order.
   * @returns what the row offers, or undefined for a row that offers nothing.
   */
  targetAt(row: number, entries: readonly SubagentEntry[]): PanelTarget | undefined {
    this.clamp(entries)
    if (entries.length === 0) return undefined
    if (row === 0) return { kind: 'header' }
    let at = 1
    const first = this.windowStart(entries)
    if (first > 0) at += 1
    const shown = Math.min(entries.length, first + SUBAGENT_ROWS) - first
    const below = entries.length - first - shown
    const footerRow = at + shown + (below > 0 ? 1 : 0)
    if (row === footerRow) return { kind: 'footer' }
    if (row < at || row >= at + shown) return undefined
    return { kind: 'item', index: first + (row - at) }
  }

  /**
   * A press+release on a target: a row enters that child; header and footer
   * are the way out, same as Escape.
   * @param target - the row chosen.
   * @param entries - the roster, in start order.
   * @returns the action the click took.
   */
  click(target: PanelTarget, entries: readonly SubagentEntry[]): SubagentsAction {
    this.clamp(entries)
    if (target.kind !== 'item') return { kind: 'close' }
    const entry = entries[target.index]
    if (entry === undefined) return { kind: 'pending' }
    this.mark_ = target.index
    return { kind: 'enter', id: entry.id }
  }

  /**
   * Apply one key.
   * @param key - the decoded keystroke.
   * @param entries - the roster, in start order.
   * @returns the action the key took.
   */
  handle(key: Key, entries: readonly SubagentEntry[]): SubagentsAction {
    this.clamp(entries)
    if (key.kind === 'scroll' && key.at !== undefined) {
      this.scrollBy(key.lines, entries)
      return { kind: 'pending' }
    }
    this.scrolled = undefined
    switch (key.kind) {
      case 'up':
        if (entries.length === 0) return { kind: 'pending' }
        this.mark_ = (this.mark_ - 1 + entries.length) % entries.length
        return { kind: 'pending' }
      case 'down':
      case 'tab':
        if (entries.length === 0) return { kind: 'pending' }
        this.mark_ = (this.mark_ + 1) % entries.length
        return { kind: 'pending' }
      case 'home':
        this.mark_ = 0
        return { kind: 'pending' }
      case 'end':
        this.mark_ = Math.max(0, entries.length - 1)
        return { kind: 'pending' }
      case 'enter': {
        const entry = entries[this.mark_]
        return entry === undefined ? { kind: 'pending' } : { kind: 'enter', id: entry.id }
      }
      case 'text': {
        const digit = Number(key.text)
        if (Number.isInteger(digit) && digit >= 1 && digit <= 9 && digit <= entries.length) this.mark_ = digit - 1
        return { kind: 'pending' }
      }
      case 'escape':
      case 'toggle-subagents':
        return { kind: 'close' }
      default:
        return { kind: 'pending' }
    }
  }

  /**
   * Render the panel: the header, the windowed list, and the footer.
   * @param entries - the roster, in start order.
   * @param theme - styling for the marks and text.
   * @param columns - display columns available; longer rows are cut.
   * @param now - now, in milliseconds, for the running clocks.
   * @param viewing - the child whose view is on screen, if one is; its row says so.
   * @returns the rows, empty when no child was started.
   */
  view(entries: readonly SubagentEntry[], theme: Theme, columns: number, now: number, viewing?: string): string[] {
    this.clamp(entries)
    if (entries.length === 0) return []
    const rows: string[] = [`  ${header(entries, theme, Math.max(0, columns - 2), ` · ${SUBAGENTS_KEY} closes`)}`]
    const first = this.windowStart(entries)
    if (first > 0) rows.push(truncate(theme.dim(`  ↑ ${String(first)} more`), columns))
    const shown = Math.min(entries.length, first + SUBAGENT_ROWS)
    for (let index = first; index < shown; index += 1) {
      const entry = entries[index]
      if (entry !== undefined) rows.push(truncate(this.row(index, entry, theme, now, entry.id === viewing), columns))
    }
    const below = entries.length - shown
    if (below > 0) rows.push(truncate(theme.dim(`  ↓ ${String(below)} more`), columns))
    rows.push(truncate(`    ${theme.dim('[enter] view · [esc] back')}`, columns))
    return rows
  }

  /** One rendered row: the mark or the pointer's dot, the number, the child. */
  private row(index: number, entry: SubagentEntry, theme: Theme, now: number, viewing: boolean): string {
    const marked = index === this.mark_
    const hoveredHere = !marked && this.hovered?.kind === 'item' && this.hovered.index === index
    const marker = marked ? theme.bold(theme.accent('❯')) : hoveredHere ? theme.dim('·') : ' '
    const number = theme.dim(`${String(index + 1)}.`)
    const line = subagentLine(entry, theme, now, marked ? text => theme.bold(theme.accent(text)) : text => text)
    return `  ${marker} ${number} ${line}${viewing ? theme.dim(' · viewing') : ''}`
  }
}
