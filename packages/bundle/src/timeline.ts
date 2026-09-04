/**
 * Pure one-column layout for the retained conversation-turn timeline.
 * @module codsh-bundle/src/timeline
 */

/** One glyph placed in the timeline rail. */
export type TimelineMark =
  | { row: number; kind: 'above'; target?: number }
  | { row: number; kind: 'below'; target?: number }
  | { row: number; kind: 'turn'; turn: number; current: boolean }

/** Real turn anchors immediately above and below the viewport top. */
export interface TimelineTargets {
  above?: number
  below?: number
}

/** Clamp a value into an inclusive range. */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * Window retained turns around the current one between two navigation arrows.
 * Every returned row is unique and every visible tick keeps its original turn
 * index. An arrow without a target remains visible as a disabled end stop.
 */
export function computeTimeline(
  count: number,
  current: number,
  height: number,
  targets: TimelineTargets = {},
): TimelineMark[] {
  const total = Math.max(0, Math.floor(count))
  const rows = Math.max(0, Math.floor(height))
  if (total < 2 || rows < 3) return []
  const selected = clamp(Math.floor(current), 0, total - 1)
  const visible = Math.min(total, rows - 2)
  const start = clamp(selected - Math.floor((visible - 1) / 2), 0, total - visible)
  const target = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isInteger(value) && value >= 0 && value < total ? value : undefined
  const above = target(targets.above)
  const below = target(targets.below)

  const marks: TimelineMark[] = [above === undefined ? { row: 0, kind: 'above' } : { row: 0, kind: 'above', target: above }]
  let row = 1
  for (let turn = start; turn < start + visible; turn += 1) {
    marks.push({ row: row++, kind: 'turn', turn, current: turn === selected })
  }
  marks.push(below === undefined ? { row, kind: 'below' } : { row, kind: 'below', target: below })
  return marks
}
