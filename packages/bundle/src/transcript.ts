/**
 * Session log to terminal lines. One appended {@link SessionEvent} renders to
 * zero or more finished lines; the surface never rewrites a line it has
 * printed, so the transcript scrolls like a shell history.
 *
 * Tool cards come from the registered presenters rather than from tool names:
 * a tool declares its own render intent, and this module switches on the
 * resulting `card` tag.
 * @module codsh-bundle/src/transcript
 */

import { structuredPatch } from 'diff'
// The `./types` entry carries the session-event augmentation for
// `tool-workflow/*`, which is how a workflow's progress reaches this surface.
import type { ToolWorkflowAgentStartData } from '@deepseek-ai/dsh-tool-workflow/types'
import { unifiedDiffText } from './diff.ts'
import { formatElapsed } from './status.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileDiff, ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { renderMarkdown } from './markdown.ts'
import { truncate } from './theme.ts'
import { todoReport } from './todos.ts'
import type { Theme } from './theme.ts'

/** Context lines kept on each side of a rendered hunk. */
const DIFF_CONTEXT = 3

/** Diff body lines printed for one file before the card collapses the rest. */
const MAX_DIFF_LINES = 24

/**
 * Result body lines printed for one completed call before the card collapses.
 *
 * Small on purpose: a long output in the transcript is skimmed, not read, and
 * the collapsed remainder is one click — or one Ctrl+O — away in full.
 */
const MAX_RESULT_LINES = 5

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
 * One dim line per image a user message carried, in place of pixels.
 *
 * An image block's bytes cannot render here, and a `<pasted-image>` context
 * block is the pipeline talking to the model — pages of description would
 * bury the words the person typed. Either becomes a line saying what rode
 * along and what became of it.
 * @param content - the message's blocks.
 * @param theme - styling for the meta lines.
 * @returns the lines, empty for a text-only message.
 */
function imageMetaLines(content: readonly ContentBlock[], theme: Theme): string[] {
  const lines: string[] = []
  for (const block of content) {
    if (block.type === 'image') {
      const { width, height, mediaType } = block.attachment
      lines.push(theme.dim(`  [image · ${width}×${height} ${mediaType.slice(6)} · sent to the model]`))
    } else if (block.type === 'text' && block.text.startsWith('<pasted-image ')) {
      const id = /id="(\d+)"/u.exec(block.text)?.[1] ?? '?'
      const dims = /dimensions="(\d+)x(\d+)"/u.exec(block.text)
      const media = /media="image\/(\w+)"/u.exec(block.text)?.[1] ?? 'image'
      const size = dims === null ? '' : ` · ${dims[1]}×${dims[2]}`
      const fate = block.text.includes('<description>') ? 'described' : 'saved to file'
      lines.push(theme.dim(`  [image #${id}${size} ${media} · ${fate}]`))
    }
  }
  return lines
}

/**
 * The left rules the transcript draws down a block's edge, one per kind.
 *
 * A rule is how a segment shows where it starts and ends without a frame or a
 * background fill: the references converge on a left border (Claude Code's
 * `borderLeft`, opencode's `border: ["left"]`), and a border costs one column
 * where a fill costs the terminal's own background — which is the theme's to
 * decide, not this surface's (ADR-0001).
 *
 * The person's own words get the heavy mark; a tool block gets the light one,
 * in the error colour when the call failed. What a person actually reads — an
 * answer, a thinking summary — stays flush, so the rules mark the machinery
 * around it rather than everything equally.
 * @param theme - styling for the marks.
 * @returns the rule per block kind.
 */
export function blockRules(theme: Theme): { user: string, tool: string, error: string } {
  return { user: theme.user('┃ '), tool: theme.tool('│ '), error: theme.error('│ ') }
}

/**
 * What the two nameless block kinds are called when a readout names them.
 *
 * A tool block answers with its card's own title, which is already on screen;
 * thinking and an answer have no title of their own, so these are theirs.
 */
export const FOLD_LABELS = { thinking: 'thinking', answer: 'answer' } as const

/**
 * The child session a continuable subagent result names, when the card can
 * open that session.
 *
 * Continuable starts return `started subagent <id>` (and a JSON form with the
 * same id). One-shot background jobs name a job, not a session, and are not a
 * view.
 * @param text - the tool result's visible text.
 * @returns the child session id, or undefined when this result is not a view.
 */
