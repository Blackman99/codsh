/** The list `/resume` offers: this workspace first, newest work first. */

import { describe, expect, it } from 'vitest'
import { age, shapeResume } from '../src/resume.ts'
import type { ResumeCandidate } from '../src/resume.ts'

const NOW = 1_700_000_000_000
const ago = (ms: number): number => NOW - ms
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('age', () => {
  it('reads as a person would say it', () => {
    expect(age(NOW, NOW)).toBe('just now')
    expect(age(ago(59_000), NOW)).toBe('just now')
    expect(age(ago(5 * MINUTE), NOW)).toBe('5m ago')
    expect(age(ago(3 * HOUR), NOW)).toBe('3h ago')
    expect(age(ago(2 * DAY), NOW)).toBe('2d ago')
  })
})

describe('shapeResume', () => {
  const candidate = (over: Partial<ResumeCandidate> & { id: string }): ResumeCandidate =>
    ({ createdAt: ago(9 * DAY), cwd: '/repo', ...over })

  it('keeps this workspace apart from everywhere else', () => {
    const { here, elsewhere } = shapeResume([
      candidate({ id: 'a', title: 'here one' }),
      candidate({ id: 'b', title: 'over there', cwd: '/other' }),
      candidate({ id: 'c', title: 'here two' }),
    ], '/repo', NOW)
    expect(here.map(r => r.id)).toEqual(['a', 'c'])
    expect(elsewhere.map(r => r.id)).toEqual(['b'])
  })

  it('orders by when the work was last touched, not when it began', () => {
    // The session started first is the one worked on last; created-at order
    // would bury it, which is what made the list hard to use.
    const { here } = shapeResume([
      candidate({ id: 'old-start', createdAt: ago(9 * DAY), lastActive: ago(2 * MINUTE) }),
      candidate({ id: 'new-start', createdAt: ago(1 * HOUR), lastActive: ago(1 * HOUR) }),
    ], '/repo', NOW)
    expect(here.map(r => r.id)).toEqual(['old-start', 'new-start'])
    expect(here[0]?.detail).toContain('2m ago')
  })

  it('falls back to when it began if the log would not say', () => {
    const { here } = shapeResume([candidate({ id: 'a', createdAt: ago(3 * HOUR) })], '/repo', NOW)
    expect(here[0]?.detail).toBe('3h ago')
  })

  it('names what a row is: title, age, size', () => {
    const { here } = shapeResume([
      candidate({ id: 'a', title: 'Fix the decoder', lastActive: ago(2 * HOUR), messages: 48 }),
    ], '/repo', NOW)
    expect(here[0]?.label).toBe('Fix the decoder')
    expect(here[0]?.detail).toBe('2h ago · 48 messages')
  })

  it('counts one message in the singular', () => {
    const { here } = shapeResume([candidate({ id: 'a', lastActive: NOW, messages: 1 })], '/repo', NOW)
    expect(here[0]?.detail).toBe('just now · 1 message')
  })

  it('falls back to the id when a session has no title', () => {
    const { here } = shapeResume([candidate({ id: 'session-abc' })], '/repo', NOW)
    expect(here[0]?.label).toBe('session-abc')
  })

  it('shows the folder as a person reads it, when one is given', () => {
    const { elsewhere } = shapeResume([
      { id: 'a', createdAt: NOW, cwd: '/Users/me/work/api', folder: '~/work/api' },
    ], '/repo', NOW)
    expect(elsewhere[0]?.detail).toContain('~/work/api')
    expect(elsewhere[0]?.detail).not.toContain('/Users/me')
  })

  it('spends width on the folder only when it is another one', () => {
    const { here, elsewhere } = shapeResume([
      candidate({ id: 'a', lastActive: NOW }),
      candidate({ id: 'b', cwd: '/elsewhere', lastActive: NOW }),
    ], '/repo', NOW)
    expect(here[0]?.detail).not.toContain('/repo')
    expect(elsewhere[0]?.detail).toContain('/elsewhere')
  })

  it('treats a session that recorded no folder as elsewhere', () => {
    const { here, elsewhere } = shapeResume([{ id: 'a', createdAt: NOW }], '/repo', NOW)
    expect(here).toEqual([])
    expect(elsewhere.map(r => r.id)).toEqual(['a'])
    // Nothing to name, so nothing is added beyond the age.
    expect(elsewhere[0]?.detail).toBe('just now')
  })
})
