import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalEvent, clip, decodeHook, discoverHooks, matcherHits } from '../packages/cli/bin/rust-acp-hooks.mjs'

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), 'codsh-hooks-'))
  mkdirSync(join(root, '.grok', 'hooks'), { recursive: true })
  mkdirSync(join(root, 'home', '.grok', 'hooks'), { recursive: true })
  return root
}

describe('grok hook contract', () => {
  it('accepts the published event names and cursor aliases', () => {
    for (const name of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'Stop', 'StopFailure', 'StopCancelled', 'Notification', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd']) {
      expect(canonicalEvent(name)).toBe(name)
    }
    expect(canonicalEvent('beforeShellExecution')).toBe('PreToolUse')
    expect(canonicalEvent('SubagentEnd')).toBe('SubagentStop')
    expect(canonicalEvent('NotAHook')).toBe('')
  })

  it('keeps a top-level deny, and does not treat exit 1 as a deny', () => {
    const deny = decodeHook('PreToolUse', {
      exitCode: 0,
      stdout: '{"decision":"deny","reason":"nope"}',
      stderr: '',
      spawned: true,
    })
    expect(deny.decision).toBe('deny')
    expect(deny.reason).toBe('nope')
    const exit2 = decodeHook('PreToolUse', { exitCode: 2, stdout: '', stderr: 'blocked\n', spawned: true })
    expect(exit2.decision).toBe('deny')
    expect(exit2.reason).toBe('blocked')
    const other = decodeHook('PreToolUse', { exitCode: 1, stdout: '', stderr: 'boom', spawned: true })
    expect(other.decision).toBe('')
    expect(other.failure).toContain('exit code 1')
    const timed = decodeHook('PreToolUse', { exitCode: undefined, stdout: '', stderr: '', spawned: true, timedOut: true })
    expect(timed.failure).toBe('timed out')
    expect(timed.decision).toBe('')
  })

  it('does not let an allow or a hook rewrite skip the later permission check', () => {
    const allow = decodeHook('PreToolUse', {
      exitCode: 0,
      stdout: '{"decision":"allow"}',
      stderr: '',
      spawned: true,
    })
    expect(allow.decision).toBe('allow')
    const rewrite = decodeHook('PreToolUse', {
      exitCode: 2,
      stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"rm -rf /"}}}',
      stderr: 'no',
      spawned: true,
    })
    expect(rewrite.decision).toBe('deny')
    expect(rewrite.updatedInput).toBeNull()
  })

  it('clips hook feedback and matches claude tool aliases', () => {
    expect(clip('abcdef', 3)).toBe('abc… [+3 chars]')
    expect(matcherHits('Bash', 'bash')).toBe(true)
    expect(matcherHits('Read', 'read_file')).toBe(true)
    expect(matcherHits('^edit$', 'read')).toBe(false)
  })

  it('skips untrusted project hooks and still loads the user file', () => {
    const root = tempProject()
    try {
      const script = join(root, 'home', 'guard.sh')
      writeFileSync(script, '#!/bin/sh\ncat >/dev/null\n')
      chmodSync(script, 0o755)
      writeFileSync(join(root, 'home', '.grok', 'hooks', 'guard.json'), JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: script }] }] },
      }))
      writeFileSync(join(root, '.grok', 'hooks', 'project.json'), JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: join(root, 'project.sh') }] }] },
      }))
      const skipped = discoverHooks({ cwd: root, grokHome: join(root, 'home', '.grok'), trusted: false, env: { HOME: join(root, 'home') } })
      expect(skipped.groups.map(group => group.source)).toEqual(['global'])
      const trusted = discoverHooks({ cwd: root, grokHome: join(root, 'home', '.grok'), trusted: true, env: { HOME: join(root, 'home') } })
      expect(trusted.groups.map(group => group.source)).toEqual(['global', 'project'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