export function childSessionId(text: string): string | undefined {
  const trimmed = text.trim()
  const started = /^started subagent (\S+)/u.exec(trimmed.split('\n')[0] ?? trimmed)
  if (started?.[1] !== undefined) return started[1]
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (
      parsed !== null
      && typeof parsed === 'object'
      && 'kind' in parsed
      && parsed.kind === 'continuable'
      && 'subagentId' in parsed
      && typeof parsed.subagentId === 'string'
      && parsed.subagentId !== ''
    ) return parsed.subagentId
  } catch {
    // Not JSON; the prose form above is the usual card.
  }
  return undefined
}

/** A finished answer longer than this many rendered lines becomes a fold. */
export const ANSWER_FOLD_LINES = 24

/** How many of its head lines a collapsed answer keeps visible. */
export const ANSWER_HEAD_LINES = 8

/**
 * The collapsed form of a finished answer, when it is long enough to fold.
 *
 * Shared by the live turn and by replay: a resumed session must offer the same
 * summary the turn itself left behind, or history would read as a different
 * conversation from the one that happened.
 * @param lines - the answer's rendered lines, without its trailing blank.
 * @param theme - styling for the count line.
 * @returns the collapsed lines, or undefined when the answer is short enough
 *   to stand as it is.
 */
export function answerSummary(lines: readonly string[], theme: Theme): string[] | undefined {
  if (lines.length <= ANSWER_FOLD_LINES) return undefined
  return [
    ...lines.slice(0, ANSWER_HEAD_LINES),
    theme.dim(`  … +${lines.length - ANSWER_HEAD_LINES} lines (click or Ctrl+O expands)`),
    '',
  ]
}

/**
 * The two forms of a thinking block: one dim line, and the deliberation behind
 * it.
 *
 * Pages of reasoning would bury the conversation, so the transcript keeps the
 * summary and hands the rest to Ctrl+O — live and on replay alike.
 * @param lines - the rendered thinking lines, already styled.
 * @param theme - styling for the header.
 * @param seconds - how long the thinking took, when the surface timed it; a
 *   replayed log carries no clock, so the header simply says it thought.
 * @returns the collapsed and expanded forms.
 */
