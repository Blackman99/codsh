/**
 * The type-ahead queue: what leaves it, and in what shape, is what the model
 * receives — a merge that crossed a `!` line would put the shell output after
 * a thought it was meant to sit between.
 */

import { describe, expect, it } from 'vitest'
import { MessageQueue, PROMPT_JOINER, classify, mergePrompts } from '../src/queue.ts'
import type { PendingImage } from '../src/prompt.ts'

/** A pasted image by number; the bytes are beside the point here. */
const image = (id: number): PendingImage => ({ id, image: { data: '', mediaType: 'image/png' } as PendingImage['image'] })

describe('classify', () => {
  it('reads the kind the way the loop dispatches it', () => {
    expect(classify('hello')).toBe('prompt')
    expect(classify('!ls')).toBe('bang')
    expect(classify('  !ls')).toBe('bang')
    expect(classify('/help')).toBe('command')
    expect(classify('/exit')).toBe('command')
    expect(classify(' /model ')).toBe('command')
  })
})

describe('mergePrompts', () => {
  it('joins the texts with a blank line and keeps every image in order', () => {
    const queue = new MessageQueue()
    const first = queue.make('see [Image #1]', [image(1)])
    const second = queue.make('and [Image #2]', [image(2)])
    expect(mergePrompts([first, second])).toEqual({
      text: `see [Image #1]${PROMPT_JOINER}and [Image #2]`,
      images: [image(1), image(2)],
    })
  })
})

describe('MessageQueue', () => {
  it('drains adjacent prompts as one, reporting every id', () => {
    const queue = new MessageQueue()
    const one = queue.push('one', [])
    const two = queue.push('two', [])
    expect(queue.drain()).toEqual({ kind: 'prompt', text: 'one\n\ntwo', images: [], ids: [one.id, two.id] })
    expect(queue.drain()).toBeUndefined()
  })

  it('keeps a ! or / line as a boundary that leaves alone, in its place', () => {
    const queue = new MessageQueue()
    queue.push('a', [])
    queue.push('!ls', [])
    queue.push('b', [])
    queue.push('c', [])
    queue.push('/compact', [])
    expect(queue.drain()?.text).toBe('a')
    expect(queue.drain()).toMatchObject({ kind: 'bang', text: '!ls' })
    expect(queue.drain()?.text).toBe('b\n\nc')
    expect(queue.drain()).toMatchObject({ kind: 'command', text: '/compact' })
    expect(queue.length).toBe(0)
  })

  it('carries each merged line\'s images, in item order', () => {
    const queue = new MessageQueue()
    queue.push('[Image #1] first', [image(1)])
    queue.push('plain', [])
    queue.push('[Image #2] third', [image(2)])
    expect(queue.drain()?.images.map(i => i.id)).toEqual([1, 2])
  })

  it('pops the tail, removes by id, and refuses an unknown id', () => {
    const queue = new MessageQueue()
    const a = queue.push('a', [])
    const b = queue.push('b', [])
    const c = queue.push('c', [])
    expect(queue.pop()).toBe(c)
    expect(queue.remove(a.id)).toBe(a)
    expect(queue.remove(a.id)).toBeUndefined()
    expect(queue.find(b.id)).toBe(b)
    expect(queue.items.map(item => item.text)).toEqual(['b'])
  })

  it('moves an item past its neighbour and stops at the ends', () => {
    const queue = new MessageQueue()
    const a = queue.push('a', [])
    const b = queue.push('b', [])
    queue.push('c', [])
    expect(queue.move(b.id, -1)).toBe(true)
    expect(queue.items.map(item => item.text)).toEqual(['b', 'a', 'c'])
    expect(queue.move(b.id, -1)).toBe(false)
    expect(queue.move(a.id, 1)).toBe(true)
    expect(queue.items.map(item => item.text)).toEqual(['b', 'c', 'a'])
    expect(queue.move(a.id, 1)).toBe(false)
    expect(queue.move(999, 1)).toBe(false)
  })

  it('puts an item back at the head, and never reuses an id', () => {
    const queue = new MessageQueue()
    const a = queue.push('a', [])
    const b = queue.push('b', [])
    expect(queue.remove(a.id)).toBe(a)
    queue.unshift(a)
    expect(queue.items.map(item => item.id)).toEqual([a.id, b.id])
    const made = queue.make('later', [])
    expect(made.id).toBeGreaterThan(b.id)
    expect(queue.length).toBe(2)
  })
})
