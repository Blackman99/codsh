/** Unified-diff styling and the raw text a card hands the reader. */

import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { styleDiffLine, unifiedDiffText } from '../src/diff.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})
const plain = (path: string): string => path.replace('/repo/', '')

describe('unified diff styling', () => {
  it('answers a file header before the marker it starts with', () => {
    // `---` and `+++` open a header and are also the removal and addition
    // markers; a header coloured as content is the bug this order prevents.
    for (const header of ['--- a/x.ts', '+++ b/x.ts', 'diff --git a/x.ts b/x.ts', 'index 1234567..89abcde 100644']) {
      expect(styleDiffLine(header, theme)).toBe(header)
    }
    expect(styleDiffLine('@@ -1,2 +1,3 @@', theme)).toBe('@@ -1,2 +1,3 @@')
    expect(styleDiffLine('+added', theme)).toBe('+added')
    expect(styleDiffLine('-removed', theme)).toBe('-removed')
    expect(styleDiffLine(' context', theme)).toBe(' context')
  })

  it('colours additions and removals apart once the theme paints', () => {
    const painted = createTheme(true, {})
    expect(painted.colored).toBe(true)
    expect(styleDiffLine('+added', painted)).not.toBe(styleDiffLine('-removed', painted))
    expect(styleDiffLine('+added', painted)).toContain('+added')
  })
})

describe('card text for the reader', () => {
  it('writes an edit as a unified hunk against the file', () => {
    const diffs: FileDiff[] = [{ path: '/repo/a.ts', oldText: 'one\ntwo\nthree', newText: 'one\nTWO\nthree' }]
    expect(unifiedDiffText(diffs, plain).split('\n')).toEqual([
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      // git annotates a file that ends without a newline, and the reader is
      // showing a diff, not a cleaned-up rendering of one.
      '\\ No newline at end of file',
    ])
  })

  it('writes a create against /dev/null, without claiming a trailing line', () => {
    const diffs: FileDiff[] = [{ path: '/repo/new.ts', oldText: null, newText: 'a\nb\n' }]
    expect(unifiedDiffText(diffs, plain).split('\n')).toEqual([
      'diff --git a/new.ts b/new.ts',
      'new file',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
    ])
  })

  it('runs one file after another', () => {
    const diffs: FileDiff[] = [
      { path: '/repo/a.ts', oldText: null, newText: 'a' },
      { path: '/repo/b.ts', oldText: null, newText: 'b' },
    ]
    const text = unifiedDiffText(diffs, plain)
    expect(text).toContain('+++ b/a.ts')
    expect(text).toContain('+++ b/b.ts')
    expect(text.indexOf('a.ts')).toBeLessThan(text.indexOf('b.ts'))
  })
})
