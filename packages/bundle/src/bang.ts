/**
 * Running a `!` line in the person's own shell.
 * @module codsh-bundle/src/bang
 */

/** The login shell, falling back to sh. */
export function userShell(): string {
  return process.env['SHELL'] ?? (process.platform === 'win32' ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh')
}
