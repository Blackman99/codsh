import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      allowedEditPaths: [],
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

  it('peels timeout duration and env assignments so deny still sees rm', () => {
    const denyRm = policy({
      mode: 'always-approve',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' }],
    })
    expect(evaluatePermission(denyRm, { kind: 'bash', command: 'timeout 30 rm -rf /' }).kind).toBe('deny')
    expect(evaluatePermission(denyRm, { kind: 'bash', command: 'env FOO=1 rm -rf /' }).kind).toBe('deny')
    expect(evaluatePermission(denyRm, { kind: 'bash', command: 'stdbuf -oL rm -rf /' }).kind).toBe('deny')
    for (const command of [
      'nice rm -rf /',
      'timeout rm -rf /',
      'ionice rm -rf /',
      'chrt rm -rf /',
      'timeout --verbose rm -rf /',
      'nice -n 10 rm -rf /',
      'timeout 30 nice -n 10 rm -rf /',
      'ionice -c 3 rm -rf /',
    ]) {
      expect(evaluatePermission(denyRm, { kind: 'bash', command }).kind, command).toBe('deny')
    }
  })

  it('prompts on env -S instead of empty-segment grant or readonly auto-allow', () => {
    const denyRm = [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' }]
    const asked = evaluatePermission(policy({ rules: denyRm }), { kind: 'bash', command: 'env -S rm -rf /' })
    expect(asked.kind).toBe('ask')
    expect(asked.reason).not.toMatch(/remembered|read-only/)
    const always = evaluatePermission(policy({
      mode: 'always-approve',
      rules: denyRm,
    }), { kind: 'bash', command: 'env -S rm -rf /' })
    expect(always.kind).toBe('ask')
  })

  it('applies deny inside clustered and long-option bash -c scripts', () => {
    const denyRm = policy({
      mode: 'always-approve',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' }],
    })
    for (const command of [
      'bash -lc "rm -rf /"',
      'bash --login -c "rm -rf /"',
      'bash -ec "rm -rf /"',
      'bash -c -- "rm -rf /"',
    ]) {
      expect(evaluatePermission(denyRm, { kind: 'bash', command }).kind, command).toBe('deny')
    }
  })

  it('does not auto-allow rg --pre or sort --compress-program as read-only', () => {
    expect(evaluatePermission(policy(), { kind: 'bash', command: 'rg --pre cat foo' }).kind).toBe('ask')
    expect(evaluatePermission(policy(), { kind: 'bash', command: 'sort --compress-program=gzip file' }).kind).toBe('ask')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), { kind: 'bash', command: 'sort --compress-pro=gzip file' }).kind).toBe('deny')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), { kind: 'bash', command: 'sort --compress-p=gzip file' }).kind).toBe('deny')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), { kind: 'bash', command: 'sort -o out.txt file' }).kind).toBe('deny')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), { kind: 'bash', command: 'sort -oout.txt file' }).kind).toBe('deny')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), { kind: 'bash', command: 'sort -oFILE file' }).kind).toBe('deny')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), { kind: 'bash', command: 'sort -uoFILE file' }).kind).toBe('deny')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), { kind: 'bash', command: 'sort -k1 file' }).kind).toBe('allow')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), { kind: 'bash', command: 'sort --output=out.txt file' }).kind).toBe('deny')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), { kind: 'bash', command: 'sort --output-file out.txt file' }).kind).toBe('deny')
    expect(evaluatePermission(policy(), { kind: 'bash', command: 'sort file' }).kind).toBe('allow')
  })

  it('does not let brace groups or ANSI-C bash -c bypass deny', () => {
    const denyRm = policy({
      mode: 'always-approve',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' }],
    })
    for (const command of [
      '{ rm -rf /; }',
      '{rm -rf /}',
      'true && { rm -rf /; }',
      'function x { rm -rf /; }',
      'bash -c "{ rm -rf /; }"',
      "bash -c $'rm -rf /'",
      "bash -c $'rm \\\\\n-rf /'",
    ]) {
      expect(evaluatePermission(denyRm, { kind: 'bash', command }).kind, command).toBe('deny')
    }
  })

  it('matches deny after quotes and backslashes are removed from parsed words', () => {
    const denyRm = policy({
      mode: 'always-approve',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' }],
    })
    for (const command of [
      "'rm' -rf /",
      '"rm" -rf /',
      "$'rm' -rf /",
      '\\rm -rf /',
      'bash -c "\'rm\' -rf /"',
      'bash -c "\\\\rm -rf /"',
      'eval "rm -rf /"',
      "eval $'rm -rf /'",
    ]) {
      expect(evaluatePermission(denyRm, { kind: 'bash', command }).kind, command).toBe('deny')
    }
  })

  it('applies Bash(rm -rf *) to a path-qualified rm under always-approve', () => {
    const denyRm = policy({
      mode: 'always-approve',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' }],
    })
    for (const command of [
      '/bin/rm -rf /',
      './rm -rf /',
      '/usr/local/bin/rm.exe -rf /',
      'timeout 30 /bin/rm -rf /',
      "bash -c '/bin/rm -rf /'",
      'RM.EXE -rf /',
      '/Bin/RM -rf /',
      '/usr/local/bin/RM.EXE -rf /',
      'timeout 30 /Bin/RM -rf /',
      'TIMEOUT 30 /Bin/RM -rf /',
    ]) {
      expect(evaluatePermission(denyRm, { kind: 'bash', command }).kind, command).toBe('deny')
    }
  })

  it('does not let sudo, nohup, or xargs hide a denied command under always-approve', () => {
    const denyRm = policy({
      mode: 'always-approve',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -rf *', patternMode: 'glob' }],
    })
    for (const command of [
      'sudo rm -rf /',
      'sudo /bin/rm -rf /',
      'sudo -u root rm -rf /',
      'nohup rm -rf /',
      'nohup /bin/rm -rf /',
      'xargs rm -rf /',
      'xargs -n 1 rm -rf /',
      '/usr/bin/sudo rm -rf /',
      'timeout 30 sudo rm -rf /',
      "bash -c 'sudo rm -rf /'",
    ]) {
      expect(evaluatePermission(denyRm, { kind: 'bash', command }).kind, command).toBe('deny')
    }
  })

  it('auto-allows the frozen git read-only subcommands and not writes', () => {
    const quiet = policy({ mode: 'dontAsk' })
    for (const command of [
      'git cat-file -t HEAD',
      'git ls-tree HEAD',
      'git check-ignore path',
      'git show-ref',
      'git for-each-ref',
      'git rev-list HEAD',
      'git name-rev HEAD',
      'git count-objects',
      'git check-attr -a path',
    ]) {
      expect(evaluatePermission(quiet, { kind: 'bash', command }).kind, command).toBe('allow')
    }
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git commit -m x' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -D topic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -d topic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --delete topic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --del topic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --dele topic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --mo topic renamed' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -m topic renamed' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -M topic renamed' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --cop topic copied' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -c topic copied' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -C topic copied' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --forc extra' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --cr extra' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --ed topic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --set-upstream-to HEAD topic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --un topic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch newtopic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -f topic HEAD' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch --force topic HEAD' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -u origin/main' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -uorigin/main' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -uupstream' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -uf' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -u=origin/main' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -vu origin/main' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -vv' }).kind).toBe('allow')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -ar' }).kind).toBe('allow')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch -t topic' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git show --output=/tmp/out HEAD' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git diff --output=/tmp/out' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git log --output=/tmp/out' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git blame --output=/tmp/out file' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git rev-list --output=/tmp/out HEAD' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git cat-file --filters HEAD:path' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git cat-file --fi HEAD:path' }).kind).toBe('deny')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git branch' }).kind).toBe('allow')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git show HEAD' }).kind).toBe('allow')
    expect(evaluatePermission(quiet, { kind: 'bash', command: 'git cat-file -t HEAD' }).kind).toBe('allow')
  })

  it('matches glob character classes on deny', () => {
    const decision = evaluatePermission(policy({
      mode: 'always-approve',
      rules: [{ action: 'deny', tool: 'bash', pattern: 'rm -[rf]*', patternMode: 'glob' }],
    }), { kind: 'bash', command: 'rm -rf /' })
    expect(decision.kind).toBe('deny')
  })

  it('persists path-scoped edit grants rather than all edits', () => {
    const granted = evaluatePermission(policy({
      grants: { ...policy().grants, allowedEditPaths: ['note.txt'] },
    }), { kind: 'edit', path: 'note.txt' })
    expect(granted.kind).toBe('allow')
    const other = evaluatePermission(policy({
      grants: { ...policy().grants, allowedEditPaths: ['note.txt'] },
    }), { kind: 'edit', path: 'other.txt' })
    expect(other.kind).toBe('ask')
  })

  it('does not let a bare Edit allow approve an unknown tool', () => {
    const decision = evaluatePermission(policy({
      mode: 'dontAsk',
      rules: [{ action: 'allow', tool: 'edit', pattern: null, patternMode: 'glob' }],
    }), { kind: 'tool', name: 'scheduler_create' })
    expect(decision.kind).toBe('deny')
  })

  it('follows in-path symlinks for Read deny and unresolved links prompt', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codsh-perm-link-'))
    mkdirSync(join(cwd, 'secret'))
    writeFileSync(join(cwd, 'secret/key'), 'SECRET')
    symlinkSync(join(cwd, 'secret/key'), join(cwd, 'visible'))
    symlinkSync(join(cwd, 'missing-target'), join(cwd, 'broken'))
    const denyRead = policy({
      cwd,
      rules: [{ action: 'deny', tool: 'read', pattern: 'secret/**', patternMode: 'glob' }],
    })
    expect(evaluatePermission(denyRead, { kind: 'read', path: 'visible' }).kind).toBe('deny')
    expect(evaluatePermission(denyRead, { kind: 'bash', command: 'cat visible' }).kind).toBe('deny')
    expect(evaluatePermission(denyRead, { kind: 'read', path: 'broken' }).kind).toBe('ask')
  })
})
