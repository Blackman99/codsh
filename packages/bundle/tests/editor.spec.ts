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
    skills: () => [
      { name: 'grill-me', description: 'interview a plan' },
      { name: 'tdd', description: 'test first' },
    ],
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
  it('takes the candidate a pointer named, not the one the mark is on', () => {
    // A click is not Tab: it names a row rather than stepping to the next.
    const editor = build()
    type(editor, '/')
    const offered = editor.view.candidates.map(candidate => candidate.value)
    expect(offered.length).toBeGreaterThan(1)
    editor.chooseCandidate(1)
    expect(editor.text).toBe(offered[1] ?? '')
    expect(editor.view.candidates).toEqual([])
  })

  it('ignores a candidate index that names nothing', () => {
    const editor = build()
    type(editor, '/')
    const before = editor.text
    editor.chooseCandidate(99)
    expect(editor.text).toBe(before)
  })

  it('moves up a wrapped row, instead of jumping to the history', () => {
    // The box wraps one long line across several rows. Up from the second row
    // used to see `row === 0`, decide there was nothing above, and recall the
    // previous prompt — losing what was being typed.
    const editor = build()
    editor.setWrapWidth(10)
    type(editor, 'abcdefghijklmno')
    expect(editor.view.row).toBe(0)
    expect(editor.view.column).toBe(15)

    editor.handle(key('up'))
    expect(editor.view.lines.join('\n')).toBe('abcdefghijklmno')
    // Still the same logical line, now on the row above it.
    expect(editor.view.row).toBe(0)
    expect(editor.view.column).toBe(5)

    // Only the top row hands the key to the history.
    editor.handle(key('up'))
    expect(editor.view.lines.join('\n')).toBe('abcdefghijklmno')
  })

  it('comes back down the same rows', () => {
    const editor = build()
    editor.setWrapWidth(10)
    type(editor, 'abcdefghijklmno')
    editor.handle(key('up'))
    editor.handle(key('down'))
    expect(editor.view.column).toBe(15)
  })

  it('keeps the column offset when the row above is shorter', () => {
    const editor = build()
    editor.setWrapWidth(10)
    type(editor, 'abc')
    editor.handle({ kind: 'newline' })
    type(editor, 'defghij')
    expect(editor.view.row).toBe(1)
    editor.handle(key('up'))
    // Column 7 does not exist on a 3-character line; the end of it does.
    expect(editor.view.row).toBe(0)
    expect(editor.view.column).toBe(3)
  })

  it('moves by logical line where nothing wraps', () => {
    // Off a TTY there is no width and no wrapping, so a line is the row.
    const editor = build()
    type(editor, 'one')
    editor.handle({ kind: 'newline' })
    type(editor, 'two')
    editor.handle(key('up'))
    expect(editor.view.row).toBe(0)
  })

  it('moves the menu with the arrows, whichever trigger opened it', () => {
    // The decoder turns every arrow report into one `down`/`up`, and all four
    // sources fill the same candidate list — so a fault in either place shows
    // up in every menu at once. `/` was the one reported; this pins the rest.
    const openings: readonly (readonly [string, string])[] = [
      ['/', 'commands'],
      ['@', 'paths'],
      ['$', 'skills'],
      ['/permission ', 'command arguments'],
    ]
    for (const [typed, what] of openings) {
      const editor = build()
      type(editor, typed)
      const opened = editor.view.candidates
      expect(opened.length, what).toBeGreaterThan(1)
      expect(editor.view.selected, what).toBe(0)

      editor.handle(key('down'))
      expect(editor.view.selected, what).toBe(1)
      editor.handle(key('up'))
      expect(editor.view.selected, what).toBe(0)
      // Up from the first wraps to the last, so the menu has no dead end.
      editor.handle(key('up'))
      expect(editor.view.selected, what).toBe(opened.length - 1)
      // Nothing was typed into the buffer by any of it.
      expect(editor.view.lines.join(''), what).toBe(typed)
    }
  })

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

  it('deletes a pasted-image token as one thing', () => {
    const editor = build()
    editor.handle({ kind: 'paste', text: 'fix this ' })
    editor.handle({ kind: 'paste', text: '[Image #3]' })
    // One backspace takes the whole token: a fragment like `[Image #` would
    // still look like a reference while no longer naming its attachment.
    editor.handle({ kind: 'backspace' })
    expect(editor.text).toBe('fix this ')
    // Plain text around it keeps the ordinary one-character behaviour.
    editor.handle({ kind: 'backspace' })
    expect(editor.text).toBe('fix this')
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
    expect(editor.view.candidates.map(c => c.value)).toEqual(['/plan', '/permission', '/compact'])
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

  it('opens skills as a $ mention is typed', () => {
    const editor = build()
    type(editor, '$g')
    expect(editor.view.candidates.map(c => c.value)).toEqual(['$grill-me'])
    expect(editor.view.candidates[0]?.detail).toBe('interview a plan')
  })

  it('offers every skill for a bare $', () => {
    const editor = build()
    type(editor, '$')
    expect(editor.view.candidates.map(c => c.value)).toEqual(['$grill-me', '$tdd'])
  })

  it('offers a skill that contains the fragment, not only a prefix', () => {
    const editor = build()
    type(editor, '$ill')
    expect(editor.view.candidates.map(c => c.value)).toEqual(['$grill-me'])
  })

  it('offers a command that contains the fragment, not only a prefix', () => {
    const editor = build()
    type(editor, '/iss')
    expect(editor.view.candidates.map(c => c.value)).toEqual(['/permission'])
  })

  it('completes a $ skill mid-sentence', () => {
    const editor = build()
    type(editor, 'use $g')
    expect(editor.view.candidates.map(c => c.value)).toEqual(['$grill-me'])
  })

  it('accepts a skill without submitting', () => {
    const editor = build()
    type(editor, '$g')
    expect(editor.handle(key('enter'))).toEqual({ kind: 'none' })
    expect(editor.text).toBe('$grill-me')
  })

  it('offers no commands mid-sentence, where a slash is not a command', () => {
    const editor = build()
    type(editor, 'use /p for')
    expect(editor.view.candidates).toEqual([])
  })
})

