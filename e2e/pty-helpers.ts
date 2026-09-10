/**
 * What the PTY suites share: the bytes a person's keys send, the screen as of
 * a marker, and where the input box sits on it.
 */

import { PTY_COLUMNS, screenAt as firstScreenAt, screenAtLast } from './pty-driver.ts'
import type { Terminal } from './vt.ts'

/**
 * The screen as it stood when `marker` was emitted.
 *
 * The surface owns its screen, so its output is frames rather than lines:
 * replaying them through a terminal is what turns a capture back into what a
 * person saw at that moment. First occurrence by default: teardown reflows the
 * viewport and re-emits transcript bytes, so the LAST copy of a transcript
 * marker is usually the chrome-less exit frame. `last` is for markers that
 * only chrome paints.
 * @param output - everything the PTY emitted.
 * @param marker - text to stop at; the whole capture when absent.
 * @param occurrence - which paint of the marker to stop at.
 * @returns the terminal at that point.
 */
export function screenAt(output: string, marker: string, occurrence: 'first' | 'last' = 'first'): Terminal {
  return occurrence === 'first' ? firstScreenAt(output, marker) : screenAtLast(output, marker)
}

/**
 * Rows that are the INPUT region's divider.
 *
 * The divider is a full-width run of `─` above the borderless input. Width is
 * what tells it from a transcript table's rule or a banner row.
 */
export const boxTops = (terminal: Terminal): number[] =>
  terminal.alternate.flatMap((row, index) => {
    const trimmed = row.trim()
    return /^─+$/u.test(trimmed) && trimmed.length > PTY_COLUMNS / 2 ? [index] : []
  })

/** A painted row without the viewport gutter, for assertions on the content. */
export const visible = (row: string): string => row.replace(/^ {2}/u, '').trimEnd()

/** The bare Escape byte, which is what a person pressing the key sends. */
export const ESCAPE = '\u001B'

/** Enter, as a terminal in raw mode sends it. */
export const ENTER = '\r'

/** Ctrl-U, which clears the line so a following command is not appended to it. */
export const CLEAR = '\u0015'

/** Bracketed-paste markers, which the surface asks the terminal to send. */
export const PASTE_START = '\u001B[200~'
export const PASTE_END = '\u001B[201~'
