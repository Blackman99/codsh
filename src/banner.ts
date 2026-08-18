/**
 * The opening banner: what answered, where, and which keys matter.
 * @module codsh-cli/src/banner
 */

import { displayPath } from './status.ts'
import { displayWidth, truncate } from './theme.ts'
import type { Theme } from './theme.ts'

/** The product name, shown as the framed headline. */
const NAME = 'dsh code'

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
  // The frame costs four columns; below that the headline is shown plain rather
  // than wrapped into a broken box.
  const plain = `${NAME} · ${composition}`
  const headline = `${theme.bold(NAME)}${theme.dim(` · ${composition}`)}`
  const framing = displayWidth(plain) + 4 <= columns
  return [
    ...framing ? framed(headline, displayWidth(plain), theme) : [truncate(plain, columns)],
    theme.dim(`  ${truncate(where, columns - 2)}`),
    theme.dim(`  session ${facts.session}${facts.resumed ? ' (resumed)' : ''}`),
    '',
    theme.dim(truncate(`  /help for commands · Tab completes · ⇧Tab plan mode · ${interrupt} interrupts · /exit leaves`, columns)),
    '',
  ]
}
