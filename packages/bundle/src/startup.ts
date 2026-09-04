/**
 * The terminal app's command-line provider: it parses the optional task
 * positional, the session-continuation flags, the preset override, and
 * `--help`, then publishes {@link CODING_CLI_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module codsh-bundle/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'coding-cli-startup'

/** Services required before the invocation can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the terminal runner. */
export const CODING_CLI_STARTUP_SERVICE = 'codingCliStartup'

/** What the runner row reads from {@link CODING_CLI_STARTUP_SERVICE}. */
export interface CodingCliStartupValues {
  /** Opening task text, or the empty string when the session starts at the prompt. */
  task: string
  /** Session to reopen: an explicit id, `'latest'` for `--continue`, or the empty string for a new session. */
  resume: string
  /** Preset id overriding the roster default, or the empty string to accept it. */
  preset: string
  /** Render the answer and exit rather than entering the interactive loop. */
  print: boolean
}

/** Flags this app accepts, before commander applies its defaults. */
interface CodingCliOptions {
  resume?: string
  continue?: boolean
  preset?: string
  print?: boolean
}

/**
 * This app's command: the optional task positional, its flags, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function codingCliCommand(): Command {
  return new Command()
    .name('dsh code')
    .description('Work through coding tasks in an interactive terminal session.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'opening task; multiple words are joined by spaces. Omit it to start at the prompt')
    .option('--resume <session>', 'reopen a session by id and continue its conversation')
    .option('--continue', 'reopen the most recent session in this working directory')
    .option('--preset <id>', 'compose the agent from this preset instead of the roster default')
    .option('-p, --print', 'render the answer to the opening task and exit without entering the prompt')
    .addHelpText('after', `
Examples:
  dsh code                                   start an interactive session
  dsh code "add a slugify helper"            start with an opening task
  dsh code -p "what does this repo do?"      answer once and exit
  dsh code --continue                        reopen the latest session here
  dsh code --resume session-1234             reopen one session by id
  dsh code --preset standard                 compose from a different preset
`)
}

/**
 * Resolve the session to reopen from the two mutually exclusive continuation flags.
 * @param program - the parsed command, used to report a usage error.
 * @param options - the flags commander collected.
 * @returns the session id, `'latest'`, or the empty string.
 */
function resolveResume(program: Command, options: CodingCliOptions): string {
  if (options.continue === true && options.resume !== undefined) {
    program.error('error: --continue and --resume are mutually exclusive')
  }
  if (options.continue === true) return 'latest'
  if (options.resume === undefined) return ''
  if (options.resume.trim() === '') program.error('error: --resume needs a session id')
  return options.resume
}

/**
 * Parse and provide this invocation as an ordinary Cordis service. On `--help`
 * and on a usage error nothing is provided, so the runner never mounts.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = codingCliCommand()
  program.action(() => {
    const options = program.opts<CodingCliOptions>()
    const task = program.args.join(' ').trim()
    const print = options.print === true
    if (print && task === '') {
      program.error('error: --print needs a task, for example: dsh code -p "run the tests"')
    }
    const preset = options.preset ?? ''
    if (options.preset !== undefined && preset.trim() === '') {
      program.error('error: --preset needs a preset id')
    }
    ctx.provide(CODING_CLI_STARTUP_SERVICE, {
      task,
      resume: resolveResume(program, options),
      preset,
      print,
    } satisfies CodingCliStartupValues)
  })
  parseCmdline(ctx, program)
}
