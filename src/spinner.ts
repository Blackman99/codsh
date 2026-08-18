/**
 * The working indicator: one rewritable line saying the agent is busy, how long
 * it has been, and which key stops it.
 *
 * It occupies the console's single live line, so the transcript above it stays
 * append-only and the indicator never survives into a redirected transcript.
 * @module codsh-cli/src/spinner
 */

import type { Theme } from './theme.ts'

/** Braille frames, one cell wide each, so the line never changes width. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** How often the frame advances. */
const TICK_MS = 90

/** The console surface a spinner drives. */
export interface LiveSurface {
  setLive(text: string | undefined): void
  readonly isTty: boolean
}

/** Formats the indicator's text for one tick. */
export interface SpinnerLabel {
  /** What the agent is doing, e.g. `working`. */
  verb: string
  /** Key that cancels, named for the surface that can read it. */
  interrupt: string
  /** Live extra segment, read each tick — e.g. tokens spent so far. */
  detail?: () => string | undefined
}

/**
 * Render one tick of the indicator.
 * @param frame - the frame index, taken modulo the frame count.
 * @param elapsedMs - milliseconds since the work started.
 * @param label - the verb and interrupt key to name.
 * @param theme - styling for the frame and the hint.
 * @returns the line to display.
 */
export function spinnerText(frame: number, elapsedMs: number, label: SpinnerLabel, theme: Theme): string {
  const seconds = (elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)
  const mark = FRAMES[frame % FRAMES.length] ?? FRAMES[0]
  const extra = label.detail?.()
  const detail = extra === undefined || extra === '' ? '' : `${extra} · `
  return `${theme.pending(mark)} ${label.verb} ${theme.dim(`${seconds}s · ${detail}${label.interrupt} to interrupt`)}`
}

/** Drives the working indicator for as long as the agent is busy. */
export class Spinner {
  private timer: NodeJS.Timeout | undefined
  private frame = 0
  private startedAt = 0

  constructor(
    private readonly surface: LiveSurface,
    private readonly theme: Theme,
    private readonly label: SpinnerLabel,
    /** Injected so tests advance time without waiting for it. */
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Whether the indicator is running. */
  get running(): boolean {
    return this.timer !== undefined
  }

  /**
   * Start the indicator, or do nothing when it is already running or the
   * surface has no cursor to rewrite.
   */
  start(): void {
    if (this.timer !== undefined || !this.surface.isTty) return
    this.startedAt = this.now()
    this.frame = 0
    this.draw()
    // Unref'd so a spinner can never be the reason the process stays alive.
    this.timer = setInterval(() => { this.frame += 1; this.draw() }, TICK_MS)
    this.timer.unref()
  }

  /** Stop the indicator and clear its line. */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
    this.surface.setLive(undefined)
  }

  /** Paint the current frame. */
  private draw(): void {
    this.surface.setLive(spinnerText(this.frame, this.now() - this.startedAt, this.label, this.theme))
  }
}
