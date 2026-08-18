/**
 * Session log to terminal lines. One appended {@link SessionEvent} renders to
 * zero or more finished lines; the surface never rewrites a line it has
 * printed, so the transcript scrolls like a shell history.
 *
 * Tool cards come from the registered presenters rather than from tool names:
 * a tool declares its own render intent, and this module switches on the
 * resulting `card` tag.
 * @module codsh/src/transcript
 */

import { structuredPatch } from 'diff'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileDiff, ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { renderMarkdown } from './markdown.ts'
import { truncate } from './theme.ts'
import type { Theme } from './theme.ts'

/** Context lines kept on each side of a rendered hunk. */
const DIFF_CONTEXT = 3

/** Diff body lines printed for one file before the card summarizes the rest. */
const MAX_DIFF_LINES = 40

/** Result body lines printed for one completed call before the card summarizes the rest. */
const MAX_RESULT_LINES = 16

/** The registered presenters, resolved against the agent's scope by the caller. */
export interface ToolPresenters {
  /**
   * Render intent for a pending call.
   * @param name - the tool the model called.
   * @param args - the parsed call arguments.
   * @returns the declared view, or undefined for the generic fallback.
   */
  call(name: string, args: unknown): ToolCallView | undefined
  /**
   * Render intent for a completed call.
   * @param name - the tool the model called.
   * @param args - the parsed call arguments.
   * @param result - the completed outcome.
   * @returns the declared view, or undefined for the generic fallback.
   */
  result(name: string, args: unknown, result: ToolResult): ToolResultView | undefined
}

/** What the renderer needs to know about the surface it writes to. */
export interface TranscriptOptions {
  theme: Theme
  /** Display columns available for one line. */
  columns: number
  /** Session workspace, stripped from absolute paths so cards stay short. */
  cwd: string
}

/** One pending call, kept until its result pairs with it. */
interface PendingCall {
  name: string
  args: unknown
  /** The header line already on screen, so the result does not reprint it. */
  title: string
}

/**
 * Concatenate a message's text blocks, dropping reasoning and non-text content.
 * @param content - the message content blocks.
 * @returns the joined visible text.
 */
function visibleText(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Render one file's change as unified-diff body lines.
 *
 * A {@link FileDiff} carries one hunk's old and new blocks including their
 * context lines, so re-diffing the two blocks recovers which lines actually
 * changed. A `null` `oldText` is a create: every line is an addition.
 * @param diff - the file change to render.
 * @param theme - styling for added and removed lines.
 * @returns the body lines, marker-prefixed.
 */
function diffBody(diff: FileDiff, theme: Theme): string[] {
  if (diff.oldText === null) {
    const lines = diff.newText.split('\n')
    // A file's trailing newline splits into a final empty element; showing it
    // as an added line would claim a line the file does not have.
    if (lines.at(-1) === '') lines.pop()
    return lines.map(line => theme.success(`+ ${line}`))
  }
  const patch = structuredPatch('', '', diff.oldText, diff.newText, undefined, undefined, { context: DIFF_CONTEXT })
  const lines: string[] = []
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      // The no-trailing-newline marker annotates the patch, not the content.
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('+')) lines.push(theme.success(`+ ${text}`))
      else if (line.startsWith('-')) lines.push(theme.error(`- ${text}`))
      else lines.push(theme.dim(`  ${text}`))
    }
  }
  return lines
}

/**
 * Cap a body at `limit` lines, replacing the remainder with a count.
 * @param lines - the rendered body.
 * @param limit - how many lines to keep.
 * @param theme - styling for the summary line.
 * @returns the capped body.
 */
function cap(lines: string[], limit: number, theme: Theme): string[] {
  if (lines.length <= limit) return lines
  return [...lines.slice(0, limit), theme.dim(`  … ${lines.length - limit} more lines`)]
}

/** Renders one session's appended events as terminal lines. */
export class Transcript {
  private readonly calls = new Map<string, PendingCall>()
  /** The most recent result whose body the cap clipped, kept in full. */
  private clipped: { title: string; lines: string[] } | undefined

