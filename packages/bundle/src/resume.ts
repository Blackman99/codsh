/**
 * Shaping the list `/resume` offers.
 *
 * Sessions accumulate across every checkout a person works in, and the one
 * they want is almost always in the folder they are standing in. So this
 * workspace's sessions are the list, and everywhere else is one row that opens
 * the rest — a person who moved work between checkouts can still reach it,
 * without the folder they are in being buried under folders they are not.
 * @module codsh-bundle/src/resume
 */

/** What is known about one session before it becomes a row. */
export interface ResumeCandidate {
  id: string
  /** Where the session was created, absent for a session that recorded none. */
  cwd?: string
  /** That folder as a person reads it, e.g. `~`-shortened; falls back to `cwd`. */
  folder?: string
  createdAt: number
  /** The session's title, absent when it has none or its log would not read. */
  title?: string
  /** Time of its last event, absent when its log would not read. */
  lastActive?: number
  /** Messages exchanged in it, absent when its log would not read. */
  messages?: number
}

/** One session as the list offers it. */
export interface ResumeRow {
  id: string
  /** What the session is called: its title, or its id when it has none. */
  label: string
  /** Dim context beside the label. */
  detail: string
  /** When it was last touched, which is what the list is ordered by. */
  lastActive: number
}

/**
 * A moment's age as a person reads it.
 * @param epochMs - when it happened.
 * @param now - the current epoch milliseconds.
 * @returns e.g. `just now`, `5m ago`, `3h ago`, `2d ago`.
 */
export function age(epochMs: number, now: number): string {
  const minutes = Math.floor((now - epochMs) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Shape one session into the row the selector shows.
 *
 * The age answers "was this the one I was just in", the message count answers
 * "how much is in it", and a folder appears only when it is not the one the
 * person is standing in — repeating the current path on every row would spend
 * the width that tells them apart.
 * @param candidate - what is known about the session.
 * @param cwd - the workspace the person is in.
 * @param now - the current epoch milliseconds.
 * @returns the row.
 */
function row(candidate: ResumeCandidate, cwd: string, now: number): ResumeRow {
  const lastActive = candidate.lastActive ?? candidate.createdAt
  const parts = [age(lastActive, now)]
  if (candidate.messages !== undefined && candidate.messages > 0) {
    parts.push(`${candidate.messages} ${candidate.messages === 1 ? 'message' : 'messages'}`)
  }
  if (candidate.cwd !== cwd && candidate.cwd !== undefined && candidate.cwd !== '') {
    parts.push(candidate.folder ?? candidate.cwd)
  }
  return {
    id: candidate.id,
    label: candidate.title ?? candidate.id,
    detail: parts.join(' · '),
    lastActive,
  }
}

/**
 * Split the candidates into this workspace's sessions and the rest, each
 * ordered by when it was last touched.
 * @param candidates - every session worth offering.
 * @param cwd - the workspace the person is in.
 * @param now - the current epoch milliseconds.
 * @returns rows for here and rows for elsewhere.
 */
export function shapeResume(
  candidates: readonly ResumeCandidate[],
  cwd: string,
  now: number,
): { here: ResumeRow[]; elsewhere: ResumeRow[] } {
  const newestFirst = (left: ResumeRow, right: ResumeRow): number => right.lastActive - left.lastActive
  const rows = candidates.map(candidate => ({ candidate, row: row(candidate, cwd, now) }))
  return {
    here: rows.filter(entry => entry.candidate.cwd === cwd).map(entry => entry.row).sort(newestFirst),
    elsewhere: rows.filter(entry => entry.candidate.cwd !== cwd).map(entry => entry.row).sort(newestFirst),
  }
}
