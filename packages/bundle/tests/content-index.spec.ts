/** Raw assistant content is indexed independently of terminal rendering. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { indexConversationContent, newestCopyTargets, resolveCopyTarget } from '../src/content-index.ts'

function answer(text: string, source: Record<string, unknown> = { kind: 'model' }): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }], source },
    },
  } as unknown as SessionEvent
}

describe('conversation content index', () => {
  it('indexes raw answers and fence-free code with stable addresses', () => {
    const targets = indexConversationContent([
      answer('First **answer**.\n\n```ts\nconst one = 1\n```'),
      answer('Second answer.\n\n~~~py\nprint("two")\n~~~'),
    ])

    expect(targets.map(target => [target.address, target.kind, target.text])).toEqual([
      ['1', 'answer', 'First **answer**.\n\n```ts\nconst one = 1\n```'],
      ['1:1', 'code', 'const one = 1'],
      ['2', 'answer', 'Second answer.\n\n~~~py\nprint("two")\n~~~'],
      ['2:1', 'code', 'print("two")'],
    ])
  })

  it('ignores tools, images, reasoning, and malformed fences but keeps plugin answers', () => {
    const events = [
      { type: 'tool/call', seq: 1, time: 0, data: {} },
      answer(''),
      answer('```ts\nnever closes'),
      {
        type: 'assistant/message', seq: 2, time: 0,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'secret' }, { type: 'image', attachment: {} }], source: { kind: 'model' } } },
      },
      answer('Plugin-produced answer', { kind: 'plugin', plugin: 'example' }),
    ] as unknown as SessionEvent[]

    expect(indexConversationContent(events).map(target => target.address)).toEqual(['1', '2'])
    expect(indexConversationContent(events).at(-1)?.text).toBe('Plugin-produced answer')
  })

  it('ignores whitespace-only answers and strips terminal escapes from raw targets', () => {
    const targets = indexConversationContent([
      answer(' \r\n\t'),
      answer('\u001B[31mPlugin answer\u001B[0m\n```txt\n\u001B[32mcode\u001B[0m\n```', { kind: 'plugin' }),
    ])
    expect(targets.map(target => [target.address, target.text])).toEqual([
      ['1', 'Plugin answer\n```txt\ncode\n```'],
      ['1:1', 'code'],
    ])
  })

  it('retains empty fenced blocks in the stable code ordinal', () => {
    const targets = indexConversationContent([answer('```txt\n```\n```txt\nsecond\n```')])
    expect(targets.map(target => [target.address, target.text])).toEqual([
      ['1', '```txt\n```\n```txt\nsecond\n```'],
      ['1:1', ''],
      ['1:2', 'second'],
    ])
  })

  it('does not expose fences the transcript renderer treats as prose', () => {
    const invalidInfo = indexConversationContent([answer('```js`bad\nnot code\n```js`bad')])
    const unmatched = indexConversationContent([answer('```js\nnever closes')])
    expect(invalidInfo.map(target => target.address)).toEqual(['1'])
    expect(unmatched.map(target => target.address)).toEqual(['1'])
  })

  it('offers newest answers first while keeping each answer before its code', () => {
    const targets = indexConversationContent([
      answer('one\n```txt\nA\n```'),
      answer('two\n```txt\nB\n```'),
    ])
    expect(newestCopyTargets(targets).map(target => target.address)).toEqual(['2', '2:1', '1', '1:1'])
  })

  it('preserves line endings inside an exact code target', () => {
    const targets = indexConversationContent([answer('~~~txt\r\nfirst\r\nsecond\r\n~~~')])
    expect(resolveCopyTarget(targets, '1:1')?.text).toBe('first\r\nsecond')
  })

  it('resolves only canonical answer and code addresses', () => {
    const targets = indexConversationContent([answer('one\n```txt\nA\n```')])
    expect(resolveCopyTarget(targets, '1')?.text).toBe(targets[0]?.text)
    expect(resolveCopyTarget(targets, '1:1')?.text).toBe('A')
    for (const invalid of ['', '0', '1:0', '01', '1:', '1:2', 'answer']) {
      expect(resolveCopyTarget(targets, invalid)).toBeUndefined()
    }
  })
})