  constructor(
    private readonly options: TranscriptOptions,
    private readonly presenters: ToolPresenters,
  ) {}

  /**
   * Shorten an absolute path inside the workspace to a workspace-relative one.
   * @param path - the model-facing path a card carries.
   * @returns the display path.
   */
  private relative(path: string): string {
    const root = this.options.cwd.endsWith('/') ? this.options.cwd : `${this.options.cwd}/`
    return path.startsWith(root) ? path.slice(root.length) : path
  }

  /**
   * Shorten every workspace path a presenter embedded in free text.
   *
   * A title is prose the tool composed (`Write /abs/path`), so the path inside
   * it needs the same shortening as a structured `locations` entry.
   * @param text - the presenter-supplied line.
   * @returns the line with workspace-rooted paths made relative.
   */
  private relativizeIn(text: string): string {
    const root = this.options.cwd.endsWith('/') ? this.options.cwd : `${this.options.cwd}/`
    return text.split(root).join('')
  }

  /**
   * Paths worth appending to a title that may already name them.
   * @param title - the presenter's title, already relativized.
   * @param paths - the relativized paths the card covers.
   * @returns the paths the title does not mention, joined for display.
   */
  private extraPaths(title: string, paths: readonly string[]): string {
    const missing = paths.filter(path => !title.includes(path))
    return missing.length === 0 ? '' : ` ${missing.join(', ')}`
  }

  /**
   * Render one appended event.
   * @param event - the event exactly as recorded.
   * @returns the lines to append to the transcript, empty when the event shows nothing.
   */
  render(event: SessionEvent): string[] {
    const { theme } = this.options
    switch (event.type) {
      case 'user/message': {
        // The person's own message: with the box owning the keyboard there is
        // no terminal echo, so this render is the only copy the transcript gets.
        if (event.data.source.kind !== 'user') return []
        const [first = '', ...rest] = visibleText(event.data.content).split('\n')
        return [`${theme.user('›')} ${first}`, ...rest.map(line => `  ${line}`), '']
      }
      case 'assistant/message': {
        const text = visibleText(event.data.message.content)
        return text === '' ? [] : [...renderMarkdown(text, theme), '']
      }
      case 'tool/call':
        return this.renderCall(event.data.callId, event.data.name, event.data.arguments)
      case 'tool/result':
        return this.renderResult(event.data)
      case 'todo/write': {
        const { todos } = event.data
        if (todos.length === 0) return []
        const done = todos.filter(todo => todo.status === 'completed').length
        return [
          `${theme.tool('todos')} ${theme.dim(`${done}/${todos.length}`)}`,
          ...todos.map((todo) => {
            if (todo.status === 'completed') return theme.dim(`  ✔ ${todo.content}`)
            if (todo.status === 'in_progress') return `  ${theme.pending('▶')} ${todo.content}`
            return theme.dim(`  ○ ${todo.content}`)
          }),
          '',
        ]
      }
      case 'plan/mode':
        return event.data.active
          ? [theme.pending('▲ plan mode — exploring only; no files will change until you approve a plan'), '']
          : [theme.dim('▼ plan mode off'), '']
      case 'turn/end':
        return event.data.reason.kind === 'error'
          ? [theme.error(`✗ ${event.data.reason.error.code}: ${event.data.reason.error.message}`), '']
          : []
      default:
        // Merge-extensible map: an event this surface shows nothing for.
        return []
    }
  }

