/**
 * Markdown as terminal lines.
 *
 * A model answers in Markdown, and printing the source verbatim leaves the
 * reader to parse `**` and fences by eye. This renders the constructs that
 * actually change how an answer reads — headings, lists, quotes, emphasis,
 * inline code, and fenced blocks — and leaves everything else exactly as it
 * arrived. Anything unrecognised must survive unchanged: mangling prose to
 * decorate it is worse than not decorating it.
 * @module codsh-cli/src/markdown
 */

import { displayWidth } from './theme.ts'
import { wrapStyled } from './wrap.ts'
import type { SyntaxTheme, Theme } from './theme.ts'

/** Opens or closes a fenced block, capturing its language. */
const FENCE = /^\s*(?:```|~~~)\s*([\w+-]*)\s*$/

/** An ATX heading and its text. */
const HEADING = /^(#{1,6})\s+(.*)$/

/** A bullet item: the indent, the marker, and the text. */
const BULLET = /^(\s*)[-*+]\s+(.*)$/

/** A numbered item: the indent, the number, and the text. */
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/

/** A blockquote line. */
const QUOTE = /^\s*>\s?(.*)$/

/** A thematic break. */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/

/** A table row: pipe-delimited cells with a leading and trailing pipe. */
const TABLE_ROW = /^\s*\|.*\|\s*$/

/** A table's delimiter cell: dashes with optional alignment colons. */
const TABLE_DELIMITER = /^:?-+:?$/

/**
 * Inline constructs, in one alternation so each is consumed once.
 *
 * Ordered so the longer delimiter wins: `**bold**` must not be read as two
 * empty emphases. Code spans come first because their content is literal.
 *
 * The underscore forms are guarded against intraword matches, which is what
 * Markdown itself requires: without the guard `some_helper_name` reads as an
 * emphasis and the identifier comes out mangled.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|((?<!\w)__[^_]+__(?!\w))|(\[[^\]]*\]\([^)]*\))|(\*[^*\s][^*]*\*)|((?<!\w)_[^_\s][^_]*_(?!\w))/g

/**
 * Keywords shared across the languages this surface commonly shows.
 *
 * Deliberately conservative: a word that reads as a keyword in one language and
 * as an ordinary name in another is left out, because colouring `go(...)` or
 * `use(...)` as a keyword is a visible error while missing one is not.
 */
const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default',
  'defer', 'elif', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'fn', 'for', 'from',
  'func', 'function', 'if', 'impl', 'import', 'in', 'instanceof', 'interface', 'lambda', 'let',
  'match', 'new', 'nil', 'none', 'null', 'package', 'private', 'protected', 'public', 'raise',
  'return', 'self', 'static', 'struct', 'super', 'switch', 'this', 'throw', 'trait', 'true', 'try',
  'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
])

/** Code tokens, in one alternation: strings, comments, numbers, then words. */
const CODE_TOKEN = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|#[^\n]*)|(\b\d[\d_.]*\b)|(\b[A-Za-z_]\w*\b)/g

/**
 * Colour one line of code by token class.
 *
 * A heuristic, not a parser: it has no state between lines, so a string or
 * comment spanning several lines is coloured only on the line where it opens.
 * Getting that wrong costs a colour, never the text — every branch reproduces
 * its input exactly.
 * @param line - the code line.
 * @param syntax - styling per token class.
 * @returns the coloured line.
 */
export function highlightCode(line: string, syntax: SyntaxTheme): string {
  return line.replace(CODE_TOKEN, (
    match: string,
    text: string | undefined,
    comment: string | undefined,
    number: string | undefined,
    word: string | undefined,
  ) => {
    if (text !== undefined) return syntax.string(text)
    if (comment !== undefined) return syntax.comment(comment)
    if (number !== undefined) return syntax.number(number)
    if (word !== undefined && KEYWORDS.has(word)) return syntax.keyword(word)
    return match
  })
}

/**
 * Style the inline constructs of one line of prose.
 * @param text - the line, with block syntax already stripped.
 * @param theme - styling for emphasis, code spans, and link targets.
 * @returns the styled line.
 */
export function renderInline(text: string, theme: Theme): string {
  // Emphasis wrapping is applied per segment around any code spans inside it:
  // one SGR reset ends every open style, so `bold(a + tool(b) + c)` would drop
  // the bold after `b` — and a single-pass regex would instead leave the
  // backticks in the text, which is what models' headings actually hit.
  const emphasized = (inner: string): string =>
    inner.split(/(`[^`]+`)/u).map(segment =>
      segment.startsWith('`') && segment.endsWith('`') && segment.length > 1
        ? theme.bold(theme.tool(segment.slice(1, -1)))
        : segment === '' ? '' : theme.bold(segment)).join('')
  return text.replace(INLINE, (
    match: string,
    code: string | undefined,
    starBold: string | undefined,
    underBold: string | undefined,
    link: string | undefined,
    starEm: string | undefined,
    underEm: string | undefined,
  ) => {
    if (code !== undefined) return theme.tool(code.slice(1, -1))
    if (starBold !== undefined) return emphasized(starBold.slice(2, -2))
    if (underBold !== undefined) return emphasized(underBold.slice(2, -2))
    if (link !== undefined) {
      const parts = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(link)
      if (parts === null) return match
      const [, label, target] = parts
      // The target is kept: a terminal cannot hide it behind a click.
      return `${theme.bold(label ?? '')} ${theme.dim(`(${target ?? ''})`)}`
    }
    if (starEm !== undefined) return emphasized(starEm.slice(1, -1))
    if (underEm !== undefined) return emphasized(underEm.slice(1, -1))
    return match
  })
}

