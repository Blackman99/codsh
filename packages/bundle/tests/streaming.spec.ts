/**
 * Text arriving in fragments: a finished line is rendered and kept, the line
 * still being typed is shown raw in the live region, and the two together must
 * reproduce the answer exactly once.
 */

import { describe, expect, it } from 'vitest'
import { TextStream } from '../src/streaming.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})

/** A stream over a fixed terminal width. */
const build = (columns = 80): TextStream => new TextStream(theme, () => columns)

describe('TextStream', () => {
  it('keeps a partial line live and renders it once it ends', () => {
    const stream = build()
    expect(stream.push('hel')).toEqual({ lines: [], live: 'hel' })
    expect(stream.push('lo')).toEqual({ lines: [], live: 'hello' })
    // The newline is what makes it a line, and only then can it be rendered.
    expect(stream.push('\n')).toEqual({ lines: ['hello'], live: undefined })
  })

  it('renders every line a single delta completes', () => {
    expect(build().push('one\ntwo\nthr')).toEqual({ lines: ['one', 'two'], live: 'thr' })
  })

  it('applies Markdown to a completed line', () => {
    expect(build().push('- **item**\n').lines).toEqual(['• item'])
  })

  it('carries fence state across deltas', () => {
    const stream = build()
    stream.push('```ts\n')
    // Inside a fence the line is code: indented and never read as Markdown.
    expect(stream.push('# not a heading\n').lines).toEqual(['  # not a heading'])
  })

  it('shows an in-progress code line indented, and never Markdown-styled', () => {
    const stream = build()
    stream.push('```\n')
    expect(stream.push('**literal**').live).toBe('  **literal**')
  })

  it('flushes a line the model never terminated', () => {
    const stream = build()
    stream.push('trailing text')
    expect(stream.flush()).toEqual(['trailing text'])
  })

  it('reports nothing to flush once the line is closed', () => {
    const stream = build()
    stream.push('done\n')
    expect(stream.flush()).toEqual([])
  })

  it('reproduces the answer exactly once across arbitrary fragment boundaries', () => {
    const answer = '# Title\n\n- one\n- two\n\n```ts\nconst a = 1\n```\ntail'
    const stream = build()
    const shown: string[] = []
    // Seven characters at a time cuts mid-word, mid-fence, and mid-marker.
    for (let at = 0; at < answer.length; at += 7) {
      shown.push(...stream.push(answer.slice(at, at + 7)).lines)
    }
    shown.push(...stream.flush())
    expect(shown).toEqual(['Title', '', '• one', '• two', '', '  ts', '  const a = 1', 'tail'])
  })

  it('truncates the live line, which the region cannot wrap', () => {
    // A wrapped live line occupies two rows and one carriage return cannot erase
    // it, so the transient text is cut to fit.
    const live = build(20).push('x'.repeat(50)).live
    expect(live?.length).toBeLessThanOrEqual(19)
  })

  it('does not carry an unterminated fence into the next message', () => {
    const stream = build()
    stream.push('```ts\nconst a = 1')
    stream.flush()
    // A cut-off answer left a fence open; the next answer is prose again.
    expect(stream.push('# Heading\n').lines).toEqual(['Heading'])
  })

  it('reports whether anything was streamed, which decides who renders the message', () => {
    const stream = build()
    expect(stream.streamed).toBe(false)
    stream.push('text')
    expect(stream.streamed).toBe(true)
    stream.flush()
    expect(stream.streamed).toBe(false)
  })

  it('ignores an empty delta', () => {
    expect(build().push('')).toEqual({ lines: [], live: undefined })
    expect(build().push('').lines).toEqual([])
  })
})
