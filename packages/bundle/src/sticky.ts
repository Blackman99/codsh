/**
 * Pure layout for the turn header pinned over a scrolled transcript.
 *
 * Prompts live in virtual physical-row coordinates. The last prompt that has
 * crossed the viewport top owns the response currently being read; its header
 * shrinks towards a compact form, then the next prompt pushes it away.
 * @module codsh-bundle/src/sticky
 */

/** One user prompt in physical transcript coordinates. */
export interface StickyPrompt {
  /** First physical row of the prompt. */
  at: number
  /** Rows the prompt currently occupies, excluding its separator row. */
  fullHeight: number
  /** Smallest pinned form. */
  minHeight: number
  /** Expanded long prompts remain boundaries but do not pin. */
  sticky: boolean
}

/** How the current prompt header occupies the viewport top. */
export interface StickyHeaderLayout {
  /** Index into the prompt descriptor list. */
  prompt: number
  /** A stable header, or one being pushed by the next prompt. */
  state: 'pinned' | 'pushed'
  /** Header rows visible now. */
  renderHeight: number
  /** Rows clipped from the header's top while it is pushed. */
  clipTop: number
  /** Rows removed from the ordinary transcript viewport. */
  reservedRows: number
}

/**
 * Viewport rows a pinned header spends on chrome rather than prompt text.
 *
 * One padding row above the prompt and one below make the pinned copy read as
 * a panel instead of text pressed against the top edge of the screen — the
 * same inset every background-filled block in the transcript carries — and the
 * divider under them is where the reader's own content starts.
 */
export const STICKY_CHROME_ROWS = 3

/**
 * Transcript rows kept between a shrinking header and the prompt pushing it.
 *
 * The hand-off drops the panel's chrome — it is mid-flight, not a stable
 * header — but the row above the arriving prompt still belongs to the turn
 * being left, so the old header shrinks one row before it would collide.
 */
const HANDOFF_GAP_ROWS = 1

/** Clamp `value` to an inclusive range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Compute the sticky user prompt for one transcript frame.
 * @param scrollTop - first virtual physical row of the ordinary viewport.
 * @param viewportHeight - physical rows available above the bottom chrome.
 * @param prompts - user prompts in ascending virtual-row order.
 * @returns the header layout, or undefined before a prompt crosses the top.
 */
export function computeStickyLayout(
  scrollTop: number,
  viewportHeight: number,
  prompts: readonly StickyPrompt[],
): StickyHeaderLayout | undefined {
  if (scrollTop <= 0 || viewportHeight <= 0) return undefined
  let prompt = -1
  for (const [index, descriptor] of prompts.entries()) {
    if (descriptor.at >= scrollTop) break
    prompt = index
  }
  if (prompt < 0) return undefined
  const current = prompts[prompt]
  if (current === undefined || !current.sticky) return undefined
  const full = clamp(current.fullHeight, 1, viewportHeight)
  const minimum = clamp(current.minHeight, 1, full)
  const renderHeight = clamp(full - (scrollTop - current.at), minimum, full)
  const next = prompts[prompt + 1]
  if (next !== undefined) {
    const nextRow = next.at - scrollTop
    if (nextRow < renderHeight + STICKY_CHROME_ROWS) {
      // A pinned panel would reach past the arriving prompt, so the header
      // gives up its chrome and shrinks instead. The rows it yields are the
      // tail of its own turn, not fragments of the header itself.
      const visible = Math.min(renderHeight, Math.max(0, nextRow - HANDOFF_GAP_ROWS))
      if (visible === 0) return undefined
      return {
        prompt,
        state: 'pushed',
        renderHeight: visible,
        clipTop: renderHeight - visible,
        reservedRows: visible,
      }
    }
  }
  return {
    prompt,
    state: 'pinned',
    renderHeight,
    clipTop: 0,
    reservedRows: Math.min(viewportHeight, renderHeight + STICKY_CHROME_ROWS),
  }
}