  /**
   * Render a pending call as its declared card.
   * @param callId - correlation id, remembered until the result pairs with it.
   * @param name - the tool the model called.
   * @param rawArguments - the unparsed arguments JSON the model produced.
   * @returns the pending card's lines.
   */
  private renderCall(callId: string, name: string, rawArguments: string): string[] {
    const { theme, columns } = this.options
    let args: unknown
    try {
      args = JSON.parse(rawArguments)
    } catch {
      // Unparseable arguments still get a card: the model called the tool, and
      // the failure belongs on the result line the executor produces.
      args = undefined
    }
    const view = this.safeCall(name, args)
    const record = (title: string, lines: string[]): string[] => {
      this.calls.set(callId, { name, args, title })
      return lines
    }
    if (view === undefined) return record(name, [`${theme.pending('●')} ${theme.tool(name)}`])
    if (view.card === 'terminal') {
      const header = view.cwd === undefined ? '' : theme.dim(` (${this.relative(view.cwd)})`)
      const description = view.description === undefined ? [] : [theme.dim(`  ${view.description}`)]
      const command = this.relativizeIn(view.title)
      return record(command, [
        `${theme.pending('●')} ${theme.tool(name)}${header}`,
        `  $ ${truncate(command, columns - 4)}`,
        ...description,
      ])
    }
    if (view.card === 'diff') {
      const title = this.relativizeIn(view.title)
      const paths = view.diffs.map(diff => this.relative(diff.path))
      const line = `${title}${this.extraPaths(title, paths)}`
      return record(line, [`${theme.pending('●')} ${theme.tool(title)}${theme.path(this.extraPaths(title, paths))}`])
    }
    const title = this.relativizeIn(view.title)
    const locations = (view.locations ?? []).map(location => this.relative(location.path))
    const extra = this.extraPaths(title, locations)
    return record(`${title}${extra}`, [`${theme.pending('●')} ${truncate(title, columns - 4)}${theme.path(extra)}`])
  }

  /**
   * Render a completed call, pairing it with the call this transcript recorded.
   * @param data - the `tool/result` payload.
   * @returns the completed card's lines.
   */
  private renderResult(data: SessionEvent<'tool/result'>['data']): string[] {
    const { theme } = this.options
    const { message, meta, error } = data
    const [block] = message.content
    const callId = message.source.callId
    const pending = this.calls.get(callId)
    this.calls.delete(callId)
    const failed = error !== undefined || block.isError === true
    const marker = failed ? theme.error('✗') : theme.success('●')
    if (pending === undefined) {
      // The call fell outside this surface's window (a resumed page boundary);
      // the raw result still prints rather than vanishing.
      const raw = this.resultText(block.content).split('\n')
      if (raw.length > MAX_RESULT_LINES) this.clipped = { title: '(result)', lines: raw }
      return [`${marker} ${theme.dim('(result)')}`, ...cap(raw, MAX_RESULT_LINES, theme), '']
    }
    const view = this.safeResult(pending, block.content, failed, meta)
    const title = view?.title === undefined ? pending.title : this.relativizeIn(view.title)
    const { suffix, body, full } = this.outcome(view, block)
    if (full !== undefined) this.clipped = { title, lines: full }
    // The pending card already printed this header, and an append-only
    // transcript cannot replace it. Reprinting an unchanged one reads as a
    // stutter, so the header returns only when the call failed or the presenter
    // changed the title. A status the pending line could not know — a match
    // count, an exit code — arrives as a continuation line under it instead, and
    // a completion with neither status nor body gets a `✓` so it never looks
    // stuck.
    const changed = failed || title !== pending.title
    const head = changed
      ? [`${marker} ${theme.tool(title)}${suffix === '' ? '' : ` ${suffix}`}`]
      : suffix !== '' ? [`  ${suffix}`]
        : body.length === 0 ? [`  ${theme.success('✓')}`] : []
    return [...head, ...body, '']
  }

  /**
   * The last clipped result, rendered without its cap.
   *
   * Ctrl-O's answer. The full body is kept from the render itself because a
   * tool's own output limits are upstream of the log — this is everything the
   * model saw, which is everything recoverable.
   * @returns the header and full body, or undefined when nothing was clipped.
   */
  expandLast(): string[] | undefined {
    if (this.clipped === undefined) return undefined
    const { theme } = this.options
    return [
      `${theme.dim('—')} ${theme.tool(this.clipped.title)} ${theme.dim('— full output —')}`,
      ...this.clipped.lines,
      '',
    ]
  }

