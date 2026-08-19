/**
 * The editing model: multi-line buffer, cursor, history, and a completion menu
 * that opens as a command is typed rather than only when asked for.
 */

import { describe, expect, it } from 'vitest'
import { Editor } from '../src/editor.ts'
import type { EditorAction } from '../src/editor.ts'
import type { Key } from '../src/keys.ts'

const commands = [
  { name: 'compact', description: 'compact history' },
  { name: 'plan', description: 'enter or leave plan mode' },
  { name: 'permission', description: 'switch the preset' },
]

/** An editor whose path source offers two fixed candidates. */
function build(): Editor {
  return new Editor({
    commands: () => commands,
    paths: (token: string) => [['@src/index.ts', '@src/invariant.ts'].filter(p => p.startsWith(token)), token],
    commandArguments: (command: string, typed: string) => {
      if (command !== 'permission') return []
      return ['read-only', 'workspace-write'].filter(value => value.startsWith(typed))
        .map(value => ({ value, detail: value === 'workspace-write' ? 'current' : '' }))
    },
  })
}

/** Type text one key at a time. */
function type(editor: Editor, text: string): EditorAction {
  let last: EditorAction = { kind: 'none' }
  for (const character of text) last = editor.handle({ kind: 'text', text: character })
  return last
}

/** Shorthand for a bare key. */
const key = (kind: Key['kind']): Key => ({ kind } as Key)

describe('editing', () => {
  it('inserts text and tracks the cursor', () => {
    const editor = build()
    type(editor, 'hello')
    expect(editor.view.lines).toEqual(['hello'])
    expect(editor.view.column).toBe(5)
  })

  it('inserts a line break without submitting', () => {
    const editor = build()
    type(editor, 'first')
    expect(editor.handle(key('newline'))).toEqual({ kind: 'none' })
    type(editor, 'second')
    expect(editor.view.lines).toEqual(['first', 'second'])
    expect(editor.view.row).toBe(1)
  })

  it('submits on Enter and clears the buffer', () => {
    const editor = build()
    type(editor, 'do it')
    expect(editor.handle(key('enter'))).toEqual({ kind: 'submit', text: 'do it' })
    expect(editor.view.lines).toEqual([''])
  })

  it('submits a multi-line buffer as one message', () => {
    const editor = build()
    type(editor, 'one')
    editor.handle(key('newline'))
    type(editor, 'two')
    expect(editor.handle(key('enter'))).toEqual({ kind: 'submit', text: 'one\ntwo' })
  })

  it('ignores Enter on a blank prompt', () => {
    expect(build().handle(key('enter'))).toEqual({ kind: 'none' })
  })

  it('takes a paste as content, newlines included', () => {
    const editor = build()
    editor.handle({ kind: 'paste', text: 'line one\nline two' })
    expect(editor.view.lines).toEqual(['line one', 'line two'])
    // The paste did not submit; the person still decides when to send it.
    expect(editor.text).toBe('line one\nline two')
  })

  it('backspaces across a line boundary', () => {
    const editor = build()
    type(editor, 'ab')
    editor.handle(key('newline'))
    editor.handle(key('backspace'))
    expect(editor.view.lines).toEqual(['ab'])
    expect(editor.view.column).toBe(2)
  })

  it('deletes forward across a line boundary', () => {
    const editor = build()
    type(editor, 'ab')
    editor.handle(key('newline'))
    type(editor, 'cd')
    editor.handle(key('home'))
    editor.handle(key('left'))
    editor.handle(key('delete'))
    expect(editor.view.lines).toEqual(['abcd'])
  })

  it('moves by character, wrapping between lines', () => {
    const editor = build()
    type(editor, 'ab')
    editor.handle(key('newline'))
    type(editor, 'cd')
    editor.handle(key('home'))
    editor.handle(key('left'))
    expect(editor.view.row).toBe(0)
    expect(editor.view.column).toBe(2)
    editor.handle(key('right'))
    expect(editor.view.row).toBe(1)
    expect(editor.view.column).toBe(0)
  })

  it('kills to the end of the line, before it, and by word', () => {
    const editor = build()
    type(editor, 'alpha beta')
    editor.handle(key('kill-word'))
    expect(editor.text).toBe('alpha ')
    editor.handle(key('kill-input'))
    expect(editor.text).toBe('')
    type(editor, 'keep drop')
    editor.handle(key('home'))
    for (let at = 0; at < 4; at += 1) editor.handle(key('right'))
    editor.handle(key('kill-line'))
    expect(editor.text).toBe('keep')
  })

  it('counts a wide character as one position', () => {
    const editor = build()
    type(editor, '终端')
    expect(editor.view.column).toBe(2)
    editor.handle(key('backspace'))
    expect(editor.text).toBe('终')
  })

  it('leaves on Ctrl-D only when the prompt is untouched', () => {
    const editor = build()
    expect(editor.handle(key('eof'))).toEqual({ kind: 'eof' })
    type(editor, 'x')
    // With text in hand it would silently discard work.
    expect(editor.handle(key('eof'))).toEqual({ kind: 'none' })
  })

  it('reports an interrupt regardless of buffer state', () => {
    const editor = build()
    type(editor, 'busy')
    expect(editor.handle(key('interrupt'))).toEqual({ kind: 'interrupt' })
  })
})

