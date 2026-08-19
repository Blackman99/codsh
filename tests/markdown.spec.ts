/**
 * Markdown rendering decorates what changes how an answer reads and leaves
 * everything else byte-identical. A renderer that mangles prose to decorate it
 * is worse than one that decorates nothing.
 */

import { describe, expect, it } from 'vitest'
import { createMarkdownStream, highlightCode, renderInline, renderMarkdown } from '../src/markdown.ts'
import { createTheme } from '../src/theme.ts'
import { displayWidth } from '../src/theme.ts'

const plain = createTheme(false, {})
const colour = createTheme(true, {})

/** Render and rejoin, for whole-answer assertions. */
const render = (text: string, theme = plain): string => renderMarkdown(text, theme).join('\n')

describe('renderInline', () => {
  it('unwraps emphasis and code spans', () => {
    expect(renderInline('a **b** and *c* and `d`', plain)).toBe('a b and c and d')
  })

  it('prefers the longer delimiter', () => {
    // `**bold**` must not read as two empty emphases.
    expect(renderInline('**bold**', colour)).toBe('\u001B[1mbold\u001B[0m')
  })

  it('keeps a link target, which a terminal cannot hide behind a click', () => {
    expect(renderInline('see [docs](https://x.dev)', plain)).toBe('see docs (https://x.dev)')
  })

  it('leaves a code span literal', () => {
    // Emphasis markers inside a code span are content, not syntax.
    expect(renderInline('`a * b`', plain)).toBe('a * b')
  })

  it.each([
    { label: 'a bare asterisk', text: 'a * b' },
    { label: 'multiplication', text: '2 * 3 * 4' },
    { label: 'an underscored identifier', text: 'call some_helper_name(x)' },
    { label: 'a lone bracket', text: 'array[0] and (paren)' },
  ])('leaves $label unchanged', ({ text }) => {
    expect(renderInline(text, plain)).toBe(text)
  })
})

describe('highlightCode', () => {
  it('colours strings, comments, numbers, and keywords', () => {
    const line = highlightCode('const x = "s" // note 42', colour.syntax)
    expect(line).toContain('\u001B[35mconst\u001B[0m')
    expect(line).toContain('\u001B[32m"s"\u001B[0m')
    expect(line).toContain('\u001B[2m// note 42\u001B[0m')
  })

  it('leaves an ordinary identifier alone even when it reads like a keyword elsewhere', () => {
    // `go` and `use` are keywords in some languages and function names in more.
    expect(highlightCode('go(); use();', plain.syntax)).toBe('go(); use();')
  })

  it('reproduces its input exactly when nothing matches', () => {
    const line = 'ordinary(text) + more'
    expect(highlightCode(line, plain.syntax)).toBe(line)
  })

  it('does not treat a comment marker inside a string as a comment', () => {
    const line = highlightCode('x = "http://a" ', colour.syntax)
    // The whole string is one token, so the slashes never open a comment.
    expect(line).toContain('\u001B[32m"http://a"\u001B[0m')
  })
})

describe('renderMarkdown', () => {
  it('renders headings, lists, quotes, and rules', () => {
    expect(render('# Title\n\n- one\n- two\n\n1. first\n\n> quoted\n\n---')).toBe(
      'Title\n\n• one\n• two\n\n1. first\n\n│ quoted\n\n───')
  })

  it('names a fenced block\'s language and drops the fence', () => {
    expect(render('```ts\nconst a = 1\n```')).toBe('  ts\n  const a = 1')
  })

  it('indents a fenced block with no language', () => {
    expect(render('```\nraw\n```')).toBe('  raw')
  })

  it('leaves markdown syntax inside a fence literal', () => {
    // Inside code, `**` and `#` are content.
    expect(render('```\n# not a heading\n**not bold**\n```')).toBe('  # not a heading\n  **not bold**')
  })

  it('leaves ordinary prose byte-identical', () => {
    const prose = 'A sentence about 2 * 3 and a path /usr/bin, plus a_name.\nAnother line.'
    expect(render(prose)).toBe(prose)
  })

  it('keeps blank lines, which carry the paragraph breaks', () => {
    expect(render('a\n\nb')).toBe('a\n\nb')
  })

  it('renders an unterminated fence as code rather than dropping it', () => {
    // A streamed answer can be cut mid-block; the content still has to appear.
    expect(render('```ts\nconst a = 1')).toBe('  ts\n  const a = 1')
  })
})

