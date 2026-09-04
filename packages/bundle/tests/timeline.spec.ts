/** Conversation timeline windowing is a pure function over retained turns. */

import { describe, expect, it } from 'vitest'
import { computeTimeline } from '../src/timeline.ts'

describe('conversation timeline layout', () => {
  it('reserves navigable arrows around every visible turn stack', () => {
    expect(computeTimeline(3, 1, 5, { above: 0, below: 2 })).toEqual([
      { row: 0, kind: 'above', target: 0 },
      { row: 1, kind: 'turn', turn: 0, current: false },
      { row: 2, kind: 'turn', turn: 1, current: true },
      { row: 3, kind: 'turn', turn: 2, current: false },
      { row: 4, kind: 'below', target: 2 },
    ])
  })

  it('windows around the current turn without changing arrow targets', () => {
    expect(computeTimeline(10, 5, 5, { above: 5, below: 6 })).toEqual([
      { row: 0, kind: 'above', target: 5 },
      { row: 1, kind: 'turn', turn: 4, current: false },
      { row: 2, kind: 'turn', turn: 5, current: true },
      { row: 3, kind: 'turn', turn: 6, current: false },
      { row: 4, kind: 'below', target: 6 },
    ])
  })

  it('keeps disabled edge arrows visible and clamps the tick window', () => {
    expect(computeTimeline(10, 0, 4, { below: 1 })).toEqual([
      { row: 0, kind: 'above' },
      { row: 1, kind: 'turn', turn: 0, current: true },
      { row: 2, kind: 'turn', turn: 1, current: false },
      { row: 3, kind: 'below', target: 1 },
    ])
    expect(computeTimeline(10, 9, 4, { above: 9 })).toEqual([
      { row: 0, kind: 'above', target: 9 },
      { row: 1, kind: 'turn', turn: 8, current: false },
      { row: 2, kind: 'turn', turn: 9, current: true },
      { row: 3, kind: 'below' },
    ])
  })

  it('hides noise and impossible rails, and rejects invalid targets', () => {
    expect(computeTimeline(0, 0, 4)).toEqual([])
    expect(computeTimeline(1, 0, 4)).toEqual([])
    expect(computeTimeline(2, 0, 2)).toEqual([])
    expect(computeTimeline(2, 9, 3, { above: -1, below: 20 })).toEqual([
      { row: 0, kind: 'above' },
      { row: 1, kind: 'turn', turn: 1, current: true },
      { row: 2, kind: 'below' },
    ])
  })
})
