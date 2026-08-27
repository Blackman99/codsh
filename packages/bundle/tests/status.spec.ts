/**
 * The status readout: how figures are abbreviated, how occupancy is derived,
 * and how the branch is found without shelling out to git.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  contextLeftPercent,
  displayPath,
  formatTokens,
  gitBranch,
  statusLine,
  statusReport,
  totalTokens,
  type StatusFacts,
} from '../src/status.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A temporary directory tree. */
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-status-'))
  dirs.push(dir)
  return dir
}

const usage: TokenUsageProjection = {
  uncachedInputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 300,
  cacheWriteTokens: 5,
}

/** The minimum a status line needs. */
const base: StatusFacts = { model: 'm', planMode: false, cwd: '/repo' }

describe('formatTokens', () => {
  it.each([
    { tokens: 0, shown: '0' },
    { tokens: 999, shown: '999' },
    { tokens: 1000, shown: '1.0k' },
    { tokens: 12_400, shown: '12k' },
    { tokens: 1_500_000, shown: '1.5M' },
  ])('renders $tokens as $shown', ({ tokens, shown }) => {
    expect(formatTokens(tokens)).toBe(shown)
  })
})

describe('totalTokens', () => {
  it('sums every bucket, which are disjoint by contract', () => {
    expect(totalTokens(usage)).toBe(425)
  })

  it('reports nothing before a provider has answered', () => {
    expect(totalTokens(undefined)).toBeUndefined()
  })
})

describe('contextLeftPercent', () => {
  it('measures what the NEXT request would cost', () => {
    // `projectedTokens` wins: it moves when a compaction shadows a span, which
    // the raw sample cannot.
    const context: ContextPressureProjection = { contextWindow: 1000, pressureTokens: 900, projectedTokens: 250 }
    expect(contextLeftPercent(context)).toBe(75)
  })

  it('falls back to the raw sample when nothing is projected yet', () => {
    expect(contextLeftPercent({ contextWindow: 200, pressureTokens: 50 })).toBe(75)
  })

  it.each([
    { label: 'no window', context: { pressureTokens: 10 } },
    { label: 'no usage', context: { contextWindow: 100 } },
    { label: 'a nonsense window', context: { contextWindow: 0, pressureTokens: 10 } },
    { label: 'nothing at all', context: undefined },
  ])('reports nothing given $label', ({ context }) => {
    expect(contextLeftPercent(context)).toBeUndefined()
  })

  it('never reports a negative remainder when the prompt overruns the window', () => {
    expect(contextLeftPercent({ contextWindow: 100, projectedTokens: 400 })).toBe(0)
  })
})

describe('displayPath', () => {
  it('collapses the home directory', () => {
    expect(displayPath('/home/me/work', '/home/me')).toBe('~/work')
    expect(displayPath('/home/me', '/home/me')).toBe('~')
  })

  it('leaves a path outside home alone', () => {
    // A sibling that merely starts with the same characters is not inside it.
    expect(displayPath('/home/melissa/work', '/home/me')).toBe('/home/melissa/work')
    expect(displayPath('/srv/app', '/home/me')).toBe('/srv/app')
  })
})

describe('gitBranch', () => {
  it('reads the checked-out branch from HEAD', async () => {
    const dir = await temp()
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/nested-name\n')
    expect(await gitBranch(dir)).toBe('feature/nested-name')
  })

  it('finds the repository from a subdirectory', async () => {
    const dir = await temp()
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const nested = join(dir, 'a', 'b')
    await mkdir(nested, { recursive: true })
    expect(await gitBranch(nested)).toBe('main')
  })

  it('follows a worktree gitdir pointer', async () => {
    const dir = await temp()
    const real = join(dir, 'real-git')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'HEAD'), 'ref: refs/heads/wt\n')
    const tree = join(dir, 'tree')
    await mkdir(tree, { recursive: true })
    await writeFile(join(tree, '.git'), `gitdir: ${real}\n`)
    expect(await gitBranch(tree)).toBe('wt')
  })

  it('reports no branch on a detached head rather than a bare revision', async () => {
    const dir = await temp()
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, '.git', 'HEAD'), '9fceb02d0ae598e95dc970b74767f19372d61af8\n')
    expect(await gitBranch(dir)).toBeUndefined()
  })

  it('reports no branch outside a repository', async () => {
    expect(await gitBranch(await temp())).toBeUndefined()
  })
})

