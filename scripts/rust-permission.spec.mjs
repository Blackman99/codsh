import { describe, expect, it } from 'vitest'
import { evaluatePermission } from '../packages/cli/bin/rust-acp-file-approval.mjs'

function policy(overrides = {}) {
  return {
    mode: 'ask',
    rememberToolApprovals: true,
    interactive: true,
    cwd: '/workspace',
    grantsPath: '/tmp/permission.toml',
    rules: [],
    grants: {
      allowedBash: [],
      deniedBash: [],
      allowedMcp: [],
      deniedMcp: [],
      allowedDomains: [],
      deniedDomains: [],
      allowedEdits: false,
    },
    ...overrides,
  }
}

describe('rust permission evaluator', () => {
  it('lets deny beat allow, always-approve, and remembered grants', () => {
    const denied = evaluatePermission(policy({
      mode: 'always-approve',
      rules: [
        { action: 'allow', tool: 'bash', pattern: null, patternMode: 'glob' },
        { action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' },
      ],
      grants: { ...policy().grants, allowedBash: ['rm -rf denied-target'] },
    }), { kind: 'bash', command: 'rm -rf denied-target' })
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toMatch(/Denied by permission policy/)
  })

  it('does not let a prefix allow approve a compound command', () => {
    const decision = evaluatePermission(policy({
      rules: [{ action: 'allow', tool: 'bash', pattern: 'git *', patternMode: 'glob' }],
    }), { kind: 'bash', command: 'git status && rm -rf /' })
    expect(decision.kind).not.toBe('allow')
  })

  it('matches path globs and keeps bash-segment ask under always-approve', () => {
    const deny = evaluatePermission(policy({
      rules: [{ action: 'deny', tool: 'read', pattern: '/workspace/secret/**', patternMode: 'glob' }],
    }), { kind: 'read', path: '/workspace/secret/key' })
    expect(deny.kind).toBe('deny')
    const ask = evaluatePermission(policy({
      mode: 'always-approve',
      rules: [{ action: 'ask', tool: 'bash', pattern: 'git *', patternMode: 'glob' }],
    }), { kind: 'bash', command: 'git status' })
    expect(ask.kind).toBe('ask')
  })

  it('keeps hook deny in always-approve', () => {
    const decision = evaluatePermission(policy({ mode: 'always-approve' }), { kind: 'edit', path: 'note.txt' }, 'blocked')
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toContain('hook')
  })

  it('refuses unconfined auto mode when not interactive', () => {
    const decision = evaluatePermission(policy({ mode: 'auto', interactive: false }), { kind: 'edit', path: 'note.txt' })
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toMatch(/Auto mode blocked/)
  })

  it('does not treat a remembered grant as stronger than deny', () => {
    const decision = evaluatePermission(policy({
      rules: [{ action: 'deny', tool: 'edit', pattern: 'note.txt', patternMode: 'glob' }],
      grants: { ...policy().grants, allowedEdits: true },
    }), { kind: 'edit', path: 'note.txt' })
    expect(decision.kind).toBe('deny')
  })

  it('does not glob-allow unsplittable command substitution', () => {
    const decision = evaluatePermission(policy({
      mode: 'always-approve',
      rules: [
        { action: 'allow', tool: 'bash', pattern: 'git *', patternMode: 'glob' },
        { action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' },
      ],
    }), { kind: 'bash', command: 'git status && $(rm -rf /)' })
    expect(decision.kind).toBe('deny')
  })

  it('does not let control-flow split dodge a deny', () => {
    const decision = evaluatePermission(policy({
      mode: 'always-approve',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' }],
    }), { kind: 'bash', command: 'if true; then rm -rf /; fi' })
    expect(decision.kind).toBe('deny')
  })

  it('requires every inner bash -c command to be allowed', () => {
    const allowed = evaluatePermission(policy({
      rules: [{ action: 'allow', tool: 'bash', pattern: 'git *', patternMode: 'glob' }],
    }), { kind: 'bash', command: 'bash -c "git status && git diff"' })
    expect(allowed.kind).toBe('allow')
    const mixed = evaluatePermission(policy({
      rules: [{ action: 'allow', tool: 'bash', pattern: 'git *', patternMode: 'glob' }],
    }), { kind: 'bash', command: 'bash -c "git status && rm -rf /"' })
    expect(mixed.kind).not.toBe('allow')
  })

  it('applies Read deny to shell operands before read-only auto-allow', () => {
    const decision = evaluatePermission(policy({
      rules: [{ action: 'deny', tool: 'read', pattern: 'secret/**', patternMode: 'glob' }],
    }), { kind: 'bash', command: 'cat secret/key' })
    expect(decision.kind).toBe('deny')
  })

  it('skips non-shell ask and remembered grants under always-approve', () => {
    const readAsk = evaluatePermission(policy({
      mode: 'always-approve',
      rules: [{ action: 'ask', tool: 'read', pattern: 'src/**', patternMode: 'glob' }],
    }), { kind: 'read', path: 'src/main.rs' })
    expect(readAsk.kind).toBe('allow')
    const granted = evaluatePermission(policy({
      mode: 'always-approve',
      rules: [{ action: 'ask', tool: 'edit', pattern: 'note.txt', patternMode: 'glob' }],
      grants: { ...policy().grants, allowedEdits: true },
    }), { kind: 'edit', path: 'note.txt' })
    expect(granted.kind).toBe('allow')
    expect(granted.reason).toBe('always-approve')
  })

  it('fail-closed denies mutating tools when the policy cannot be parsed', () => {
    const broken = policy({ loadError: 'Permission policy unreadable or invalid; refusing mutating tools.' })
    const edit = evaluatePermission(broken, { kind: 'edit', path: 'note.txt' })
    expect(edit.kind).toBe('deny')
    expect(edit.reason).toMatch(/unreadable|refusing/)
    const read = evaluatePermission(broken, { kind: 'read', path: 'note.txt' })
    expect(read.kind).toBe('allow')
  })
})
