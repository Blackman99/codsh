/**
 * The `/theme` picker and the history repaint behind it.
 *
 * Moving through the list previews each theme live, the way Grok CLI's
 * picker does: the chrome repaints at once, and the conversation above it is
 * repainted in the new palette once the marker settles. Enter keeps the
 * choice; Esc puts back the one in force before the picker opened.
 * @module codsh-bundle/src/theme-picker
 */

import type { ThemeSetting } from './palette.ts'
import type { SelectOutcome, SelectSpec } from './selector.ts'
import { THEME_CHOICES } from './theme-setting.ts'

/** How long the marker must rest before the history is repainted for a preview. */
export const PREVIEW_REPAINT_MS = 150

/** A history repaint slower than this is skipped while previewing; the chrome still follows. */
export const SLOW_REPAINT_MS = 250

/** What {@link HistoryRepaint} needs from the surface. */
export interface HistoryRepaintHost {
  /** Whether the painted history is in another palette than the live one. */
  stale(): boolean
  /** Whether repainting now would disturb work in flight (a running turn, a Child view). */
  busy(): boolean
  /**
   * Repaint the history in the live palette.
   * @returns how long it took, in milliseconds.
   */
  run(): number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * When the conversation above the prompt is repainted after a theme change.
 *
 * Repainting replays the whole session, so it waits for a moment the person
 * is not in the middle of: never under a running turn or inside a Child view
 * — those {@link flush} later — and, while previewing, only once the marker
 * rests and only when the last repaint was quick.
 */
export class HistoryRepaint {
  private pending = false
  private timer: unknown
  private lastMs = 0
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly host: HistoryRepaintHost) {
    this.setTimer = host.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = host.clearTimer ?? (handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  }

  /** Repaint now if the history is stale and nothing is in flight; otherwise at the next {@link flush}. */
  request(): void {
    this.cancelTimer()
    if (!this.host.stale()) {
      this.pending = false
      return
    }
    if (this.host.busy()) {
      this.pending = true
      return
    }
    this.pending = false
    this.lastMs = this.host.run()
  }

  /** A preview's repaint: debounced, and skipped for a session too long to repaint per keystroke. */
  soon(): void {
    this.cancelTimer()
    if (this.lastMs > SLOW_REPAINT_MS) {
      this.pending = true
      return
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.request()
    }, PREVIEW_REPAINT_MS)
  }

  /** Run a repaint deferred by a running turn or a Child view, now that it is safe. */
  flush(): void {
    if (this.pending) this.request()
  }

  /** Drop a scheduled preview repaint. */
  cancel(): void {
    this.cancelTimer()
    this.pending = false
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    this.clearTimer(this.timer)
    this.timer = undefined
  }
}

/** What {@link pickTheme} drives. */
export interface ThemePickerHost {
  /**
   * Offer a selection; `preview` hears every row the marker lands on, and
   * `settled` the outcome before the closing frame is painted.
   */
  select(
    spec: SelectSpec,
    signal: AbortSignal | undefined,
    preview: (index: number) => void,
    settled: (outcome: SelectOutcome) => void,
  ): Promise<SelectOutcome>
  /** The choice in force when the picker opens. */
  current(): ThemeSetting
  /**
   * Put a choice in force for the chrome.
   * @returns whether the palette changed.
   */
  apply(setting: ThemeSetting): boolean
  readonly history: HistoryRepaint
}

/**
 * Let the person pick a theme, previewing each as the marker moves.
 * @param host - the selection and the theme it switches.
 * @param signal - cancels the picker, reverting the preview.
 * @returns the chosen theme, or undefined when the picker was dismissed.
 */
export async function pickTheme(host: ThemePickerHost, signal?: AbortSignal): Promise<ThemeSetting | undefined> {
  const original = host.current()
  const choiceOf = (outcome: SelectOutcome): ThemeSetting | undefined =>
    outcome.kind === 'chosen' ? THEME_CHOICES[outcome.indices[0] ?? -1]?.name : undefined
  const outcome = await host.select({
    title: 'Theme',
    options: THEME_CHOICES.map(choice => ({
      label: choice.name,
      detail: choice.name === original ? `${choice.detail} · current` : choice.detail,
    })),
    prior: { selected: original },
  }, signal, (index) => {
    const choice = THEME_CHOICES[index]
    if (choice !== undefined && host.apply(choice.name)) host.history.soon()
  }, (settled) => {
    // Before the closing frame: the box comes back in the theme that stays.
    host.history.cancel()
    host.apply(choiceOf(settled) ?? original)
  })
  const chosen = choiceOf(outcome)
  host.history.request()
  return chosen
}
