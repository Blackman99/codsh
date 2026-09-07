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
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ToolWorkflowAgentStartData } from '@deepseek-ai/dsh-tool-workflow/types'
import { unifiedDiffText } from './diff.ts'
import { formatElapsed } from './status.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileDiff, ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { blockRules } from './gutter.ts'
import { renderMarkdown } from './markdown.ts'
import { DEFAULT_DENSITY, DIFF_SOFT_CAP, type Density } from './density.ts'
import { displayWidth, oneRow, truncate } from './theme.ts'
import { todoReport } from './todos.ts'
import type { Theme } from './theme.ts'

export { blockRules, gutter } from './gutter.ts'
export type { GutterRole } from './gutter.ts'

/** Context lines kept on each side of a rendered hunk. */
const DIFF_CONTEXT = 3

/**
 * Result body lines printed for one completed call before the card collapses.
 *
 * Small on purpose: a long output in the transcript is skimmed, not read, and
 * the collapsed remainder is one click — or one Ctrl+O — away in full.
 */
const MAX_RESULT_LINES = 5

/**
 * Rows' worth of columns one shown result line may take before it is cut.
 *
 * The body is capped at {@link MAX_RESULT_LINES} lines, but one line can be
 * a whole page — an HTML document a command printed, a minified bundle, a
 * JSON blob. Left whole it wraps to hundreds of rows, and the card that
 * promised five lines fills the screen many times over; one such line, 49,616
 * characters long, is what a resumed session spent its seconds on. The shown
 * form keeps this much of it, marked; the fold keeps the whole line.
 */
const MAX_RESULT_LINE_ROWS = 3

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
  /** Display columns available for one line, or a getter for live content columns. */
  columns: number | (() => number)
  /** Session workspace, stripped from absolute paths so cards stay short. */
  cwd: string
  /** Transcript density. Compact is the default; comfortable adds turn gaps. */
  density?: Density
}

/** One pending call, kept until its result pairs with it. */
interface PendingCall {
  name: string
  args: unknown
  /** The header line already on screen, so the result does not reprint it. */
  title: string
  /**
   * What the call is about in one short line — the command of a terminal
   * card, the paths of a file card — for a prompt that has to name the call
   * somewhere its card is not, such as the approval widget.
   */
  summary: string | undefined
  /** Description supplied with the tool call, when present. */
  description?: string | undefined
  /**
   * The exact lines the pending card printed, so the finished card can take
   * their place instead of piling up under them. Identity rather than a
   * count: by the time a result lands, an approval note or another call's
   * card may sit between the pending card and the tail. Trimmed if a later
   * card takes over the closing pad this one printed.
   */
  lines: readonly string[]
  /** Whether the pending card joined a run rather than opening one. */
  joined: boolean
  /** Whether the closing pad it printed is still its own. */
  closes: boolean
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
 * What a nameless thinking block is called when a readout names it.
 *
 * A tool block answers with its card's own title, which is already on screen;
 * thinking has no title of its own, so this is its.
 */
export const FOLD_LABELS = { thinking: 'thinking', summary: 'compaction summary' } as const

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

/**
 * The two forms of a thinking block: one slim clock line, and the deliberation
 * behind it.
 *
 * Pages of reasoning would bury the conversation, so the transcript keeps a
 * one-line summary — the `✻` lives in the agent gutter via {@link blockRules} —
 * and hands the full body to the fold (click or Ctrl+O).
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
  hadRun = false,
): { summary: string[], full: string[] } {
  // Glyph lives in the agent gutter (`✻ `); the line is the clock only.
  const clock = seconds === undefined ? 'thought' : `thought for ${formatElapsed(seconds * 1000)}`
  const text = theme.dim(`${cardIndent(theme)}${clock}`)
  const headFull = theme.bgThinking(text)
  const pad = blockPad(theme, text => theme.bgThinking(text))
  const gap = hadRun ? [''] : []
  return {
    // The collapsed summary is a single row with no background color.
    // Surrounded by tool block padding (bgTool), it appears perfectly centered.
    summary: [text],
    full: [...gap, ...pad, headFull, ...lines.map(line => theme.bgThinking(line)), ...pad, ''],
  }
}

/** Count added/removed lines across one or more file diffs. */
function diffStats(diffs: readonly FileDiff[]): { added: number, removed: number } {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    if (diff.oldText === null) {
      const lines = diff.newText.split('\n')
      if (lines.at(-1) === '') lines.pop()
      added += lines.length
      continue
    }
    const patch = structuredPatch('', '', diff.oldText, diff.newText, undefined, undefined, { context: DIFF_CONTEXT })
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added += 1
        else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
      }
    }
  }
  return { added, removed }
}

