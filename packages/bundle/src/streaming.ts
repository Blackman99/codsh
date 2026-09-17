/**
 * Assistant text as it arrives.
 *
 * Token-level display and Markdown rendering pull against each other: a line
 * cannot be styled until it is complete, and a terminal cannot restyle a line
 * that has scrolled. The split is what resolves it — the line being typed lives
 * in the console's one rewritable region as raw text, and the moment it ends it
 * is rendered and written permanently.
 * @module codsh-bundle/src/streaming
 */

import { createMarkdownStream } from './markdown.ts'
import { truncate } from './theme.ts'
import type { MarkdownStream } from './markdown.ts'
import type { Theme } from './theme.ts'

/** What one delta produced: finished lines, and the line still being typed. */
export interface StreamStep {
  /** Rendered lines to append to the transcript. */
  lines: string[]
  /** The in-progress line for the live region, or undefined when none is open. */
  live: string | undefined
}

/** Accumulates assistant text deltas into rendered lines. */
export class TextStream {
  private markdown: MarkdownStream
  private partial = ''
  private seen = false
  /** Blank rows held until more prose arrives; dropped if the answer ends there. */
  private heldBlanks = 0

  constructor(
    private readonly theme: Theme,
    /** Display columns, so the in-progress line never wraps the live region. */
    private readonly columns: () => number,
    /**
     * Render lines as dim plain text instead of Markdown. Reasoning wants
     * this: it is the model thinking aloud, not an answer to typeset.
     */
    private readonly plain = false,
  ) {
    this.markdown = createMarkdownStream(theme, columns)
  }

  /** Whether this message has produced any text yet. */
  get streamed(): boolean {
    return this.seen
  }

  /** The in-progress live line, when one is still being typed. */
  get live(): string | undefined {
    return this.liveText()
  }

  /**
   * Take one text delta.
   * @param delta - the text fragment, which may contain any number of newlines.
   * @returns the lines to append and the line still open.
   */
  push(delta: string): StreamStep {
    if (delta === '') return { lines: [], live: this.liveText() }
    const lines: string[] = []
    const parts = (this.partial + delta).split('\n')
    // The last part has no terminator yet, so it stays open for the next delta.
    this.partial = parts.pop() ?? ''
    for (const complete of parts) {
      const inFence = this.markdown.inCode
      const rendered = this.renderLine(complete)
      if (complete === '' && !inFence) {
        // Leading blanks the model wrapped the answer in stay off screen;
        // inner blanks wait in case they are only a trailing wrapper. A blank
        // still has to reach Markdown first: a table drains on it.
        if (rendered.some(line => line !== '')) {
          if (this.heldBlanks > 0) {
            lines.push(...Array.from({ length: this.heldBlanks }, () => ''))
            this.heldBlanks = 0
          }
          this.seen = true
          lines.push(...rendered)
          continue
        }
        if (this.seen) this.heldBlanks += 1
        continue
      }
      if (this.heldBlanks > 0) {
        lines.push(...Array.from({ length: this.heldBlanks }, () => ''))
        this.heldBlanks = 0
      }
      this.seen = true
      lines.push(...rendered)
    }
    if (this.partial !== '') this.seen = true
    return { lines, live: this.liveText() }
  }

  /**
   * Close the message, rendering whatever line was still open.
   *
   * Called when the model finishes and when a turn is cancelled mid-line: the
   * text already shown has to land in the transcript either way, or the live
   * region would take it away again.
   * @returns the remaining lines to append.
   */
  flush(): string[] {
    const leftover = this.partial === '' ? [] : this.renderLine(this.partial)
    const content = leftover.some(line => line !== '') ? leftover : []
    if (content.length > 0 && this.heldBlanks > 0) {
      content.unshift(...Array.from({ length: this.heldBlanks }, () => ''))
    }
    // A table cut off mid-answer still shows its buffered rows.
    content.push(...this.plain ? [] : this.markdown.flush())
    this.partial = ''
    this.seen = false
    this.heldBlanks = 0
    // A fence left open by a cut-off answer must not leak into the next one.
    this.markdown = createMarkdownStream(this.theme, this.columns)
    return content
  }

  /** Render one complete line in this stream's mode. */
  private renderLine(line: string): string[] {
    return this.plain ? [this.theme.bgThinking(this.theme.dim(`  ${line}`))] : this.markdown.line(line)
  }

  /**
   * The in-progress line as the live region should show it.
   *
   * Raw rather than rendered: it is not a line yet, and inside a fenced block it
   * is code that Markdown must not touch. Truncated because the live region is
   * one row — a wrapped live line cannot be erased by a single carriage return.
   * @returns the text, or undefined when no line is open.
   */
  private liveText(): string | undefined {
    if (this.partial === '') return undefined
    const prefix = this.markdown.inCode ? '  ' : ''
    return this.theme.dim(truncate(`${prefix}${this.partial}`, this.columns() - 1))
  }
}