describe('known gestures in the box', () => {
  it('marks a finished /command', () => {
    const editor = build()
    type(editor, '/plan')
    expect(editor.view.hits).toEqual([{ row: 0, start: 0, end: 5, kind: 'command' }])
  })

  it('leaves a partial command unmarked', () => {
    const editor = build()
    type(editor, '/pla')
    expect(editor.view.hits).toEqual([])
  })

  it('marks a finished $skill, including mid-sentence', () => {
    const editor = build()
    type(editor, 'use $grill-me now')
    expect(editor.view.hits).toEqual([{ row: 0, start: 4, end: 13, kind: 'skill' }])
  })

  it('leaves an unknown $word unmarked', () => {
    const editor = build()
    type(editor, '$amount')
    expect(editor.view.hits).toEqual([])
  })
})

describe('completion menu selection', () => {
  it('moves the selection with Tab and the arrows', () => {
    const editor = build()
    type(editor, '/p')
    expect(editor.view.selected).toBe(0)
    editor.handle(key('tab'))
    expect(editor.view.selected).toBe(1)
    editor.handle(key('down'))
    expect(editor.view.selected).toBe(2)
    editor.handle(key('down'))
    expect(editor.view.selected).toBe(0)
    editor.handle(key('up'))
    expect(editor.view.selected).toBe(2)
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

describe('history search', () => {
  it('opens on history-search and previews the newest entry', () => {
    const editor = build()
    type(editor, 'alpha')
    editor.handle(key('enter'))
    type(editor, 'bravo')
    editor.handle(key('enter'))
    editor.handle(key('history-search'))
    expect(editor.text).toBe('bravo')
    expect(editor.view.search).toEqual({ query: '', hits: 2, index: 0 })
  })

  it('narrows by typed query, newest first', () => {
    const editor = build()
    type(editor, 'alpha')
    editor.handle(key('enter'))
    type(editor, 'bravo')
    editor.handle(key('enter'))
    editor.handle(key('history-search'))
    type(editor, 'a')
    expect(editor.text).toBe('bravo')
    type(editor, 'l')
    expect(editor.text).toBe('alpha')
    expect(editor.view.search).toEqual({ query: 'al', hits: 1, index: 0 })
  })

  it('steps to an older match on repeat history-search', () => {
    const editor = build()
    type(editor, 'alpha')
    editor.handle(key('enter'))
    type(editor, 'bravo')
    editor.handle(key('enter'))
    editor.handle(key('history-search'))
    type(editor, 'a')
    editor.handle(key('history-search'))
    expect(editor.text).toBe('alpha')
    expect(editor.view.search?.index).toBe(1)
  })

  it('accepts the match into the buffer without submitting', () => {
    const editor = build()
    type(editor, 'kept')
    editor.handle(key('enter'))
    editor.handle(key('history-search'))
    expect(editor.handle(key('enter'))).toEqual({ kind: 'none' })
    expect(editor.text).toBe('kept')
    expect(editor.view.search).toBeUndefined()
  })

  it('restores the draft on Escape', () => {
    const editor = build()
    type(editor, 'kept')
    editor.handle(key('enter'))
    type(editor, 'draft')
    editor.handle(key('history-search'))
    expect(editor.text).toBe('kept')
    editor.handle(key('escape'))
    expect(editor.text).toBe('draft')
    expect(editor.view.search).toBeUndefined()
  })

  it('keeps the draft when history is empty', () => {
    const editor = build()
    type(editor, 'draft')
    editor.handle(key('history-search'))
    expect(editor.text).toBe('draft')
    expect(editor.view.search).toEqual({ query: '', hits: 0, index: 0 })
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