/**
 * One ToolCard headline: bullet, title, optional +n -m, trailing status.
 *
 * Title truncates first so `+n -m` and the status glyph survive an 80-col
 * terminal; omit the stats segment when both counts are zero.
 * @param theme - styling for title and muted stats.
 * @param columns - display columns available for the line (rule excluded).
 * @param bullet - already-styled leading marker (`●` / pending).
 * @param title - plain card title.
 * @param stats - already-styled `+n -m`, or `''`.
 * @param status - already-styled trailing `✔` / `✗` / spinner.
 * @returns the painted one-liner.
 */
export function formatToolCardLine(
  theme: Theme,
  columns: number,
  bullet: string,
  title: string,
  stats: string,
  status: string,
): string {
  const statsPart = stats === '' ? '' : ` ${stats}`
  const statusPart = ` ${status}`
  const prefix = `${cardIndent(theme)}${bullet} `
  const reserve = displayWidth(oneRow(`${prefix}${statsPart}${statusPart}`))
  const minBudget = columns <= 30 && title.length <= 16 ? title.length : 8
  const titleBudget = Math.max(minBudget, columns - reserve)
  return `${prefix}${theme.tool(truncate(title, titleBudget))}${statsPart}${statusPart}`
}

/** Left inset that keeps a card's glyph clear of the block rule beside it. */
function cardIndent(theme: Theme): string {
  return theme.colored ? '  ' : ''
}

/**
 * The blank row a background-filled block opens with.
 *
 * A block reads as a panel only when its text does not touch the panel edge.
 * Uncoloured output paints no panel and so gets no row.
 * @param theme - the active theme.
 * @param bg - the block's background wrapper.
 * @returns the padding row, or nothing at all when uncoloured.
 */
function blockPad(theme: Theme, bg: (text: string) => string): string[] {
  return theme.colored ? [bg('  ')] : []
}

/**
 * The row a block closes with.
 *
 * On a terminal it is the panel's lower padding, which also holds the next
 * block off it; piped output has no panel to pad, so the separator there is
 * the plain blank row it has always been.
 * @param theme - the active theme.
 * @param bg - the block's background wrapper.
 * @returns the closing row.
 */
