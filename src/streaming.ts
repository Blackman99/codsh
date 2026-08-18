/**
 * Assistant text as it arrives.
 *
 * Token-level display and Markdown rendering pull against each other: a line
 * cannot be styled until it is complete, and a terminal cannot restyle a line
 * that has scrolled. The split is what resolves it — the line being typed lives
 * in the console's one rewritable region as raw text, and the moment it ends it
 * is rendered and written permanently.
 * @module codsh/src/streaming
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

  /**
   * Take one text delta.
   * @param delta - the text fragment, which may contain any number of newlines.
   * @returns the lines to append and the line still open.
   */
  push(delta: string): StreamStep {
    if (delta === '') return { lines: [], live: this.liveText() }
    this.seen = true
    const lines: string[] = []
    const parts = (this.partial + delta).split('\n')
    // The last part has no terminator yet, so it stays open for the next delta.
    this.partial = parts.pop() ?? ''
    for (const complete of parts) lines.push(...this.renderLine(complete))
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
    const lines = this.partial === '' ? [] : this.renderLine(this.partial)
    // A table cut off mid-answer still shows its buffered rows.
    lines.push(...this.plain ? [] : this.markdown.flush())
    this.partial = ''
    this.seen = false
    // A fence left open by a cut-off answer must not leak into the next one.
    this.markdown = createMarkdownStream(this.theme, this.columns)
    return lines
  }

  /** Render one complete line in this stream's mode. */
  private renderLine(line: string): string[] {
    return this.plain ? [this.theme.dim(`  ${line}`)] : this.markdown.line(line)
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
