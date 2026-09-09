/**
 * What a workflow round is doing, read off its child session.
 *
 * A Ralph round runs for minutes inside ONE step of the parent, in a worker
 * thread this process sees no event from. Its log is on disk, though, and
 * polled a few times a minute it says what the round is up to: how many calls
 * it has made and what the last one was. Without that the working line stood
 * still for the whole round, and a person read the stillness as a hang and
 * interrupted a round that had already landed a ticket.
 *
 * Pure: events in, progress out. The surface owns the polling and the row.
 * @module codsh-bundle/src/round-watch
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** How far into a child's log the watch has read, and what it found. */
export interface RoundProgress {
  /** The last event seq folded in; -1 before anything was read. */
  readonly cursor: number
  /** Tool calls the round has made so far. */
  readonly calls: number
  /** The latest call, named for a row: `bash: pytest -v`. */
  readonly latest: string | undefined
}

/** Where a watch starts: nothing read, nothing seen. */
export const NO_PROGRESS: RoundProgress = { cursor: -1, calls: 0, latest: undefined }

/** Names one call for the row; undefined lets the fallback speak. */
export type CallDescriber = (name: string, args: unknown) => string | undefined

/**
 * Fold the events past the cursor into the progress.
 * @param progress - where the watch stood.
 * @param events - the child's log, oldest first; events at or before the cursor are skipped.
 * @param describe - the surface's own call presenter, tried before the fallback.
 * @returns the progress after these events, and whether any call was new.
 */
export function advanceRound(
  progress: RoundProgress,
  events: readonly SessionEvent[],
  describe: CallDescriber = () => undefined,
): { progress: RoundProgress; moved: boolean } {
  let { cursor, calls, latest } = progress
  let moved = false
  for (const event of events) {
    if (event.seq <= cursor) continue
    cursor = event.seq
    if (event.type !== 'tool/call') continue
    moved = true
    calls += 1
    latest = describeCall(event.data.name, event.data.arguments, describe)
  }
  return { progress: { cursor, calls, latest }, moved }
}

/**
 * Name one call the way the working line has room for.
 *
 * The presenter is asked first; when it has nothing, the argument that says
 * most is picked by shape — a command, a path, a pattern — so a round's row
 * reads `bash: pytest -v` rather than `bash`.
 * @param name - the tool.
 * @param rawArguments - the arguments JSON as the model produced it.
 * @param describe - the presenter to try first.
 * @returns `name: what`, or just the name.
 */
export function describeCall(name: string, rawArguments: string, describe: CallDescriber = () => undefined): string {
  let args: unknown
  try {
    args = JSON.parse(rawArguments)
  } catch {
    args = undefined
  }
  let what: string | undefined
  try {
    what = describe(name, args)
  } catch {
    what = undefined
  }
  what ??= salientArgument(args)
  const oneLine = what?.replaceAll(/\s+/gu, ' ').trim()
  return oneLine === undefined || oneLine === '' ? name : `${name}: ${oneLine}`
}

/** The argument worth a glance: a command, a path, a pattern, a query. */
function salientArgument(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'name', 'description']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * The working-line fragment for a round in flight.
 * @param progress - what the watch has read.
 * @returns `12 calls · bash: pytest -v`, or undefined before the first call.
 */
export function roundActivity(progress: RoundProgress): string | undefined {
  if (progress.calls === 0) return undefined
  const count = `${String(progress.calls)} ${progress.calls === 1 ? 'call' : 'calls'}`
  return progress.latest === undefined ? count : `${count} · ${progress.latest}`
}
