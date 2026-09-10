/**
 * The status readout: how figures are abbreviated, how occupancy is derived,
 * and how the branch is found without shelling out to git.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePlan, parseShipStatus } from '../src/plan.ts'
import {
  contextLeftPercent,
  displayPath,
  formatElapsed,
  formatSessionTime,
  formatTokens,
  formatTurnTime,
  gitBranch,
  landChip,
  paintShipChip,
  sessionHistoryTiming,
  sameShipChip,
  shipChipFromSpec,
  shipChipLabel,
  statusLine,
  statusReport,
  topBar,
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

  it('totals many thinking segments rather than listing them', () => {
    // Each block already prints its own clock where it happened. A turn that
    // thinks before every tool call would otherwise end on a line of
    // durations longer than the answer it is summarizing.
    expect(formatTurnTime(15_000, [2100, 4300])).toBe('15s (thought 6.4s)')
    expect(formatTurnTime(622_000, [900, 4200, 100, 1100, 100, 10_000, 0, 6000, 3800, 6100, 100, 5100, 2100, 0, 1100, 0, 1700]))
      .toBe('10m 22s (thought 42s)')
  })

  it('formats long thinking durations with appropriate units', () => {
    expect(formatTurnTime(120_000, [65_000])).toBe('2m 00s (thought 1m 05s)')
  })

  it('appends cumulative session duration when multiple turns ran', () => {
    expect(formatTurnTime(15_000, [4200], 270_000)).toBe('15s (thought 4.2s) · session 4m 30s')
    expect(formatTurnTime(15_000, [], 270_000)).toBe('15s · session 4m 30s')
  })
})

describe('sessionHistoryTiming', () => {
  it('returns zeroes for empty session events', () => {
    expect(sessionHistoryTiming([])).toEqual({ activeMs: 0, turnCount: 0, firstEventTime: undefined })
  })

  it('folds completed turns and calculates total active duration', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 1, time: 10_000, data: { turn: 1 } } as SessionEvent,
      { type: 'turn/end', seq: 2, time: 25_000, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
      { type: 'turn/start', seq: 3, time: 40_000, data: { turn: 2 } } as SessionEvent,
      { type: 'turn/end', seq: 4, time: 70_000, data: { turn: 2, reason: { kind: 'completed' } } } as SessionEvent,
    ]
    const timing = sessionHistoryTiming(events)
    expect(timing.turnCount).toBe(2)
    // 15s + 30s = 45s = 45_000ms
    expect(timing.activeMs).toBe(45_000)
    expect(timing.firstEventTime).toBe(10_000)
  })
})

describe('formatSessionTime', () => {
  it('formats single continuous session duration', () => {
    expect(formatSessionTime(180_000, 180_000)).toBe('3m 00s')
  })

  it('formats wall-clock and active time when there is an idle gap', () => {
    expect(formatSessionTime(1_500_000, 180_000)).toBe('25m 00s (active 3m 00s)')
  })

  it('falls back to wall-clock when there is no active time yet', () => {
    expect(formatSessionTime(60_000, 0)).toBe('1m 00s')
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

describe('topBar', () => {
  it('packs the branch and directory left and context pressure right', () => {
    const line = topBar({
      ...base,
      branch: 'main',
      cwd: '/repo',
      context: { contextWindow: 100, projectedTokens: 50 },
    }, theme, 40)
    expect(line).toBe(`main · /repo${' '.repeat(20)}50% left`)
  })

  it('keeps the branch readable when the directory path overflows', () => {
    const line = topBar({
      ...base,
      branch: 'feature/x',
      cwd: '/a/very/long/workspace/path/that/will/not/fit',
      context: { contextWindow: 100, projectedTokens: 50 },
    }, theme, 30)
    expect(line).toContain('feature/x')
    expect(line).toContain('50% left')
    expect(line).not.toContain('/a/very')
  })

  it('carries the plan and ship chips on the left', () => {
    const line = topBar({ ...base, planMode: true, shipGate: 1, branch: 'main', cwd: '/repo' }, theme, 60)
    expect(line).toContain('plan')
    expect(line).toContain('ship · gate1')
    expect(line).toContain('main')
    expect(line).toContain('/repo')
  })

  it('keeps context pressure when the left group cannot fit', () => {
    const line = topBar({
      ...base,
      planMode: true,
      branch: 'main',
      cwd: '/a/very/long/workspace/path',
      context: { contextWindow: 100, projectedTokens: 50 },
    }, theme, 16)
    expect(line).toContain('50% left')
    expect(line).toContain('main')
  })

  it('prepends the ship gate chip ahead of plan mode', () => {
    expect(topBar({ ...base, planMode: true, shipGate: 1 }, theme, 200)).toBe('ship · gate1 · plan · /repo')
    expect(topBar({ ...base, shipGate: 2 }, theme, 200)).toBe('ship · gate2 · /repo')
  })

  it('paints ship · land k/n with spaces around the middot', () => {
    expect(topBar({ ...base, shipChip: { kind: 'land', k: 2, n: 3 } }, theme, 200)).toBe('ship · land 2/3 · /repo')
  })

  it('paints grill, spec, tickets, verify, and done chips', () => {
    expect(topBar({ ...base, shipChip: { kind: 'grill' } }, theme, 200)).toBe('ship · grill · /repo')
    expect(topBar({ ...base, shipChip: { kind: 'spec' } }, theme, 200)).toBe('ship · spec · /repo')
    expect(topBar({ ...base, shipChip: { kind: 'tickets' } }, theme, 200)).toBe('ship · tickets · /repo')
    expect(topBar({ ...base, shipChip: { kind: 'verify' } }, theme, 200)).toBe('ship · verify · /repo')
    expect(topBar({ ...base, shipChip: { kind: 'done' } }, theme, 200)).toBe('ship · done · /repo')
  })

  it('treats a bare shipGate as a gate chip when shipChip is omitted', () => {
    expect(shipChipLabel({ kind: 'gate', gate: 1 })).toBe('ship · gate1')
    expect(topBar({ ...base, shipGate: 1 }, theme, 200)).toBe('ship · gate1 · /repo')
  })

  it('lets shipChip win over a leftover shipGate', () => {
    expect(topBar({
      ...base,
      shipGate: 1,
      shipChip: { kind: 'land', k: 1, n: 2 },
    }, theme, 200)).toBe('ship · land 1/2 · /repo')
  })

  it('is cut rather than wrapped when even the branch will not fit', () => {
    const line = topBar({ ...base, branch: 'feature/very-long', cwd: '/a/very/long/path' }, theme, 8)
    expect(line.length).toBeLessThanOrEqual(8)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('statusLine', () => {
  it('carries the shortcuts entry and the reasoning level, and nothing about where I am', () => {
    const line = statusLine({
      ...base,
      model: 'deepseek-chat',
      branch: 'main',
      shortcuts: true,
      reasoningEffort: 'high',
      reasoningSupported: true,
    }, theme, 200)
    expect(line).toBe('reasoning high · ? shortcuts')
    expect(line).not.toContain('deepseek')
    expect(line).not.toContain('main')
    expect(line).not.toContain('/repo')
  })

  it('drops the segments that have nothing to say', () => {
    // A fresh session with nothing to report reads as no foot at all.
    expect(statusLine(base, theme, 200)).toBe('')
  })

  it('shows the reasoning level only when the model supports one', () => {
    expect(statusLine({ ...base, reasoningEffort: 'high', reasoningSupported: false }, theme, 200)).toBe('')
    expect(statusLine({ ...base, reasoningSupported: true }, theme, 200)).toBe('')
    expect(statusLine({ ...base, reasoningEffort: 'high' }, theme, 200)).toBe('')
    expect(statusLine({ ...base, reasoningEffort: 'high', reasoningSupported: true }, theme, 200)).toBe('reasoning high')
  })

  it('keeps the full line when no budget is given, so a later paint can re-fit it', () => {
    expect(statusLine({ ...base, shortcuts: true, reasoningEffort: 'high', reasoningSupported: true }, theme))
      .toBe('reasoning high · ? shortcuts')
  })

  it('drops shortcuts before the reasoning level when the budget is tight', () => {
    const line = statusLine({ ...base, shortcuts: true, reasoningEffort: 'high', reasoningSupported: true }, theme, 14)
    expect(line).not.toContain('shortcuts')
    expect(line).toContain('reasoning high')
  })

  it('is cut rather than wrapped when even the kept segment will not fit', () => {
    const line = statusLine({ ...base, reasoningEffort: 'high', reasoningSupported: true }, theme, 6)
    expect(line.length).toBeLessThanOrEqual(6)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('topBar styling', () => {
  const colour = createTheme(true, {})

  it('styles the ship gate chip warn', () => {
    const line = topBar({ ...base, shipGate: 1 }, colour, 200)
    expect(line).toContain('\u001B[93mship · gate1\u001B[0m')
  })

  it('styles the landing chip agent, and ok while a ticket flash is on', () => {
    const land = topBar({ ...base, shipChip: { kind: 'land', k: 2, n: 3 } }, colour, 200)
    expect(land).toContain('\u001B[35mship · land 2/3\u001B[0m')
    const flash = topBar({ ...base, shipChip: { kind: 'land', k: 2, n: 3, flashOk: true } }, colour, 200)
    expect(flash).toContain('\u001B[32mship · land 2/3\u001B[0m')
  })

  it('styles grill, spec, and tickets muted, verify muted, and done ok', () => {
    expect(topBar({ ...base, shipChip: { kind: 'grill' } }, colour, 200)).toContain('\u001B[90mship · grill\u001B[0m')
    expect(topBar({ ...base, shipChip: { kind: 'spec' } }, colour, 200)).toContain('\u001B[90mship · spec\u001B[0m')
    expect(topBar({ ...base, shipChip: { kind: 'tickets' } }, colour, 200)).toContain('\u001B[90mship · tickets\u001B[0m')
    expect(topBar({ ...base, shipChip: { kind: 'verify' } }, colour, 200)).toContain('\u001B[90mship · verify\u001B[0m')
    expect(topBar({ ...base, shipChip: { kind: 'done' } }, colour, 200)).toContain('\u001B[32mship · done\u001B[0m')
  })

  it('keeps ship chips readable under NO_COLOR', () => {
    const plain = createTheme(true, { NO_COLOR: '1' })
    expect(topBar({ ...base, shipChip: { kind: 'land', k: 2, n: 3 } }, plain, 200)).toBe('ship · land 2/3 · /repo')
    expect(topBar({ ...base, shipChip: { kind: 'grill' } }, plain, 200)).toContain('ship · grill')
    expect(topBar({ ...base, shipChip: { kind: 'spec' } }, plain, 200)).toContain('ship · spec')
    expect(topBar({ ...base, shipChip: { kind: 'tickets' } }, plain, 200)).toContain('ship · tickets')
    expect(topBar({ ...base, shipChip: { kind: 'verify' } }, plain, 200)).toContain('ship · verify')
    expect(topBar({ ...base, shipChip: { kind: 'done' } }, plain, 200)).toContain('ship · done')
    expect(paintShipChip({ kind: 'land', k: 1, n: 4 }, plain)).toBe('ship · land 1/4')
  })

  it('styles the branch and directory muted, never cyan/accent', () => {
    const line = topBar({ ...base, branch: 'main', preset: 'code-cli', usage }, colour, 200)
    expect(line).toContain('\u001B[90mmain\u001B[0m')
    expect(line).not.toContain('\u001B[36m')
  })

  it('paints context pressure muted routinely, and escalates as it falls', () => {
    const at = (projected: number): string => topBar({
      ...base,
      context: { contextWindow: 100, projectedTokens: projected },
    }, colour, 200)
    expect(at(50)).toContain('\u001B[90m50% left\u001B[0m')
    expect(at(80)).toContain('\u001B[93m20% left\u001B[0m')
    expect(at(95)).toContain('\u001B[31m5% left\u001B[0m')
  })
})

describe('ship chip helpers', () => {
  it('counts land k as done+1 while a ticket is current', () => {
    const plan = parsePlan('## Plan\n\n- [x] a\n- [ ] b\n- [ ] c\n')
    expect(landChip(plan)).toEqual({ kind: 'land', k: 2, n: 3 })
    expect(landChip(plan, true)).toEqual({ kind: 'land', k: 2, n: 3, flashOk: true })
    expect(landChip(parsePlan('## Plan\n\n- [x] a\n- [x] b\n'))).toBeUndefined()
  })

  it('derives spec / tickets / land / verify / done from Status and the plan', () => {
    const landing = parsePlan('Status: landing\n\n## Plan\n\n- [x] a\n- [ ] b\n- [ ] c\n')
    expect(shipChipFromSpec(undefined, undefined)).toBeUndefined()
    expect(shipChipFromSpec('interviewing', undefined)).toEqual({ kind: 'spec' })
    expect(shipChipFromSpec('confirmed', undefined)).toEqual({ kind: 'tickets' })
    expect(shipChipFromSpec('planned', landing)).toEqual({ kind: 'land', k: 2, n: 3 })
    expect(shipChipFromSpec('landing', landing)).toEqual({ kind: 'land', k: 2, n: 3 })
    expect(shipChipFromSpec('landing', parsePlan('## Plan\n\n- [x] a\n- [x] b\n'))).toEqual({ kind: 'verify' })
    expect(shipChipFromSpec('shipped', landing)).toEqual({ kind: 'done' })
    expect(parseShipStatus('# Spec\n\nStatus: landing\n')).toBe('landing')
  })

  it('treats two chips as the same when they would paint the same label', () => {
    expect(sameShipChip({ kind: 'grill' }, { kind: 'grill' })).toBe(true)
    expect(sameShipChip({ kind: 'spec' }, { kind: 'grill' })).toBe(false)
    expect(sameShipChip({ kind: 'land', k: 2, n: 3 }, { kind: 'land', k: 2, n: 3 })).toBe(true)
    expect(sameShipChip({ kind: 'land', k: 2, n: 3 }, { kind: 'land', k: 3, n: 3 })).toBe(false)
    expect(sameShipChip({ kind: 'land', k: 2, n: 3, flashOk: true }, { kind: 'land', k: 2, n: 3 })).toBe(false)
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

  it('includes thinking row with active level and available choices when supported', () => {
    const report = statusReport({
      ...base,
      reasoningEffort: 'high',
      reasoningSupported: true,
      reasoningChoices: ['off', 'low', 'high', 'max'],
    }, 'session-1')
    expect(report).toContain('thinking   high (available: off, low, high, max)')
  })

  it('includes thinking row with level only when choices are absent', () => {
    const report = statusReport({
      ...base,
      reasoningEffort: 'low',
      reasoningSupported: true,
    }, 'session-1')
    expect(report).toContain('thinking   low')
  })

  it('reports thinking as not supported when unsupported or absent', () => {
    expect(statusReport({ ...base, reasoningSupported: false }, 'session-1')).toContain('thinking   not supported')
    expect(statusReport(base, 'session-1')).toContain('thinking   not supported')
  })

  it('includes session time row when provided', () => {
    const report = statusReport({ ...base, sessionTime: '25m (active 3m 40s)' }, 'session-1')
    expect(report).toContain('time       25m (active 3m 40s)')
  })
})
