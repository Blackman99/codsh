/**
 * Pure one-column layout for the retained conversation-turn timeline.
 * @module codsh-bundle/src/timeline
 */

/** One glyph placed in the timeline rail. */
export type TimelineMark =
  | { row: number; kind: 'above' }
  | { row: number; kind: 'below' }
  | { row: number; kind: 'turn'; turn: number; current: boolean }

/** Clamp a value into an inclusive range. */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * Window retained turns around the current one and reserve edge rows for
 * overflow arrows. Every returned row is unique and every visible tick keeps
 * its original turn index.
 */
export function computeTimeline(count: number, current: number, height: number): TimelineMark[] {
  const total = Math.max(0, Math.floor(count))
  const rows = Math.max(0, Math.floor(height))
  if (total === 0 || rows === 0) return []
  const selected = clamp(Math.floor(current), 0, total - 1)
  if (rows === 1) return [{ row: 0, kind: 'turn', turn: selected, current: true }]

  let visible = Math.min(total, rows)
  let start = 0
  for (;;) {
    start = clamp(selected - Math.floor((visible - 1) / 2), 0, total - visible)
    const needed = visible + (start > 0 ? 1 : 0) + (start + visible < total ? 1 : 0)
    if (needed <= rows || visible === 1) break
    visible -= 1
  }

  const marks: TimelineMark[] = []
  let row = 0
  if (start > 0) marks.push({ row: row++, kind: 'above' })
  for (let turn = start; turn < start + visible; turn += 1) {
    marks.push({ row: row++, kind: 'turn', turn, current: turn === selected })
  }
  if (start + visible < total && row < rows) marks.push({ row, kind: 'below' })
  return marks
}
