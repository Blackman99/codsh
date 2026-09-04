/**
 * The opening banner: what answered, and which keys matter.
 * @module codsh-bundle/src/banner
 */

import { displayWidth, truncate } from './theme.ts'
import type { Theme } from './theme.ts'

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

/** How the opening banner greets this invocation. */
export type WelcomeKind = 'first' | 'returning' | 'none'

/** What the banner reports about the composed session. */
export interface BannerFacts {
  /** Model route answering this session. */
  model: string
  /** Composed preset, absent when the deployment composes no roster. */
  preset?: string | undefined
  /** Session identity, shown on the returning greeting. */
  session: string
  /** Whether Escape can reach the surface; decides which interrupt is named. */
  readsKeys: boolean
  /**
   * Which greeting to paint.
   * - `first` — ASCII (when wide enough) + short tips
   * - `returning` — two muted content lines (no ASCII)
   * - `none` — skip (`--resume` / `--continue`; replay owns the screen)
   */
  welcomeKind: WelcomeKind
}

/**
 * Model · optional preset, matching the status composition.
 */
function compositionOf(facts: BannerFacts): string {
  return [facts.model, ...facts.preset === undefined ? [] : [facts.preset]].join(' · ')
}

/**
 * Decide the greeting kind.
 *
 * Resume maps to `'none'` (replay owns the screen). Otherwise a prior session
 * in this workspace — or an explicit `/clear` paint — is `'returning'`; a
 * true first run is `'first'`.
 * @param resumeOrClear - at boot: `config.resume !== ''`; after `/clear`: pass
 *   `false` and set `priorInWorkspace` true (or call with clear semantics via
 *   the second overload path used by boot: `resolveWelcomeKind(false, prior)`).
 * @param priorInWorkspace - true when this cwd already has a prior session.
 */
export function resolveWelcomeKind(resumeOrClear: boolean, priorInWorkspace: boolean): WelcomeKind {
  // Boot path: first arg is `config.resume !== ''`. When true → none.
  // /clear path hardcodes welcomeKind: 'returning' and does not call this.
  // The existing boot call is resolveWelcomeKind(false, prior) after skipping resume.
  if (resumeOrClear) return 'none'
  return priorInWorkspace ? 'returning' : 'first'
}

/**
 * Shorten a session id so `session <id> · /status · ⇧Tab plan` fits `columns`.
 * Prefers trimming the id over dropping the tip suffix.
 */
function fitSessionId(session: string, columns: number): string {
  const prefix = 'session '
  const suffix = ' · /status · ⇧Tab plan'
  const budget = columns - displayWidth(prefix) - displayWidth(suffix)
  if (budget <= 0) return ''
  if (displayWidth(session) <= budget) return session
  // Session ids are ASCII; character length equals display width.
  if (budget < 2) return session.slice(0, budget)
  return `${session.slice(0, budget - 1)}…`
}

/**
 * Returning welcome: two content lines + trailing blank. No ASCII.
 */
function returningLines(facts: BannerFacts, theme: Theme, columns: number): string[] {
  const line1 = truncate(
    `${theme.agent('✻')}${theme.muted(` codsh · ${facts.model} · /help`)}`,
    columns,
  )
  const id = fitSessionId(facts.session, columns)
  const line2 = truncate(theme.muted(`session ${id} · /status · ⇧Tab plan`), columns)
  return [line1, line2, '']
}

/**
 * First-run welcome: ASCII whale when the TTY is wide enough, then short tips.
 */
function firstLines(facts: BannerFacts, theme: Theme, columns: number): string[] {
  const composition = compositionOf(facts)
  const interrupt = facts.readsKeys ? 'ESC' : 'Ctrl-C'
  const welcome = truncate(
    `${theme.agent('✻')}${theme.muted(` Welcome to codsh · ${composition}`)}`,
    columns,
  )
  const tips = truncate(
    theme.muted(`/help · /status · Tab · ⇧Tab plan · ${interrupt} · /exit`),
    columns,
  )
  // A terminal wide enough gets the mark. Off a terminal (or squeezed) the
  // short tips still greet without the lettermark.
  if (facts.readsKeys && columns >= Math.max(LOGO_WIDTH + 2, 40)) {
    return ['', ...logoLines(theme), '', welcome, tips, '']
  }
  return [welcome, tips, '']
}

/**
 * Render the opening banner.
 * @param facts - what to report.
 * @param theme - styling; `✻` via `agent`, everything else `muted`.
 * @param columns - display columns available; no line may exceed them.
 * @returns the lines to print (empty when `welcomeKind` is `none`).
 */
export function bannerLines(facts: BannerFacts, theme: Theme, columns: number): string[] {
  if (facts.welcomeKind === 'none') return []
  if (facts.welcomeKind === 'returning') return returningLines(facts, theme, columns)
  return firstLines(facts, theme, columns)
}
