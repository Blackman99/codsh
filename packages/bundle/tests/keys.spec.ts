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
    { label: 'Ctrl-T', bytes: '\u0014', key: { kind: 'toggle-todos' } },
    { label: 'Ctrl-V asks for the clipboard image', bytes: '\u0016', key: { kind: 'paste-image' } },
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

  it('turns the wheel into scroll keys', () => {
    expect(decode(`${ESC}[<64;10;5M`)).toEqual([{ kind: 'scroll', lines: -1 }])
    expect(decode(`${ESC}[<65;10;5M`)).toEqual([{ kind: 'scroll', lines: 1 }])
  })

  it('reports a left-button press, drag, and release with their position', () => {
    expect(decode(`${ESC}[<0;3;2M`)).toEqual([{ kind: 'mouse-down', row: 2, column: 3 }])
    expect(decode(`${ESC}[<32;9;4M`)).toEqual([{ kind: 'mouse-drag', row: 4, column: 9 }])
    expect(decode(`${ESC}[<0;9;4m`)).toEqual([{ kind: 'mouse-up', row: 4, column: 9 }])
  })

  it('reports the pointer moving with nothing held', () => {
    // Any-motion tracking sends 32 (motion) over 3 (no button); a modifier
    // held while the pointer merely moves is still nothing being dragged.
    expect(decode(`${ESC}[<35;10;5M`)).toEqual([{ kind: 'mouse-move', row: 5, column: 10 }])
    expect(decode(`${ESC}[<39;10;5M`)).toEqual([{ kind: 'mouse-move', row: 5, column: 10 }])
  })

  it('leaves modified and non-left clicks to the terminal', () => {
    // Shift-click (4), right button (2), and middle (1) are not ours.
    expect(decode(`${ESC}[<4;3;2M`)).toEqual([])
    expect(decode(`${ESC}[<2;3;2M`)).toEqual([])
    expect(decode(`${ESC}[<1;3;2M`)).toEqual([])
    expect(decode(`${ESC}[<36;3;2M`)).toEqual([])
  })

  it('holds a split mouse report until it completes', () => {
    const decoder = new KeyDecoder()
    expect(decoder.push(`${ESC}[<0;12`)).toEqual([])
    expect(decoder.push(';7M')).toEqual([{ kind: 'mouse-down', row: 7, column: 12 }])
  })

  it.each([
    { label: 'Shift+Enter breaks the line', bytes: `${ESC}[13;2u`, keys: [{ kind: 'newline' }] },
    { label: 'Alt+Enter still breaks the line', bytes: `${ESC}[13;3u`, keys: [{ kind: 'newline' }] },
    { label: 'plain Enter still submits', bytes: `${ESC}[13u`, keys: [{ kind: 'enter' }] },
    { label: 'Esc is unambiguous', bytes: `${ESC}[27u`, keys: [{ kind: 'escape' }] },
    { label: 'Shift+Tab', bytes: `${ESC}[9;2u`, keys: [{ kind: 'shift-tab' }] },
    { label: 'Ctrl+C interrupts', bytes: `${ESC}[99;5u`, keys: [{ kind: 'interrupt' }] },
    { label: 'Ctrl+D is EOF', bytes: `${ESC}[100;5u`, keys: [{ kind: 'eof' }] },
    { label: 'Ctrl+O expands', bytes: `${ESC}[111;5u`, keys: [{ kind: 'expand-output' }] },
    { label: 'Ctrl+V pastes the clipboard image', bytes: `${ESC}[118;5u`, keys: [{ kind: 'paste-image' }] },
    { label: 'Ctrl+T opens the todo list', bytes: `${ESC}[116;5u`, keys: [{ kind: 'toggle-todos' }] },
    { label: 'Alt+b steps a word left', bytes: `${ESC}[98;3u`, keys: [{ kind: 'word-left' }] },
    { label: 'Alt+Backspace kills a word', bytes: `${ESC}[127;3u`, keys: [{ kind: 'kill-word' }] },
  ])('decodes the kitty report: $label', ({ bytes, keys }) => {
    expect(decode(bytes)).toEqual(keys)
  })

  it('masks kitty lock bits, so Caps Lock does not change the key', () => {
    // mods 66 = 1 + shift(1) + caps_lock(64).
    expect(decode(`${ESC}[13;66u`)).toEqual([{ kind: 'newline' }])
  })

  it('takes key presses and repeats, and ignores releases', () => {
    expect(decode(`${ESC}[13;2:1u`)).toEqual([{ kind: 'newline' }])
    expect(decode(`${ESC}[13;2:2u`)).toEqual([{ kind: 'newline' }])
    expect(decode(`${ESC}[13;2:3u`)).toEqual([])
  })

  it('swallows a kitty chord it has no binding for, instead of typing it', () => {
    expect(decode(`${ESC}[99;3u`)).toEqual([])
    expect(decode(`${ESC}[98;5u`)).toEqual([])
  })

  it('holds a split kitty report until it completes', () => {
    const decoder = new KeyDecoder()
    expect(decoder.push(`${ESC}[13;`)).toEqual([])
    expect(decoder.pending).toBe(true)
    expect(decoder.push('2u')).toEqual([{ kind: 'newline' }])
  })

  it('reports focus in and out', () => {
    expect(decode(`${ESC}[I`)).toEqual([{ kind: 'focus', focused: true }])
    expect(decode(`${ESC}[O`)).toEqual([{ kind: 'focus', focused: false }])
  })

  it('consumes an OSC color answer instead of typing it', () => {
    expect(decode(`${ESC}]11;rgb:ffff/ffff/ffff\u0007`))
      .toEqual([{ kind: 'osc-reply', code: 11, payload: 'rgb:ffff/ffff/ffff' }])
    // ST-terminated answers too, and split across reads.
    const decoder = new KeyDecoder()
    expect(decoder.push(`${ESC}]11;rgb:1e1e/1e`)).toEqual([])
    expect(decoder.push(`1e/2e2e${ESC}`)).toEqual([])
    expect(decoder.push('\\')).toEqual([{ kind: 'osc-reply', code: 11, payload: 'rgb:1e1e/1e1e/2e2e' }])
  })

  it('swallows OSC answers it has no use for', () => {
    expect(decode(`${ESC}]52;c;Zm9v\u0007after`)).toEqual([{ kind: 'text', text: 'after' }])
  })
})
