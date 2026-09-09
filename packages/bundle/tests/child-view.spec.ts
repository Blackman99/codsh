/**
 * Nested Child views: a stack of in-process child Sessions, event ownership
 * for the one on top, the inherited prefix a fork view skips, and which
 * agents the keyboard answers approvals for.
 */

import { describe, expect, it } from 'vitest'
import {
  ChildViews,
  childOwnedEvents,
  ownsApproval,
  paintsViewedSession,
} from '../src/child-view.ts'

describe('ChildViews', () => {
  it('pushes on enter and pops one level per Esc', () => {
    const views = new ChildViews()
    expect(views.current).toBeUndefined()

    views.push('child')
    expect(views.current?.sessionId).toBe('child')

    views.push('grandchild')
    expect(views.current?.sessionId).toBe('grandchild')

    expect(views.pop()?.sessionId).toBe('grandchild')
    expect(views.current?.sessionId).toBe('child')

    expect(views.pop()?.sessionId).toBe('child')
    expect(views.current).toBeUndefined()
    expect(views.pop()).toBeUndefined()
  })

  it('forgets the whole stack on a session replacement', () => {
    const views = new ChildViews()
    views.push('child')
    views.push('grandchild')
    views.clear()
    expect(views.current).toBeUndefined()
  })
})

describe('paintsViewedSession', () => {
  it('owns events for the current Session and not a sibling', () => {
    const views = new ChildViews()
    views.push('child-a')
    expect(paintsViewedSession(views.current, 'child-a')).toBe(true)
    expect(paintsViewedSession(views.current, 'child-b')).toBe(false)
    expect(paintsViewedSession(views.current, 'parent')).toBe(false)
  })

  it('owns nothing when the stack is empty', () => {
    expect(paintsViewedSession(undefined, 'child-a')).toBe(false)
  })
})

describe('childOwnedEvents', () => {
  it('skips the inheritedEventCount leading events', () => {
    const events = [
      { seq: 0, type: 'parent/turn' },
      { seq: 1, type: 'parent/answer' },
      { seq: 2, type: 'child/prompt' },
      { seq: 3, type: 'child/tool' },
    ]
    expect(childOwnedEvents(events, 2)).toEqual([
      { seq: 2, type: 'child/prompt' },
      { seq: 3, type: 'child/tool' },
    ])
  })

  it('replays the whole log when nothing was inherited', () => {
    const events = [{ seq: 0, type: 'child/prompt' }]
    expect(childOwnedEvents(events, 0)).toEqual(events)
  })
})

describe('ownsApproval', () => {
  it('answers the live agent and an in-process descendant, not an unrelated agent', () => {
    const descendants = new Set(['child', 'grandchild'])
    expect(ownsApproval('parent', 'parent', descendants)).toBe(true)
    expect(ownsApproval('child', 'parent', descendants)).toBe(true)
    expect(ownsApproval('grandchild', 'parent', descendants)).toBe(true)
    expect(ownsApproval('stranger', 'parent', descendants)).toBe(false)
  })
})