/**
 * A Markdown renderer that consumes one line at a time.
 *
 * Stateful because fencing is: whether a line is code depends on a fence seen
 * earlier, so a renderer that forgot between lines would style the inside of a
 * code block as prose. This is the form streaming needs — a line can be
 * rendered the moment it completes, without waiting for the whole answer.
 */
export interface MarkdownStream {
  /**
   * Render one input line.
   * @param line - the line, without its terminator.
   * @returns the output lines, which may be none (a fence delimiter, or a table
   *   row held until the table ends).
   */
  line(line: string): string[]
  /**
   * Close the stream, rendering anything still held back.
   *
   * A table is only recognisable once its delimiter row arrives, so its rows
   * buffer; an answer that ends mid-table must still show them.
   * @returns the remaining output lines.
   */
  flush(): string[]
  /** Whether the renderer is currently inside a fenced block. */
  readonly inCode: boolean
}

/**
 * Build a line-at-a-time Markdown renderer.
 * @param theme - styling for every construct.
 * @param columns - display columns available, read per table; absent means
 *   unconstrained. A table wider than this prints as its source lines.
 * @returns the renderer, carrying its own fence and table state.
 */
export function createMarkdownStream(theme: Theme, columns?: () => number): MarkdownStream {
  let fenceLanguage: string | undefined
  const table: string[] = []
  const fence: FenceState = {
    get: () => fenceLanguage,
    set: (value) => { fenceLanguage = value },
  }
  const drainTable = (): string[] => {
    if (table.length === 0) return []
    return layoutTable(table.splice(0), theme, columns?.() ?? Number.POSITIVE_INFINITY)
  }
  return {
    get inCode(): boolean {
      return fenceLanguage !== undefined
    },
    line: (line: string): string[] => {
      // Table rows buffer until the table ends: layout needs every row's width.
      // A fence keeps its content verbatim, so rows inside one are code.
      if (fenceLanguage === undefined && TABLE_ROW.test(line)) {
        table.push(line)
        return []
      }
      return [...drainTable(), ...renderLine(line, theme, fence)]
    },
    flush: drainTable,
  }
}

/**
 * Lay out one buffered table, or fall back to its source lines.
 *
 * Cells print verbatim — padding is by display width, and styled text would
 * make the two disagree. Only the frame carries styling: the header is bold and
 * the rule under it dim.
 * @param rows - the raw `|`-delimited lines, in order.
 * @param theme - styling for the frame.
 * @param budget - display columns available; a wider table degrades to source.
 * @returns the rendered table, or the source lines styled as prose.
 */