function blockClose(theme: Theme, bg: (text: string) => string): string[] {
  return theme.colored ? [bg('  ')] : ['']
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
    return lines.map(line => theme.diffAdd(`+ ${line}`))
  }
  const patch = structuredPatch('', '', diff.oldText, diff.newText, undefined, undefined, { context: DIFF_CONTEXT })
  const lines: string[] = []
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      // The no-trailing-newline marker annotates the patch, not the content.
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('+')) lines.push(theme.diffAdd(`+ ${text}`))
      else if (line.startsWith('-')) lines.push(theme.diffDel(`- ${text}`))
      else lines.push(theme.bgTool(theme.dim(`  ${text}`)))
    }
  }
  return lines
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
  /** The padding row that prompt's panel opens and closes with, if any. */
  private promptPad: string | undefined
  /** Child session a click on this card should open, when the result names one. */
  private enter: string | undefined
  /** Raw text a click on this card should read, when its body was capped. */
  private page: string | undefined
  /** Files the event just rendered reported writing, workspace-relative. */
  private written: readonly string[] = []
  /** Rounds a workflow started, keyed `runId:seq`: an end carries only the seq. */
  private readonly workflowAgents = new Map<string, Pick<ToolWorkflowAgentStartData, 'label' | 'childId'>>()
  /** Whether a real user turn has already been painted — comfortable gaps after the first. */
  private sawUser = false
  /** The pending card the block {@link render} just returned supersedes. */
  private pendingCard: readonly string[] = []
  /**
   * The tool-card run standing at the tail of the transcript.
   *
   * Cards that follow one another share a panel rather than each opening and
   * closing one of their own: only the first pads above, and the closing pad
   * moves down to whichever card is last. A card with body rows keeps the pad
   * above it as the divider from the card before; a bare one-liner does not
   * need one, which is what stops a run of reads from spending three rows on
   * each single line it has to say.
   */
  private run: { rule: string; owner: string | undefined; bodied: boolean; close: string } | undefined

  constructor(
    private readonly options: TranscriptOptions,
    private readonly presenters: ToolPresenters,
  ) {}

  /** Display columns available for content, evaluated live when provided as a getter. */
  get columns(): number {
    return typeof this.options.columns === 'function' ? this.options.columns() : this.options.columns
  }

  /**
   * Switch density for later events. Already-painted cards keep their fold.
   * @param density - the live mode.
   */
  setDensity(density: Density): void {
    this.options.density = density
  }

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

  /** Close an active tool run, so subsequent tools open in a new panel. */
  endRun(): boolean {
    const hadRun = this.run !== undefined
    this.run = undefined
    return hadRun
  }

  /**
   * Render one appended event.
   * @param event - the event exactly as recorded.
   * @returns the lines to append to the transcript, empty when the event shows nothing.
   */
  render(event: SessionEvent): string[] {
    // Only tool cards share a panel; anything else printed under one ends it,
    // and its own leading rows are the gap.
    const hadRun = this.run !== undefined
    const lines = this.renderBlock(event, hadRun)
    if (lines.length > 0 && event.type !== 'tool/call' && event.type !== 'tool/result') {
      this.run = undefined
    }
    return lines
  }

  /**
   * One appended event's finished lines, before the run bookkeeping.
   * @param event - the session event to render.
   * @param hadRun - whether an active tool run was open immediately before this event.
   * @returns the block's lines, empty when the event paints nothing.
   */
  private renderBlock(event: SessionEvent, hadRun = false): string[] {
    const { theme } = this.options
    const rules = blockRules(theme)
    this.rule = ''
    this.prompt = undefined
    this.promptPad = undefined
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
        // The panel's padding is the screen's to place: it wraps the block
        // rather than joining it, so the navigation seam, the fold, and the
        // pinned copy all stay the text the person actually typed.
        this.promptPad = theme.colored ? theme.bgUser('  ') : undefined
        const lines = [
          theme.bgUser(`${cardIndent(theme)}${first}`),
          ...rest.map(line => theme.bgUser(`  ${line}`)),
          ...meta.map(m => theme.bgUser(m)),
          ...this.promptPad === undefined ? [''] : [],
        ]
        // Comfortable only: one extra blank row between turns, never before the first.
        const gap = this.options.density === 'comfortable' && this.sawUser
        this.sawUser = true
        return gap ? ['', ...lines] : lines
      }
      case 'assistant/message': {
        const text = visibleText(event.data.message.content)
        if (text === '') return []
        const lines = renderMarkdown(text, theme)
        return hadRun ? ['', ...lines, ''] : [...lines, '']
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
        const lines = todoReport(event.data.todos, theme, this.columns)
        return lines.length === 0 ? [] : [...lines.map(line => theme.bgTool(line)), '']
      }
      // Compaction — automatic under pressure, or `/compact` — used to leave no
      // trace but the shorter context: its summary replaces history through a
      // `user/message` this renderer drops. The summary event is the moment to
      // say what happened, and the summary itself is what the fold keeps.
      case 'compaction/summary': {
        this.rule = rules.meta
        const items = event.data.shadowedSeqs.length
        const head = theme.bgMeta(theme.dim(`✂ compacted ${String(items)} history item${items === 1 ? '' : 's'} (~${String(event.data.shadowedTokenCount)} tokens) into a summary · ${event.data.model}`))
        const summary = visibleText(event.data.summary)
        const body = summary === '' ? [theme.bgMeta(theme.dim('  (empty summary)'))] : renderMarkdown(summary, theme).map(line => theme.bgMeta(`  ${line}`))
        this.fold = [head, ...body, '']
        this.label = FOLD_LABELS.summary
        return [head, theme.bgMeta(theme.dim(`  … ${String(body.length)} lines of summary (click or Ctrl+O expands)`)), '']
      }
      case 'compaction/end':
        if (event.data.error === undefined) return []
        this.rule = rules.error
        return [theme.bgError(theme.error(`✗ compaction failed: ${event.data.error}`)), '']
      case 'plan/mode':
        this.rule = rules.meta
        return event.data.active
          ? [theme.bgMeta(theme.pending('▲ plan mode — exploring only; no files will change until you approve a plan')), '']
          : [theme.bgMeta(theme.dim('▼ plan mode off')), '']
      case 'turn/end':
        if (event.data.reason.kind !== 'error') return []
        this.rule = rules.error
        return [theme.bgError(theme.error(`✗ ${event.data.reason.error.code}: ${event.data.reason.error.message}`)), '']
      // A workflow — `/ship`'s ralph loop is one — runs for minutes per round
      // and showed nothing until the whole run returned. These four events are
      // its only public progress, so the transcript prints the shape of the
      // run: a head, a line as each round settles, and what stopped it.
      case 'tool-workflow/run-start':
        this.rule = rules.tool
        return [theme.bgTool(`${theme.pending('●')} ${theme.tool(event.data.name)}`)]
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
        if (event.data.outcome === 'completed') return [theme.bgTool(`  ${theme.success('✓')} ${label}`)]
        return [theme.bgError(`  ${theme.error('✗')} ${label} ${theme.dim(`(${event.data.outcome})`)}`)]
      }
      case 'tool-workflow/run-end':
        this.rule = rules.tool
        return [theme.bgTool(theme.dim(`  ${event.data.stopReason}`)), '']
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
  /**
   * One line naming a pending call, for a prompt shown away from its card.
   * @param callId - the call to name.
   * @returns the summary, or undefined once the call has its result or was never seen.
   */
  callSummary(callId: string): string | undefined {
    return this.calls.get(callId)?.summary
  }

  /**
   * What is known about a pending call — its one-line summary and its parsed
   * arguments — for a prompt deciding it away from its card.
   * @param callId - the call to look up.
   * @returns the summary and arguments, or undefined once the call has its result or was never seen.
   */
  pendingCall(callId: string): { summary: string | undefined; args: unknown } | undefined {
    const pending = this.calls.get(callId)
    return pending === undefined ? undefined : { summary: pending.summary, args: pending.args }
  }

  /**
   * Open the tool-card run at the tail, or join the one already standing.
   *
   * Joining means printing no pad above: the card before already closed with
   * one, and that row is the divider between them. Two bare one-liners do not
   * even need that — the newcomer takes over the closing pad — which is what
   * stops a run of reads from spending three rows on each single line it has
   * to say.
   * @param bodied - whether the card prints rows under its head.
   * @param bg - the card's background wrapper.
   * @param close - the rows the card ends with.
   * @param callId - the call the card belongs to, while it is pending.
   * @returns how to open and close the card, and the rows it supersedes.
   */
  private joinRun(bodied: boolean, bg: (text: string) => string, close: string[], callId?: string): {
    lead: string[]
    close: string[]
    joined: boolean
    supersedes: string[]
  } {
    const { theme } = this.options
    const open = this.run
    const joined = open !== undefined && open.rule === this.rule
    let supersedes: string[] = []
    if (joined && open !== undefined && !open.bodied && !bodied && theme.colored) {
      // Neither card has anything under its head, so the row between them is
      // only a gap: the run's closing pad moves down under the newcomer.
      supersedes = [open.close]
      const previous = open.owner === undefined ? undefined : this.calls.get(open.owner)
      if (previous !== undefined) {
        previous.lines = previous.lines.slice(0, -1)
        previous.closes = false
      }
    }
    this.run = { rule: this.rule, owner: callId, bodied, close: close[0] ?? '' }
    return { lead: joined ? [] : blockPad(theme, bg), close, joined, supersedes }
  }

  private renderCall(callId: string, name: string, rawArguments: string): string[] {
    const { theme } = this.options
    const columns = this.columns
    let args: unknown
    try {
      args = JSON.parse(rawArguments)
    } catch {
      // Unparseable arguments still get a card: the model called the tool, and
      // the failure belongs on the result line the executor produces.
      args = undefined
    }
    const view = this.safeCall(name, args)
    let joined = false
    // True until a later card takes the closing pad over.
    const closes = true
    const card = (bodied: boolean): { lead: string[]; close: string[] } => {
      const opened = this.joinRun(bodied, text => theme.bgTool(text), blockPad(theme, text => theme.bgTool(text)), callId)
      this.pendingCard = opened.supersedes
      joined = opened.joined
      return opened
    }
    const record = (title: string, summary: string | undefined, lines: string[], description?: string): string[] => {
      this.calls.set(callId, { name, args, title, summary, description, lines, joined, closes })
      return lines
    }
    const indent = cardIndent(theme)
    if (view === undefined) {
      const { lead, close } = card(false)
      return record(name, undefined, [...lead, theme.bgTool(`${indent}${theme.pending('●')} ${theme.tool(name)}`), ...close])
    }
    if (view.card === 'terminal') {
      const header = view.cwd === undefined ? '' : theme.dim(` (${this.relative(view.cwd)})`)
      const description = view.description === undefined ? [] : [theme.dim(`  ${view.description}`)]
      const command = this.relativizeIn(view.title)
      const lines = command.split('\n')
      const summary = lines.length > 1 ? `${lines[0] ?? ''} …` : command
      const { lead, close } = card(true)
      return record(command, summary, [
        ...lead,
        theme.bgTool(`${indent}${theme.pending('●')} ${theme.tool(name)}${header}`),
        theme.bgTool(`  $ ${truncate(summary, columns - 4)}`),
        ...description.map(d => theme.bgTool(d)),
        ...close,
      ], view.description)
    }
    if (view.card === 'diff') {
      const title = this.relativizeIn(view.title)
      const paths = view.diffs.map(diff => this.relative(diff.path))
      const line = `${title}${this.extraPaths(title, paths)}`
      // Pending stays off-screen: the completed one-liner is the card. The
      // spinner names the tool while it runs.
      return record(line, paths.length === 0 ? title : paths.join(', '), [])
    }
    const title = this.relativizeIn(view.title)
    const locations = (view.locations ?? []).map(location => this.relative(location.path))
    const extra = this.extraPaths(title, locations)
    const { lead, close } = card(false)
    const titleBudget = Math.max(8, columns - 4 - displayWidth(extra))
    return record(`${title}${extra}`, locations.length === 0 ? title : locations.join(', '), [
      ...lead,
      theme.bgTool(`${indent}${theme.pending('●')} ${truncate(title, titleBudget)}${theme.path(extra)}`),
      ...close,
    ])
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
    const bg = failed ? (text: string) => theme.bgError(text) : (text: string) => theme.bgTool(text)
    if (pending === undefined) {
      // The call fell outside this surface's window (a resumed page boundary);
      // the raw result still prints rather than vanishing.
      const marker = failed ? theme.err('✗') : theme.ok('●')
      const text = this.resultText(block.content)
      const { body, full } = this.capBody(text.split('\n').map(line => bg(line)), MAX_RESULT_LINES)
      const head = bg(`${cardIndent(theme)}${marker} ${theme.dim('(result)')}`)
      const enter = failed ? undefined : childSessionId(text)
      const hint = enter === undefined ? [] : [bg(theme.dim('  click to enter'))]
      const { lead, close, supersedes } = this.joinRun(true, bg, blockClose(theme, bg))
      this.pendingCard = supersedes
      if (full !== undefined) {
        this.fold = [...lead, head, ...full, ...hint, ...close]
        this.label = 'tool result'
      }
      if (enter !== undefined) {
        this.enter = enter
        this.label = 'tool result'
      }
      return [...lead, head, ...body, ...hint, ...close]
    }
    const view = this.safeResult(pending, block.content, failed, meta)
    const title = view?.title === undefined ? pending.title : this.relativizeIn(view.title)
    const { suffix, body, full } = this.outcome(view, block, pending)
    const enter = failed ? undefined : childSessionId(this.resultText(block.content))
    const hint = enter === undefined ? [] : [bg(theme.dim('  click to enter'))]
    // One stable ToolCard line: ● · title · +n -m · ✔/✗. Truncate the title
    // first so the stats and status survive a narrow terminal.
    const bullet = theme.ok('●')
    const done = failed ? theme.err('✗') : theme.ok('✔')
    // The screen paints the tool rule (`│ `) beside this line; budget the
    // headline for what's left so `+n -m` cannot wrap onto the next row.
    const ruleWidth = displayWidth(oneRow(this.rule || blockRules(theme).tool))
    const head = [bg(formatToolCardLine(theme, this.columns - ruleWidth, bullet, title, suffix, done))]
    const bodyLines = view?.card === 'diff' ? body : body.map(line => bg(line))
    const fullLines = view?.card === 'diff' ? full : full?.map(line => bg(line))
    // Diff cards stay collapsed on screen (hunks only in the fold).
    const shown = view?.card === 'diff' ? [] : bodyLines
    const bodied = shown.length > 0 || hint.length > 0
    // The card takes the place its pending form held, and keeps that form's
    // standing in the run: a result cannot re-open a panel its pending card
    // already joined, nor re-print a closing pad a later card took over.
    const { lead, close, supersedes } = this.joinRun(bodied, bg, blockClose(theme, bg))
    const open = pending === undefined ? lead : (pending.joined ? [] : blockPad(theme, bg))
    const shut = pending === undefined || pending.closes ? close : []
    this.pendingCard = pending === undefined ? supersedes : pending.lines
    // The fold swaps the WHOLE event's lines, so the expanded form repeats the
    // same head with the uncapped body under it.
    if (fullLines !== undefined) {
      this.fold = [...open, ...head, ...fullLines, ...hint, ...shut]
      this.label = title
    }
    if (enter !== undefined) {
      this.enter = enter
      this.label = title
    }
    return [...open, ...head, ...shown, ...hint, ...shut]
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

  /**
   * The pending card the block just rendered replaces, and forgets it.
   *
   * Empty for everything that is not a completed call, and for a call whose
   * pending card this surface never printed — a resumed page boundary, say.
   * @returns the lines to take the place of.
   */
  takePendingCard(): readonly string[] {
    const card = this.pendingCard
    this.pendingCard = []
    return card
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
  /**
   * The padding row the prompt just rendered wants around it, and forgets it.
   * @returns the row, or undefined when the block paints no panel.
   */
  takePromptPad(): string | undefined {
    const pad = this.promptPad
    this.promptPad = undefined
    return pad
  }

  takePrompt(): number | undefined {
    const prompt = this.prompt
    this.prompt = undefined
    return prompt
  }

  /**
   * Cut each shown result line to a few rows' worth of columns.
   * @param lines - the styled body lines to show.
   * @returns the lines as shown, and how many were cut.
   */
  private fit(lines: readonly string[]): { shown: string[]; cut: number } {
    const budget = Math.max(20, (this.columns - 4) * MAX_RESULT_LINE_ROWS)
    let cut = 0
    const shown = lines.map((line) => {
      // Measured flat, the way a row is painted; a line that fits is kept
      // exactly as it came.
      if (displayWidth(oneRow(line)) <= budget) return line
      cut += 1
      return truncate(line, budget)
    })
    return { shown, cut }
  }

  /**
   * Cap a result body by line count and by line width.
   *
   * Either cut withholds part of the result, so either earns the fold that
   * keeps the whole. The collapsed remainder names its key — an affordance,
   * not just a count — and a body cut only for width says so the same way.
   * @param lines - the rendered body, styled.
   * @param limit - how many lines to show.
   * @param hint - what the summary line promises, when not the default.
   * @returns the body to show, and the full body when anything was withheld.
   */
  private capBody(lines: string[], limit: number, hint = 'click or Ctrl+O expands'): { body: string[]; full?: string[] } {
    const { theme } = this.options
    // If the excess over limit is only 1-2 lines, collapsing them saves nothing
    // because the fold hint itself takes 1 line. Show them in full.
    const slack = 2
    if (lines.length <= limit + slack) {
      const { shown, cut } = this.fit(lines)
      if (cut === 0) return { body: shown }
      const what = cut === 1 ? 'a long line' : `${String(cut)} long lines`
      return { body: [...shown, theme.dim(`  … ${what} cut (${hint})`)], full: lines }
    }
    const { shown, cut } = this.fit(lines.slice(0, limit))
    if (lines.length > limit) {
      return { body: [...shown, theme.dim(`  … +${lines.length - limit} lines (${hint})`)], full: lines }
    }
    if (cut === 0) return { body: shown }
    const what = cut === 1 ? 'a long line' : `${String(cut)} long lines`
    return { body: [...shown, theme.dim(`  … ${what} cut (${hint})`)], full: lines }
  }

  /**
   * Render one completed call's status suffix and body from its declared view.
   * @param view - the result view, absent when no presenter answered.
   * @param block - the model-facing result block, used by the generic fallback.
   * @param pending - the recorded pending call, carrying command or description.
   * @returns the suffix, the (possibly capped) body, and — when the cap dropped
   *   lines, or a bodiless card withheld content — the full body for Ctrl-O.
   */
  private outcome(
    view: ToolResultView | undefined,
    block: { content: ContentBlock[] },
    pending?: PendingCall,
  ): { suffix: string; body: string[]; full?: string[] } {
    const { theme } = this.options
    const capped = (lines: string[], limit: number, hint?: string): { body: string[]; full?: string[] } =>
      this.capBody(lines, limit, hint)
    if (view?.card === 'diff') {
      // What the turn changed on disk. A `/ship` run keeps its plan in a spec
      // file, so the surface learns where that file is by watching it written.
      this.written = view.diffs.map(diff => diff.path)
      const hunks = view.diffs.flatMap(diff => diffBody(diff, theme))
      const { added, removed } = diffStats(view.diffs)
      const stats = added === 0 && removed === 0
        ? ''
        : theme.muted(`+${added} -${removed}`)
      // Default collapsed: one-line ToolCard; body lives in the fold until expand.
      // Soft-cap still applies inside the expanded form; only then does a click
      // open the reader (Ctrl+O still expands inline).
      // Always fold the full hunks; optional reader when the expanded form is large.
      const soft = capped(hunks, DIFF_SOFT_CAP[this.options.density ?? DEFAULT_DENSITY], 'click reads it · Ctrl+O expands')
      if (soft.full !== undefined) this.page = unifiedDiffText(view.diffs, path => this.relative(path))
      return hunks.length === 0
        ? { suffix: stats, body: [] }
        : { suffix: stats, body: [], full: hunks }
    }
    if (view?.card === 'terminal') {
      const suffix = view.signal !== undefined
        ? theme.error(`(killed by ${view.signal})`)
        : view.exitCode !== undefined && view.exitCode !== 0 ? theme.error(`(exit ${view.exitCode})`) : ''
      const output = (view.output ?? '').trimEnd()
      const desc = pending?.description
      const descLines = desc !== undefined && desc !== '' ? [theme.dim(`  ${desc}`)] : []
      const outputLines = output === '' ? [] : output.split('\n').map(line => theme.dim(`  ${line}`))
      const body = [...descLines, ...outputLines]
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
