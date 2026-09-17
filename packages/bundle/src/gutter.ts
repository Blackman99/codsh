/**
 * Transcript left gutter: one connecting `│`, coloured by block role.
 *
 * The screen paints this rule on every wrapped row of a block, including
 * blank separators. Content starts at column 3. Colour — not a different
 * character — says what the row is.
 * @module codsh-bundle/src/gutter
 */

import type { Theme } from './theme.ts'

/** Roles the transcript maps onto a gutter colour. */
export type GutterRole = 'user' | 'thinking' | 'tool' | 'error' | 'answer' | 'system'

/** The two-column rail every transcript row carries. */
const RAIL = '│ '

/**
 * Styled gutter for one block role: coloured `│` plus a trailing space.
 * @param role - which kind of block is being drawn.
 * @param theme - colour roles; under NO_COLOR the glyph remains unstyled.
 * @returns the two-column rule.
 */
export function gutter(role: GutterRole, theme: Theme): string {
  switch (role) {
    case 'user':
      return theme.accent(RAIL)
    case 'thinking':
      return theme.agent(RAIL)
    case 'tool':
      return theme.dim(RAIL)
    case 'error':
      return theme.err(RAIL)
    case 'system':
    case 'answer':
      return theme.muted(RAIL)
  }
}

/**
 * A runner notice that lands among tool cards: dim inset text plus the tool
 * gutter, so the left rule continues through drift flashes and alignment
 * denials instead of breaking on every one.
 * @param text - the notice, without the two-space inset.
 * @param theme - colour roles; under NO_COLOR the glyph remains unstyled.
 * @returns the styled line and the two-column tool rule.
 */
export function runnerNotice(text: string, theme: Theme): { line: string; rule: string } {
  return { line: theme.dim(`  ${text}`), rule: gutter('tool', theme) }
}

/**
 * The left rules the transcript draws down a block's edge.
 *
 * `agent` is thinking; `meta` is system chrome. Prefer {@link gutter} at new
 * call sites.
 * @param theme - styling for the marks.
 * @returns the rule per block kind.
 */
export function blockRules(theme: Theme): {
  user: string
  tool: string
  error: string
  agent: string
  meta: string
  answer: string
} {
  return {
    user: gutter('user', theme),
    tool: gutter('tool', theme),
    error: gutter('error', theme),
    agent: gutter('thinking', theme),
    meta: gutter('system', theme),
    answer: gutter('answer', theme),
  }
}
