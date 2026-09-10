/**
 * Session log to terminal lines. One appended {@link SessionEvent} renders to
 * zero or more finished lines; the surface never rewrites a line it has
 * printed, so the transcript scrolls like a shell history.
 *
 * Tool cards come from the registered presenters rather than from tool names:
 * a tool declares its own render intent, and this module switches on the
 * resulting `card` tag. Consecutive cards with the same command and output
 * shape collapse into one fold rather than stacking.
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
import { DEFAULT_DENSITY, DIFF_SOFT_CAP, blockGap, type Density } from './density.ts'
import { displayWidth, oneRow, truncate } from './theme.ts'
import { todoReport } from './todos.ts'
import { toolCategory, toolGroupLabel, type ToolCategory } from './tool-group.ts'
import { isDestructiveCommand } from './destructive.ts'
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

/** The glyph that marks a tool group's single row. Kept distinct from the `✻` thinking mark. */
const TOOL_BULLET = '●'

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
  /** The call's one-line title, as the presenter declared it. */
  title: string
  /**
   * What the call is about in one short line — the command of a terminal
   * call, the paths of a file call — for a prompt that has to name the call
   * somewhere its row is not, such as the approval widget.
   */
  summary: string | undefined
  /** Description supplied with the tool call, when present. */
  description?: string | undefined
  /**
   * Child session this pending call was promoted to, when `subagent/start`
   * bound it as a view before the tool result.
   */
  enter?: string
  /** The group member this call is counted under, while its run is alive. */
  member?: GroupMember
}

/**
 * One call inside the tool run at the tail.
 *
 * The run is the unit of layout and interaction: its members share one muted
 * row and one Fold, and the label is recomputed from them as calls settle.
 */
interface GroupMember {
  /** Correlation id; absent for an unpaired result from a replayed page boundary. */
  callId: string | undefined
  name: string
  /** The category the merged label counts this member under. */
  category: ToolCategory
  /** Whether this member's call is still in flight. */
  running: boolean
  /** Whether the executor reported a failure for this member. */
  failed: boolean
  /** The one-line head this member shows inside the expanded group. */
  head: string
  /** The body rows this member contributes to the expanded group (output, diff). */
  body: string[]
  /** Raw reader text for this member, when its body is large enough to page. */
  page?: string
  /** Child session this member opens, when it is a subagent view. */
  enter?: string
  /**
   * Whether this member stands alone rather than in the run: a destructive
   * command, or a call waiting on the person. A solo row is never folded away.
   */
  solo?: boolean
  /** The member's plain title, so a solo row can be re-painted as it settles. */
  title?: string
  /** The member's prior solo row, so the next update can replace it in place. */
  shown?: string
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
 * Drop blank rows a model wrapped an answer in, keeping inner paragraph breaks.
 *
 * The transcript already prints one separator after an answer and one before
 * the next tool card. Leading or trailing empty rows from the source stack on
 * those separators and read as a hole in the conversation.
 * @param lines - rendered Markdown rows.
 * @returns the same rows without outer blanks.
 */
function trimOuterBlanks(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start] === '') start += 1
  while (end > start && lines[end - 1] === '') end -= 1
  return [...lines.slice(start, end)]
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
  totalSeconds?: number,
): { summary: string[], full: string[] } {
  // Glyph lives in the agent gutter (`✻ `); the line is the clock only.
  const baseClock = seconds === undefined ? 'thought' : `thought for ${formatElapsed(seconds * 1000)}`
  const clock = totalSeconds === undefined ? baseClock : `${baseClock} · total ${formatElapsed(totalSeconds * 1000)}`
  const text = theme.dim(`${cardIndent(theme)}${clock}`)
  const head = theme.bgThinking(text)
  // The panel's inset, not a gap: uncoloured output paints no panel to pad.
  const pad = theme.colored ? [theme.bgThinking('  ')] : []
  return {
    // Pads are the panel's inset, not a gap between neighbouring cards.
    // Collapsed and expanded both carry them so hover lights the whole panel.
    summary: [...pad, head, ...pad],
    full: [...pad, head, ...pad, ...lines.map(line => theme.bgThinking(line)), ...pad],
  }
}

/**
 * Left rules for a thinking fold: the clock carries the agent gutter; pads
 * and body rows stay blank so the glyph sits on the clock only.
 * @param theme - styling for the agent glyph.
 * @param bodyLines - how many deliberation lines the expanded form carries.
 * @returns the collapsed rule and, when coloured, the expanded per-row rules.
 */