  /**
   * Render one completed call's status suffix and body from its declared view.
   * @param view - the result view, absent when no presenter answered.
   * @param block - the model-facing result block, used by the generic fallback.
   * @returns the suffix, the (possibly capped) body, and — when the cap dropped
   *   lines, or a bodiless card withheld content — the full body for Ctrl-O.
   */
  private outcome(
    view: ToolResultView | undefined,
    block: { content: ContentBlock[] },
  ): { suffix: string; body: string[]; full?: string[] } {
    const { theme } = this.options
    const capped = (lines: string[], limit: number): { body: string[]; full?: string[] } => {
      const body = cap(lines, limit, theme)
      return lines.length > limit ? { body, full: lines } : { body }
    }
    if (view?.card === 'diff') {
      return { suffix: '', ...capped(view.diffs.flatMap(diff => diffBody(diff, theme)), MAX_DIFF_LINES) }
    }
    if (view?.card === 'terminal') {
      const suffix = view.signal !== undefined
        ? theme.error(`(killed by ${view.signal})`)
        : view.exitCode !== undefined && view.exitCode !== 0 ? theme.error(`(exit ${view.exitCode})`) : ''
      const output = (view.output ?? '').trimEnd()
      // Left to wrap: a truncated command output is a lie about what happened.
      const body = output === '' ? [] : output.split('\n').map(line => theme.dim(`  ${line}`))
      return { suffix, ...capped(body, MAX_RESULT_LINES) }
    }
    if (view?.card === 'search') {
      const total = view.truncated ? `${view.total}+ (capped)` : String(view.total)
      const body = view.shape === 'paths'
        ? view.paths.map(path => theme.dim(`  ${this.relative(path)}`))
        : view.files.flatMap(file => [
          theme.path(`  ${this.relative(file.path)}`),
          ...file.matches.map(match => theme.dim(`    ${match.lineNumber}: ${match.line}`)),
        ])
      return { suffix: theme.dim(`${total} results`), ...capped(body, MAX_RESULT_LINES) }
    }
    if (view?.card === 'read') {
      // The card shows no body, so the read content itself is the withheld
      // part: Ctrl-O is how a person sees what the model just read.
      const body = view.lines.map(line => theme.dim(`  ${line.number}: ${line.text}`))
      return {
        suffix: theme.dim(`${view.lines.length} of ${view.totalLines} lines`),
        body: [],
        ...body.length === 0 ? {} : { full: body },
      }
    }
    const text = this.resultText(view?.card === 'generic' && view.content !== undefined ? view.content : block.content)
    // A successful call whose result the model reads but a reader does not need
    // (an editor's confirmation line) stays out of the transcript body.
    if (text === '') return { suffix: '', body: [] }
    const lines = text.split('\n').map(line => theme.dim(`  ${line}`))
    return { suffix: '', ...capped(lines, MAX_RESULT_LINES) }
  }

  /**
   * Flatten a result's content blocks to displayable text.
   * @param content - the result content blocks.
   * @returns the joined text.
   */
  private resultText(content: readonly ContentBlock[]): string {
    return visibleText(content).trimEnd()
  }

  /**
   * Ask a call presenter for its view, absorbing a throwing presenter.
   * @param name - the tool the model called.
   * @param args - the parsed call arguments.
   * @returns the view, or undefined to fall back to the generic line.
   */
  private safeCall(name: string, args: unknown): ToolCallView | undefined {
    try {
      return this.presenters.call(name, args)
    } catch {
      // A throwing presenter degrades this card; it never breaks the transcript.
      return undefined
    }
  }

  /**
   * Ask a result presenter for its view, absorbing a throwing presenter.
   * @param pending - the recorded call this result pairs with.
   * @param content - the model-facing result content.
   * @param isError - whether the executor reported a failure.
   * @param meta - the tool's private presentation payload, when it attached one.
   * @returns the view, or undefined to fall back to the generic card.
   */
  private safeResult(
    pending: PendingCall,
    content: readonly ContentBlock[],
    isError: boolean,
    meta: SessionEvent<'tool/result'>['data']['meta'],
  ): ToolResultView | undefined {
    try {
      return this.presenters.result(pending.name, pending.args, {
        content: [...content],
        isError,
        ...meta === undefined ? {} : { meta },
      })
    } catch {
      // A throwing presenter degrades this card; it never breaks the transcript.
      return undefined
    }
  }
}
