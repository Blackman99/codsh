/**
 * Panorama overlay paint: inner then outer, bucket on the row, Track-N
 * suffix, wrap Blocked by, empty overlay kept. Teaser paint stays in
 * ship-graph.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { joinShipGraph, type JoinSources, type ShipGraph, type ShipGraphJoinError } from '../src/ship-graph.ts'
import { EMPTY_INNER_RING, PanoramaOverlay, panoramaOverlayLines } from '../src/ship-panorama.ts'
import { createTheme, displayWidth } from '../src/theme.ts'

const theme = createTheme(false, {})

const isJoinError = (value: ShipGraph | ShipGraphJoinError): value is ShipGraphJoinError =>
  'error' in value

const sources = (partial: Partial<JoinSources> & Pick<JoinSources, 'specPath' | 'markdown'>): JoinSources => ({
  mapChildren: [],
  landingScratch: [],
  ...partial,
})

function mixedGraph(): ShipGraph {
  const graph = joinShipGraph(sources({
    specPath: 'widget.md',
    markdown: [
      'Status: landing',
      '',
      '## Main Track',
      '',
      '**Idea.** One canvas.',
      '**Track-1.** Hybrid compass.',
      '**Track-2.** Parent wakes only to ask.',
      '',
      '## Plan',
      '',
      '- [x] Ticket 1: Graph join (Blocked by: none) (Track: 1)',
      '- [ ] Ticket 2: Teaser paint (Blocked by: 1) (Track: 1, 2)',
    ].join('\n'),
    mapChildren: [
      {
        id: 'decision:github:Blackman99/codsh#107',
        title: 'Graph node identity across tracker, spec, and cache',
        closed: true,
        ticketType: 'grilling',
      },
      {
        id: 'decision:github:Blackman99/codsh#115',
        title: 'Ship graph sidecar fields and rebuild join',
        assignee: 'Blackman99',
        ticketType: 'grilling',
        blockedBy: ['decision:github:Blackman99/codsh#107'],
      },
    ],
    landingScratch: [{ n: 1, claim: 'claimed' }, { n: 2 }],
  }))
  expect(isJoinError(graph)).toBe(false)
  if (isJoinError(graph)) throw new Error(graph.error)
  return graph
}

function emptyInnerGraph(): ShipGraph {
  const graph = joinShipGraph(sources({
    specPath: 'widget.md',
    markdown: [
      'Status: confirmed',
      '',
      '## Main Track',
      '',
      '**Idea.** No-map.',
      '**Track-1.** Empty inner ring.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Land the teaser (Track: 1)',
    ].join('\n'),
    mapChildren: [],
  }))
  expect(isJoinError(graph)).toBe(false)
  if (isJoinError(graph)) throw new Error(graph.error)
  return graph
}

function assertFits(lines: readonly string[], columns: number): void {
  for (const line of lines) {
    expect(displayWidth(line), line).toBeLessThanOrEqual(columns)
  }
}

describe('panoramaOverlayLines', () => {
  it.each([120, 80] as const)('paints mixed inner then outer at %i columns', (columns) => {
    const lines = panoramaOverlayLines(mixedGraph(), theme, columns)
    assertFits(lines, columns)
    const text = lines.join('\n')
    expect(text).toContain('已关闭 Graph node identity across tracker, spec, and cache')
    expect(text).toContain('已认领 Ship graph sidecar fields and rebuild join')
    expect(text).toContain('已关闭 Graph join')
    expect(text).toContain('待认领 Teaser paint')
    const inner = text.indexOf('Graph node identity')
    const outer = text.indexOf('Teaser paint')
    expect(inner).toBeGreaterThanOrEqual(0)
    expect(outer).toBeGreaterThan(inner)
    expect(text).toContain('Teaser paint · Track-1 Track-2')
    expect(text).toContain('Graph join · Track-1')
    expect(text).not.toMatch(/^Track-\d+/m)
    expect(text).not.toContain('hub')
    expect(text).not.toContain('in-flight')
    expect(text).not.toContain('decision:github')
    expect(text).not.toContain('landing:1')
  })

  it.each([120, 80] as const)('puts Blocked by on the next row with ticket names at %i columns', (columns) => {
    const lines = panoramaOverlayLines(mixedGraph(), theme, columns)
    const sidecar = lines.findIndex(line => line.includes('Ship graph sidecar'))
    const blocked = lines.findIndex((line, index) => index > sidecar && line.includes('Blocked by:'))
    expect(sidecar).toBeGreaterThanOrEqual(0)
    expect(blocked).toBeGreaterThan(sidecar)
    expect(lines[blocked]).toContain('Blocked by:')
    expect(lines[blocked]).not.toContain('Ship graph sidecar')
    expect(lines.join('\n')).toContain('Blocked by: Graph node identity across tracker, spec, and cache')
    expect(lines.join('\n')).toContain('Blocked by: Graph join')
    expect(lines.some(line => line.includes('…'))).toBe(false)
  })

  it.each([120, 80] as const)('keeps an empty inner ring overlay with a body line at %i columns', (columns) => {
    const graph = emptyInnerGraph()
    const lines = panoramaOverlayLines(graph, theme, columns)
    assertFits(lines, columns)
    expect(lines.some(line => line.includes(EMPTY_INNER_RING))).toBe(true)
    expect(lines.join('\n')).toContain('待认领 Land the teaser')
    expect(lines.join('\n')).toContain('Land the teaser · Track-1')
    expect(lines.join('\n')).not.toContain('hub')
    expect(lines.filter(line => line.includes(EMPTY_INNER_RING))).toHaveLength(1)

    const none = panoramaOverlayLines({ version: 1, specPath: 'widget.md', nodes: [], edges: [] }, theme, columns)
    expect(none.some(line => line.includes(EMPTY_INNER_RING))).toBe(true)
    expect(none.join('\n')).not.toContain('待认领')
    expect(none.join('\n')).not.toContain('hub')
  })

  it('wraps a long ticket name at 80 columns instead of ellipsizing it', () => {
    const graph: ShipGraph = {
      version: 1,
      specPath: 'widget.md',
      nodes: [{
        id: 'decision:local:1',
        kind: 'decision',
        title: 'A deliberately long grilling ticket name that must remain readable when the overlay is eighty columns wide',
        claim: 'unclaimed',
      }],
      edges: [],
    }
    const lines = panoramaOverlayLines(graph, theme, 80)
    assertFits(lines, 80)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join('')).toContain('A deliberately long grilling ticket name that must remain readable')
    expect(lines.some(line => line.includes('…'))).toBe(false)
    expect(lines[0]).toContain('待认领')
  })
})

describe('PanoramaOverlay', () => {
  it('fills the whole screen like the viewer, not an 8-row window', () => {
    const overlay = new PanoramaOverlay(mixedGraph())
    const wide = overlay.frame(theme, 120, 24)
    expect(wide.rows).toHaveLength(24)
    expect(wide.body).toHaveLength(22)
    expect(wide.rows[0]).toContain('待认领')
    expect(wide.rows[0]).toContain('已认领')
    expect(wide.rows[0]).toContain('已关闭')
    expect(wide.rows.join('\n')).toContain('已认领 Ship graph sidecar')
    expect(wide.rows.join('\n')).toContain('Teaser paint · Track-1 Track-2')
    expect(wide.rows.at(-1)).toContain('Esc teaser')
    assertFits(wide.rows, 120)

    const narrow = overlay.frame(theme, 80, 24)
    expect(narrow.rows).toHaveLength(24)
    expect(narrow.rows.join('\n')).toContain('Blocked by:')
    expect(narrow.rows.join('\n')).not.toContain('in-flight')
    assertFits(narrow.rows, 80)
  })

  it('pins the loopback URL on the overlay title row', () => {
    const overlay = new PanoramaOverlay(mixedGraph())
    const url = 'http://127.0.0.1:49152'
    const frame = overlay.frame(theme, 120, 24, url)
    expect(frame.rows[0]).toContain('待认领')
    expect(frame.rows[0]).toContain(url)
    expect(frame.body.every(row => !row.includes(url))).toBe(true)
    assertFits(frame.rows, 120)
  })

  it('keeps the empty inner-ring body on the fullscreen, not a skip to the teaser', () => {
    const overlay = new PanoramaOverlay(emptyInnerGraph())
    const frame = overlay.frame(theme, 120, 12)
    expect(frame.body.some(row => row.includes(EMPTY_INNER_RING))).toBe(true)
    expect(frame.body.some(row => row.includes('Land the teaser'))).toBe(true)
  })

  it('scrolls the whole screen by line and page', () => {
    const nodes = Array.from({ length: 40 }, (_, index) => ({
      id: `decision:local:${String(index + 1)}`,
      kind: 'decision' as const,
      title: `Ticket ${String(index + 1)}`,
      claim: 'unclaimed' as const,
    }))
    const overlay = new PanoramaOverlay({ version: 1, specPath: 'widget.md', nodes, edges: [] })
    expect(overlay.frame(theme, 40, 6).body[0]).toContain('Ticket 1')
    overlay.move({ kind: 'line', lines: 1 }, theme, 40, 6)
    expect(overlay.frame(theme, 40, 6).body[0]).toContain('Ticket 2')
    overlay.move({ kind: 'end' }, theme, 40, 6)
    expect(overlay.frame(theme, 40, 6).body.at(-1)).toContain('Ticket 40')
    overlay.move({ kind: 'home' }, theme, 40, 6)
    expect(overlay.frame(theme, 40, 6).body[0]).toContain('Ticket 1')
  })
})