/** Result of flushing a completed thinking segment. */
export interface ThinkingFlush {
  /** All lines produced by this thinking segment. */
  lines: string[]
  /** Duration in milliseconds this thinking segment took. */
  elapsedMs: number
  /**
   * The rows the surface painted while the thought streamed — the head it
   * opened with and every finished line since — so the finished block can
   * take their place instead of piling up under them.
   */
  painted: string[]
}

/**
 * Tracks a model's deliberation during a step.
 *
 * Models often deliberate before replying or calling tools. When streaming
 * from proxies or providers that buffer reasoning deltas, the arrival of
 * tokens may be compressed into a single delta late in the step. Starting the
 * deliberation clock when the step begins (`step/start`) ensures the recorded
 * elapsed time accurately reflects the full duration the model spent thinking
 * (including server-side deliberation and network round-trip), rather than
 * merely the few milliseconds it took for the client to read buffered chunks.
 */
export class ThinkingTracker {
  private stream: TextStream
  private lines: string[] = []
  /** What the surface has put on screen for the thought in flight. */
  private painted: string[] = []
  private stepStartedAt = 0
  private thinkingStartedAt = 0
  private thinkingEndedAt = 0

  constructor(
    private readonly theme: Theme,
    private readonly columns: () => number,
  ) {
    this.stream = new TextStream(theme, columns, true)
  }

  /** Current accumulated lines for live preview. */
  get currentLines(): readonly string[] {
    return this.lines
  }

  /** Rows the surface has painted for the thought in flight, head included. */
  get paintedRows(): readonly string[] {
    return this.painted
  }

  /** Whether the surface has opened this thought on screen. */
  get opened(): boolean {
    return this.painted.length > 0
  }

  /** The in-progress thinking line, when one is still being typed. */
  get live(): string | undefined {
    return this.stream.live
  }

  /**
   * Note rows the surface put on screen for this thought.
   *
   * Kept here rather than in the surface because the thought is what they
   * belong to: its flush hands them back, and a new turn drops them with it.
   * @param rows - the rows exactly as appended, so a later search finds them.
   */
  markPainted(rows: readonly string[]): void {
    this.painted.push(...rows)
  }

  /**
   * Replace the rows the surface currently shows for this thought.
   *
   * The in-progress head is one block that ticks in place: each frame
   * takes the last one's place, so the clock that lands still finds the
   * rows that are on screen.
   * @param rows - the rows exactly as just painted.
   */
  replacePainted(rows: readonly string[]): void {
    this.painted = [...rows]
  }

  /** Reset state for a new turn. */
  reset(): void {
    this.stream = new TextStream(this.theme, this.columns, true)
    this.lines = []
    this.painted = []
    this.stepStartedAt = 0
    this.thinkingStartedAt = 0
    this.thinkingEndedAt = 0
  }

  /** Mark the start of an execution step (e.g. `step/start`). */
  markStepStart(now = performance.now()): void {
    this.stepStartedAt = now
    this.thinkingEndedAt = 0
  }

  /** Mark the end of an execution step (e.g. `step/end`). */
  markStepEnd(): void {
    this.stepStartedAt = 0
  }

  /**
   * Consume a reasoning chunk delta.
   * @param delta - text fragment of reasoning.
   * @param now - current timestamp.
   * @returns live streaming step.
   */
  push(delta: string, now = performance.now()): StreamStep {
    if (delta === '') return { lines: [], live: undefined }
    if (this.thinkingStartedAt === 0) {
      this.thinkingStartedAt = this.stepStartedAt > 0 ? this.stepStartedAt : now
    }
    const step = this.stream.push(delta)
    this.lines.push(...step.lines)
    return step
  }

  /** Mark that reasoning has ended (e.g. `block-end` or answer / tool call started). */
  markReasoningEnd(now = performance.now()): void {
    if (this.thinkingEndedAt === 0 && (this.thinkingStartedAt > 0 || this.lines.length > 0 || this.stream.streamed)) {
      this.thinkingEndedAt = now
    }
  }

  /**
   * Flush any accumulated thinking.
   * @param now - current timestamp.
   * @returns finished thinking lines and elapsed time, or undefined if no thinking occurred.
   */
  flush(now = performance.now()): ThinkingFlush | undefined {
    this.lines.push(...this.stream.flush())
    if (this.lines.length === 0) return undefined

    const end = this.thinkingEndedAt > 0 ? this.thinkingEndedAt : now
    const elapsedMs = this.thinkingStartedAt > 0 ? Math.max(0, end - this.thinkingStartedAt) : 0

    const result: ThinkingFlush = {
      lines: this.lines,
      elapsedMs,
      painted: this.painted,
    }

    this.lines = []
    this.painted = []
    this.thinkingStartedAt = 0
    this.thinkingEndedAt = 0
    this.stream = new TextStream(this.theme, this.columns, true)

    return result
  }
}

