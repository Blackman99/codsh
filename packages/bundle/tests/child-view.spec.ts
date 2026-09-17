/**
 * Nested Child views: a stack of in-process child Sessions, event ownership
 * for the one on top, the inherited prefix a fork view skips, and which
 * agents the keyboard answers approvals for.
 */

import { describe, expect, it } from 'vitest'
import {
  ChildViews,
  childOwnedEvents,
  descriptorLabel,
  graphKeyedSessions,
  inProcessDescendants,
  ownsApproval,
  paintsViewedSession,
  runnerFolds,
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

  it('names a Session\'s depth on the stack', () => {
    const views = new ChildViews()
    expect(views.indexOf('child')).toBeUndefined()
    views.push('child')
    views.push('grandchild')
    expect(views.indexOf('child')).toBe(0)
    expect(views.indexOf('grandchild')).toBe(1)
    expect(views.indexOf('other')).toBeUndefined()
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

describe('inProcessDescendants', () => {
  it('collects the live tree under the parent and ignores unrelated Sessions', () => {
    expect(inProcessDescendants('parent', [
      { id: 'parent' },
      { id: 'child', parentSession: 'parent' },
      { id: 'grandchild', parentSession: 'child' },
      { id: 'other', parentSession: 'elsewhere' },
    ])).toEqual(new Set(['child', 'grandchild']))
  })
})

describe('graphKeyedSessions', () => {
  it('keeps only live Sessions that the runner still names', () => {
    expect(graphKeyedSessions(
      [{ id: 'parent' }, { id: 'child' }],
      [
        { id: 'child', graphKey: 'landing:2', label: 'Ticket 2: Teaser' },
        { id: 'gone', graphKey: 'landing:1', label: 'Ticket 1: Graph join' },
      ],
    )).toEqual([
      { id: 'child', graphKey: 'landing:2', label: 'Ticket 2: Teaser' },
    ])
  })
})

describe('runnerFolds', () => {
  it('orders one Fold per live Session by graph key and omits a leftover with no Session', () => {
    expect(runnerFolds([
      { id: 'later', graphKey: 'landing:2', label: 'Ticket 2: Teaser' },
      { id: 'first', graphKey: 'decision:local:1', label: 'Graph node identity' },
    ])).toEqual([
      { sessionId: 'first', graphKey: 'decision:local:1', label: 'Graph node identity' },
      { sessionId: 'later', graphKey: 'landing:2', label: 'Ticket 2: Teaser' },
    ])
    expect(runnerFolds([])).toEqual([])
  })

  it('adds · conflict / · repair only when two Sessions share one key', () => {
    expect(runnerFolds([
      { id: 'tdd', graphKey: 'landing:1', label: 'Ticket 1: Graph join' },
      { id: 'fix', graphKey: 'landing:1', label: 'Ticket 1: Graph join', role: 'conflict' },
    ])).toEqual([
      { sessionId: 'fix', graphKey: 'landing:1', label: 'Ticket 1: Graph join · conflict' },
      { sessionId: 'tdd', graphKey: 'landing:1', label: 'Ticket 1: Graph join · repair' },
    ])
    expect(runnerFolds([
      { id: 'only', graphKey: 'landing:1', label: 'Ticket 1: Graph join' },
    ])[0]?.label).toBe('Ticket 1: Graph join')
  })
})

describe('descriptorLabel', () => {
  it('reads the trimmed creation label from the child\'s descriptor event', () => {
    const events = [
      { type: 'turn/start', data: {} },
      { type: 'subagent/descriptor', data: { mode: 'continuable', label: '  Investigate CONTEXT.md  ' } },
      { type: 'subagent/descriptor', data: { mode: 'continuable', label: 'later, ignored' } },
    ]
    expect(descriptorLabel(events)).toBe('Investigate CONTEXT.md')
  })

  it('answers nothing for a log with no descriptor, or an empty label', () => {
    expect(descriptorLabel([{ type: 'turn/start', data: {} }])).toBeUndefined()
    expect(descriptorLabel([{ type: 'subagent/descriptor', data: { mode: 'one-shot' } }])).toBeUndefined()
    expect(descriptorLabel([{ type: 'subagent/descriptor', data: { label: '   ' } }])).toBeUndefined()
    expect(descriptorLabel([{ type: 'subagent/descriptor', data: null }])).toBeUndefined()
  })
})
