/**
 * `/ui compact|comfortable`: parse, persist, thinking preview, and the
 * surfaces that must stay identical across densities.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DENSITY,
  DIFF_SOFT_CAP,
  blockGap,
  densityReport,
  loadDensity,
  parseDensity,
  saveDensity,
  thinkingStreamPreview,
} from '../src/density.ts'
import { GateModal } from '../src/gate-modal.ts'
import { topBar } from '../src/status.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})

describe('parseDensity / densityReport', () => {
  it('defaults to compact', () => {
    expect(DEFAULT_DENSITY).toBe('compact')
  })

  it('accepts the two modes and rejects everything else', () => {
    expect(parseDensity('compact')).toBe('compact')
    expect(parseDensity(' comfortable ')).toBe('comfortable')
    expect(parseDensity('')).toBeUndefined()
    expect(parseDensity('cozy')).toBeUndefined()
  })

  it('reports the live mode as one ui · line', () => {
    expect(densityReport('compact')).toBe('ui · compact')
    expect(densityReport('comfortable')).toBe('ui · comfortable')
  })

  it('raises the expanded-diff pager threshold in comfortable', () => {
    expect(DIFF_SOFT_CAP.compact).toBe(24)
    expect(DIFF_SOFT_CAP.comfortable).toBe(48)
  })

  it('gives the block gap its own value per density, and keeps the two apart', () => {
    expect(blockGap('compact')).toBe(1)
    expect(blockGap('comfortable')).toBe(2)
    expect(blockGap('compact')).not.toBe(blockGap('comfortable'))
  })
})

describe('thinkingStreamPreview', () => {
  const fallback = '✻ thinking'

  it('keeps three live rows in compact', () => {
    expect(thinkingStreamPreview('compact', ['a', 'b'], 'c', fallback)).toEqual(['a', 'b', 'c'])
    expect(thinkingStreamPreview('compact', ['a', 'b', 'c', 'd'], 'e', fallback)).toEqual(['c', 'd', 'e'])
    expect(thinkingStreamPreview('compact', ['a', 'b'], undefined, fallback)).toEqual(['a', 'b'])
    expect(thinkingStreamPreview('compact', [], undefined, fallback)).toBe(fallback)
  })

  it('shows six live rows in comfortable', () => {
    expect(thinkingStreamPreview('comfortable', ['a', 'b', 'c', 'd', 'e'], 'f', fallback))
      .toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(thinkingStreamPreview('comfortable', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'h', fallback))
      .toEqual(['c', 'd', 'e', 'f', 'g', 'h'])
  })

  it('keeps the two density budgets distinct', () => {
    const finished = ['1', '2', '3', '4', '5', '6', '7']
    const compact = thinkingStreamPreview('compact', finished, undefined, fallback)
    const comfortable = thinkingStreamPreview('comfortable', finished, undefined, fallback)
    expect(compact).toHaveLength(3)
    expect(comfortable).toHaveLength(6)
    expect(compact).not.toEqual(comfortable)
  })

  it('never exceeds its budget when more lines arrive than it can hold', () => {
    for (const density of ['compact', 'comfortable'] as const) {
      const rows = thinkingStreamPreview(density, Array.from({ length: 40 }, (_, i) => `line ${i}`), 'live', fallback)
      expect(Array.isArray(rows) ? rows.length : 1).toBeLessThanOrEqual(density === 'compact' ? 3 : 6)
    }
  })
})

describe('loadDensity / saveDensity', () => {
  it('round-trips a prefs file and ignores junk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codsh-ui-'))
    const path = join(dir, 'code-cli-ui.json')
    expect(await loadDensity(path)).toBeUndefined()
    await saveDensity(path, 'comfortable')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ density: 'comfortable' })
    expect(await loadDensity(path)).toBe('comfortable')
    await writeFile(path, '{"density":"nope"}\n')
    expect(await loadDensity(path)).toBeUndefined()
    await writeFile(path, 'not json')
    expect(await loadDensity(path)).toBeUndefined()
  })
})

describe('GateModal and MetaBar ignore density', () => {
  it('frames the same GateModal either way — the modal takes no density', () => {
    const spec = {
      kind: 'spec' as const,
      title: 'ship · gate 1/2 — confirm spec',
      bodyLines: ['body'],
      recommended: 'confirm' as const,
    }
    const a = new GateModal(spec).frame(theme, 72, 16).rows
    const b = new GateModal(spec).frame(theme, 72, 16).rows
    expect(a).toEqual(b)
    expect(a.join('\n')).toContain('gate 1/2')
    expect(a.join('\n')).toContain('[y] confirm')
  })

  it('paints the same MetaBar top bar either way', () => {
    const facts = { model: 'm', planMode: false, cwd: '/repo', branch: 'main' }
    expect(topBar(facts, theme, 200)).toBe('main · /repo')
    expect(topBar({ ...facts, shipGate: 1 as const }, theme, 200)).toBe('ship · gate1 · main · /repo')
  })
})
