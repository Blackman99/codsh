/**
 * Remembered approvals: how a rule is spelled, which calls it covers, what the
 * widget offers for a call, and the three files that hold the rules.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PermissionRules, formatRule, isCompound, parseRule, ruleMatches, suggestRule, type Rule } from '../src/permissions.ts'

describe('spelling a rule', () => {
  it.each([
    { text: 'write', rule: { tool: 'write' } },
    { text: 'bash(git push *)', rule: { tool: 'bash', command: { kind: 'prefix', prefix: 'git push' } } },
    { text: 'bash(pnpm test)', rule: { tool: 'bash', command: { kind: 'exact', command: 'pnpm test' } } },
    { text: '  mcp__github__create_issue  ', rule: { tool: 'mcp__github__create_issue' } },
    { text: 'bash(*)', rule: { tool: 'bash' } },
  ])('reads $text', ({ text, rule }) => {
    expect(parseRule(text)).toEqual(rule)
  })

  it.each(['', 'bash(', 'bash()', 'two words', 'bash(x)y'])('refuses %j', (text) => {
    expect(parseRule(text)).toBeUndefined()
  })

  it('round-trips through its written form', () => {
    for (const text of ['write', 'bash(git push *)', 'bash(pnpm test)']) {
      expect(formatRule(parseRule(text) as Rule)).toBe(text)
    }
  })
})

describe('matching a call', () => {
  const prefix: Rule = { tool: 'bash', command: { kind: 'prefix', prefix: 'git push' } }
  const exact: Rule = { tool: 'bash', command: { kind: 'exact', command: 'pnpm test' } }
  const whole: Rule = { tool: 'write' }

  it('covers the prefix itself and anything after a space', () => {
    expect(ruleMatches(prefix, 'bash', { command: 'git push' })).toBe(true)
    expect(ruleMatches(prefix, 'bash', { command: 'git push origin main --force' })).toBe(true)
    expect(ruleMatches(prefix, 'bash', { command: '  git push\n' })).toBe(true)
    expect(ruleMatches(prefix, 'bash', { command: 'git pushx' })).toBe(false)
    expect(ruleMatches(prefix, 'bash', { command: 'git pull' })).toBe(false)
  })

  it('never lets a compound command through a prefix', () => {
    for (const command of ['git push && rm -rf .', 'git push; ls', 'git push | tee log', 'git push &', 'git push `id`', 'git push $(id)', 'git push\nrm -rf .']) {
      expect(ruleMatches(prefix, 'bash', { command })).toBe(false)
    }
  })

  it('matches an exact rule to the letter', () => {
    expect(ruleMatches(exact, 'bash', { command: 'pnpm test' })).toBe(true)
    expect(ruleMatches(exact, 'bash', { command: 'pnpm test --watch' })).toBe(false)
  })

  it('stays on its own tool, and reads only a string command', () => {
    expect(ruleMatches(prefix, 'terminal', { command: 'git push' })).toBe(false)
    expect(ruleMatches(prefix, 'bash', { command: 42 })).toBe(false)
    expect(ruleMatches(prefix, 'bash', undefined)).toBe(false)
    expect(ruleMatches(prefix, 'bash', 'git push')).toBe(false)
  })

  it('covers every call of a tool-level rule, arguments known or not', () => {
    expect(ruleMatches(whole, 'write', { file_path: 'a.ts' })).toBe(true)
    expect(ruleMatches(whole, 'write', undefined)).toBe(true)
    expect(ruleMatches(whole, 'edit', undefined)).toBe(false)
  })
})

describe('what the widget offers', () => {
  it.each([
    { command: 'git push origin main', offered: 'bash(git push *)' },
    { command: 'git -C sub status', offered: 'bash(git *)' },
    { command: 'pnpm test', offered: 'bash(pnpm test *)' },
    { command: 'ls -la', offered: 'bash(ls *)' },
    { command: 'CI=1 FORCE_COLOR=0 pnpm run build', offered: 'bash(pnpm run *)' },
    { command: './scripts/dev.sh --fast', offered: 'bash(./scripts/dev.sh *)' },
    { command: '  printf hello  ', offered: 'bash(printf *)' },
  ])('offers $offered for $command', ({ command, offered }) => {
    expect(formatRule(suggestRule('bash', { command }) as Rule)).toBe(offered)
  })

  it('offers a tool without a command line whole', () => {
    expect(suggestRule('write', { file_path: 'a.ts' })).toEqual({ tool: 'write' })
    expect(suggestRule('mcp__github__create_issue', undefined)).toEqual({ tool: 'mcp__github__create_issue' })
  })

  it('offers nothing for a compound or empty command', () => {
    expect(suggestRule('bash', { command: 'git status && rm -rf .' })).toBeUndefined()
    expect(suggestRule('bash', { command: 'echo $(id)' })).toBeUndefined()
    expect(suggestRule('bash', { command: '   ' })).toBeUndefined()
    expect(isCompound('a | b')).toBe(true)
    expect(isCompound('a b')).toBe(false)
  })
})

describe('the rule files', () => {
  let root: string
  let store: PermissionRules
  let warnings: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codsh-permissions-'))
    warnings = []
    store = new PermissionRules({
      project: join(root, 'project', '.dsh', 'permissions.json'),
      projectLocal: join(root, 'project', '.dsh', 'permissions.local.json'),
      user: join(root, 'home', 'permissions.json'),
    }, {
      label: path => path.slice(root.length + 1),
      warn: line => void warnings.push(line),
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const write = async (path: string, content: unknown): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content))
  }

  it('allows nothing when no file exists, and says nothing about it', async () => {
    expect(await store.allows('bash', { command: 'git push' })).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('unions the three files, the personal project file first', async () => {
    await write(join(root, 'project', '.dsh', 'permissions.local.json'), { allow: ['bash(git push *)'] })
    await write(join(root, 'project', '.dsh', 'permissions.json'), { allow: ['bash(pnpm test *)'] })
    await write(join(root, 'home', 'permissions.json'), { allow: ['write'] })
    expect(formatRule(await store.allows('bash', { command: 'git push origin' }) as Rule)).toBe('bash(git push *)')
    expect(formatRule(await store.allows('bash', { command: 'pnpm test' }) as Rule)).toBe('bash(pnpm test *)')
    expect(formatRule(await store.allows('write', undefined) as Rule)).toBe('write')
    expect(await store.allows('bash', { command: 'rm -rf .' })).toBeUndefined()
  })

  it('writes the personal project file, creating its folder, and reads it back', async () => {
    const path = await store.remember({ tool: 'bash', command: { kind: 'prefix', prefix: 'git push' } })
    expect(path).toBe('project/.dsh/permissions.local.json')
    await store.remember({ tool: 'write' })
    // Once is enough for the same rule.
    await store.remember({ tool: 'write' })
    const written = JSON.parse(await readFile(join(root, path), 'utf8')) as { allow: string[] }
    expect(written.allow).toEqual(['bash(git push *)', 'write'])
    expect(await readFile(join(root, path), 'utf8')).toMatch(/\n$/u)
    expect(await store.allows('bash', { command: 'git push' })).toBeDefined()
  })

  it('names a file that does not parse once, skips it, and refuses to overwrite it', async () => {
    const local = join(root, 'project', '.dsh', 'permissions.local.json')
    await write(local, '{ not json')
    await write(join(root, 'home', 'permissions.json'), { allow: ['write', 'not a rule!'] })
    expect(await store.allows('write', undefined)).toBeDefined()
    expect(await store.allows('write', undefined)).toBeDefined()
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/^project\/\.dsh\/permissions\.local\.json: /u)
    expect(warnings[1]).toBe('home/permissions.json: not a rule, skipped: "not a rule!"')
    await expect(store.remember({ tool: 'write' })).rejects.toThrow(/fix or remove the file/u)
    expect(await readFile(local, 'utf8')).toBe('{ not json')
  })

  it('reads a file with the wrong shape as empty, and says so', async () => {
    await write(join(root, 'project', '.dsh', 'permissions.json'), { deny: ['bash'] })
    expect(await store.allows('bash', undefined)).toBeUndefined()
    expect(warnings).toEqual(['project/.dsh/permissions.json: expected { "allow": [ … ] }'])
  })
})
