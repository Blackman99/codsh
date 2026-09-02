/**
 * Display-width wrapping for styled text.
 *
 * Inside the alternate screen the terminal no longer wraps for us: a transcript
 * line longer than the viewport must be broken into rows before it is painted,
 * or it would overwrite the row below. The lines being broken are already
 * styled, so a naive split would cut an escape sequence in half and leak
 * gibberish — and a continuation row would lose the colour its first half set.
 * @module codsh-bundle/src/wrap
 */

import { displayWidth, oneRow } from './theme.ts'

/** One SGR sequence, which occupies no display columns. */
const SGR = /^\u001B\[[0-9;]*m/

/** Any other escape sequence, also zero-width. */
const ESCAPE = /^(?:\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007|\u001B.)/

/** Closes every style a row opened, so a row never bleeds into the next. */
const RESET = '\u001B[0m'

/**
 * Break one styled line into rows no wider than `columns` display columns.
 *
 * Styles carry across the break: each continuation row re-opens whatever was
 * active where the cut fell, and every row that opened a style closes it.
 * @param text - the styled line, without a terminator.
 * @param columns - display columns available per row.
 * @returns the rows, at least one (an empty line yields one empty row).
 */
export function wrapStyled(text: string, columns: number): string[] {
  if (columns <= 0) return [text]
  const rows: string[] = []
  /** SGR sequences active at the cursor, in the order they were applied. */
  let active: string[] = []
  let row = ''
  let width = 0
  // A row cannot hold a cursor movement, so every other control character
  // becomes a space here and the newline breaks a row below — where the styles
  // open at the break carry over, the way any other row break does.
  let rest = oneRow(text, true)

  const flush = (): void => {
    rows.push(active.length > 0 ? `${row}${RESET}` : row)
    row = active.join('')
    width = 0
  }

  while (rest !== '') {
    if (rest.startsWith('\n')) {
      flush()
      rest = rest.slice(1)
      continue
    }
    const sgr = SGR.exec(rest)
    if (sgr !== null) {
      const sequence = sgr[0]
      // A reset drops everything; anything else adds to what is open.
      if (sequence === '\u001B[0m' || sequence === '\u001B[m') active = []
      else active.push(sequence)
      row += sequence
      rest = rest.slice(sequence.length)
      continue
    }
    const other = ESCAPE.exec(rest)
    if (other !== null) {
      row += other[0]
      rest = rest.slice(other[0].length)
      continue
    }
    const character = [...rest][0] ?? ''
    const cost = displayWidth(character)
    // A wide character that would straddle the edge moves down whole.
    if (width + cost > columns && width > 0) flush()
    row += character
    width += cost
    rest = rest.slice(character.length)
  }
  rows.push(active.length > 0 ? `${row}${RESET}` : row)
  return rows
}

/**
 * Wrap many lines, keeping their order.
 * @param lines - styled lines.
 * @param columns - display columns per row.
 * @returns the physical rows they occupy.
 */
export function wrapAll(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapStyled(line, columns))
}
