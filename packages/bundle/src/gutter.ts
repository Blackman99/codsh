/**
 * Transcript left gutter: one display column + space, coloured by block role.
 *
 * The screen paints this rule on every wrapped row of a block. Content starts
 * at column 3; answers leave the gutter blank so prose stays flush.
 * @module codsh-bundle/src/gutter
 */

import type { Theme } from './theme.ts'

/** Roles the transcript maps onto a gutter glyph. */
export type GutterRole = 'user' | 'thinking' | 'tool' | 'error' | 'answer' | 'system'

/**
 * Styled gutter for one block role: glyph + trailing space, or empty for answers.
 * @param role - which kind of block is being drawn.
 * @param theme - colour roles; under NO_COLOR the glyph remains unstyled.
 * @returns the two-column rule, or `''` when the gutter is blank.
 */
export function gutter(role: GutterRole, theme: Theme): string {
  switch (role) {
    case 'user':
      return theme.accent('› ')
    case 'thinking':
      return theme.agent('✻ ')
    case 'tool':
      return theme.tool('│ ')
    case 'error':
      return theme.err('│ ')
    case 'system':
      return theme.muted('· ')
    case 'answer':
      return ''
  }
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
} {
  return {
    user: gutter('user', theme),
    tool: gutter('tool', theme),
    error: gutter('error', theme),
    agent: gutter('thinking', theme),
    meta: gutter('system', theme),
  }
}
