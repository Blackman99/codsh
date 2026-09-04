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
  IDLE_TIP,
  densityReport,
  loadDensity,
  parseDensity,
  saveDensity,
  thinkingStreamPreview,
} from '../src/density.ts'
import { GateModal } from '../src/gate-modal.ts'
import { statusLine } from '../src/status.ts'
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
})

describe('thinkingStreamPreview', () => {
  const fallback = '✻ thinking'

  it('keeps one live line in compact', () => {
    expect(thinkingStreamPreview('compact', ['done'], 'live', fallback)).toBe('live')
    expect(thinkingStreamPreview('compact', ['done'], undefined, fallback)).toBe('done')
    expect(thinkingStreamPreview('compact', [], undefined, fallback)).toBe(fallback)
  })

  it('shows the last finished line plus the live one in comfortable', () => {
    expect(thinkingStreamPreview('comfortable', ['a', 'b'], 'c', fallback)).toEqual(['b', 'c'])
    expect(thinkingStreamPreview('comfortable', ['a', 'b'], undefined, fallback)).toEqual(['a', 'b'])
    expect(thinkingStreamPreview('comfortable', [], 'only', fallback)).toBe('only')
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

  it('paints the same MetaBar status line either way', () => {
    const facts = { model: 'm', planMode: false, cwd: '/repo' }
    expect(statusLine(facts, theme, 200)).toBe('m · /repo')
    expect(statusLine({ ...facts, shipGate: 1 as const }, theme, 200)).toBe('ship · gate1 · m · /repo')
  })

  it('keeps the idle tip readable under NO_COLOR', () => {
    const plain = createTheme(true, { NO_COLOR: '1' })
    expect(plain.muted(`  ${IDLE_TIP}`)).toContain('⇧Tab plan')
    expect(plain.muted(`  ${IDLE_TIP}`)).toContain('Ctrl+T todos')
  })
})