describe('completion menu', () => {
  it('opens as a command is typed, without asking', () => {
    const editor = build()
    type(editor, '/p')
    expect(editor.view.candidates.map(c => c.value)).toEqual(['/plan', '/permission'])
    expect(editor.view.candidates[0]?.detail).toBe('enter or leave plan mode')
  })

  it('narrows as more is typed and closes when nothing matches', () => {
    const editor = build()
    type(editor, '/pl')
    expect(editor.view.candidates.map(c => c.value)).toEqual(['/plan'])
    type(editor, 'zz')
    expect(editor.view.candidates).toEqual([])
  })

  it('closes once the command is complete, since the word is finished', () => {
    const editor = build()
    type(editor, '/plan')
    expect(editor.view.candidates).toEqual([])
  })

  it('offers no commands mid-sentence, where a slash is not a command', () => {
    const editor = build()
    type(editor, 'use /p for')
    expect(editor.view.candidates).toEqual([])
  })

  it('moves the selection with Tab and the arrows', () => {
    const editor = build()
    type(editor, '/p')
    expect(editor.view.selected).toBe(0)
    editor.handle(key('tab'))
    expect(editor.view.selected).toBe(1)
    editor.handle(key('down'))
    expect(editor.view.selected).toBe(0)
    editor.handle(key('up'))
    expect(editor.view.selected).toBe(1)
  })

  it('accepts the selection on Enter instead of submitting', () => {
    const editor = build()
    type(editor, '/p')
    editor.handle(key('tab'))
    expect(editor.handle(key('enter'))).toEqual({ kind: 'none' })
    expect(editor.text).toBe('/permission')
  })

  it('finishes the word on Tab when only one candidate matches', () => {
    const editor = build()
    type(editor, '/co')
    editor.handle(key('tab'))
    expect(editor.text).toBe('/compact')
  })

  it('closes on Escape rather than reporting it', () => {
    const editor = build()
    type(editor, '/p')
    expect(editor.handle(key('escape'))).toEqual({ kind: 'none' })
    expect(editor.view.candidates).toEqual([])
    // With no menu to dismiss, Escape is the caller's business.
    expect(editor.handle(key('escape'))).toEqual({ kind: 'escape' })
  })

  it('offers a command argument once the command word is finished', () => {
    const editor = build()
    type(editor, '/permission ')
    // The empty argument token offers everything the command takes.
    expect(editor.view.candidates.map(c => c.value)).toEqual(['read-only', 'workspace-write'])
    type(editor, 'w')
    expect(editor.view.candidates.map(c => c.value)).toEqual(['workspace-write'])
    editor.handle(key('tab'))
    expect(editor.text).toBe('/permission workspace-write')
  })

  it('offers no arguments for a command that takes none', () => {
    const editor = build()
    type(editor, '/compact x')
    expect(editor.view.candidates).toEqual([])
  })

  it('offers no arguments past the first one', () => {
    const editor = build()
    type(editor, '/permission read-only extra')
    // The third word is the command's own business, not the completer's.
    expect(editor.view.candidates).toEqual([])
  })

  it('completes an @ mention anywhere in the line', () => {
    const editor = build()
    type(editor, 'explain @src/i')
    expect(editor.view.candidates.map(c => c.value)).toEqual(['@src/index.ts', '@src/invariant.ts'])
    editor.handle(key('tab'))
    editor.handle(key('enter'))
    expect(editor.text).toBe('explain @src/invariant.ts')
  })
})

