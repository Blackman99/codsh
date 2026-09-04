/**
 * Rewind: where a conversation can be forked from, turn by turn.
 *
 * The session log is append-only — there is no truncate — but the store can
 * fork a session through an inclusive event seq, and a fork taken just before
 * a turn opened is a conversation that never had that turn. This module finds
 * those points: one per prompt the person typed, each with the seq of the last
 * event before its `turn/start`. Injected context and goal rounds are user-role
 * messages too, but they are not turns anyone typed, so they are not offered.
 * @module codsh-bundle/src/rewind
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One place the conversation can be rewound to. */
export interface RewindPoint {
  /** The turn as the person counts them: the k-th prompt they typed. */
  turn: number
  /** The prompt's first line, for a picker row. */
  summary: string
  /**
   * The inclusive seq to fork through: the last event before the turn opened.
   * Undefined when nothing precedes it — the turn is the log's first event, and
   * a fork before it would be empty.
   */
  boundary: number | undefined
}

/** Longest summary a picker row carries. */
const SUMMARY_LIMIT = 60

/**
 * The turns a person typed, oldest first, each with where to fork from.
 * @param events - the session log, oldest first.
 * @returns the points; empty when nothing was typed yet.
 */
export function rewindPoints(events: readonly SessionEvent[]): RewindPoint[] {
  const points: RewindPoint[] = []
  /** The seq before the most recent `turn/start`, awaiting the prompt that entered it. */
  let beforeOpen: { boundary: number | undefined } | undefined
  let previous: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      beforeOpen = { boundary: previous }
    } else if (event.type === 'turn/end') {
      beforeOpen = undefined
    } else if (event.type === 'user/message' && event.data.source.kind === 'user') {
      // A typed prompt without a recorded opening — an older log shape — is
      // forked from just before the prompt itself.
      const boundary = beforeOpen === undefined ? previous : beforeOpen.boundary
      points.push({ turn: points.length + 1, summary: summarize(event.data.content), boundary })
      beforeOpen = undefined
    }
    previous = event.seq
  }
  return points
}

/**
 * The first line of what was typed, fit for a row.
 * @param content - the message's blocks.
 * @returns the line, trimmed and capped, or `(empty)`.
 */
function summarize(content: readonly { type: string; text?: string }[]): string {
  const text = content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '' && !part.startsWith('<pasted-image ')) ?? ''
  if (line === '') return '(empty)'
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line
}
