/**
 * Byte decoding. A terminal splits sequences across reads, so the decoder has to
 * hold what it cannot yet resolve — and must still report a key that is only
 * ever sent alone.
 */

import { describe, expect, it } from 'vitest'
import { KeyDecoder } from '../src/keys.ts'
import type { Key } from '../src/keys.ts'

const ESC = '\u001B'

/** Feed chunks in order and collect every key produced. */
function decode(...chunks: string[]): Key[] {
  const decoder = new KeyDecoder()
  return chunks.flatMap(chunk => decoder.push(chunk))
}

describe('KeyDecoder', () => {
  it('takes printable text in one key, so fast typing is not split', () => {
    expect(decode('hello')).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('keeps a multi-byte character whole', () => {
    expect(decode('终端')).toEqual([{ kind: 'text', text: '终端' }])
  })

  it.each([
    { label: 'Enter submits', bytes: '\r', key: { kind: 'enter' } },
    { label: 'a line feed also submits', bytes: '\n', key: { kind: 'enter' } },
    { label: 'Tab', bytes: '\t', key: { kind: 'tab' } },
    { label: 'Backspace', bytes: '\u007F', key: { kind: 'backspace' } },
    { label: 'Ctrl-C', bytes: '\u0003', key: { kind: 'interrupt' } },
    { label: 'Ctrl-D', bytes: '\u0004', key: { kind: 'eof' } },
    { label: 'Ctrl-A', bytes: '\u0001', key: { kind: 'home' } },
    { label: 'Ctrl-E', bytes: '\u0005', key: { kind: 'end' } },
    { label: 'Ctrl-W', bytes: '\u0017', key: { kind: 'kill-word' } },
    { label: 'Ctrl-L', bytes: '\u000C', key: { kind: 'clear-screen' } },
  ])('decodes $label', ({ bytes, key }) => {
    expect(decode(bytes)).toEqual([key])
  })

  it.each([
    { label: 'up', bytes: `${ESC}[A`, kind: 'up' },
    { label: 'down', bytes: `${ESC}[B`, kind: 'down' },
    { label: 'right', bytes: `${ESC}[C`, kind: 'right' },
    { label: 'left', bytes: `${ESC}[D`, kind: 'left' },
    { label: 'home', bytes: `${ESC}[H`, kind: 'home' },
    { label: 'shift-tab', bytes: `${ESC}[Z`, kind: 'shift-tab' },
    { label: 'word left (Ctrl)', bytes: `${ESC}[1;5D`, kind: 'word-left' },
    { label: 'word right (Alt)', bytes: `${ESC}[1;3C`, kind: 'word-right' },
    { label: 'word left (Alt-b)', bytes: `${ESC}b`, kind: 'word-left' },
    { label: 'end', bytes: `${ESC}OF`, kind: 'end' },
    { label: 'delete', bytes: `${ESC}[3~`, kind: 'delete' },
  ])('decodes the $label sequence', ({ bytes, kind }) => {
    expect(decode(bytes)).toEqual([{ kind }])
  })

  it('reassembles a sequence split across reads', () => {
    // A terminal is free to deliver `ESC`, `[`, `A` as three reads.
    expect(decode(ESC, '[', 'A')).toEqual([{ kind: 'up' }])
  })

  it('holds an Escape until nothing follows it, then reports the key', () => {
    // `ESC` alone and the first byte of `ESC [ A` are the same byte: only the
    // absence of a successor tells them apart.
    const decoder = new KeyDecoder()
    expect(decoder.push(ESC)).toEqual([])
    expect(decoder.flush()).toEqual([{ kind: 'escape' }])
  })

  it('does not turn a real sequence prefix into Escape on flush', () => {
    const decoder = new KeyDecoder()
    decoder.push(`${ESC}[`)
    expect(decoder.flush()).toEqual([])
    expect(decoder.push('A')).toEqual([{ kind: 'up' }])
  })

  it('does not flush an Escape while a paste is open', () => {
    const decoder = new KeyDecoder()
    decoder.push(`${ESC}[200~text`)
    expect(decoder.flush()).toEqual([])
  })

  it('kills a word on Alt-Backspace', () => {
    expect(decode(`${ESC}\u007F`)).toEqual([{ kind: 'kill-word' }])
  })

  it('treats Alt-Enter as a line break, which is what adds a line', () => {
    expect(decode(`${ESC}\r`)).toEqual([{ kind: 'newline' }])
    expect(decode(`${ESC}\n`)).toEqual([{ kind: 'newline' }])
  })

  it('reads a bracketed paste as one key, newlines included', () => {
    const pasted = `${ESC}[200~first\nsecond${ESC}[201~`
    expect(decode(pasted)).toEqual([{ kind: 'paste', text: 'first\nsecond' }])
  })

  it('assembles a paste split across reads', () => {
    expect(decode(`${ESC}[200~one`, '\ntwo', `${ESC}[201~`))
      .toEqual([{ kind: 'paste', text: 'one\ntwo' }])
  })

  it('never emits a partial end marker as pasted text', () => {
    const decoder = new KeyDecoder()
    decoder.push(`${ESC}[200~text`)
    // The marker's first bytes must not be delivered as content.
    expect(decoder.push(`${ESC}[20`)).toEqual([])
    expect(decoder.push('1~')).toEqual([{ kind: 'paste', text: 'text' }])
  })

  it('takes control bytes inside a paste as content, not as commands', () => {
    // Pasted text can contain anything; a Ctrl-C in it must not interrupt.
    expect(decode(`${ESC}[200~ab${ESC}[201~`))
      .toEqual([{ kind: 'paste', text: 'ab' }])
  })

  it('holds an incomplete sequence rather than guessing', () => {
    const decoder = new KeyDecoder()
    expect(decoder.push(`${ESC}[`)).toEqual([])
    expect(decoder.pending).toBe(true)
    expect(decoder.push('B')).toEqual([{ kind: 'down' }])
    expect(decoder.pending).toBe(false)
  })

  it('drops an escape sequence it has no binding for', () => {
    // The introducer must not end up typed into the buffer as a control byte.
    expect(decode(`${ESC}Z`)).toEqual([{ kind: 'text', text: 'Z' }])
  })

  it('decodes several keys from one read', () => {
    expect(decode('ab\r')).toEqual([{ kind: 'text', text: 'ab' }, { kind: 'enter' }])
  })
})
