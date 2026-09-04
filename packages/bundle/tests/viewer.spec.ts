/** Fullscreen reader layout and navigation stay independent of terminal effects. */

import { describe, expect, it } from 'vitest'
import { createTheme, displayWidth } from '../src/theme.ts'
import { FullscreenViewer } from '../src/viewer.ts'

const theme = createTheme(false, {})

describe('fullscreen response viewer', () => {
  it('renders raw answer Markdown and fence-free code into a full frame', () => {
    const answer = new FullscreenViewer({
      title: 'Answer 1',
      kind: 'answer',
      text: '# Heading\n\n```ts\nconst value = 1\n```',
    })
    const frame = answer.frame(theme, 32, 7)
    expect(frame.rows).toHaveLength(7)
    expect(frame.rows[0]).toContain('Answer 1')
    expect(frame.body.join('\n')).toContain('Heading')
    expect(frame.body.join('\n')).toContain('const value = 1')
    expect(frame.rows.join('\n')).not.toContain('```')

    const code = new FullscreenViewer({ title: 'Code 1:1', kind: 'code', text: 'const raw = true' })
    expect(code.frame(theme, 32, 4).body).toContain('const raw = true')
  })

  it('reads a diff by what each line does, not by its language', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' const kept = 1',
      '-const value = 1',
      '+const value = 2',
    ].join('\n')
    const painted = createTheme(true, {})
    const viewer = new FullscreenViewer({ title: 'Uncommitted changes', kind: 'diff', text })
    const frame = viewer.frame(painted, 40, 8)

    expect(frame.rows[0]).toContain('Uncommitted changes')
    const added = frame.body.find(row => row.includes('+const value = 2')) ?? ''
    const removed = frame.body.find(row => row.includes('-const value = 1')) ?? ''
    expect(added).not.toBe('')
    // The two rows carry the same code and must still not look alike: the
    // colour here belongs to the marker, not to the `const` they share.
    expect(added.replace('2', '1')).not.toBe(removed.replace('-', '+'))
    expect(frame.body.some(row => row.includes('@@ -1,2 +1,2 @@'))).toBe(true)
  })

  it('moves by line and page and reaches both boundaries', () => {
    const viewer = new FullscreenViewer({
      title: 'Code 1:1',
      kind: 'code',
      text: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'),
    })
    expect(viewer.frame(theme, 20, 6).body[0]).toBe('line 1')
    viewer.move({ kind: 'line', lines: 1 }, theme, 20, 6)
    expect(viewer.frame(theme, 20, 6).body[0]).toBe('line 2')
    viewer.move({ kind: 'page', direction: 1 }, theme, 20, 6)
    expect(viewer.frame(theme, 20, 6).body[0]).toBe('line 6')
    viewer.move({ kind: 'end' }, theme, 20, 6)
    expect(viewer.frame(theme, 20, 6).body.at(-1)).toBe('line 12')
    viewer.move({ kind: 'home' }, theme, 20, 6)
    expect(viewer.frame(theme, 20, 6).body[0]).toBe('line 1')
  })

  it('reuses one physical layout while navigating at the same width', () => {
    const viewer = new FullscreenViewer({
      title: 'Answer 1',
      kind: 'answer',
      text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'),
    })
    viewer.frame(theme, 20, 6)
    const initial = (viewer as unknown as { layout: unknown }).layout
    viewer.move({ kind: 'line', lines: 1 }, theme, 20, 6)
    viewer.frame(theme, 20, 6)
    expect((viewer as unknown as { layout: unknown }).layout).toBe(initial)

    viewer.frame(theme, 10, 6)
    expect((viewer as unknown as { layout: unknown }).layout).not.toBe(initial)
  })

  it('reflows wide characters and clamps position after resize', () => {
    const viewer = new FullscreenViewer({ title: 'Answer 1', kind: 'answer', text: '界'.repeat(10) })
    viewer.move({ kind: 'end' }, theme, 6, 4)
    expect(viewer.frame(theme, 6, 4)).toMatchObject({ offset: 2, maxOffset: 2 })
    const wide = viewer.frame(theme, 20, 4)
    expect(wide).toMatchObject({ offset: 0, maxOffset: 0 })
    expect(wide.body).toEqual(['界'.repeat(10), ''])
  })

  it('keeps the same logical content at the top during mid-document reflow', () => {
    const text = Array.from({ length: 10 }, (_, index) => `row${String(index + 1).padStart(2, '0')}-abcdef`).join('\n')
    const viewer = new FullscreenViewer({ title: 'Code 1:1', kind: 'code', text })
    viewer.move({ kind: 'line', lines: 4 }, theme, 12, 6)
    expect(viewer.frame(theme, 12, 6).body[0]).toBe('row05-abcdef')
    const narrow = viewer.frame(theme, 6, 6)
    expect(narrow.offset).toBe(8)
    expect(narrow.body[0]).toBe('row05-')
  })

  it('renders CRLF Markdown without carriage-return control bytes', () => {
    const viewer = new FullscreenViewer({
      title: 'Answer 1',
      kind: 'answer',
      text: '# Heading\r\n\r\n```ts\r\nconst value = 1\r\n```',
    })
    const frame = viewer.frame(theme, 30, 7)
    expect(frame.rows.join('\n')).not.toContain('\r')
    expect(frame.body.join('\n')).toContain('Heading')
    expect(frame.body.join('\n')).toContain('const value = 1')
  })

  it('reflows Markdown table cells within the viewer width', () => {
    const viewer = new FullscreenViewer({
      title: 'Answer 1',
      kind: 'answer',
      text: '| 名称 | 内容 |\n|---|---|\n| 项目 | 很长的中文内容很长的中文内容 |',
    })
    const frame = viewer.frame(theme, 24, 10)
    expect(frame.body.some(row => row.includes('│'))).toBe(true)
    for (const row of frame.rows) expect(displayWidth(row)).toBeLessThanOrEqual(24)
  })

  it('uses only the title when the viewport has one row', () => {
    const viewer = new FullscreenViewer({ title: 'Answer 1', kind: 'answer', text: 'body' })
    expect(viewer.frame(theme, 20, 1).rows).toEqual(['Answer 1'])
  })
})

