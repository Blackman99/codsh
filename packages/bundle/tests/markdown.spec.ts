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

describe('inline HTML in an answer', () => {
  const truecolor = createTheme(true, { COLORTERM: 'truecolor' })
  const palette = createTheme(true, { TERM: 'xterm-256color' })

  it('paints a <font color> in the terminal\'s own colour, and strips the tag off a TTY', () => {
    // The field case: a P&L line whose gain the model wrapped in a tag, which
    // the reader saw printed literally.
    const line = '累计净盈亏: <font color="green">+757.22 USDT</font> (+7.57%)'
    expect(renderInline(line, colour)).toBe('累计净盈亏: \u001B[32m+757.22 USDT\u001B[0m (+7.57%)')
    expect(renderInline(line, plain)).toBe('累计净盈亏: +757.22 USDT (+7.57%)')
  })

  it('reads a span\'s CSS colour and weight, at the depth the terminal has', () => {
    const line = '<span style="color: #ff8800; font-weight: bold">hot</span>'
    expect(renderInline(line, truecolor)).toBe('\u001B[1m\u001B[38;2;255;136;0mhot\u001B[0m')
    expect(renderInline(line, palette)).toContain('\u001B[38;5;208mhot')
    expect(renderInline(line, colour)).toContain('\u001B[33mhot')
    expect(renderInline(line, plain)).toBe('hot')
  })

  it('maps the emphasis tags onto the theme roles', () => {
    expect(renderInline('<b>a</b> <strong>b</strong>', colour)).toBe('\u001B[1ma\u001B[0m \u001B[1mb\u001B[0m')
    expect(renderInline('<i>a</i> <em>b</em>', colour)).toBe('\u001B[3ma\u001B[0m \u001B[3mb\u001B[0m')
    expect(renderInline('<u>a</u> <s>b</s> <del>c</del>', colour)).toBe('\u001B[4ma\u001B[0m \u001B[9mb\u001B[0m \u001B[9mc\u001B[0m')
    expect(renderInline('<code>x</code>', colour)).toBe(colour.tool('x'))
    // Grouping tags keep their text and lose the markup.
    expect(renderInline('H<sub>2</sub>O <span>plain</span> <small>fine</small>', plain)).toBe('H2O plain fine')
  })

  it('keeps an outer style open past a tag\'s own reset', () => {
    // `**a <font>b</font> c**`: the tag closes with a reset, which used to end
    // the bold too; `c` must still be bold.
    expect(renderInline('**a <font color="red">b</font> c**', colour))
      .toBe('\u001B[1ma \u001B[31mb\u001B[0m\u001B[1m c\u001B[0m')
    // And Markdown inside a tag renders, wrapped in the tag's colour throughout.
    expect(renderInline('<font color="red">a **b** c</font>', colour))
      .toBe('\u001B[31ma \u001B[1mb\u001B[0m\u001B[31m c\u001B[0m')
  })

  it('leaves what is not styled markup exactly as written', () => {
    for (const literal of ['`<b>code</b>`', '<div>block</div>', 'a < b and b > c', 'Vec<T> and <b>unclosed', 'for <i> in range', '<font color="chartreuse-ish">']) {
      expect(renderInline(literal, plain)).toBe(literal.startsWith('`') ? '<b>code</b>' : literal)
    }
    // A known tag with a colour nobody can name still gives the text back plain.
    expect(renderInline('<font color="nosuchcolour">x</font>', colour)).toBe('x')
    expect(renderInline('<FONT COLOR=GREEN>x</FONT>', colour)).toBe('\u001B[32mx\u001B[0m')
  })

  it('decodes entities outside code spans', () => {
    expect(renderInline('R&amp;D &lt;tag&gt; &quot;q&quot; &#20320;&#x597D; a&nbsp;b', plain)).toBe('R&D <tag> "q" 你好 a b')
    expect(renderInline('`&amp;` and &amp;', plain)).toBe('&amp; and &')
    // An escaped tag is text the author wanted shown, not markup.
    expect(renderInline('&lt;b&gt;shown&lt;/b&gt;', colour)).toBe('<b>shown</b>')
  })

  it('breaks a row at <br>, under the text of a list item', () => {
    expect(renderMarkdown('- first<br>second', plain)).toEqual(['• first', '  second'])
    expect(renderMarkdown('1. first<br/>second', plain)).toEqual(['1. first', '   second'])
    expect(renderMarkdown('a<br>b', plain)).toEqual(['a', 'b'])
    // The styles open at the break — the heading's and the tag's — carry onto the next row.
    const heading = renderMarkdown('# <font color="red">a<br>b</font>', colour)
    expect(heading).toHaveLength(2)
    expect(heading[0]).toContain('\u001B[93m\u001B[31ma\u001B[0m')
    expect(heading[1]?.startsWith('\u001B[93m\u001B[31mb\u001B[0m')).toBe(true)
  })

  it('lets a <br> inside a table cell make a second row of the cell', () => {
    const rendered = renderMarkdown('| a | b |\n|---|---|\n| one<br>two | 1 |', plain)
    expect(rendered).toEqual([
      '╭─────┬───╮',
      '│ a   │ b │',
      '├─────┼───┤',
      '│ one │ 1 │',
      '│ two │   │',
      '╰─────┴───╯',
    ])
  })
})

