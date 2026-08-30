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
    if (nextRow <= renderHeight + 1) {
      // One gap row belongs between a stable header and its content. During
      // the hand-off that row is the last thing left before the next prompt;
      // it is not itself a fragment of the old header.
      const visible = Math.min(renderHeight, Math.max(0, nextRow - 1))
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
    reservedRows: Math.min(viewportHeight, renderHeight + 1),
  }
}