describe('statusLine', () => {
  it('drops the segments that have nothing to say', () => {
    // A fresh session should read as short, not as broken.
    expect(statusLine(base, theme, 200)).toBe('m · /repo')
  })

  it('reports composition, permissions, location, spend, and headroom', () => {
    const line = statusLine({
      ...base,
      preset: 'code-cli',
      permission: 'workspace-write',
      branch: 'main',
      usage,
      context: { contextWindow: 1000, projectedTokens: 250 },
    }, theme, 200)
    expect(line).toBe('m · code-cli · workspace-write · 425 tokens · 75% context left · /repo (main)')
  })

  it('marks plan mode, which changes what the agent may do', () => {
    expect(statusLine({ ...base, planMode: true }, theme, 200)).toContain('plan')
  })

  it('keeps the full line when no budget is given, so a later paint can re-fit it', () => {
    const path = '/very/long/path/that/keeps/going/on'
    expect(statusLine({ ...base, cwd: path }, theme)).toContain(path)
    expect(statusLine({ ...base, cwd: path }, theme, 20).endsWith('…')).toBe(true)
  })

  it('is cut rather than wrapped when it will not fit', () => {
    // Two rows above every prompt is not a status line any more.
    const line = statusLine({ ...base, cwd: '/very/long/path/that/keeps/going/on' }, theme, 20)
    expect(line.length).toBeLessThanOrEqual(20)
    expect(line.endsWith('…')).toBe(true)
  })

  it('keeps spend and headroom when the cut has to fall somewhere', () => {
    // The workspace is the longest segment and the banner already stated it;
    // context remaining is the figure a person is watching.
    const line = statusLine({
      ...base,
      cwd: '/a/very/long/workspace/path/that/will/not/fit/anywhere',
      usage,
      context: { contextWindow: 1000, projectedTokens: 250 },
    }, theme, 46)
    expect(line).toContain('425 tokens')
    expect(line).toContain('75% context left')
  })
})

describe('status styling', () => {
  const colour = createTheme(true, { TERM: 'xterm-256color' })

  it('keeps the model identity coloured and the routine facts gray', () => {
    const line = statusLine({ ...base, preset: 'code-cli', usage }, colour, 200)
    expect(line).toContain('\u001B[36mm\u001B[0m')
    expect(line).toContain('\u001B[38;5;245mcode-cli\u001B[0m')
  })

  it('escalates the context segment as headroom shrinks', () => {
    const at = (projected: number): string => statusLine({
      ...base,
      context: { contextWindow: 100, projectedTokens: projected },
    }, colour, 200)
    // Routine, then warning, then alarm: the figure a person is watching is the
    // one that changes colour.
    expect(at(50)).toContain('\u001B[38;5;245m50% context left')
    expect(at(80)).toContain('\u001B[33m20% context left')
    expect(at(95)).toContain('\u001B[31m5% context left')
  })
})

describe('statusReport', () => {
  it('names each usage bucket rather than one total', () => {
    const report = statusReport({ ...base, preset: 'code-cli', usage }, 'session-1')
    expect(report).toContain('session      session-1')
    expect(report).toContain('cache read   300')
    expect(report).toContain('total        425')
  })

  it('omits usage rows before a provider has answered', () => {
    expect(statusReport(base, 'session-1')).not.toContain('cache read')
  })

  it('reports occupancy against the window', () => {
    const report = statusReport({ ...base, context: { contextWindow: 1000, projectedTokens: 250 } }, 'session-1')
    expect(report).toContain('next request  250 of 1.0k (75% left)')
  })
})
