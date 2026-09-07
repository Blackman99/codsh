/**
 * Inline-graphics protocols: Kitty's `APC _G` and iTerm2's `OSC 1337`.
 *
 * A terminal that paints images does it through one of two escape protocols,
 * and which one is not a matter of taste: Ghostty and kitty implement Kitty
 * graphics and ignore `OSC 1337 ; File=` outright, iTerm2 is the other way
 * round. Sending the wrong one fails silently — the payload is swallowed and
 * the card comes up empty — so the protocol is read off the terminal rather
 * than assumed.
 *
 * A payload built here is NOT row text. It carries base64 image bytes, which
 * measure as tens of thousands of display columns and get cut mid-sequence by
 * anything that fits a string to a width; a cut payload loses its terminator
 * and the terminal then eats every sequence after it as string data. So these
 * travel to the screen as a graphic beside the frame, never inside a row.
 * @module codsh-bundle/src/terminal-graphics
 */

/** The inline-graphics protocol a terminal implements. */
export type GraphicsProtocol = 'kitty' | 'iterm2'

/**
 * A graphic floated over the frame, addressed in absolute terminal cells.
 *
 * The payload paints at the cursor and the frame is what positions it, so the
 * offsets say where the image belongs, not where it was built.
 */
export interface TerminalGraphic {
  /** Identity of what is painted; an unchanged key is not retransmitted. */
  key: string
  /** Escapes that paint the image at the cursor. */
  payload: string
  /** Escapes that remove it, emitted before a repaint and on teardown. */
  clear: string
  /** Row offset inside the overlay block. */
  row: number
  /** Column offset inside the content area. */
  column: number
  /** Cell columns the image occupies. */
  columns: number
  /** Cell rows the image occupies. */
  rows: number
}

/**
 * Which protocol this terminal speaks, if either.
 *
 * Multiplexers are why this can answer "neither" for a terminal that would
 * otherwise qualify: tmux and screen do not hand a graphics payload through
 * to the emulator that could paint it, so inside one the honest answer is
 * that no protocol is available.
 * @param env - the environment to read the terminal's identity from.
 * @returns the protocol, or undefined when nothing there can paint an image.
 */
export function graphicsProtocol(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): GraphicsProtocol | undefined {
  const term = env.TERM ?? ''
  if (env.TMUX !== undefined || term.startsWith('screen') || term.startsWith('tmux')) return undefined
  const program = env.TERM_PROGRAM ?? ''
  if (program === 'ghostty' || term === 'xterm-ghostty') return 'kitty'
  if (program === 'kitty' || term === 'xterm-kitty' || env.KITTY_WINDOW_ID !== undefined) return 'kitty'
  // WezTerm implements both; Kitty graphics is the one that takes the image
  // without a size guess, so it wins there too.
  if (program === 'WezTerm' || env.WEZTERM_PANE !== undefined) return 'kitty'
  if (program === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') return 'iterm2'
  return undefined
}

/** The most base64 one Kitty escape may carry, per the protocol. */
const KITTY_CHUNK = 4096

/**
 * Transmit and place a PNG in one go, scaled into a cell rectangle.
 *
 * `q=2` is not decoration: without it the terminal answers the transmission
 * with a report, and this surface's stdin is a key reader — the reply would
 * arrive as keystrokes. `C=1` keeps the cursor where the frame left it, so a
 * placement cannot scroll the screen out from under the layout.
 * @param base64 - the PNG bytes, base64 encoded.
 * @param id - the image id, so a later frame can delete exactly this one.
 * @param columns - cell columns to scale into.
 * @param rows - cell rows to scale into.
 * @returns one or more APC sequences, chunked as the protocol requires.
 */
export function kittyImage(base64: string, id: number, columns: number, rows: number): string {
  const keys = `a=T,f=100,t=d,i=${id},c=${columns},r=${rows},C=1,q=2`
  if (base64.length <= KITTY_CHUNK) return `\u001B_G${keys};${base64}\u001B\\`
  let out = ''
  for (let at = 0; at < base64.length; at += KITTY_CHUNK) {
    const chunk = base64.slice(at, at + KITTY_CHUNK)
    // Only the first escape carries the control keys; every later one may hold
    // nothing but `m` and `q`, and the last says the payload is complete.
    out += at === 0
      ? `\u001B_G${keys},m=1;${chunk}\u001B\\`
      : `\u001B_Gm=${at + KITTY_CHUNK < base64.length ? 1 : 0},q=2;${chunk}\u001B\\`
  }
  return out
}

/**
 * Delete one Kitty image and free its bytes.
 *
 * A placement is not cell content: clearing the rows it covers leaves it on
 * screen, so a card that closes or moves has to say so explicitly.
 * @param id - the image id given at transmission.
 */
export function kittyDelete(id: number): string {
  return `\u001B_Ga=d,d=I,i=${id},q=2\u001B\\`
}

/**
 * Place an image inline through iTerm2's file protocol.
 *
 * The size is a box to fit inside rather than a shape to fill:
 * `preserveAspectRatio=1` means a mismatch between the cell rectangle and the
 * image leaves a gap, which the card can hold, instead of an overflow, which
 * would paint over the chrome.
 * @param base64 - the image bytes, base64 encoded, in any format iTerm2 reads.
 * @param columns - cell columns to fit within.
 * @param rows - cell rows to fit within.
 */
export function iterm2Image(base64: string, columns: number, rows: number): string {
  return `\u001B]1337;File=inline=1;width=${columns};height=${rows};preserveAspectRatio=1:${base64}\u0007`
}
