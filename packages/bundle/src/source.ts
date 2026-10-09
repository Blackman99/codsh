/**
 * The message source of a turn this surface composes on the person's behalf:
 * `/init`, custom commands, `/ship` children, and the vision sidecar.
 *
 * dsh 0.1.7 dropped the shared `plugin` kind — `MessageSourceMap` is
 * merge-extensible and each producer declares its own. Readers here only ask
 * whether a message is the person's (`kind === 'user'`), so a session logged
 * under the old `plugin` kind replays the same.
 * @module codsh-bundle/src/source
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A user-role turn the terminal surface wrote, not the person. */
    'coding-cli': {
      kind: 'coding-cli'
    }
  }
}

/** The source every surface-composed turn carries. */
export const CLI_SOURCE = { kind: 'coding-cli' } as const
