/**
 * Desktop notifications for a person who has looked away.
 *
 * The bell already rings only while the window is unfocused; a notification
 * is the same moment made visible from another window. The terminal is asked
 * first: OSC 9 is what iTerm2, WezTerm, Ghostty, kitty, and Windows Terminal
 * turn into a system notification, and it costs one write. Terminal.app
 * ignores OSC 9, so there the platform is asked through `osascript`; on
 * Linux, a terminal not known to speak OSC 9 gets `notify-send` beside it,
 * when the command exists. A failure anywhere is silent — a notification
 * that did not arrive is not worth a line in the transcript.
 * @module codsh-bundle/src/notify
 */

import { execFile } from 'node:child_process'

/** How one notification is to be delivered. */
export interface NotificationPlan {
  /** Whether to write OSC 9 to the terminal. */
  osc: boolean
  /** A platform command to run beside, or instead of, the escape sequence. */
  command?: { file: string; args: string[] }
}

/** Longest body a notification carries; the rest is the transcript's job. */
const BODY_LIMIT = 160

/** `TERM_PROGRAM` values of terminals known to turn OSC 9 into a notification. */
const OSC9_TERMINALS = new Set(['iTerm.app', 'WezTerm', 'ghostty', 'kitty', 'WarpTerminal'])

/**
 * One line fit for a notification: no control characters, no line breaks.
 * @param text - what to say.
 * @returns the text, cleaned and capped.
 */
export function notificationText(text: string): string {
  const oneLine = text.replaceAll(/\r?\n+/gu, ' · ').replaceAll(/[\u0000-\u001F\u007F]/gu, '').trim()
  return oneLine.length > BODY_LIMIT ? `${oneLine.slice(0, BODY_LIMIT - 1)}…` : oneLine
}

/**
 * Decide how to deliver one notification on this terminal and platform.
 * @param title - the notification's title, for platforms that show one.
 * @param body - the cleaned one-line body.
 * @param env - the process environment (`TERM_PROGRAM`, `TERM`, `WT_SESSION`).
 * @param platform - `process.platform`.
 * @returns the plan.
 */
export function planNotification(
  title: string,
  body: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): NotificationPlan {
  const program = env.TERM_PROGRAM ?? ''
  // Terminal.app shows nothing for OSC 9; the platform does it instead.
  if (program === 'Apple_Terminal') {
    return {
      osc: false,
      command: { file: 'osascript', args: ['-e', `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`] },
    }
  }
  const speaksOsc9 = OSC9_TERMINALS.has(program) || (env.TERM ?? '').startsWith('xterm-kitty') || env.WT_SESSION !== undefined
  if (speaksOsc9) return { osc: true }
  // Unknown terminal: the escape sequence is free to try, and on Linux the
  // desktop can be asked directly when `notify-send` is there.
  if (platform === 'linux') return { osc: true, command: { file: 'notify-send', args: [title, body] } }
  return { osc: true }
}

/**
 * Run a plan's platform command, if it has one, and never wait on it or
 * report it: a missing binary or a refused notification is not an error here.
 * @param plan - the plan to carry out.
 * @param run - the spawner, `execFile` unless a test supplies one.
 */
export function runNotificationCommand(plan: NotificationPlan, run: typeof execFile = execFile): void {
  if (plan.command === undefined) return
  try {
    run(plan.command.file, plan.command.args, { timeout: 5_000 }, () => undefined)
  } catch {
    // A synchronous spawn failure is the same non-event as an asynchronous one.
  }
}

/**
 * Quote text as an AppleScript string literal.
 * @param text - the text.
 * @returns the literal, backslashes and quotes escaped.
 */
function appleScriptString(text: string): string {
  return `"${text.replaceAll(/[\\"]/gu, match => `\\${match}`)}"`
}
