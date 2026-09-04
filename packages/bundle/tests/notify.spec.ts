/**
 * Desktop notifications: what the text becomes, which terminal gets the
 * escape sequence, which platform gets a command, and that a failing command
 * is nobody's problem.
 */

import { describe, expect, it } from 'vitest'
import { notificationText, planNotification, runNotificationCommand } from '../src/notify.ts'

describe('the text', () => {
  it('drops control characters and folds line breaks into one line', () => {
    expect(notificationText('done\u0007 \u001B[31mnow\r\nnext\n\nlast')).toBe('done [31mnow · next · last')
  })

  it('caps a long body and marks the cut', () => {
    const text = notificationText('x'.repeat(500))
    expect(text).toHaveLength(160)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('the plan', () => {
  const title = 'codsh'
  const body = 'waiting for approval: bash: git push'

  it.each([
    { label: 'iTerm2', env: { TERM_PROGRAM: 'iTerm.app' }, platform: 'darwin' },
    { label: 'WezTerm', env: { TERM_PROGRAM: 'WezTerm' }, platform: 'linux' },
    { label: 'Ghostty', env: { TERM_PROGRAM: 'ghostty' }, platform: 'darwin' },
    { label: 'kitty by TERM', env: { TERM: 'xterm-kitty' }, platform: 'linux' },
    { label: 'Windows Terminal', env: { WT_SESSION: 'abc' }, platform: 'win32' },
  ])('asks only the terminal on $label', ({ env, platform }) => {
    expect(planNotification(title, body, env, platform)).toEqual({ osc: true })
  })

  it('asks the platform instead of Terminal.app, which ignores OSC 9, quoting for AppleScript', () => {
    const plan = planNotification(title, 'say "hi" \\ there', { TERM_PROGRAM: 'Apple_Terminal' }, 'darwin')
    expect(plan.osc).toBe(false)
    expect(plan.command).toEqual({
      file: 'osascript',
      args: ['-e', 'display notification "say \\"hi\\" \\\\ there" with title "codsh"'],
    })
  })

  it('tries both on an unknown Linux terminal, and only the sequence elsewhere', () => {
    expect(planNotification(title, body, { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color' }, 'linux')).toEqual({
      osc: true,
      command: { file: 'notify-send', args: [title, body] },
    })
    expect(planNotification(title, body, { TERM: 'xterm-256color' }, 'darwin')).toEqual({ osc: true })
    expect(planNotification(title, body, {}, 'win32')).toEqual({ osc: true })
  })
})

describe('the command', () => {
  it('runs the plan\'s command with a timeout and ignores what happens to it', () => {
    const calls: { file: string; args: readonly string[] }[] = []
    const run = ((file: string, args: readonly string[], _options: unknown, done: (error: Error | null) => void) => {
      calls.push({ file, args })
      done(new Error('not installed'))
    }) as never
    runNotificationCommand({ osc: true, command: { file: 'notify-send', args: ['codsh', 'done'] } }, run)
    expect(calls).toEqual([{ file: 'notify-send', args: ['codsh', 'done'] }])
    expect(() => runNotificationCommand({ osc: true }, run)).not.toThrow()
    const throwing = (() => { throw new Error('spawn ENOENT') }) as never
    expect(() => runNotificationCommand({ osc: false, command: { file: 'osascript', args: [] } }, throwing)).not.toThrow()
  })
})
