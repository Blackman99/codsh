/**
 * A workflow round's progress, read off its child's log: the figures that
 * keep the working line moving while a Ralph round works for minutes.
 */

import { describe, expect, it } from 'vitest'
import { NO_PROGRESS, advanceRound, describeCall, roundActivity } from '../src/round-watch.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** A child's tool call, as the log records it. */
const call = (seq: number, name: string, args: Record<string, unknown>): SessionEvent =>
  ({ seq, time: 0, type: 'tool/call', data: { turn: 1, step: seq, callId: `${name}-${String(seq)}`, name, arguments: JSON.stringify(args) } }) as unknown as SessionEvent
const other = (seq: number): SessionEvent => ({ seq, time: 0, type: 'step/start', data: { turn: 1, step: seq } }) as unknown as SessionEvent

describe('advanceRound', () => {
  it('counts the calls past the cursor and names the latest', () => {
    const events = [other(0), call(1, 'read', { file_path: 'docs/spec.md' }), other(2), call(3, 'bash', { command: 'python3 -m pytest -v', description: 'Run the tests' })]
    const { progress, moved } = advanceRound(NO_PROGRESS, events)
    expect(moved).toBe(true)
    expect(progress).toEqual({ cursor: 3, calls: 2, latest: 'bash: python3 -m pytest -v' })
  })

  it('reads only what is new on the next poll', () => {
    const first = advanceRound(NO_PROGRESS, [call(0, 'read', { file_path: 'a' })]).progress
    const again = advanceRound(first, [call(0, 'read', { file_path: 'a' })])
    expect(again.moved).toBe(false)
    expect(again.progress).toEqual(first)
    const more = advanceRound(first, [call(0, 'read', { file_path: 'a' }), call(1, 'write', { file_path: 'b' })])
    expect(more.progress).toEqual({ cursor: 1, calls: 2, latest: 'write: b' })
  })

  it('prefers the presenter\'s own words for a call', () => {
    const { progress } = advanceRound(NO_PROGRESS, [call(0, 'edit', { file_path: 'x.ts' })], (name, args) =>
      name === 'edit' && typeof args === 'object' ? 'x.ts (+2 −1)' : undefined)
    expect(progress.latest).toBe('edit: x.ts (+2 −1)')
  })
})

describe('describeCall', () => {
  it('picks the argument that says most, on one line', () => {
    expect(describeCall('bash', JSON.stringify({ command: 'git\n  status' }))).toBe('bash: git status')
    expect(describeCall('glob', JSON.stringify({ pattern: '**/*.py' }))).toBe('glob: **/*.py')
    expect(describeCall('skill', JSON.stringify({ name: 'tdd' }))).toBe('skill: tdd')
  })

  it('falls back to the bare name for arguments it cannot read', () => {
    expect(describeCall('todo_write', '{not json')).toBe('todo_write')
    expect(describeCall('todo_write', JSON.stringify({ todos: [] }))).toBe('todo_write')
  })

  it('absorbs a throwing presenter', () => {
    expect(describeCall('bash', JSON.stringify({ command: 'ls' }), () => { throw new Error('no') })).toBe('bash: ls')
  })
})

describe('roundActivity', () => {
  it('says nothing before the first call, then counts with the latest', () => {
    expect(roundActivity(NO_PROGRESS)).toBeUndefined()
    expect(roundActivity({ cursor: 0, calls: 1, latest: 'read: a' })).toBe('1 call · read: a')
    expect(roundActivity({ cursor: 5, calls: 12, latest: 'bash: pytest' })).toBe('12 calls · bash: pytest')
    expect(roundActivity({ cursor: 5, calls: 2, latest: undefined })).toBe('2 calls')
  })
})
