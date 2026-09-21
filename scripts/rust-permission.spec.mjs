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

  it('matches path globs and explicit ask rules', () => {
    const deny = evaluatePermission(policy({
      rules: [{ action: 'deny', tool: 'read', pattern: '/workspace/secret/**', patternMode: 'glob' }],
    }), { kind: 'read', path: '/workspace/secret/key' })
    expect(deny.kind).toBe('deny')
    const ask = evaluatePermission(policy({
      mode: 'always-approve',
      rules: [{ action: 'ask', tool: 'read', pattern: 'src/**', patternMode: 'glob' }],
    }), { kind: 'read', path: 'src/main.rs' })
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
})
