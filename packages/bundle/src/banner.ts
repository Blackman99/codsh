/**
 * The opening banner: what answered, where, and which keys matter.
 * @module codsh-bundle/src/banner
 */

import { displayPath } from './status.ts'
import { displayWidth, truncate } from './theme.ts'
import type { Theme } from './theme.ts'

/** The product name, shown as the framed headline. */
const NAME = 'dsh code'

/**
 * Half-block sprite of `assets/logo.svg`: a › chevron, a hull, a wave, and a
 * whale tail. Each character is two vertical pixels (`▀` `▄` `█`).
 *
 * `.` empty, `c` chevron, `h` hull, `w` water and fluke.
 */
const SPRITE = [
  '........c...........',
  '........ccc.........',
  '........c.ccc.......',
  '........c..cc.......',
  '........c.ccc.......',
  '........ccc.........',
  '......hhhhhhhh......',
  '.......hhhhhh.......',
  '....w.ww..ww.ww.....',
  '....wwwwwwwwwwww....',
  '.....w...ww...w.....',
  '......ww.ww.ww......',
  '.......ww..ww.......',
  '........wwww........',
] as const

/** Display width of the sprite, plus the leading pad. */
const LOGO_WIDTH = SPRITE[0]!.length + 1

/** One sprite pixel. */
type Pixel = '.' | 'c' | 'h' | 'w'

/** Truecolor fills matching `assets/logo.svg`, used only on a coloured TTY. */
const FILL: Record<Exclude<Pixel, '.'>, string> = {
  c: '\u001B[38;2;126;150;245m',
  h: '\u001B[38;2;238;241;251m',
  w: '\u001B[38;2;61;86;214m',
}

/**
 * Paint one half-block cell from a pair of pixels.
 */
function paintCell(upper: Pixel, lower: Pixel, theme: Theme): string {
  const ink = (role: Exclude<Pixel, '.'>, ch: string): string =>
    theme.colored ? `${FILL[role]}${ch}\u001B[0m` : ch
  if (upper === '.') return lower === '.' ? ' ' : ink(lower, '▄')
  if (lower === '.') return ink(upper, '▀')
  if (upper === lower) return ink(upper, '█')
  return ink(upper, '▀')
}

/**
 * Paint the first-screen mark as half-block rows.
 */
function logoLines(theme: Theme): string[] {
  const rows: string[] = []
  for (let y = 0; y < SPRITE.length; y += 2) {
    const top = SPRITE[y] ?? ''
    const bot = SPRITE[y + 1] ?? ''
    let line = ' '
    for (let x = 0; x < top.length; x += 1) {
      line += paintCell((top[x] ?? '.') as Pixel, (bot[x] ?? '.') as Pixel, theme)
    }
    rows.push(line)
  }
  return rows
}

/** What the banner reports about the composed session. */
export interface BannerFacts {
  /** Model route answering this session. */
  model: string
  /** Composed preset, absent when the deployment composes no roster. */
  preset?: string | undefined
  /** Session workspace. */
  cwd: string
  /** Checked-out branch, absent outside a repository. */
  branch?: string | undefined
  /** Session identity, so a person can resume this exact conversation later. */
  session: string
  /** Whether Escape can reach the surface; decides which interrupt is named. */
  readsKeys: boolean
  /** Whether the transcript replayed a resumed conversation above the banner. */
  resumed: boolean
}

/**
 * Frame one headline in a rounded box sized to its content.
 *
 * Drawn from the measured display width rather than the character count, so a
 * headline carrying wide characters still closes its own box.
 * @param headline - the text to frame, already styled.
 * @param width - display width of the headline's plain text.
 * @param theme - styling for the frame itself.
 * @returns the three box lines.
 */
function framed(headline: string, width: number, theme: Theme): string[] {
  const rule = '─'.repeat(width + 2)
  return [
    theme.dim(`╭${rule}╮`),
    `${theme.dim('│')} ${headline} ${theme.dim('│')}`,
    theme.dim(`╰${rule}╯`),
  ]
}

/**
 * Render the opening banner.
 * @param facts - what to report.
 * @param theme - styling for the frame and the detail lines.
 * @param columns - display columns available; a narrow terminal loses the frame.
 * @returns the lines to print, ending with a blank separator.
 */
export function bannerLines(facts: BannerFacts, theme: Theme, columns: number): string[] {
  const composition = [facts.model, ...facts.preset === undefined ? [] : [facts.preset]].join(' · ')
  const where = facts.branch === undefined
    ? displayPath(facts.cwd)
    : `${displayPath(facts.cwd)} (${facts.branch})`
  const interrupt = facts.readsKeys ? 'ESC' : 'Ctrl-C'
  const plain = `${NAME} · ${composition}`
  const headline = `${theme.bold(NAME)}${theme.dim(` · ${composition}`)}`
  const details = [
    theme.dim(`  ${truncate(where, columns - 2)}`),
    theme.dim(`  session ${facts.session}${facts.resumed ? ' (resumed)' : ''}`),
    '',
    theme.dim(truncate(`  /help for commands · Tab completes · ⇧Tab plan mode · ${interrupt} interrupts · /exit leaves`, columns)),
    '',
  ]
  // A terminal wide enough gets the mark; a resumed session skips it — the
  // conversation being continued matters more than the greeting. Off a
  // terminal (or squeezed) the compact framed headline still says everything.
  if (facts.readsKeys && !facts.resumed && columns >= Math.max(LOGO_WIDTH + 2, 40)) {
    return [
      '',
      ...logoLines(theme),
      '',
      truncate(` ${theme.bold('✻ Welcome to codsh')}${theme.dim(` · ${composition}`)}`, columns),
      '',
      ...details,
    ]
  }
  // The frame costs four columns; below that the headline is shown plain rather
  // than wrapped into a broken box.
  const framing = displayWidth(plain) + 4 <= columns
  return [
    ...framing ? framed(headline, displayWidth(plain), theme) : [truncate(plain, columns)],
    ...details,
  ]
}