export function thinkingFoldRules(theme: Theme, bodyLines: number): {
  summary: string | string[]
  full?: string[]
} {
  const agentRule = blockRules(theme).agent
  if (!theme.colored) return { summary: agentRule }
  const blank = '  '
  return {
    summary: [blank, agentRule, blank],
    full: [blank, agentRule, blank, ...Array.from({ length: bodyLines }, () => blank), blank],
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

/** Left inset that keeps a card's glyph clear of the block rule beside it. */
function cardIndent(theme: Theme): string {
  return theme.colored ? '  ' : ''
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
      else lines.push(theme.dim(`  ${text}`))
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
  /** What each round did, by run and seq, noted by the surface before the end line renders. */
  private readonly roundWork = new Map<string, string>()
  /** Whether a real user turn has already been painted — comfortable gaps after the first. */
  private sawUser = false
  /** Whether the step before the boundary painted a block, so it owes a gap. */
  private paintedStep = false
  /** Whether the last block the renderer emitted already ended on a separator. */
  private trailingBlank = false
  /** The pending card the block {@link render} just returned supersedes. */
  private pendingCard: readonly string[] = []
  /**
   * The contiguous tool run standing at the tail of the transcript.
   *
   * Consecutive tool calls are one unit: one muted row whose label aggregates
   * their categories, and one Fold holding the member calls and their bodies.
   * The run is broken by assistant prose, a real-user message, or a call the
   * grouping rule excludes. `shown` is the row on screen, kept so the next
   * member replaces it rather than stacking under it.
   */
  private group: { members: GroupMember[]; shown: string[] } | undefined

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

  /**
   * Close the active tool run, so the next call opens a fresh group row.
   *
   * An interrupted turn never gets the pending call's result; settling the run
   * here is what stops its row from reading as still running.
   * @returns the settled row to replace the running one, empty when nothing was running.
   */
  endRun(): string[] {
    const group = this.group
    this.group = undefined
    if (group === undefined || !group.members.some(member => member.running)) return []
    for (const member of group.members) member.running = false
    this.group = group
    const row = this.emitGroup()
    this.group = undefined
    return row
  }

  /**
   * Render one appended event.
   * @param event - the event exactly as recorded.
   * @returns the lines to append to the transcript, empty when the event shows nothing.
   */
  render(event: SessionEvent): string[] {
    const hadRun = this.group !== undefined
    const lines = this.renderBlock(event, hadRun)
    // Only consecutive tool calls share a group; assistant prose and a
    // real-user message end it, and their own leading rows are the gap. A
    // step boundary does not end a run: grouping is not reopened here.
    if (lines.length > 0 && event.type !== 'tool/call' && event.type !== 'tool/result' && event.type !== 'step/start') {
      this.group = undefined
    }
    if (event.type !== 'step/start') this.notePainted(event, lines)
    return lines
  }

  /**
   * Remember what the block just rendered leaves behind, for the next boundary.
   *
   * A real user message is the turn's own separator, so the first step after it
   * must not add a second blank.
   * @param event - the event just rendered.
   * @param lines - the rows it emitted.
   */
  private notePainted(event: SessionEvent, lines: readonly string[]): void {
    if (event.type === 'user/message') this.paintedStep = false
    else if (lines.length > 0) this.paintedStep = true
    if (lines.length > 0) this.trailingBlank = lines.at(-1) === ''
  }

  /**
   * Open a new step with the density's block gap, when the previous step
   * painted and did not already end on a separator.
   *
   * The gap belongs to the step it precedes, not the one it follows, so a turn
   * that stops after its last step still ends on that step's content. Emitting
   * it here — the first row of the new block — is what keeps the transcript the
   * owner of "what is one step".
   * @returns the gap rows, empty when no gap is due.
   */
  private takeStepGap(): string[] {
    const due = this.paintedStep && !this.trailingBlank
    this.paintedStep = false
    if (!due) return []
    this.trailingBlank = true
    return Array.from({ length: blockGap(this.options.density ?? DEFAULT_DENSITY) }, () => '')
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
        const lines = trimOuterBlanks(renderMarkdown(text, theme))
        if (lines.length === 0) return []
        return hadRun ? [...lines, ''] : [...lines, '']
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
        // What the round did, when the surface watched its child: the line
        // that says a round which showed nothing while it ran was working.
        const work = this.roundWork.get(key)
        this.roundWork.delete(key)
        const did = work === undefined ? '' : theme.dim(` · ${work}`)
        this.rule = rules.tool
        // No door, though the event names a child session: a workflow's
        // children run in a worker thread, so their sessions are never in this
        // process's registry — clicking a round could only ever answer "no
        // longer running". Driven on a real terminal, that is exactly what it
        // answered. The line stands on its own.
        if (event.data.outcome === 'completed') return [theme.bgTool(`  ${theme.success('✓')} ${label}${did}`)]
        return [theme.bgError(`  ${theme.error('✗')} ${label} ${theme.dim(`(${event.data.outcome})`)}${did}`)]
      }
      case 'tool-workflow/run-end':
        this.rule = rules.tool
        return [theme.bgTool(theme.dim(`  ${event.data.stopReason}`)), '']
      case 'step/start':
        // A step boundary is not prose: the gap it opens leaves the tail run
        // intact, so calls across the boundary still group exactly as before.
        return this.takeStepGap()
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
  /**
   * Say what a workflow round did before its end line prints.
   * @param runId - the workflow run.
   * @param seq - the round within it.
   * @param work - one fragment: `48 calls · 2m40s`.
   */
  noteRoundWork(runId: string, seq: number, work: string): void {
    this.roundWork.set(`${runId}:${String(seq)}`, work)
  }

  pendingCall(callId: string): { summary: string | undefined; args: unknown } | undefined {
    const pending = this.calls.get(callId)
    return pending === undefined ? undefined : { summary: pending.summary, args: pending.args }
  }

  /**
   * Bind the oldest unmatched pending `subagent` or `subagent_fork` call to a
   * child Session id, so the group row that stands for it becomes a door.
   *
   * `subagent/start` publishes the id as soon as the child exists — before the
   * tool result — so a click can enter while the call is still running. Two
   * unmatched pendings bind FIFO. The pending call stays recorded so a later
   * continuable start-result still pairs with it.
   * @param childId - the child Session the group row should open.
   * @returns the group row to re-register, empty when no unmatched pending call remains.
   */
  promotePendingView(childId: string): string[] {
    this.fold = undefined
    this.rule = ''
    this.prompt = undefined
    this.promptPad = undefined
    this.enter = undefined
    this.page = undefined
    this.written = []
    this.pendingCard = []
    this.label = ''
    if (childId === '') return []
    let matched: PendingCall | undefined
    for (const pending of this.calls.values()) {
      if (pending.enter !== undefined) continue
      if (pending.name !== 'subagent' && pending.name !== 'subagent_fork') continue
      matched = pending
      break
    }
    if (matched === undefined) return []
    matched.enter = childId
    if (matched.member !== undefined) matched.member.enter = childId
    if (this.group === undefined || matched.member === undefined) return []
    const row = this.emitGroup()
    // The promotion that just happened is the live door, not an older member's.
    this.enter = childId
    return row
  }

  /**
   * Pull a call that is waiting on the person out of the run, so a question
   * addressed to them can never be hidden behind a collapsed summary.
   *
   * The pending-call state is the surface's own signal that an approval was
   * requested for this call; the group logic consults it rather than guessing
   * from the tool name.
   * @param callId - the call the approval request names.
   * @returns the rows to append: the remaining group row and the solo row.
   */
  markApproval(callId: string): string[] {
    const member = this.calls.get(callId)?.member
    if (member === undefined || member.solo === true) return []
    const group = this.group
    const replaces = group?.shown ?? []
    if (group !== undefined) {
      const at = group.members.indexOf(member)
      if (at >= 0) group.members.splice(at, 1)
      if (group.members.length === 0) this.group = undefined
    }
    member.solo = true
    member.head = this.soloHead(member.title ?? '', '', '', 'pending')
    const hasGroup = this.group !== undefined && this.group.members.length > 0
    const groupLines = hasGroup ? this.emitGroup() : []
    const groupFold = hasGroup ? this.fold ?? [] : []
    const groupLabel = this.label
    const groupRule = this.rule
    const groupEnter = this.enter
    const groupPage = this.page
    const solo = this.emitSolo(member)
    this.pendingCard = replaces
    if (hasGroup) {
      this.fold = [...groupFold, ...(this.fold ?? [])]
      this.label = [groupLabel, this.label].filter(part => part !== '').join(' · ')
      this.rule = groupRule
      this.enter = groupEnter ?? this.enter
      this.page = groupPage ?? this.page
    }
    return [...groupLines, ...solo]
  }

  /**
   * Add one member to the run at the tail, opening the run when it is absent.
   * @param member - the call to count and fold.
   */
  private pushMember(member: GroupMember): void {
    this.group ??= { members: [], shown: [] }
    this.group.members.push(member)
  }

  /**
   * Recompute the run's one row and its Fold, replacing the row on screen.
   *
   * The label is aggregated from every member — categories in first-appearance
   * order, present tense while any member runs, past once all settle, with a
   * trailing failure segment — so it is recomputed rather than appended to and
   * never changes for a volatile path or count.
   * @returns the one row to append, which supersedes the prior group row.
   */
  private emitGroup(): string[] {
    const { theme } = this.options
    const group = this.group
    if (group === undefined) return []
    const counts = group.members.map(member => ({
      category: member.category,
      running: member.running,
      failed: member.failed,
    }))
    const failedCount = group.members.filter(member => member.failed).length
    const label = toolGroupLabel(counts)
    const clean = failedCount === 0 ? label : toolGroupLabel(counts.map(entry => ({ ...entry, failed: false })))
    const painted = `${cardIndent(theme)}${theme.muted(TOOL_BULLET)} ${theme.dim(clean)}${failedCount === 0 ? '' : theme.error(` · ${String(failedCount)} failed`)}`
    // One row, always: the label truncates rather than wrapping the transcript.
    const ruleWidth = displayWidth(oneRow(blockRules(theme).tool))
    const row = truncate(painted, Math.max(8, this.columns - ruleWidth))
    const body = group.members.flatMap(member => [member.head, ...member.body])
    this.pendingCard = group.shown
    group.shown = [row]
    this.fold = [row, ...body]
    this.label = label
    this.rule = blockRules(theme).tool
    const enter = group.members.find(member => member.enter !== undefined)?.enter
    this.enter = enter
    // A run whose expansion is large is read in the pager on click; Ctrl+O
    // still swaps the whole fold inline.
    const soft = DIFF_SOFT_CAP[this.options.density ?? DEFAULT_DENSITY]
    const pages = group.members.map(member => member.page).filter((page): page is string => page !== undefined)
    this.page = body.length > soft && pages.length > 0 ? pages.join('\n') : undefined
    return [row]
  }

  /**
   * The muted head one member shows inside the expanded group.
   * @param title - the call's title, already workspace-relative.
   * @param suffix - already-styled stats (`+n -m`, `3 of 9 lines`), or `''`.
   * @param status - already-styled trailing glyph, or `''` while still running.
   * @returns the painted one-liner.
   */
  /**
   * A title reduced to the single row a head may occupy.
   *
   * A terminal command can be several lines — a heredoc is — and a head is one
   * row by contract. Left whole, the command's own newlines became extra
   * transcript rows, which is how a script body escaped onto the screen. The
   * first line names the call; the rest stays in the fold.
   * @param title - the call's title, possibly multi-line.
   * @returns the first line, marked when more followed.
   */
  private oneLineTitle(title: string): string {
    const newline = title.indexOf('\n')
    if (newline < 0) return title
    const first = title.slice(0, newline).trimEnd()
    return first === '' ? '…' : `${first} …`
  }

  private memberHead(title: string, suffix = '', status = ''): string {
    const { theme } = this.options
    const stats = suffix === '' ? '' : ` ${suffix}`
    const mark = status === '' ? '' : ` ${status}`
    return `${cardIndent(theme)}${theme.muted(TOOL_BULLET)} ${theme.dim(this.oneLineTitle(title))}${stats}${mark}`
  }

  /**
   * The one-line summary a call contributes to a prompt shown away from its row.
   * @param view - the declared call view, when one exists.
   * @param title - the call's relativized title.
   * @returns the summary, or undefined for a call with no presenter.
   */
  private summarizeCall(view: ToolCallView | undefined, title: string): string | undefined {
    if (view === undefined) return undefined
    if (view.card === 'terminal') {
      const lines = this.relativizeIn(view.title).split('\n')
      return lines.length > 1 ? `${lines[0] ?? ''} …` : this.relativizeIn(view.title)
    }
    if (view.card === 'diff') {
      const paths = view.diffs.map(diff => this.relative(diff.path))
      return paths.length === 0 ? title : paths.join(', ')
    }
    const locations = (view.locations ?? []).map(location => this.relative(location.path))
    return locations.length === 0 ? title : locations.join(', ')
  }

  /**
   * The alert-styled head a destructive command, or a call waiting on the
   * person, shows on its own row.
   * @param title - the call's title, already workspace-relative.
   * @param suffix - already-styled stats, or `''`.
   * @param status - already-styled trailing glyph, or `''` while running.
   * @param style - the alert role to paint with.
   * @returns the painted one-liner.
   */
  private soloHead(title: string, suffix = '', status = '', style: 'warn' | 'pending' = 'warn'): string {
    const { theme } = this.options
    const stats = suffix === '' ? '' : ` ${suffix}`
    const mark = status === '' ? '' : ` ${status}`
    return theme[style](`${cardIndent(theme)}⚠ ${this.oneLineTitle(title)}${stats}${mark}`)
  }

  /**
   * Re-emit one standalone member's row after its body or status changed.
   * @param member - the solo member.
   * @returns the one row to append, which supersedes the prior solo row.
   */
  private emitSolo(member: GroupMember): string[] {
    const { theme } = this.options
    const row = member.head
    this.pendingCard = member.shown === undefined ? [] : [member.shown]
    member.shown = row
    this.fold = [row, ...member.body]
    this.label = member.title ?? ''
    this.rule = blockRules(theme).error
    this.enter = member.enter
    const soft = DIFF_SOFT_CAP[this.options.density ?? DEFAULT_DENSITY]
    this.page = member.body.length > soft && member.page !== undefined ? member.page : undefined
    return [row]
  }

  /**
   * Render a pending call as one member of the group at the tail.
   * @param callId - correlation id, remembered until the result pairs with it.
   * @param name - the tool the model called.
   * @param rawArguments - the unparsed arguments JSON the model produced.
   * @returns the group row.
   */
  private renderCall(callId: string, name: string, rawArguments: string): string[] {
    let args: unknown
    try {
      args = JSON.parse(rawArguments)
    } catch {
      // Unparseable arguments still get a row: the model called the tool, and
      // the failure belongs on the result line the executor produces.
      args = undefined
    }
    const view = this.safeCall(name, args)
    const category = toolCategory(name, view)
    const base = view === undefined ? name : this.relativizeIn(view.title)
    const locations = view?.card === 'generic' ? (view.locations ?? []).map(location => this.relative(location.path)) : []
    const title = view?.card === 'generic' ? `${base}${this.extraPaths(base, locations)}` : base
    const summary = this.summarizeCall(view, title)
    // A destructive command is the one deliberate break in the merge rule: it
    // stands on its own alert row, and the run on either side stays separate.
    const destructive = view?.card === 'terminal' && isDestructiveCommand(view.title)
    if (destructive) this.group = undefined
    const member: GroupMember = {
      callId,
      name,
      category,
      running: true,
      failed: false,
      head: destructive ? this.soloHead(title) : this.memberHead(title),
      body: [],
      title,
      ...destructive ? { solo: true } : {},
    }
    this.calls.set(callId, {
      name,
      args,
      title,
      summary,
      ...view?.card === 'terminal' && view.description !== undefined ? { description: view.description } : {},
      member,
    })
    if (destructive) return this.emitSolo(member)
    this.pushMember(member)
    return this.emitGroup()
  }

  /**
   * Render a completed call, pairing it with the call this transcript recorded.
   * @param data - the `tool/result` payload.
   * @returns the group row.
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
    const view = pending === undefined ? undefined : this.safeResult(pending, block.content, failed, meta)
    const title = view?.title === undefined ? (pending?.title ?? '(result)') : this.relativizeIn(view.title)
    let suffix = ''
    let body: string[] = []
    let full: string[] | undefined
    if (pending === undefined) {
      // A page-boundary orphan: there is no declared view, only the raw result.
      const text = failed ? this.resultText(block.content) : formatAskUserQuestionResult(this.resultText(block.content))
      const lines = text === '' ? [] : text.split('\n').map(line => theme.dim(`  ${line}`))
      const capped = this.capBody(lines, MAX_RESULT_LINES)
      body = capped.body
      full = capped.full
    } else {
      const out = this.outcome(view, block, pending, failed)
      suffix = out.suffix
      body = out.body
      full = out.full
    }
    // `outcome` parks a large diff's reader text on `page`; a terminal, read or
    // generic body supplies its own raw text, and the group decides whether the
    // whole run is large enough to hand to the pager.
    let page = this.page
    this.page = undefined
    if (page === undefined && view !== undefined) {
      if (view.card === 'terminal') page = (view.output ?? '').replace(/\n+$/u, '')
      else if (view.card === 'read') page = view.lines.map(line => `${String(line.number)}: ${line.text}`).join('\n')
      else if (view.card === 'generic' && view.content !== undefined) page = this.resultText(view.content)
    }
    if (page === '') page = undefined
    const enter = failed ? undefined : childSessionId(this.resultText(block.content))
    const status = failed ? theme.err('✗') : theme.ok('✔')
    const member = pending?.member
    if (pending !== undefined && member !== undefined && member.solo === true) {
      member.running = false
      member.failed = failed
      member.category = toolCategory(pending.name, view)
      member.title = title
      member.head = this.soloHead(title, suffix, status)
      member.body = full ?? body
      if (page !== undefined) member.page = page
      if (enter !== undefined) member.enter = enter
      return this.emitSolo(member)
    }
    const head = this.memberHead(title, suffix, status)
    if (pending !== undefined && member !== undefined) {
      // A non-tool event between the call and its result ends the run; the
      // result then reopens a group of its own rather than vanishing.
      if (this.group === undefined || !this.group.members.includes(member)) {
        this.group = { members: [member], shown: [] }
      }
      member.running = false
      member.failed = failed
      member.category = toolCategory(pending.name, view)
      member.title = title
      member.head = head
      member.body = full ?? body
      if (page !== undefined) member.page = page
      if (enter !== undefined) member.enter = enter
    } else {
      this.pushMember({
        callId: undefined,
        name: pending?.name ?? '',
        category: toolCategory(pending?.name ?? '', view),
        running: false,
        failed,
        head,
        body: full ?? body,
        ...page === undefined ? {} : { page },
        ...enter === undefined ? {} : { enter },
      })
    }
    return this.emitGroup()
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
   * Empty unless a completed call or a pending-view promotion just rebuilt a
   * card this surface already printed. A resumed page boundary that never
   * showed the pending form also yields empty.
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
    failed = false,
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
      // A command that is several lines — a heredoc is — keeps its body here,
      // under the one-row head. The head names the call; this is where its
      // script stays readable instead of being flattened to an ellipsis.
      const commandLines = view.title === undefined || !view.title.includes('\n')
        ? []
        : view.title.split('\n').map(line => theme.dim(`  ${line}`))
      const outputLines = output === '' ? [] : output.split('\n').map(line => theme.dim(`  ${line}`))
      const body = [...descLines, ...commandLines, ...outputLines]
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
    let text = this.resultText(view?.card === 'generic' && view.content !== undefined ? view.content : block.content)
    if (pending?.name === 'ask_user_question' && !failed) {
      text = formatAskUserQuestionResult(text)
    }
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

/**
 * Format an ask_user_question tool result into human-facing text.
 * If the result is a JSON string containing an `answers` array, extracts and formats
 * the user's answers (selected options or custom text) directly instead of displaying raw JSON.
 *
 * @param text - the raw result text (typically JSON.stringify({ answers })).
 * @returns the formatted human-readable answer string.
 */
export function formatAskUserQuestionResult(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { answers?: unknown }).answers)) {
      const answers = (parsed as { answers: unknown[] }).answers
      const lines: string[] = []
      for (const item of answers) {
        if (typeof item !== 'object' || item === null) continue
        const answer = item as { selected?: unknown; custom?: unknown }
        const parts: string[] = []
        if (Array.isArray(answer.selected)) {
          const selected = answer.selected.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
          if (selected.length > 0) parts.push(selected.join(', '))
        }
        if (typeof answer.custom === 'string' && answer.custom.trim() !== '') {
          parts.push(answer.custom.trim())
        }
        if (parts.length > 0) {
          lines.push(parts.join(', '))
        }
      }
      return lines.join('\n')
    }
  } catch {
    // Not valid JSON, return original text.
  }
  return text
}

/**
 * Result presenter for `ask_user_question` tool calls, displaying the user's
 * reply directly as clean text rather than raw `{ answers: [...] }` JSON.
 *
 * @param result - the tool execution result.
 * @returns the generic tool result view with formatted text content.
 */
export function presentAskUserQuestionResult(result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  const raw = visibleText(result.content).trimEnd()
  const text = formatAskUserQuestionResult(raw)
  return {
    card: 'generic',
    content: text === '' ? [] : [{ type: 'text', text }],
  }
}
