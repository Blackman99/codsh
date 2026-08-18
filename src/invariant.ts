/**
 * Package-owned invariant companion for `codsh`.
 * @module codsh/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'codsh'

/** Cordis companion plugin name. */
export const name = 'coding-cli-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the surface is a renderer and input loop over the
 * session log whose observable contract (rendered transcript, approval
 * decisions, exit code) is process-level and owned by the launcher e2e. It
 * holds no durable relation of its own — every fact it shows is derived from
 * `session/event`, whose relations `dsh-session` already audits.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
