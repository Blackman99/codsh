/**
 * Text arriving in fragments: a finished line is rendered and kept, the line
 * still being typed is shown raw in the live region, and the two together must
 * reproduce the answer exactly once.
 */

import { describe, expect, it } from 'vitest'
import { TextStream, ThinkingTracker } from '../src/streaming.ts'
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

  it('drops leading and trailing blank lines the model wrapped the answer in', () => {
    // A sentence that arrived as `\n\nhello\n\n` used to paint two empty rows
    // before the words and two after — then the surface added another separator.
    const stream = build()
    expect(stream.push('\n\nhello\n\n')).toEqual({ lines: ['hello'], live: undefined })
    expect(stream.flush()).toEqual([])
  })

  it('still keeps a paragraph break between sentences', () => {
    expect(build().push('one\n\ntwo\n')).toEqual({ lines: ['one', '', 'two'], live: undefined })
  })

  it('keeps blank lines that belong inside a fenced block', () => {
    const stream = build()
    expect(stream.push('```\nconst a = 1\n\nconst b = 2\n```\n')).toEqual({
      lines: ['  const a = 1', '  ', '  const b = 2'],
      live: undefined,
    })
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

describe('ThinkingTracker', () => {
  const buildTracker = (columns = 80): ThinkingTracker => new ThinkingTracker(theme, () => columns)

  it('accurately tracks thinking duration from step/start when reasoning arrives buffered', () => {
    const tracker = buildTracker()
    tracker.markStepStart(1000)

    // Provider spends 3s deliberating and sends reasoning in a single chunk at t=4000
    tracker.push('Analyzing repo and workspace\n', 4000)

    // Reasoning ends at t=4100
    tracker.markReasoningEnd(4100)
    const result = tracker.flush(4100)

    expect(result).toBeDefined()
    expect(result?.lines).toEqual(['  Analyzing repo and workspace'])
    // Should include full deliberation time (4100 - 1000 = 3100ms), NOT just chunk arrival time (100ms)
    expect(result?.elapsedMs).toBe(3100)
  })

  it('tracks token-by-token streaming deliberation and ends on reasoning end', () => {
    const tracker = buildTracker()
    tracker.markStepStart(1000)

    tracker.push('token 1 ', 2000)
    tracker.push('token 2\n', 3000)
    tracker.markReasoningEnd(5000)
    const result = tracker.flush(5000)

    expect(result).toBeDefined()
    expect(result?.lines).toEqual(['  token 1 token 2'])
    expect(result?.elapsedMs).toBe(4000)
  })

  it('returns undefined and zero duration when no reasoning was pushed', () => {
    const tracker = buildTracker()
    tracker.markStepStart(1000)
    tracker.markReasoningEnd(2000)
    expect(tracker.flush(2000)).toBeUndefined()
  })

  it('resets step start on markStepEnd so previous steps do not bleed into later steps', () => {
    const tracker = buildTracker()
    // Step 1: executed a tool with no reasoning
    tracker.markStepStart(1000)
    tracker.markStepEnd()

    // Step 2: model deliberates
    tracker.markStepStart(5000)
    tracker.push('thinking line\n', 7000)
    tracker.markReasoningEnd(8000)
    const result = tracker.flush(8000)

    expect(result).toBeDefined()
    // Duration measured against Step 2's start (8000 - 5000 = 3000ms), NOT Step 1
    expect(result?.elapsedMs).toBe(3000)
  })

  it('does not count tool call streaming after reasoning towards thinking time', () => {
    const tracker = buildTracker()
    tracker.markStepStart(1000)
    tracker.push('deliberation\n', 3000)
    // Reasoning ends when tool call or text begins at t=4000
    tracker.markReasoningEnd(4000)

    // Tool call arguments stream until t=9000
    const result = tracker.flush(9000)
    expect(result).toBeDefined()
    // Must only measure up to markReasoningEnd (4000 - 1000 = 3000ms), NOT 8000ms
    expect(result?.elapsedMs).toBe(3000)
  })

  it('falls back to first delta arrival time when step/start was not marked', () => {
    const tracker = buildTracker()
    tracker.push('unanchored thinking\n', 2000)
    tracker.markReasoningEnd(3500)
    const result = tracker.flush(3500)
    expect(result).toBeDefined()
    expect(result?.elapsedMs).toBe(1500)
  })

  it('resets cleanly for a new turn', () => {
    const tracker = buildTracker()
    tracker.markStepStart(1000)
    tracker.push('thinking\n', 2000)
    tracker.reset()

    expect(tracker.currentLines).toEqual([])
    expect(tracker.flush()).toBeUndefined()
  })
})
