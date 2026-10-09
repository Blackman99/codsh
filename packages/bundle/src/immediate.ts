/**
 * Which `/` commands run the moment they are submitted.
 *
 * A command that only works the surface or the session's settings — the
 * theme, the model, the thinking level, a picker over the transcript — has
 * nothing to wait for. Held in the Queue behind a running turn it reads as
 * ignored, and by the time it runs the moment it was for has passed. Those
 * run at Enter, turn or no turn. A command that spends a turn, swaps the
 * session, or rewrites the history still waits its place in the Queue, so it
 * never lands in the middle of the work it would disturb.
 *
 * The flag lives beside each surface registration (`immediate` on
 * {@link SurfaceCommand}); harness-owned commands, whose definitions this
 * repository does not write, are classified in {@link HARNESS_IMMEDIATE}.
 * Pure: no console, no agent.
 * @module codsh-bundle/src/immediate
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

/**
 * Whether a command runs at Enter: always, never, or by its argument — a
 * bare `/plan` toggles a mode, `/plan <message>` also hands the agent a
 * message.
 */
export type Immediacy = boolean | ((rawInput: string) => boolean)

/** A command this surface registers, with whether it bypasses the Queue. */
export type SurfaceCommand = CommandDefinition & {
  /** Run at Enter even while a turn is running; absent means it queues. */
  readonly immediate?: Immediacy
}

/**
 * Harness commands that only switch a setting of the session.
 *
 * `/permission` swaps the approval policy, which the harness applies to the
 * next decision. `/plan` and `/plan off` toggle plan mode, which the harness
 * defers to the next step when a turn is running ("applies from the next
 * step") — Shift-Tab already sends them mid-turn. `/plan <message>` also
 * hands the agent a message, so it keeps its place in the Queue. `/compact`,
 * `/goal`, and `/feedback` are left out: the first two drive the model, and
 * the last writes into the session log rather than a setting.
 */
export const HARNESS_IMMEDIATE: Readonly<Record<string, Immediacy>> = {
  permission: true,
  plan: rawInput => rawInput === '' || rawInput === 'off',
}

/** The table the submission path consults, filled as commands register. */
export class ImmediateCommands {
  private readonly table = new Map<string, Immediacy>()

  constructor(seed: Readonly<Record<string, Immediacy>> = {}) {
    for (const [name, immediacy] of Object.entries(seed)) this.mark(name, immediacy)
  }

  /**
   * Record how a command is dispatched.
   * @param name - the command name, without its slash.
   * @param immediacy - whether, or for which arguments, it runs at Enter.
   */
  mark(name: string, immediacy: Immediacy): void {
    this.table.set(name.toLowerCase(), immediacy)
  }

  /**
   * Whether a submitted line runs now rather than through the Queue.
   * @param line - the submission, as typed.
   * @returns true for a `/` line naming an immediate command with arguments it accepts.
   */
  test(line: string): boolean {
    // A bare slash is how the surface spells `/help`.
    if (line.trim() === '/') return this.table.get('help') === true
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(line.trim())
    if (match === null) return false
    const immediacy = this.table.get((match[1] ?? '').toLowerCase())
    if (typeof immediacy === 'function') return immediacy((match[2] ?? '').trim())
    return immediacy === true
  }
}

/**
 * Split a surface registration into what the registry takes and its flag.
 * @param command - the registration, flag included.
 * @returns the harness definition and the flag, defaulting to queued.
 */
export function splitSurfaceCommand(command: SurfaceCommand): { definition: CommandDefinition; immediate: Immediacy } {
  const { immediate = false, ...definition } = command
  return { definition, immediate }
}