function layoutTable(rows: readonly string[], theme: Theme, budget: number): string[] {
  const asSource = (): string[] => rows.map(row => renderInline(row, theme))
  const raw = rows.map(row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()))
  const delimiter = raw[1]
  // Without a delimiter row this is not a table, just prose with pipes.
  if (raw.length < 2 || delimiter === undefined || !delimiter.every(cell => TABLE_DELIMITER.test(cell))) {
    return asSource()
  }
  // Cells render their inline constructs — a model puts code spans and bold in
  // tables constantly — and every width below is of the VISIBLE text.
  const styled = [raw[0] ?? [], ...raw.slice(2)].map(row => row.map(cell => renderInline(cell, theme)))
  const visible = (cell: string): number => displayWidth(cell.replaceAll(/\u001B\[[0-9;]*m/gu, ''))
  const count = Math.max(...styled.map(row => row.length))
  const natural = Array.from({ length: count }, (_, column) =>
    Math.max(1, ...styled.map(row => visible(row[column] ?? ''))))
  // ` │ ` between columns: with wrapped cells, a bare gap loses which column a
  // continuation row belongs to; the rule keeps every row legible.
  const gaps = 3 * (count - 1)
  // A table too wide for the terminal keeps its shape by wrapping inside the
  // cells: columns shrink toward the budget in proportion to their excess over
  // an even share, and a truly hopeless width falls back to the source lines.
  let widths = [...natural]
  const total = natural.reduce((sum, width) => sum + width, 0)
  if (total + gaps > budget) {
    const available = budget - gaps
    if (available < count * 3) return asSource()
    const fair = Math.floor(available / count)
    // Narrow columns keep their natural width; the wide ones split the rest.
    const kept = natural.map(width => Math.min(width, fair))
    let spare = available - kept.reduce((sum, width) => sum + width, 0)
    widths = natural.map((width, column) => {
      const base = kept[column] ?? 0
      if (width <= base) return width
      const extra = Math.min(width - base, spare)
      spare -= extra
      return base + extra
    })
  }
  const rule = theme.dim(' │ ')
  const line = (row: readonly string[], style: (text: string) => string): string[] => {
    // Each cell wraps at its column width; the row is as tall as its tallest,
    // and every physical row carries the column rules so a continuation still
    // reads as part of its column.
    const wrapped = Array.from({ length: count }, (_, column) => wrapStyled(row[column] ?? '', widths[column] ?? 1))
    const height = Math.max(...wrapped.map(cell => cell.length))
    return Array.from({ length: height }, (_, index) =>
      wrapped.map((cell, column) => {
        const piece = cell[index] ?? ''
        const alignRight = /^:?-+:$/.test(delimiter[column] ?? '') && !/^:-+:$/.test(delimiter[column] ?? '')
        const pad = ' '.repeat(Math.max(0, (widths[column] ?? 0) - visible(piece)))
        return alignRight ? `${pad}${style(piece)}` : `${style(piece)}${pad}`
      }).join(rule).trimEnd())
  }
  const separator = theme.dim(widths.map(width => '─'.repeat(width)).join('─┼─'))
  const groups = styled.slice(1).map(row => line(row, text => text))
  // Once any row wraps, its continuations would blur into the next record, so
  // a wrapped table rules BETWEEN rows too; a compact table keeps only the
  // head rule and stays dense.
  const ruled = groups.some(group => group.length > 1)
  const body = groups.flatMap((group, index) => index > 0 && ruled ? [separator, ...group] : group)
  return [
    ...line(styled[0] ?? [], text => theme.bold(text)),
    // One unbroken separator with crossings at the column rules, so the head
    // is underlined across the WHOLE table rather than only its first column.
    separator,
    ...body,
  ]
}

/** The fence state one {@link renderLine} call may read and change. */
interface FenceState {
  get(): string | undefined
  set(value: string | undefined): void
}

/**
 * Render one Markdown line against the carried fence state.
 * @param line - the input line.
 * @param theme - styling for every construct.
 * @param fence - the fence state, read and updated in place.
 * @returns the output lines for this input line.
 */
function renderLine(line: string, theme: Theme, fence: FenceState): string[] {
  const out: string[] = []
  {
    const opened = FENCE.exec(line)
    let fenceLanguage = fence.get()
    if (opened !== null) {
      if (fenceLanguage === undefined) {
        fenceLanguage = opened[1] ?? ''
        // The language is worth naming; the fence itself is not.
        if (fenceLanguage !== '') out.push(theme.dim(`  ${fenceLanguage}`))
      } else {
        fenceLanguage = undefined
      }
      fence.set(fenceLanguage)
      return out
    }
    if (fenceLanguage !== undefined) {
      // Indented rather than fenced, so a block reads as code without the
      // reader having to match delimiters.
      out.push(`  ${highlightCode(line, theme.syntax)}`)
      return out
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      out.push(theme.bold(renderInline(heading[2] ?? '', theme)))
      return out
    }
    if (RULE.test(line)) {
      out.push(theme.dim('───'))
      return out
    }
    const quote = QUOTE.exec(line)
    if (quote !== null) {
      out.push(`${theme.dim('│')} ${theme.dim(renderInline(quote[1] ?? '', theme))}`)
      return out
    }
    const bullet = BULLET.exec(line)
    if (bullet !== null) {
      out.push(`${bullet[1] ?? ''}${theme.dim('•')} ${renderInline(bullet[2] ?? '', theme)}`)
      return out
    }
    const numbered = NUMBERED.exec(line)
    if (numbered !== null) {
      out.push(`${numbered[1] ?? ''}${theme.dim(`${numbered[2] ?? ''}.`)} ${renderInline(numbered[3] ?? '', theme)}`)
      return out
    }
    out.push(renderInline(line, theme))
  }
  return out
}

/**
 * Render a whole Markdown answer as terminal lines.
 * @param text - the answer, as the model produced it.
 * @param theme - styling for every construct.
 * @returns the output lines, blocks included.
 */
export function renderMarkdown(text: string, theme: Theme): string[] {
  const stream = createMarkdownStream(theme)
  return [...text.split('\n').flatMap(line => stream.line(line)), ...stream.flush()]
}
