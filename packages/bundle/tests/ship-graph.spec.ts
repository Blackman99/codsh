/**
 * Ship graph rebuild: canonical sources join into an adjacent cache,
 * and the Panorama teaser paints Claim buckets without Occupancy.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  graphPathFor,
  joinShipGraph,
  panoramaTeaser,
  parseShipGraph,
  readShipGraph,
  teaserCounts,
  writeShipGraph,
  type DecisionChild,
  type JoinSources,
  type ShipGraph,
  type ShipGraphJoinError,
} from '../src/ship-graph.ts'
import { createTheme, displayWidth } from '../src/theme.ts'

const theme = createTheme(false, {})

const isJoinError = (value: ShipGraph | ShipGraphJoinError): value is ShipGraphJoinError =>
  'error' in value

const sources = (partial: Partial<JoinSources> & Pick<JoinSources, 'specPath' | 'markdown'>): JoinSources => ({
  mapChildren: [],
  landingScratch: [],
  ...partial,
})

const github = (n: number, title: string, extra: Partial<DecisionChild> = {}): DecisionChild => ({
  id: `decision:github:Blackman99/codsh#${String(n)}`,
  title,
  ...extra,
})

describe('graphPathFor', () => {
  it('derives the sidecar from the spec path, never from markdown', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-graph-'))
    const path = join(cwd, 'docs', 'specs', 'widget.md')
    expect(graphPathFor(path)).toBe(join(cwd, 'docs', 'specs', 'widget.ship.graph.json'))
    expect(graphPathFor(join(cwd, 'docs', 'specs', 'widget.MD'))).toBe(join(cwd, 'docs', 'specs', 'widget.ship.graph.json'))
  })
})

describe('joinShipGraph', () => {
  it('pins native keys, derived Claim, blocked-by and hangs-off', () => {
    const markdown = [
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
    ].join('\n')
    const graph = joinShipGraph(sources({
      specPath: '/repo/docs/specs/widget.md',
      markdown,
      mapChildren: [
        github(107, 'Graph node identity', { closed: true, ticketType: 'grilling' }),
        github(115, 'Ship graph sidecar', {
          assignee: 'Blackman99',
          ticketType: 'grilling',
          blockedBy: ['decision:github:Blackman99/codsh#107'],
          blockedByBody: ['decision:github:Blackman99/codsh#999'],
        }),
      ],
      landingScratch: [
        { n: 1, title: 'scratch title ignored for identity', claim: 'claimed' },
        { n: 2 },
      ],
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.version).toBe(1)
    expect(graph.specPath).toBe('widget.md')
    expect(graph.nodes.map(node => node.id)).toEqual([
      'decision:github:Blackman99/codsh#107',
      'decision:github:Blackman99/codsh#115',
      'track:1',
      'track:2',
      'landing:1',
      'landing:2',
    ])
    expect(graph.nodes.find(node => node.id === 'decision:github:Blackman99/codsh#107')).toEqual({
      id: 'decision:github:Blackman99/codsh#107',
      kind: 'decision',
      title: 'Graph node identity',
      claim: 'closed',
      ticketType: 'grilling',
    })
    expect(graph.nodes.find(node => node.id === 'decision:github:Blackman99/codsh#115')?.claim).toBe('claimed')
    expect(graph.nodes.find(node => node.id === 'landing:1')).toMatchObject({
      kind: 'landing',
      title: 'Graph join',
      claim: 'closed',
    })
    expect(graph.nodes.find(node => node.id === 'landing:2')?.claim).toBe('unclaimed')
    const track = graph.nodes.find(node => node.id === 'track:1')
    expect(track).toEqual({ id: 'track:1', kind: 'track', title: 'Hybrid compass.' })
    expect(track).not.toHaveProperty('claim')
    expect(graph.edges).toEqual([
      {
        from: 'decision:github:Blackman99/codsh#115',
        to: 'decision:github:Blackman99/codsh#107',
        kind: 'blocked-by',
      },
      { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:1', to: 'track:1', kind: 'hangs-off' },
      { from: 'landing:2', to: 'track:1', kind: 'hangs-off' },
      { from: 'landing:2', to: 'track:2', kind: 'hangs-off' },
    ])
  })

  it('lets GitHub blocked_by win over body Blocked by and does not union', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: 'Status: grilling\n',
      mapChildren: [
        github(107, 'Identity', { closed: true }),
        github(111, 'Claim'),
        github(115, 'Sidecar', {
          blockedBy: ['decision:github:Blackman99/codsh#107'],
          blockedByBody: ['decision:github:Blackman99/codsh#111'],
        }),
      ],
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.edges).toEqual([
      {
        from: 'decision:github:Blackman99/codsh#115',
        to: 'decision:github:Blackman99/codsh#107',
        kind: 'blocked-by',
      },
    ])
  })

  it('falls back to body Blocked by only when native blocked_by is absent', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: 'Status: grilling\n',
      mapChildren: [
        github(107, 'Identity', { closed: true }),
        github(115, 'Sidecar', { blockedByBody: ['decision:github:Blackman99/codsh#107'] }),
      ],
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.edges).toEqual([
      {
        from: 'decision:github:Blackman99/codsh#115',
        to: 'decision:github:Blackman99/codsh#107',
        kind: 'blocked-by',
      },
    ])
  })

  it('treats native blocked_by none as empty, not a body union', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: 'Status: grilling\n',
      mapChildren: [
        github(107, 'Identity', { closed: true }),
        github(115, 'Sidecar', {
          blockedBy: [],
          blockedByBody: ['decision:github:Blackman99/codsh#107'],
        }),
      ],
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.edges).toEqual([])
  })

  it('mints local decision keys from the integer filename prefix', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: 'Status: grilling\n',
      mapChildren: [
        {
          id: 'decision:local:1',
          title: 'Local grilling',
          claimed: true,
          ticketType: 'grilling',
          blockedByBody: ['2'],
        },
        { id: 'decision:local:2', title: 'Earlier', closed: true },
      ],
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.nodes.map(node => node.id)).toEqual(['decision:local:1', 'decision:local:2'])
    expect(graph.nodes[0]).toMatchObject({ claim: 'claimed', ticketType: 'grilling' })
    expect(graph.edges).toEqual([
      { from: 'decision:local:1', to: 'decision:local:2', kind: 'blocked-by' },
    ])
  })

  it('keeps an empty inner ring without a hub node', () => {
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
    if (isJoinError(graph)) return
    expect(graph.nodes.filter(node => node.kind === 'decision')).toEqual([])
    expect(graph.nodes.map(node => node.id)).toEqual(['track:1', 'landing:1'])
  })

  it('omits claim on Track anchors', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: 'Status: confirmed\n\n## Main Track\n\n**Track-3.** Occupancy stays /goal.\n',
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    const track = graph.nodes[0]
    expect(track).toEqual({ id: 'track:3', kind: 'track', title: 'Occupancy stays /goal.' })
    expect('claim' in (track ?? {})).toBe(false)
  })

  it('lets scratch Claim win a rebuild over a drifted GitHub landing assignee', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: '## Plan\n\n- [ ] Ticket 1: Land the teaser\n',
      landingScratch: [{ n: 1 }],
      landingAssignees: { 1: 'drifted-bot' },
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.nodes.find(node => node.id === 'landing:1')?.claim).toBe('unclaimed')

    const claimed = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: '## Plan\n\n- [ ] Ticket 1: Land the teaser\n',
      landingScratch: [{ n: 1, claim: 'claimed' }],
      landingAssignees: {},
    }))
    expect(isJoinError(claimed)).toBe(false)
    if (isJoinError(claimed)) return
    expect(claimed.nodes.find(node => node.id === 'landing:1')?.claim).toBe('claimed')
  })

  it('stops when Ticket N does not match the scratch filename integer', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: '## Plan\n\n- [ ] Ticket 1: Land the teaser\n',
      landingScratch: [{ n: 2, filename: '02-land-the-teaser.md', ticketN: 1 }],
    }))
    expect(isJoinError(graph)).toBe(true)
    if (!isJoinError(graph)) return
    expect(graph.error).toMatch(/Ticket/i)
  })

  it('treats extra scratch without a matching Ticket N as skip, not a stop', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: '## Plan\n\n- [ ] Ticket 1: Land the teaser\n',
      landingScratch: [{ n: 9, filename: '09-orphan.md' }],
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.nodes.map(node => node.id)).toEqual(['landing:1'])
  })

  it('stops on a Plan checkbox that is not Ticket N, or a duplicate N', () => {
    const missing = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: '## Plan\n\n- [ ] Land the teaser\n',
    }))
    expect(isJoinError(missing)).toBe(true)
    if (isJoinError(missing)) expect(missing.error).toMatch(/Ticket N/i)

    const duplicate = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: '## Plan\n\n- [ ] Ticket 1: One\n- [ ] Ticket 1: Two\n',
    }))
    expect(isJoinError(duplicate)).toBe(true)
    if (isJoinError(duplicate)) expect(duplicate.error).toMatch(/duplicate/i)
  })

  it('stops when two scratch files share the same NN', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: '## Plan\n\n- [ ] Ticket 1: One\n',
      landingScratch: [
        { n: 1, filename: '01-one.md' },
        { n: 1, filename: '01-also.md' },
      ],
    }))
    expect(isJoinError(graph)).toBe(true)
    if (isJoinError(graph)) expect(graph.error).toMatch(/scratch/i)
  })

  it('stops when a named Track is absent from the sealed track', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: [
        'Status: confirmed',
        '',
        '## Main Track',
        '',
        '**Track-1.** Hybrid compass.',
        '',
        '## Plan',
        '',
        '- [ ] Ticket 1: Land the teaser (Track: 9)',
      ].join('\n'),
    }))
    expect(isJoinError(graph)).toBe(true)
    if (isJoinError(graph)) expect(graph.error).toMatch(/Track/i)
  })

  it('keeps a landing node when scratch is missing and drops unknown blocked-by ends', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: '## Plan\n\n- [ ] Ticket 1: Land the teaser (Blocked by: 99)\n',
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.nodes).toEqual([
      { id: 'landing:1', kind: 'landing', title: 'Land the teaser', claim: 'unclaimed' },
    ])
    expect(graph.edges).toEqual([])
  })
})

describe('sidecar cache', () => {
  it('discards missing, invalid, and unknown-version sidecars', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-graph-'))
    const spec = join(cwd, 'docs', 'specs', 'widget.md')
    mkdirSync(dirname(spec), { recursive: true })
    expect(readShipGraph(spec)).toBeUndefined()

    writeFileSync(graphPathFor(spec), '{not json')
    const invalid = parseShipGraph(readFileSync(graphPathFor(spec), 'utf8'))
    expect(invalid).toEqual({ discard: true })
    expect(readShipGraph(spec)).toEqual({ discard: true })

    writeFileSync(graphPathFor(spec), `${JSON.stringify({ version: 99, specPath: 'widget.md', nodes: [], edges: [] }, null, 2)}\n`)
    expect(readShipGraph(spec)).toEqual({ discard: true })
  })

  it('round-trips a lean envelope with field order and trailing newline', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-graph-'))
    const spec = join(cwd, 'docs', 'specs', 'widget.md')
    mkdirSync(dirname(spec), { recursive: true })
    const graph: ShipGraph = {
      version: 1,
      specPath: 'widget.md',
      nodes: [
        {
          id: 'decision:github:Blackman99/codsh#107',
          kind: 'decision',
          title: 'Graph node identity across tracker, spec, and cache',
          claim: 'closed',
          ticketType: 'grilling',
        },
      ],
      edges: [
        {
          from: 'decision:github:Blackman99/codsh#115',
          to: 'decision:github:Blackman99/codsh#107',
          kind: 'blocked-by',
        },
      ],
    }
    writeShipGraph(graph, spec)
    const raw = readFileSync(graphPathFor(spec), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual(graph)
    expect(readShipGraph(spec)).toEqual(graph)
  })
})

describe('teaserCounts', () => {
  it('counts ticket nodes only — Track anchors are not buckets', () => {
    const graph: ShipGraph = {
      version: 1,
      specPath: 'widget.md',
      nodes: [
        { id: 'decision:local:1', kind: 'decision', title: 'A', claim: 'unclaimed' },
        { id: 'decision:local:2', kind: 'decision', title: 'B', claim: 'claimed' },
        { id: 'track:1', kind: 'track', title: 'Hybrid' },
        { id: 'landing:1', kind: 'landing', title: 'C', claim: 'closed' },
        { id: 'landing:2', kind: 'landing', title: 'D', claim: 'unclaimed' },
      ],
      edges: [],
    }
    expect(teaserCounts(graph)).toEqual({ unclaimed: 2, claimed: 1, closed: 1 })
    expect(teaserCounts({ version: 1, specPath: 'widget.md', nodes: [], edges: [] }))
      .toEqual({ unclaimed: 0, claimed: 0, closed: 0 })
  })
})

describe('panoramaTeaser', () => {
  const buckets = { unclaimed: 1, claimed: 2, closed: 3 }

  it('paints three buckets at 120 columns and keeps the key hint', () => {
    const row = panoramaTeaser(buckets, theme, 120, 0) ?? ''
    expect(row).toContain('待认领 1')
    expect(row).toContain('已认领 2')
    expect(row).toContain('已关闭 3')
    expect(row).toContain('click or Ctrl+G')
    expect(row).not.toContain('in-flight')
    expect(displayWidth(row)).toBeLessThanOrEqual(120)
  })

  it('drops the key hint first at 80 columns and never a bucket word', () => {
    const row = panoramaTeaser(buckets, theme, 80, 0) ?? ''
    expect(row).toContain('待认领 1')
    expect(row).toContain('已认领 2')
    expect(row).toContain('已关闭 3')
    expect(row).not.toContain('click or Ctrl+G')
    expect(row).not.toContain('in-flight')
    expect(displayWidth(row)).toBeLessThanOrEqual(80)
  })

  it('shows in-flight only when greater than zero', () => {
    const idle = panoramaTeaser(buckets, theme, 120, 0) ?? ''
    const flying = panoramaTeaser(buckets, theme, 120, 2) ?? ''
    expect(idle).not.toContain('in-flight')
    expect(flying).toContain('in-flight 2')
    expect(flying).toContain('待认领 1')
  })

  it('paints zeros for an empty graph', () => {
    const row = panoramaTeaser({ unclaimed: 0, claimed: 0, closed: 0 }, theme, 120) ?? ''
    expect(row).toContain('待认领 0')
    expect(row).toContain('已认领 0')
    expect(row).toContain('已关闭 0')
  })
})