describe('tables', () => {
  it('lays out a table on display-width columns with column rules', () => {
    // Compact — nothing wrapped — so only the head rule: density matters.
    expect(render('| Name | Count |\n|------|-------|\n| a | 10 |\n| bbbb | 2 |')).toBe(
      'Name │ Count\n─────┼──────\na    │ 10\nbbbb │ 2')
  })

  it('pads wide characters by their two-column width', () => {
    const rows = renderMarkdown('| 名字 | n |\n|---|---|\n| 终端 | 1 |\n| a | 2 |', plain)
    // Both body rows put the second column at the same display column.
    expect(rows[2]).toBe('终端 │ 1')
    expect(rows[3]).toBe('a    │ 2')
  })

  it('right-aligns a column whose delimiter ends in a colon, header included', () => {
    expect(render('| n | v |\n|---|---:|\n| a | 1 |\n| b | 1000 |')).toBe(
      'n │    v\n──┼─────\na │    1\nb │ 1000')
  })

  it('prints pipe lines without a delimiter row as prose', () => {
    // `a | b` piped prose is not a table; it must survive unchanged.
    expect(render('| just | prose |\nafter')).toBe('| just | prose |\nafter')
  })

  it('keeps a too-wide table in shape by wrapping inside its cells', () => {
    const wide = `| ${'x'.repeat(60)} | ${'y'.repeat(60)} |`
    const source = `${wide}\n|---|---|\n${wide}`
    const narrow = createMarkdownStream(plain, () => 40)
    const lines = [...source.split('\n').flatMap(line => narrow.line(line)), ...narrow.flush()]
    // Still a table — no raw pipe rows — and no line exceeds the terminal.
    expect(lines.join('\n')).not.toContain('|')
    expect(lines.join('\n')).toContain('┼')
    // One body row: just the head rule, there is no between-rows to mark.
    expect(lines.filter(line => line.includes('┼'))).toHaveLength(1)
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    // The cells wrapped rather than truncated: every character survives.
    expect(lines.join('').replaceAll(/[\s─│┼]/gu, '').length).toBe('x'.repeat(120).length + 'y'.repeat(120).length)
  })

  it('rules between rows once any cell wraps, so records cannot blur together', () => {
    const wide = `| a | ${'y'.repeat(60)} |`
    const source = `| h1 | h2 |\n|---|---|\n${wide}\n${wide}`
    const narrow = createMarkdownStream(plain, () => 40)
    const lines = [...source.split('\n').flatMap(line => narrow.line(line)), ...narrow.flush()]
    // Head rule plus exactly one between the two wrapped body rows.
    expect(lines.filter(line => line.includes('┼'))).toHaveLength(2)
  })

  it('renders inline constructs inside cells, and sizes on the visible text', () => {
    const colour = createTheme(true, { TERM: 'xterm-256color' })
    const rows = renderMarkdown('| a | b |\n|---|---|\n| `code` | **bold** |', colour)
    const body = rows[2] ?? ''
    // Backticks and stars are consumed, not printed.
    expect(body).not.toContain('`')
    expect(body).not.toContain('**')
    expect(body).toContain('\u001B[36mcode\u001B[0m')
  })

  it('falls back to source lines only when the terminal cannot hold columns at all', () => {
    const source = '| aaaa | bbbb | cccc |\n|---|---|---|\n| a | b | c |'
    const hopeless = createMarkdownStream(plain, () => 10)
    const lines = [...source.split('\n').flatMap(line => hopeless.line(line)), ...hopeless.flush()]
    expect(lines.join('\n')).toBe(source)
  })

  it('shows a table cut off before any delimiter row on flush', () => {
    const stream = createMarkdownStream(plain)
    expect(stream.line('| a | b |')).toEqual([])
    expect(stream.flush()).toEqual(['| a | b |'])
  })

  it('keeps pipe lines inside a fence as code', () => {
    expect(render('```\n| a | b |\n```')).toBe('  | a | b |')
  })
})

describe('nested inline, as models actually write it', () => {
  it('renders code spans inside bold instead of leaving the backticks', () => {
    // The exact shape from a real session: a bold heading carrying a path.
    expect(renderInline('**1. 启动包装层 — `bin/codsh.mjs`**', plain)).toBe('1. 启动包装层 — bin/codsh.mjs')
  })

  it('keeps the bold open across an embedded code span', () => {
    const colour256 = createTheme(true, { TERM: 'xterm-256color' })
    const out = renderInline('**a `b` c**', colour256)
    // Three bold segments: the reset that closes the code span must not strip
    // the bold from the tail.
    const boldOpens = out.split('\u001B[1m').length - 1
    expect(boldOpens).toBeGreaterThanOrEqual(3)
    expect(out).not.toContain('`')
  })

  it('renders a bulleted bold-code label', () => {
    expect(renderMarkdown('- **`screen.ts`**: 备用屏', plain).join('')).toBe('• screen.ts: 备用屏')
  })
})
