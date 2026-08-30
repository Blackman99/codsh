/** Conversation timeline windowing is a pure function over retained turns. */

import { describe, expect, it } from 'vitest'
import { computeTimeline } from '../src/timeline.ts'

describe('conversation timeline layout', () => {
  it('shows every turn when the rail has room', () => {
    expect(computeTimeline(3, 1, 5)).toEqual([
      { row: 0, kind: 'turn', turn: 0, current: false },
      { row: 1, kind: 'turn', turn: 1, current: true },
      { row: 2, kind: 'turn', turn: 2, current: false },
    ])
  })

  it('windows around the current turn with both overflow marks', () => {
    expect(computeTimeline(10, 5, 5)).toEqual([
      { row: 0, kind: 'above' },
      { row: 1, kind: 'turn', turn: 4, current: false },
      { row: 2, kind: 'turn', turn: 5, current: true },
      { row: 3, kind: 'turn', turn: 6, current: false },
      { row: 4, kind: 'below' },
    ])
  })

  it('uses the freed edge slot when only one side overflows', () => {
    expect(computeTimeline(10, 0, 4)).toEqual([
      { row: 0, kind: 'turn', turn: 0, current: true },
      { row: 1, kind: 'turn', turn: 1, current: false },
      { row: 2, kind: 'turn', turn: 2, current: false },
      { row: 3, kind: 'below' },
    ])
    expect(computeTimeline(10, 9, 4)).toEqual([
      { row: 0, kind: 'above' },
      { row: 1, kind: 'turn', turn: 7, current: false },
      { row: 2, kind: 'turn', turn: 8, current: false },
      { row: 3, kind: 'turn', turn: 9, current: true },
    ])
  })

  it('shows only the current tick in a one-row viewport and clamps bad input', () => {
    expect(computeTimeline(20, 12, 1)).toEqual([
      { row: 0, kind: 'turn', turn: 12, current: true },
    ])
    expect(computeTimeline(0, 0, 4)).toEqual([])
    expect(computeTimeline(2, 9, 2).at(-1)).toMatchObject({ turn: 1, current: true })
  })
})
