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

import { displayWidth, graphemeAt, oneRow } from './theme.ts'

/** One SGR sequence, matched where the scan stands; it occupies no display columns. */
const SGR_AT = /\u001B\[[0-9;]*m/y

/** Any other escape sequence, matched where the scan stands, also zero-width. */
const ESCAPE_AT = /(?:\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007|\u001B.)/y

/** Closes every style a row opened, so a row never bleeds into the next. */
const RESET = '\u001B[0m'

/** Punctuation a row must not open with: it belongs to the text before it. */
const NO_START = new Set([...'，。、；：！？）」』》〉】〕”’…,.;:!?)]}'])

/** Punctuation a row must not close with: it belongs to the text after it. */
const NO_END = new Set([...'（「『《〈【〔“‘([{'])

/** Text that breaks between any two characters: CJK scripts and their punctuation. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u

/** A line's hang: its indent, and a list marker with the space after it. */
const HANG = /^( *)(?:(?:[•○●◆✔✗]|\d{1,3}[.)]) (?=\S))?/u

/** Every SGR sequence, stripped to read a line's plain text. */
const SGR = /\u001B\[[0-9;]*m/gu

/**
 * The columns a line's continuation rows are indented by, so they sit
 * under its text rather than under its marker.
 *
 * The line's own indent, plus a list marker (`•`, `○`, `●`, `◆`, `✔`, `✗`,
 * `1.`) and the space after it. None once it would take half the row, where
 * the text left beside it would be too narrow to read.
 * @param text - the styled line.
 * @param columns - display columns a row has.
 * @returns the hang, in display columns.
 */
export function hangOf(text: string, columns: number): number {
  const match = HANG.exec(text.replaceAll(SGR, ''))
  const hang = match === null ? 0 : displayWidth(match[0])
  return usable(hang, columns)
}

/**
 * A hang the row can afford: under half of it, or none.
 * @param hang - the columns asked for.
 * @param columns - display columns a row has.
 * @returns the hang to indent by.
 */
function usable(hang: number, columns: number): number {
  return hang > 0 && hang * 2 < columns ? hang : 0
}

/**
 * Whether a row may break between two neighbouring clusters.
 *
 * Around CJK text, which has no spaces to break at, and after a `/` (a
 * path's segments), but never where punctuation would be torn from the text
 * it belongs to. An emoji is a word like any other. Spaces are the other
 * break, taken on their own.
 * @param before - the cluster the row would end with.
 * @param after - the cluster the next row would open with.
 * @returns whether the break is allowed.
 */
function breaksBetween(before: string, after: string): boolean {
  if (NO_START.has(after) || NO_END.has(before)) return false
  return before === '/' || CJK.test(before) || CJK.test(after)
}

/**
 * Break one styled line into rows no wider than `columns` display columns.
 *
 * Styles carry across the break: each continuation row re-opens whatever was
 * active where the cut fell, and every row that opened a style closes it.
 *
 * Rows break between words: at a space, which the break takes (no row opens
 * or closes with one), around CJK text, or after a `/`. A word wider
 * than a whole row is cut where the row ends, as a terminal would. With a
 * hang, every row after the first opens with that many spaces, inside the
 * styles it carries, so a continuation sits under the line's text.
 *
 * The line is scanned by index, one grapheme cluster per step: the unit the
 * terminal paints and the width authority measures, so `🎙️` costs its two
 * columns whole rather than one for the base and none for the selector, and
 * a joined emoji never breaks across rows. Slicing the remainder off after
 * every character copied the whole rest of the line each time, which made one
 * 50,000-character line — a tool's HTML dump, say — cost four seconds per
 * wrap, and the buffer is wrapped again at every resize and fold toggle. A
 * break between words moves at most one row's worth back, so the scan stays
 * linear.
 * @param text - the styled line, without a terminator.
 * @param columns - display columns available per row.
 * @param hang - columns each continuation row is indented by; see {@link hangOf}.
 * @returns the rows, at least one (an empty line yields one empty row).
 */
export function wrapStyled(text: string, columns: number, hang = 0): string[] {
  if (columns <= 0) return [text]
  const indent = ' '.repeat(usable(hang, columns))
  const rows: string[] = []
  /** SGR sequences active at the cursor, in the order they were applied. */
  let active: string[] = []
  let row = ''
  let width = 0
  /** Whether the row holds anything but its indent and spaces yet. */
  let seen = false
  /** The last cluster placed, which a break after it is judged by. */
  let previous = ''
  /** Where the row can break between words, with the styles open there. */
  let chance: { at: number; width: number; active: string[]; space: boolean } | undefined
  /** A space met the edge: the break is taken, the next text opens a row. */
  let broken = false
  // A row cannot hold a cursor movement, so every other control character
  // becomes a space here and the newline breaks a row below — where the styles
  // open at the break carry over, the way any other row break does.
  const source = oneRow(text, true)
  const cluster = graphemeAt(source)

  const flush = (): void => {
    rows.push(active.length > 0 ? `${row}${RESET}` : row)
    row = `${active.join('')}${indent}`
    width = indent.length
    seen = false
    chance = undefined
    broken = false
  }

  /** Break at the last chance, carrying what followed it onto a new row. */
  const cut = (): boolean => {
    if (chance === undefined) return false
    const head = row.slice(0, chance.at)
    let carried = row.slice(chance.at)
    let carriedWidth = width - chance.width
    if (chance.space) {
      carried = carried.replace(/^(?:\u001B\[[0-9;]*m| )+/u, (lead) => {
        const spaces = lead.replaceAll(/\u001B\[[0-9;]*m/gu, '').length
        carriedWidth -= spaces
        return lead.replaceAll(' ', '')
      })
    }
    rows.push(chance.active.length > 0 ? `${head}${RESET}` : head)
    row = `${chance.active.join('')}${indent}${carried}`
    width = indent.length + carriedWidth
    seen = /[^ ]/u.test(carried.replaceAll(SGR, ''))
    chance = undefined
    return true
  }

  let at = 0
  while (at < source.length) {
    const code = source.charCodeAt(at)
    if (code === 0x0A) {
      flush()
      previous = ''
      at += 1
      continue
    }
    if (code === 0x1B) {
      SGR_AT.lastIndex = at
      const sgr = SGR_AT.exec(source)
      if (sgr !== null) {
        const sequence = sgr[0]
        // A reset drops everything; anything else adds to what is open.
        if (sequence === '\u001B[0m' || sequence === '\u001B[m') active = []
        else active.push(sequence)
        row += sequence
        at += sequence.length
        continue
      }
      ESCAPE_AT.lastIndex = at
      const other = ESCAPE_AT.exec(source)
      if (other !== null) {
        row += other[0]
        at += other[0].length
        continue
      }
    }
    const character = cluster(at)
    const cost = displayWidth(character)
    const space = character === ' '
    if (broken) {
      // Spaces at a break are the break; the text after them opens the row.
      if (space) {
        at += 1
        continue
      }
      flush()
    }
    if (width + cost > columns && width > 0) {
      if (space && seen) {
        broken = true
        at += 1
        continue
      }
      // Where the row may break right here it does; otherwise it goes back
      // to the last place it could, or cuts the word the edge fell in. A
      // wide character that would straddle the edge moves down whole.
      const here = seen && breaksBetween(previous, character)
      if (here || !cut() || width + cost > columns) flush()
    }
    if (seen) {
      if (space) {
        if (previous !== ' ') chance = { at: row.length, width, active: [...active], space: true }
      } else if (breaksBetween(previous, character)) {
        chance = { at: row.length, width, active: [...active], space: false }
      }
    }
    row += character
    width += cost
    at += character.length
    if (!space) seen = true
    previous = character
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