describe('highlightCode', () => {
  it('colours strings, comments, numbers, and keywords', () => {
    const line = highlightCode('const x = "s" // note 42', colour.syntax)
    expect(line).toContain('\u001B[35mconst\u001B[0m')
    expect(line).toContain('\u001B[32m"s"\u001B[0m')
    expect(line).toContain('\u001B[2m// note 42\u001B[0m')
  })

  it('highlights function calls, types, properties, and constants', () => {
    const fnLine = highlightCode('const lines = this.renderBlock(event)', colour.syntax)
    expect(fnLine).toContain('\u001B[33mrenderBlock\u001B[0m')
    expect(fnLine).toContain('.\u001B[33mrenderBlock\u001B[0m')

    const propLine = highlightCode('const run = this.run', colour.syntax)
    expect(propLine).toContain('.\u001B[34mrun\u001B[0m')

    const typeLine = highlightCode('const ev: SessionEvent = event', colour.syntax)
    expect(typeLine).toContain('\u001B[36mSessionEvent\u001B[0m')

    const constLine = highlightCode('let x = undefined', colour.syntax)
    expect(constLine).toContain('\u001B[36mundefined\u001B[0m')
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

  it('pads and spaces coloured code blocks cleanly away from adjacent text', () => {
    const text = 'before:\n```ts\nconst a = 1\n```\nafter'
    const rendered = renderMarkdown(text, colour)
    // Blank separator line before the block
    expect(rendered[1]).toBe('')
    // Language header row with bgCode
    expect(rendered[2]).toContain('ts')
    // Highlighted code row with bgCode
    expect(rendered[3]).toContain('const')
    expect(rendered[3]).toContain('a =')
    // Bottom padding row with bgCode
    expect(rendered[4]).toBe(colour.bgCode('  '))
    // Blank separator line after the block
    expect(rendered[5]).toBe('')
    expect(rendered[6]).toBe('after')
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
  it('lays out a bordered, padded grid with a rule between every row', () => {
    expect(render('| Name | Count |\n|------|-------|\n| a | 10 |\n| bbbb | 2 |')).toBe([
      '╭──────┬───────╮',
      '│ Name │ Count │',
      '├──────┼───────┤',
      '│ a    │ 10    │',
      '├──────┼───────┤',
      '│ bbbb │ 2     │',
      '╰──────┴───────╯',
    ].join('\n'))
  })

  it('pads wide characters by their two-column width', () => {
    const rows = renderMarkdown('| 名字 | n |\n|---|---|\n| 终端 | 1 |\n| a | 2 |', plain)
    // Both body rows put the second column at the same display column.
    expect(rows[3]).toBe('│ 终端 │ 1 │')
    expect(rows[5]).toBe('│ a    │ 2 │')
  })

  it('right-aligns a column whose delimiter ends in a colon, header included', () => {
    const rows = renderMarkdown('| n | v |\n|---|---:|\n| a | 1 |\n| b | 1000 |', plain)
    expect(rows[3]).toBe('│ a │    1 │')
    expect(rows[5]).toBe('│ b │ 1000 │')
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
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    // The cells wrapped rather than truncated: every character survives.
    expect(lines.join('').replaceAll(/[\s─│┼╭╮╰╯├┤┬┴]/gu, '').length).toBe('x'.repeat(120).length + 'y'.repeat(120).length)
  })

  it('rules between every pair of rows, wrapped or not', () => {
    const wide = `| a | ${'y'.repeat(60)} |`
    const source = `| h1 | h2 |\n|---|---|\n${wide}\n${wide}`
    const narrow = createMarkdownStream(plain, () => 40)
    const lines = [...source.split('\n').flatMap(line => narrow.line(line)), ...narrow.flush()]
    // Head rule plus one between the two body rows: records never blur.
    expect(lines.filter(line => line.includes('┼'))).toHaveLength(2)
    // And the grid is framed: one top edge, one bottom edge.
    expect(lines.filter(line => line.startsWith('╭'))).toHaveLength(1)
    expect(lines.filter(line => line.startsWith('╰'))).toHaveLength(1)
  })

  it('keeps columns aligned when a cell carries an emoji', () => {
    const rows = renderMarkdown('| a | b |\n|---|---|\n| ⚡ x | 1 |\n| yyyy | 2 |', plain)
    // Both body rows put the second column's rule at the same display column.
    const ruleAt = (row: string): number => displayWidth(row.slice(0, row.indexOf('│', 1)))
    expect(ruleAt(rows[3] ?? '')).toBe(ruleAt(rows[5] ?? ''))
  })

  it('keeps every row the frame\'s width when a wrapped cell carries a selector emoji', () => {
    // The field case: a storyboard table whose script cells open with 🎙️
    // (U+1F399 U+FE0F). Wrapped by code point the emoji cost one column and
    // the row ran one past the frame, pushing every rule after it right.
    const source = [
      '| 时间轴 | 对应口播台词 | 首尾相接细节 |',
      '|---|---|---|',
      '| 0.00s ~ 4.66s | 🎙️《蜂蜜落到面包上，怎么不摊平，反而给自己盘了个发髻?》 | 盘发动作自然收尾，进入过渡区 |',
      '| 4.36s ~ 4.66s | 音频无缝承接 | 0.3s 交叉微溶，两个镜头间的面包与小纸人位置重合淡入淡出 |',
    ].join('\n')
    const narrow = createMarkdownStream(plain, () => 60)
    const lines = [...source.split('\n').flatMap(line => narrow.line(line)), ...narrow.flush()]
    expect(lines.join('\n')).toContain('🎙️《')
    const widths = new Set(lines.map(line => displayWidth(line)))
    expect([...widths]).toEqual([displayWidth(lines[0] ?? '')])
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(60)
  })

  it('ignores stray trailing pipes: the header defines the columns', () => {
    // Models routinely pad rows with empty cells or over-long delimiters; the
    // ghosts squeezed real columns into wrapping in the field.
    const rows = renderMarkdown([
      '| a | b | c |',
      '|---|---|---|---|---|---|',
      '| 1 | 2 | 3 | | | |',
      '| 4 | 5 | 6 |||',
    ].join('\n'), plain)
    // Three columns framed: four │ per row, no empty ghost cells.
    expect(rows[1]).toBe('│ a │ b │ c │')
    for (const row of rows) expect(row.split('│').length - 1).toBeLessThanOrEqual(4)
  })

  it('trims columns that are empty in every row, header included', () => {
    const rows = renderMarkdown('| a | b | | |\n|---|---|---|---|\n| 1 | 2 | | |', plain)
    expect(rows[1]).toBe('│ a │ b │')
  })

  it('renders inline constructs inside cells, and sizes on the visible text', () => {
    const colour = createTheme(true, { TERM: 'xterm-256color' })
    const rows = renderMarkdown('| a | b |\n|---|---|\n| `code` | **bold** |', colour)
    const body = rows[3] ?? ''
    // Backticks and stars are consumed, not printed.
    expect(body).not.toContain('`')
    expect(body).not.toContain('**')
    expect(body).toContain('\u001B[38;5;172mcode\u001B[0m')
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

describe('task lists and strikethrough', () => {
  it('renders unchecked task list items with dim circle and preserves indentation', () => {
    expect(render('- [ ] first task', plain)).toBe('○ first task')
    expect(render('* [ ] second task', plain)).toBe('○ second task')
    expect(render('+ [ ] third task', plain)).toBe('○ third task')
    expect(render('  - [ ] nested task', plain)).toBe('  ○ nested task')

    const out = render('- [ ] colored task', colour)
    expect(out).toContain('\u001B[2m○\u001B[0m')
    expect(out).toContain('colored task')
  })

  it('renders completed task list items with checkmark and dimmed strikethrough text', () => {
    expect(render('- [x] done task', plain)).toBe('✔ done task')
    expect(render('* [X] uppercase done', plain)).toBe('✔ uppercase done')
    expect(render('  + [x] nested done', plain)).toBe('  ✔ nested done')

    const out = render('- [x] styled done', colour)
    expect(out).toContain('\u001B[32m✔\u001B[0m')
    expect(out).toContain('\u001B[9mstyled done\u001B[0m')
    expect(out).toContain('\u001B[2m')
  })

  it('renders inline strikethrough with ANSI SGR 9 in colored mode and plain in uncolored', () => {
    expect(renderInline('this is ~~obsolete~~ info', plain)).toBe('this is obsolete info')
    expect(renderInline('~~deprecated~~', colour)).toBe('\u001B[9mdeprecated\u001B[0m')
  })

  it('renders strikethrough inside table cells and mixed with other inline styles', () => {
    expect(renderInline('**bold ~~strike~~ text**', plain)).toBe('bold strike text')
    const table = renderMarkdown('| Old | New |\n|---|---|\n| ~~v1~~ | v2 |', plain)
    expect(table.join('\n')).toContain('v1')
    expect(table.join('\n')).not.toContain('~~')
  })
})