describe('copying what it shows', () => {
  it('offers the gesture in the footer', () => {
    const viewer = new FullscreenViewer({ title: 'Answer 1', kind: 'answer', text: 'body' })
    expect(viewer.frame(theme, 80, 6).rows.at(-1)).toContain('c copies')
  })

  it('says it copied, until the next move', () => {
    const viewer = new FullscreenViewer({
      title: 'Code 1:1',
      kind: 'code',
      text: Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'),
    })
    viewer.markCopied()
    expect(viewer.frame(theme, 80, 6).rows.at(-1)).toContain('copied')
    // Reading on is how a person acknowledges it; no timer is needed.
    viewer.move({ kind: 'line', lines: 1 }, theme, 80, 6)
    expect(viewer.frame(theme, 80, 6).rows.at(-1)).toContain('c copies')
  })

  it('hands over exactly what it was given, not what it drew', () => {
    // The diff a card cannot address through `/copy`: the raw text, not the
    // coloured rows the reader painted from it.
    const text = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-was\n+is'
    expect(new FullscreenViewer({ title: 'Changes', kind: 'diff', text }).text).toBe(text)
  })
})

describe('the footer at a narrow width', () => {
  it('keeps the way out when it has to cut', () => {
    const viewer = new FullscreenViewer({ title: 'Answer 1', kind: 'answer', text: 'body' })
    // Losing `Esc closes` to a navigation hint would be losing the exit.
    expect(viewer.frame(theme, 24, 6).rows.at(-1)).toContain('Esc closes')
  })
})