describe('word movement', () => {
  it('steps by word in both directions', () => {
    const editor = build()
    type(editor, 'alpha beta gamma')
    editor.handle(key('word-left'))
    expect(editor.view.column).toBe(11)
    editor.handle(key('word-left'))
    expect(editor.view.column).toBe(6)
    editor.handle(key('word-right'))
    expect(editor.view.column).toBe(10)
  })

  it('stops at the line edges', () => {
    const editor = build()
    type(editor, 'one')
    editor.handle(key('word-right'))
    expect(editor.view.column).toBe(3)
    editor.handle(key('home'))
    editor.handle(key('word-left'))
    expect(editor.view.column).toBe(0)
  })
})

describe('history', () => {
  it('recalls submissions with the up arrow', () => {
    const editor = build()
    type(editor, 'first')
    editor.handle(key('enter'))
    type(editor, 'second')
    editor.handle(key('enter'))
    editor.handle(key('up'))
    expect(editor.text).toBe('second')
    editor.handle(key('up'))
    expect(editor.text).toBe('first')
  })

  it('gives back the line being written when stepping past the newest entry', () => {
    const editor = build()
    type(editor, 'done')
    editor.handle(key('enter'))
    type(editor, 'draft')
    editor.handle(key('up'))
    expect(editor.text).toBe('done')
    editor.handle(key('down'))
    // The draft was set aside, not discarded.
    expect(editor.text).toBe('draft')
  })

  it('stops at the oldest entry', () => {
    const editor = build()
    type(editor, 'only')
    editor.handle(key('enter'))
    editor.handle(key('up'))
    editor.handle(key('up'))
    expect(editor.text).toBe('only')
  })

  it('does not record an immediate repeat twice', () => {
    const editor = build()
    type(editor, 'same')
    editor.handle(key('enter'))
    type(editor, 'same')
    editor.handle(key('enter'))
    editor.handle(key('up'))
    editor.handle(key('up'))
    // Two entries would make the second Up land on the same text again.
    expect(editor.text).toBe('same')
  })

  it('starts where a seeded history ended', () => {
    const editor = build()
    editor.seedHistory(['older', 'newer'])
    editor.handle(key('up'))
    expect(editor.text).toBe('newer')
    editor.handle(key('up'))
    expect(editor.text).toBe('older')
  })

  it('reports its submissions for persistence', () => {
    const editor = build()
    type(editor, 'kept')
    editor.handle(key('enter'))
    expect(editor.pastSubmissions).toEqual(['kept'])
  })

  it('recalls a multi-line submission whole', () => {
    const editor = build()
    type(editor, 'one')
    editor.handle(key('newline'))
    type(editor, 'two')
    editor.handle(key('enter'))
    editor.handle(key('up'))
    expect(editor.view.lines).toEqual(['one', 'two'])
  })

  it('moves within a multi-line buffer before reaching history', () => {
    const editor = build()
    type(editor, 'kept')
    editor.handle(key('enter'))
    type(editor, 'a')
    editor.handle(key('newline'))
    type(editor, 'b')
    editor.handle(key('up'))
    // The first Up moves inside the buffer; history is only past its edge.
    expect(editor.view.row).toBe(0)
    expect(editor.text).toBe('a\nb')
  })
})

describe('recall for editing', () => {
  it('prefills the buffer with earlier text, cursor at its end', () => {
    const editor = build()
    editor.prefill('first line\nsecond')
    expect(editor.text).toBe('first line\nsecond')
    expect(editor.view.row).toBe(1)
    expect(editor.view.column).toBe('second'.length)
    // Prefilled text is editable text, not a submission.
    expect(editor.handle({ kind: 'text', text: '!' })).toEqual({ kind: 'none' })
    expect(editor.text).toBe('first line\nsecond!')
  })

  it('reports emptiness so Escape can tell recall from dismissal', () => {
    const editor = build()
    expect(editor.empty).toBe(true)
    type(editor, 'x')
    expect(editor.empty).toBe(false)
  })
})
