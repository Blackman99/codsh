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
  formatElapsed,
  formatTokens,
  formatTurnTime,
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

describe('formatElapsed', () => {
  it('keeps a decimal while a turn is still quick', () => {
    expect(formatElapsed(0)).toBe('0.0s')
    expect(formatElapsed(1500)).toBe('1.5s')
    expect(formatElapsed(9_949)).toBe('9.9s')
  })

  it('drops it once the decimal is noise', () => {
    expect(formatElapsed(10_000)).toBe('10s')
    expect(formatElapsed(59_400)).toBe('59s')
  })

  it('grows a unit instead of counting seconds forever', () => {
    // The report that started this: `5845s` on a long ralph run.
    expect(formatElapsed(60_000)).toBe('1m 00s')
    expect(formatElapsed(62_000)).toBe('1m 02s')
    expect(formatElapsed(3_599_000)).toBe('59m 59s')
    expect(formatElapsed(3_600_000)).toBe('1h 00m')
    expect(formatElapsed(5_845_000)).toBe('1h 37m')
    expect(formatElapsed(86_400_000)).toBe('24h 00m')
  })

  it('pads the smaller unit, so the figure does not jump width', () => {
    expect(formatElapsed(65_000)).toBe('1m 05s')
    expect(formatElapsed(3_902_000)).toBe('1h 05m')
  })

  it('never shows a negative clock', () => {
    expect(formatElapsed(-1)).toBe('0.0s')
  })
})

describe('formatTurnTime', () => {
  it('returns plain elapsed time when there are no thinking segments', () => {
    expect(formatTurnTime(1500)).toBe('1.5s')
    expect(formatTurnTime(1500, [])).toBe('1.5s')
  })

  it('includes a single thinking segment in parentheses', () => {
    expect(formatTurnTime(12_300, [3200])).toBe('12s (thought 3.2s)')
  })

  it('includes multiple thinking segments separated by commas', () => {
    expect(formatTurnTime(15_000, [2100, 4300])).toBe('15s (thought 2.1s, 4.3s)')
  })

  it('formats long thinking durations with appropriate units', () => {
    expect(formatTurnTime(120_000, [65_000])).toBe('2m 00s (thought 1m 05s)')
  })
})

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

  it('keeps extras out of the glance line — preset, permission, tokens, routine context', () => {
    const line = statusLine({
      ...base,
      preset: 'code-cli',
      permission: 'workspace-write',
      branch: 'main',
      usage,
      context: { contextWindow: 1000, projectedTokens: 250 },
    }, theme, 200)
    expect(line).toBe('m · /repo (main)')
  })

  it('marks plan mode ahead of model and cwd', () => {
    expect(statusLine({ ...base, planMode: true }, theme, 200)).toBe('plan · m · /repo')
  })

  it('prepends the ship gate chip ahead of plan mode', () => {
    expect(statusLine({ ...base, planMode: true, shipGate: 1 }, theme, 200)).toBe('ship · gate1 · plan · m · /repo')
    expect(statusLine({ ...base, shipGate: 2 }, theme, 200)).toBe('ship · gate2 · m · /repo')
  })

  it('keeps the full line when no budget is given, so a later paint can re-fit it', () => {
    const path = '/very/long/path/that/keeps/going/on'
    expect(statusLine({ ...base, cwd: path }, theme)).toContain(path)
  })

  it('drops cwd before model when the budget is tight', () => {
    const line = statusLine({
      ...base,
      planMode: true,
      cwd: '/a/very/long/workspace/path/that/will/not/fit',
      context: { contextWindow: 100, projectedTokens: 80 },
    }, theme, 18)
    expect(line).not.toContain('/a/very')
    expect(line).toContain('plan')
    expect(line).toContain('20%')
  })

  it('keeps shipGate like mode — drops cwd then model before the chip', () => {
    const line = statusLine({
      ...base,
      shipGate: 1,
      planMode: true,
      cwd: '/a/very/long/workspace/path/that/will/not/fit',
      context: { contextWindow: 100, projectedTokens: 80 },
    }, theme, 28)
    expect(line).not.toContain('/a/very')
    expect(line).toContain('ship · gate1')
    expect(line).toContain('plan')
    expect(line).toContain('20%')
  })

  it('is cut rather than wrapped when even the kept segments will not fit', () => {
    const line = statusLine({ ...base, cwd: '/very/long/path/that/keeps/going/on' }, theme, 8)
    expect(line.length).toBeLessThanOrEqual(8)
    expect(line.endsWith('…') || line === 'm').toBe(true)
  })
})

describe('status styling', () => {
  const colour = createTheme(true, {})

  it('styles the ship gate chip warn', () => {
    const line = statusLine({ ...base, shipGate: 1 }, colour, 200)
    expect(line).toContain('\u001B[93mship · gate1\u001B[0m')
  })

  it('styles the model muted, never cyan/accent', () => {
    const line = statusLine({ ...base, preset: 'code-cli', usage }, colour, 200)
    expect(line).toContain('\u001B[90mm\u001B[0m')
    expect(line).not.toContain('\u001B[36m')
  })

  it('escalates alarming context only; routine headroom stays off the glance', () => {
    const at = (projected: number): string => statusLine({
      ...base,
      context: { contextWindow: 100, projectedTokens: projected },
    }, colour, 200)
    expect(at(50)).not.toContain('50%')
    expect(at(80)).toContain('\u001B[93m20%\u001B[0m')
    expect(at(95)).toContain('\u001B[31m5%\u001B[0m')
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