export function thinkingFold(
  lines: readonly string[],
  theme: Theme,
  seconds?: number,
): { summary: string[], full: string[] } {
  const head = seconds === undefined ? '✻ thought' : `✻ thought for ${formatElapsed(seconds * 1000)}`
  return {
    summary: [theme.dim(`${head} · +${lines.length} lines (click or Ctrl+O expands)`), ''],
    full: [theme.dim(head), ...lines, ''],
  }
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
function cap(lines: string[], limit: number, theme: Theme, hint = 'click or Ctrl+O expands'): string[] {
  if (lines.length <= limit) return lines
  // The collapsed remainder names its key: an affordance, not just a count.
  return [...lines.slice(0, limit), theme.dim(`  … +${lines.length - limit} lines (${hint})`)]
}

/** Renders one session's appended events as terminal lines. */
export class Transcript {
  private readonly calls = new Map<string, PendingCall>()
  /** The full form of the event just rendered, when its body was collapsed. */
  private fold: string[] | undefined
  /** What the block {@link render} just returned is, for a hover readout. */
  private label = ''
  /** The left rule the block {@link render} just returned belongs to. */
  private rule = ''
  /** Explicit text lines in the real-user prompt just rendered. */
  private prompt: number | undefined
  /** Child session a click on this card should open, when the result names one. */
  private enter: string | undefined
  /** Raw text a click on this card should read, when its body was capped. */
  private page: string | undefined
  /** Files the event just rendered reported writing, workspace-relative. */
  private written: readonly string[] = []
  /** Rounds a workflow started, keyed `runId:seq`: an end carries only the seq. */
  private readonly workflowAgents = new Map<string, Pick<ToolWorkflowAgentStartData, 'label' | 'childId'>>()

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
    const rules = blockRules(theme)
    this.rule = ''
    this.prompt = undefined
    this.enter = undefined
    this.page = undefined
    this.written = []
    switch (event.type) {
      case 'user/message': {
        // The person's own message: with the box owning the keyboard there is
        // no terminal echo, so this render is the only copy the transcript gets.
        if (event.data.source.kind !== 'user') return []
        this.rule = rules.user
        // Only what the person typed: a trailing <pasted-image> block is the
        // pipeline's context for the model, summarized by a meta line instead.
        const typed = event.data.content
          .filter(block => block.type === 'text')
          .filter(block => !block.text.startsWith('<pasted-image '))
        const [first = '', ...rest] = typed.map(block => block.text).join('').split('\n')
        this.prompt = 1 + rest.length
        const meta = imageMetaLines(event.data.content, theme)
        return [`${theme.user('›')} ${first}`, ...rest.map(line => `  ${line}`), ...meta, '']
      }
      case 'assistant/message': {
        const text = visibleText(event.data.message.content)
        return text === '' ? [] : [...renderMarkdown(text, theme), '']
      }
      case 'tool/call':
        this.rule = rules.tool
        return this.renderCall(event.data.callId, event.data.name, event.data.arguments)
      case 'tool/result':
        // Set before rendering: a failed call re-marks the block's edge, which
        // is the renderer's own finding rather than something the type says.
        this.rule = rules.tool
        return this.renderResult(event.data)
      case 'todo/write': {
        this.rule = rules.tool
        // The same renderer the pinned readout uses: the card is this write, the
        // readout is the list as it now stands, and they must not disagree.
        const lines = todoReport(event.data.todos, theme, this.options.columns)
        return lines.length === 0 ? [] : [...lines, '']
      }
      case 'plan/mode':
        return event.data.active
          ? [theme.pending('▲ plan mode — exploring only; no files will change until you approve a plan'), '']
          : [theme.dim('▼ plan mode off'), '']
      case 'turn/end':
        if (event.data.reason.kind !== 'error') return []
        this.rule = rules.error
        return [theme.error(`✗ ${event.data.reason.error.code}: ${event.data.reason.error.message}`), '']
      // A workflow — `/ship`'s ralph loop is one — runs for minutes per round
      // and showed nothing until the whole run returned. These four events are
      // its only public progress, so the transcript prints the shape of the
      // run: a head, a line as each round settles, and what stopped it.
      case 'tool-workflow/run-start':
        this.rule = rules.tool
        return [`${theme.pending('●')} ${theme.tool(event.data.name)}`]
      case 'tool-workflow/agent-start':
        // Nothing is appended for a start: the round that is running is named
        // in the working line, which is where a moving figure belongs. An
        // append-only transcript cannot take the line back when it ends.
        this.workflowAgents.set(`${event.data.runId}:${String(event.data.seq)}`, {
          label: event.data.label,
          childId: event.data.childId,
        })
        this.rule = rules.tool
        return []
      case 'tool-workflow/agent-end': {
        const key = `${event.data.runId}:${String(event.data.seq)}`
        const started = this.workflowAgents.get(key)
        this.workflowAgents.delete(key)
        const label = started?.label ?? `round ${String(event.data.seq)}`
        this.rule = rules.tool
        // No door, though the event names a child session: a workflow's
        // children run in a worker thread, so their sessions are never in this
        // process's registry — clicking a round could only ever answer "no
        // longer running". Driven on a real terminal, that is exactly what it
        // answered. The line stands on its own.
        if (event.data.outcome === 'completed') return [`  ${theme.success('✓')} ${label}`]
        return [`  ${theme.error('✗')} ${label} ${theme.dim(`(${event.data.outcome})`)}`]
      }
      case 'tool-workflow/run-end':
        this.rule = rules.tool
        return [theme.dim(`  ${event.data.stopReason}`), '']
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
      // A command that is several lines is named by its first. The rest is not
      // lost — it arrives in full with the result — and a script whose lines
      // are run together on one row reads as noise.
      const lines = command.split('\n')
      const summary = lines.length > 1 ? `${lines[0] ?? ''} …` : command
      return record(command, [
        `${theme.pending('●')} ${theme.tool(name)}${header}`,
        `  $ ${truncate(summary, columns - 4)}`,
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
    if (failed) this.rule = blockRules(theme).error
    const marker = failed ? theme.error('✗') : theme.success('●')
    if (pending === undefined) {
      // The call fell outside this surface's window (a resumed page boundary);
      // the raw result still prints rather than vanishing.
      const text = this.resultText(block.content)
      const raw = text.split('\n')
      const head = `${marker} ${theme.dim('(result)')}`
      const enter = failed ? undefined : childSessionId(text)
      const hint = enter === undefined ? [] : [theme.dim('  click to enter')]
      if (raw.length > MAX_RESULT_LINES) {
        this.fold = [head, ...raw, ...hint, '']
        this.label = 'tool result'
      }
      if (enter !== undefined) {
        this.enter = enter
        this.label = 'tool result'
      }
      return [head, ...cap(raw, MAX_RESULT_LINES, theme), ...hint, '']
    }
    const view = this.safeResult(pending, block.content, failed, meta)
    const title = view?.title === undefined ? pending.title : this.relativizeIn(view.title)
    const { suffix, body, full } = this.outcome(view, block)
    const enter = failed ? undefined : childSessionId(this.resultText(block.content))
    const hint = enter === undefined ? [] : [theme.dim('  click to enter')]
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
        : body.length === 0 && hint.length === 0 ? [`  ${theme.success('✓')}`] : []
    // The fold swaps the WHOLE event's lines, so the expanded form repeats the
    // same head with the uncapped body under it.
    if (full !== undefined) {
      this.fold = [...head, ...full, ...hint, '']
      // The card's own title, unstyled: what the block is called on screen is
      // what a readout naming it should say.
      this.label = title
    }
    if (enter !== undefined) {
      this.enter = enter
      this.label = title
    }
    return [...head, ...body, ...hint, '']
  }

  /**
   * The expanded form of the lines {@link render} just returned, when that
   * event's body was collapsed — the whole event re-rendered without its cap,
   * because a fold swaps entire blocks, not just the clipped tail. The full
   * body is kept from the render itself: what a tool truncated before
   * returning is upstream of the log and unrecoverable everywhere.
   * @returns the full lines, or undefined when nothing was collapsed.
   */
  takeFold(): string[] | undefined {
    const fold = this.fold
    this.fold = undefined
    return fold
  }

  /**
   * What the block {@link takeFold} just described is called.
   *
   * The card's title, so the readout that names what the pointer rests on says
   * the same thing the block's own head line says.
   * @returns the label, or `''` when the block has no name of its own.
   */
  takeLabel(): string {
    const label = this.label
    this.label = ''
    return label
  }

  /**
   * The child session the block {@link render} just returned can open.
   *
   * A click on that card enters the child's transcript rather than folding
   * the card. Taken once, like {@link takeFold}.
   * @returns the child session id, or undefined when the card is not a view.
   */
  takeEnter(): string | undefined {
    const enter = this.enter
    this.enter = undefined
    return enter
  }

  /**
   * Raw text a click on the block {@link render} just returned should read
   * instead of expanding. Taken once, like {@link takeFold}.
   * @returns the reader's text, or `undefined` when the block just folds.
   */
  /**
   * Paths the block {@link render} just returned reported writing. Taken once,
   * like {@link takeFold}.
   * @returns the paths, empty when the event wrote nothing.
   */
  takeWritten(): readonly string[] {
    const written = this.written
    this.written = []
    return written
  }

  takePage(): string | undefined {
    const page = this.page
    this.page = undefined
    return page
  }

  /**
   * The left rule for the block {@link render} just returned, `''` when the
   * block stands flush.
   *
   * Paired with the lines rather than baked into them: the rule repeats on
   * every row the block wraps to, which only the buffer that wraps them knows.
   * @returns the styled rule, or `''`.
   */
  takeRule(): string {
    const rule = this.rule
    this.rule = ''
    return rule
  }

  /**
   * Explicit text-line count when the last block starts a response section.
   *
   * Only a real `source.kind === "user"` message sets it; plugin context may
   * use the user role for the model but must never become navigation chrome.
   */
  takePrompt(): number | undefined {
    const prompt = this.prompt
    this.prompt = undefined
    return prompt
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
    const capped = (lines: string[], limit: number, hint?: string): { body: string[]; full?: string[] } => {
      const body = cap(lines, limit, theme, hint)
      return lines.length > limit ? { body, full: lines } : { body }
    }
    if (view?.card === 'diff') {
      // What the turn changed on disk. A `/ship` run keeps its plan in a spec
      // file, so the surface learns where that file is by watching it written.
      this.written = view.diffs.map(diff => diff.path)
      const result = capped(
        view.diffs.flatMap(diff => diffBody(diff, theme)),
        MAX_DIFF_LINES,
        'click reads it · Ctrl+O expands',
      )
      // Only a diff that outgrew its card earns the reader; a short one is
      // already whole on screen, and opening a modal over it would be noise.
      if (result.full !== undefined) this.page = unifiedDiffText(view.diffs, path => this.relative(path))
      return { suffix: '', ...result }
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
