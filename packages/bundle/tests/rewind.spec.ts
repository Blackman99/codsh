/**
 * Rewind points: one per typed prompt, each forking from just before its turn
 * opened.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { rewindPoints } from '../src/rewind.ts'

let seq = 0
const event = (type: string, data: unknown): SessionEvent => ({ type, seq: ++seq, time: 0, data } as unknown as SessionEvent)
const user = (text: string, kind = 'user'): SessionEvent =>
  event('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind } })
const assistant = (text: string): SessionEvent =>
  event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } })

describe('rewindPoints', () => {
  it('offers each typed turn, forked from the event before its opening', () => {
    seq = 0
    const events = [
      event('approval/policy', { policy: 'ask' }),   // 1
      event('turn/start', { turn: 1 }),               // 2
      user('first question'),                         // 3
      assistant('first answer'),                      // 4
      event('turn/end', { turn: 1, reason: { kind: 'complete' } }), // 5
      event('turn/start', { turn: 2 }),               // 6
      user('second question\nwith a second line'),    // 7
      assistant('second answer'),                     // 8
      event('turn/end', { turn: 2, reason: { kind: 'complete' } }), // 9
    ]
    expect(rewindPoints(events)).toEqual([
      { turn: 1, summary: 'first question', boundary: 1 },
      { turn: 2, summary: 'second question', boundary: 5 },
    ])
  })

  it('has no boundary for a turn nothing precedes', () => {
    seq = 0
    const events = [event('turn/start', { turn: 1 }), user('alone'), event('turn/end', { turn: 1, reason: { kind: 'complete' } })]
    expect(rewindPoints(events)).toEqual([{ turn: 1, summary: 'alone', boundary: undefined }])
  })

  it('skips injected context and goal rounds, and a turn that entered nothing', () => {
    seq = 0
    const events = [
      event('session/seed', {}),                       // 1
      event('turn/start', { turn: 1 }),                // 2
      event('turn/end', { turn: 1, reason: { kind: 'rejected' } }), // 3: no prompt entered
      user('<skill> injected', 'inject'),              // 4
      event('turn/start', { turn: 2 }),                // 5
      user('typed'),                                   // 6
      event('turn/end', { turn: 2, reason: { kind: 'complete' } }), // 7
    ]
    expect(rewindPoints(events)).toEqual([{ turn: 1, summary: 'typed', boundary: 4 }])
  })

  it('forks from just before a prompt whose opening was not recorded', () => {
    seq = 0
    const events = [event('session/seed', {}), user('old shape'), assistant('reply')]
    expect(rewindPoints(events)).toEqual([{ turn: 1, summary: 'old shape', boundary: 1 }])
  })

  it('summarizes by the first non-empty line, past pasted images, and caps it', () => {
    seq = 0
    const long = 'x'.repeat(100)
    const events = [
      event('turn/start', { turn: 1 }), user('\n\n  spaced  \nmore'), event('turn/end', { turn: 1, reason: { kind: 'complete' } }),
      event('turn/start', { turn: 2 }), user(`<pasted-image path="a.png">\n${long}`), event('turn/end', { turn: 2, reason: { kind: 'complete' } }),
      event('turn/start', { turn: 3 }), user('   '), event('turn/end', { turn: 3, reason: { kind: 'complete' } }),
    ]
    const summaries = rewindPoints(events).map(point => point.summary)
    expect(summaries[0]).toBe('spaced')
    expect(summaries[1]).toHaveLength(60)
    expect(summaries[1]?.endsWith('…')).toBe(true)
    expect(summaries[2]).toBe('(empty)')
  })

  it('offers nothing before the first prompt', () => {
    seq = 0
    expect(rewindPoints([event('session/seed', {}), event('turn/start', { turn: 1 })])).toEqual([])
  })
})
