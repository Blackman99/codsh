/**
 * Sticky turn headers are a pure layout decision over virtual transcript rows.
 */

import { describe, expect, it } from 'vitest'
import { computeStickyLayout } from '../src/sticky.ts'

describe('sticky turn header layout', () => {
  it('appears only after its prompt has crossed the viewport top', () => {
    const prompts = [{ at: 4, fullHeight: 3, minHeight: 1, sticky: true }]

    expect(computeStickyLayout(4, 10, prompts)).toBeUndefined()
    expect(computeStickyLayout(5, 10, prompts)).toEqual({
      prompt: 0,
      state: 'pinned',
      renderHeight: 2,
      clipTop: 0,
      reservedRows: 3,
    })
  })

  it('lets the next prompt push the old header out without duplicating either', () => {
    const prompts = [
      { at: 0, fullHeight: 3, minHeight: 3, sticky: true },
      { at: 10, fullHeight: 2, minHeight: 1, sticky: true },
    ]

    expect(computeStickyLayout(7, 10, prompts)).toEqual({
      prompt: 0,
      state: 'pushed',
      renderHeight: 2,
      clipTop: 1,
      reservedRows: 2,
    })
    expect(computeStickyLayout(9, 10, prompts)).toBeUndefined()
    expect(computeStickyLayout(10, 10, prompts)).toBeUndefined()
    expect(computeStickyLayout(11, 10, prompts)?.prompt).toBe(1)
  })

  it('treats an expanded long prompt as a boundary that does not itself pin', () => {
    const prompts = [
      { at: 0, fullHeight: 1, minHeight: 1, sticky: true },
      { at: 6, fullHeight: 8, minHeight: 1, sticky: false },
      { at: 20, fullHeight: 1, minHeight: 1, sticky: true },
    ]

    expect(computeStickyLayout(7, 10, prompts)).toBeUndefined()
    expect(computeStickyLayout(21, 10, prompts)?.prompt).toBe(2)
  })

  it('keeps the final prompt pinned at its compact height', () => {
    const prompts = [{ at: 2, fullHeight: 3, minHeight: 1, sticky: true }]

    expect(computeStickyLayout(3, 10, prompts)?.renderHeight).toBe(2)
    expect(computeStickyLayout(4, 10, prompts)?.renderHeight).toBe(1)
    expect(computeStickyLayout(40, 10, prompts)).toMatchObject({ state: 'pinned', renderHeight: 1 })
  })

  it('clamps the header to a tiny viewport without inventing a gap row', () => {
    const prompts = [{ at: 0, fullHeight: 3, minHeight: 1, sticky: true }]

    expect(computeStickyLayout(1, 1, prompts)).toEqual({
      prompt: 0,
      state: 'pinned',
      renderHeight: 1,
      clipTop: 0,
      reservedRows: 1,
    })
  })

  it('reverses the same one-row hand-off when scrolling back up', () => {
    const prompts = [
      { at: 0, fullHeight: 3, minHeight: 1, sticky: true },
      { at: 10, fullHeight: 2, minHeight: 1, sticky: true },
    ]
    const down = [7, 8, 9, 10, 11].map(top => computeStickyLayout(top, 10, prompts))
    const up = [11, 10, 9, 8, 7].map(top => computeStickyLayout(top, 10, prompts))

    expect(up).toEqual([...down].reverse())
  })
})
