/**
 * The `/theme` picker previews each theme as the marker moves — the chrome at
 * once, the history once the marker rests — and Esc puts the original back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SelectOutcome, SelectSpec } from '../src/selector.ts'
import { createTheme } from '../src/theme.ts'
import type { ThemeSetting } from '../src/theme.ts'
import { HistoryRepaint, PREVIEW_REPAINT_MS, SLOW_REPAINT_MS, pickTheme } from '../src/theme-picker.ts'

/** A surface whose history knows which palette it was painted in. */
function surface(options: { busy?: boolean; repaintMs?: number } = {}) {
  const theme = createTheme(true, { TERM: 'xterm-256color' })
  let painted = theme.resolved
  let busy = options.busy ?? false
  const runs: (string | undefined)[] = []
  const history = new HistoryRepaint({
    stale: () => painted !== theme.resolved,
    busy: () => busy,
    run: () => {
      painted = theme.resolved
      runs.push(painted)
      return options.repaintMs ?? 5
    },
  })
  return {
    theme,
    history,
    runs,
    setBusy: (next: boolean) => { busy = next },
    apply: (setting: ThemeSetting) => theme.setTheme(setting),
  }
}

/** A selection that moves the marker through `marks`, then ends with `outcome`. */
function scripted(marks: number[], outcome: SelectOutcome, onSpec?: (spec: SelectSpec) => void) {
  return async (
    spec: SelectSpec,
    _signal: AbortSignal | undefined,
    preview: (index: number) => void,
    settled: (outcome: SelectOutcome) => void,
  ): Promise<SelectOutcome> => {
    onSpec?.(spec)
    for (const index of marks) {
      preview(index)
      await vi.advanceTimersByTimeAsync(PREVIEW_REPAINT_MS + 1)
    }
    settled(outcome)
    return outcome
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('HistoryRepaint', () => {
  it('repaints at once when stale and idle, and not at all when current', () => {
    const s = surface()
    s.history.request()
    expect(s.runs).toEqual([])
    s.apply('deepseek-light')
    s.history.request()
    expect(s.runs).toEqual(['deepseek-light'])
  })

  it('holds a repaint while busy and runs it on flush', () => {
    const s = surface({ busy: true })
    s.apply('terminal')
    s.history.request()
    s.history.flush()
    expect(s.runs).toEqual([])
    s.setBusy(false)
    s.history.flush()
    expect(s.runs).toEqual(['terminal'])
    s.history.flush()
    expect(s.runs).toEqual(['terminal'])
  })

  it('debounces preview repaints to the one the marker rests on', async () => {
    const s = surface()
    s.apply('deepseek-light')
    s.history.soon()
    s.apply('terminal')
    s.history.soon()
    await vi.advanceTimersByTimeAsync(PREVIEW_REPAINT_MS - 1)
    expect(s.runs).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    expect(s.runs).toEqual(['terminal'])
  })

  it('skips preview repaints for a session too slow to repaint per keystroke', async () => {
    const s = surface({ repaintMs: SLOW_REPAINT_MS + 1 })
    s.apply('deepseek-light')
    s.history.request()
    expect(s.runs).toEqual(['deepseek-light'])
    s.apply('terminal')
    s.history.soon()
    await vi.advanceTimersByTimeAsync(PREVIEW_REPAINT_MS * 4)
    expect(s.runs).toEqual(['deepseek-light'])
    // The choice itself still repaints.
    s.history.flush()
    expect(s.runs).toEqual(['deepseek-light', 'terminal'])
  })
})

describe('pickTheme', () => {
  it('lists the catalog with the current theme marked, and previews as the marker moves', async () => {
    const s = surface()
    let offered: SelectSpec | undefined
    const chosen = await pickTheme({
      select: scripted([2, 3], { kind: 'chosen', indices: [3] }, (spec) => { offered = spec }),
      current: () => s.theme.setting,
      apply: s.apply,
      history: s.history,
    })
    expect(offered?.title).toBe('Theme')
    expect(offered?.options.map(option => option.label)).toEqual(['auto', 'deepseek', 'deepseek-light', 'terminal'])
    expect(offered?.options[0]?.detail).toContain('current')
    expect(offered?.prior).toEqual({ selected: 'auto' })
    expect(chosen).toBe('terminal')
    expect(s.theme.setting).toBe('terminal')
    expect(s.runs).toEqual(['deepseek-light', 'terminal'])
  })

  it('puts the original back on Esc, repainting only what the preview changed', async () => {
    const s = surface()
    const chosen = await pickTheme({
      select: scripted([2], { kind: 'cancelled' }),
      current: () => s.theme.setting,
      apply: s.apply,
      history: s.history,
    })
    expect(chosen).toBeUndefined()
    expect(s.theme.setting).toBe('auto')
    expect(s.theme.resolved).toBe('deepseek')
    expect(s.runs).toEqual(['deepseek-light', 'deepseek'])
  })

  it('previews the chrome under a running turn and leaves the history to the turn end', async () => {
    const s = surface({ busy: true })
    const chosen = await pickTheme({
      select: scripted([2], { kind: 'chosen', indices: [2] }),
      current: () => s.theme.setting,
      apply: s.apply,
      history: s.history,
    })
    expect(chosen).toBe('deepseek-light')
    expect(s.runs).toEqual([])
    s.setBusy(false)
    s.history.flush()
    expect(s.runs).toEqual(['deepseek-light'])
  })
})
