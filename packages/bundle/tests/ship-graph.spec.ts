/**
 * Ship graph rebuild: canonical sources join into an adjacent cache,
 * and the Panorama teaser paints Claim buckets without Occupancy.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectJoinSources,
  essentialBlockedBy,
  graphPathFor,
  isShipGraphJoinError,
  joinShipGraph,
  panoramaTeaser,
  parseShipGraph,
  readShipGraph,
  teaserCounts,
  worktreeDirectory,
  worktreeDirectoryParts,
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

describe('worktreeDirectory', () => {
  it('maps graph keys to Track-10 directory names', () => {
    expect(worktreeDirectory('landing:2')).toBe('landing-2')
    expect(worktreeDirectory('decision:github:Blackman99/codsh#107')).toBe('decision-107')
    expect(worktreeDirectory('decision:local:3')).toBe('decision-3')
    expect(worktreeDirectoryParts('landing-2')).toEqual({ kind: 'landing', n: 2 })
    expect(worktreeDirectoryParts('decision-107')).toEqual({ kind: 'decision', n: 107 })
  })
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
  it.each(['wayfinding', 'grilling', 'interviewing', 'confirmed', 'planned', 'landing', 'shipped'] as const)('retains ledger status %s through graph serialization', status => {
    const graph = joinShipGraph(sources({ specPath: 'widget.md', markdown: `Status: ${status}` }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.status).toBe(status)
    expect(parseShipGraph(JSON.stringify(graph))).toEqual(graph)
  })

  it('accepts legacy graphs without status and drops invalid cached status', () => {
    const graph = { version: 1, specPath: 'widget.md', nodes: [], edges: [] }
    expect(parseShipGraph(JSON.stringify(graph))).toEqual(graph)
    expect(parseShipGraph(JSON.stringify({ ...graph, status: 'unknown' }))).toEqual(graph)
  })

  it('keeps exact originalRequirement and Main Track Idea objective, never a plan-ticket guess', () => {
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: [
        'Status: interviewing',
        '',
        '## Original Requirement',
        '',
        'Build a widget',
        'that works offline.',
        '',
        '## Wayfinder',
        '',
        'Destination: Chart the route.',
        '',
        '## Main Track',
        '',
        '**Idea.** One canvas for the person.',
        '**Track-1.** Hybrid compass.',
        '',
        '## Plan',
        '',
        '- [ ] Ticket 1: Land the teaser (Track: 1)',
      ].join('\n'),
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.originalRequirement).toBe('Build a widget\nthat works offline.')
    expect(graph.objective).toBe('One canvas for the person.')
    expect(graph.nodes.map(node => node.id)).toEqual(['track:1', 'landing:1'])
  })

  it('accepts an old v1 cache without answers and restores answers from join extras', () => {
    const cached = { version: 1, specPath: 'widget.md', nodes: [], edges: [] }
    expect(parseShipGraph(JSON.stringify(cached))).toEqual(cached)
    const graph = joinShipGraph(sources({
      specPath: 'widget.md',
      markdown: 'Status: grilling\n\n## Original Requirement\n\nBuild a widget.\n',
      answers: [{ id: 'q1', phase: 'grill', question: 'Storage?', answer: 'SQLite' }],
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.originalRequirement).toBe('Build a widget.')
    expect(graph.objective).toBe('Build a widget.')
    expect(graph.answers).toEqual([
      { id: 'q1', phase: 'grill', question: 'Storage?', answer: 'SQLite' },
    ])
    expect(graph.nodes).toEqual([])
  })

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

  it('drops a numbered landing chain so siblings of one prerequisite fan out', () => {
    const edges = essentialBlockedBy([
      { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:3', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:3', to: 'landing:2', kind: 'blocked-by' },
      { from: 'landing:4', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:4', to: 'landing:2', kind: 'blocked-by' },
      { from: 'landing:4', to: 'landing:3', kind: 'blocked-by' },
      { from: 'landing:5', to: 'landing:2', kind: 'blocked-by' },
      { from: 'landing:5', to: 'landing:3', kind: 'blocked-by' },
      { from: 'landing:1', to: 'track:1', kind: 'hangs-off' },
    ])
    expect(edges.filter(edge => edge.kind === 'blocked-by')).toEqual([
      { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:3', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:4', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:5', to: 'landing:2', kind: 'blocked-by' },
      { from: 'landing:5', to: 'landing:3', kind: 'blocked-by' },
    ])
    expect(edges).toContainEqual({ from: 'landing:1', to: 'track:1', kind: 'hangs-off' })
    const graph = joinShipGraph(sources({
      specPath: '/repo/docs/specs/honor.md',
      markdown: [
        'Status: landing',
        '',
        '## Main Track',
        '',
        '**Track-1.** Playable FPS.',
        '',
        '## Plan',
        '',
        '- [x] Ticket 1: Engine (Blocked by: none) (Track: 1)',
        '- [ ] Ticket 2: Audio (Blocked by: 1) (Track: 1)',
        '- [ ] Ticket 3: Arsenal (Blocked by: 1, 2) (Track: 1)',
        '- [ ] Ticket 4: AI (Blocked by: 1, 2, 3) (Track: 1)',
        '- [ ] Ticket 5: Mission (Blocked by: 2, 3) (Track: 1)',
      ].join('\n'),
    }))
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.edges.filter(edge => edge.kind === 'blocked-by')).toEqual([
      { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:3', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:4', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:5', to: 'landing:2', kind: 'blocked-by' },
      { from: 'landing:5', to: 'landing:3', kind: 'blocked-by' },
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
    expect(graph.nodes.some(node => node.id === 'hub' || node.title.toLowerCase().includes('hub'))).toBe(false)
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

describe('collectJoinSources', () => {
  const wayfinding = [
    'Status: wayfinding',
    'Branch: ship/widget',
    '',
    '## Wayfinder',
    '',
    '[Map](https://github.com/Blackman99/codsh/issues/106)',
  ].join('\n')

  it('unions local wayfinder tickets with a published map pointer (empty inner ring is not a skipped local ring)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-graph-'))
    const spec = join(cwd, 'docs', 'specs', 'widget.md')
    mkdirSync(dirname(spec), { recursive: true })
    writeFileSync(spec, wayfinding)
    const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '01-repo-facts.md'), [
      '# Repo facts',
      '',
      'Type: research',
      'Status: open',
      '',
    ].join('\n'))
    const collected = collectJoinSources(cwd, spec, wayfinding)
    expect(isShipGraphJoinError(collected)).toBe(false)
    if (isShipGraphJoinError(collected)) return
    expect(collected.mapChildren).toEqual([
      { id: 'decision:local:1', title: 'Repo facts', ticketType: 'research' },
    ])
    const graph = joinShipGraph(collected)
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    expect(graph.nodes.filter(node => node.kind === 'decision')).toEqual([
      {
        id: 'decision:local:1',
        kind: 'decision',
        title: 'Repo facts',
        claim: 'unclaimed',
        ticketType: 'research',
      },
    ])
    expect(graph.nodes.some(node => node.id.includes('#106'))).toBe(false)
  })

  it('reads GitHub decision tickets from the local map, not the map issue itself', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-graph-'))
    const spec = join(cwd, 'docs', 'specs', 'widget.md')
    mkdirSync(dirname(spec), { recursive: true })
    const markdown = [
      'Status: wayfinding',
      'Branch: ship/widget',
      '',
      '## Wayfinder',
      '',
      'Canonical map: [Automatic /ship continuation](https://github.com/Blackman99/codsh/issues/106).',
      '',
      '[Map](../../.scratch/widget/wayfinder/map.md)',
    ].join('\n')
    writeFileSync(spec, markdown)
    const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'map.md'), [
      '# wayfinder:map',
      '',
      'Canonical map: [Automatic /ship continuation](https://github.com/Blackman99/codsh/issues/106).',
      '',
      '- [Graph node identity](https://github.com/Blackman99/codsh/issues/107)',
      '- Blackman99/codsh#115',
    ].join('\n'))
    const collected = collectJoinSources(cwd, spec, markdown)
    expect(isShipGraphJoinError(collected)).toBe(false)
    if (isShipGraphJoinError(collected)) return
    expect(collected.mapChildren?.map(child => child.id)).toEqual([
      'decision:github:Blackman99/codsh#107',
      'decision:github:Blackman99/codsh#115',
    ])
    expect(collected.mapChildren?.some(child => child.id.endsWith('#106'))).toBe(false)
  })

  it('keeps local wayfinder tickets beside GitHub children listed on the named map', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-graph-'))
    const spec = join(cwd, 'docs', 'specs', 'widget.md')
    mkdirSync(dirname(spec), { recursive: true })
    const markdown = [
      'Status: wayfinding',
      'Branch: ship/widget',
      '',
      '## Wayfinder',
      '',
      '[Map](../../.scratch/widget/wayfinder/map.md)',
    ].join('\n')
    writeFileSync(spec, markdown)
    const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'map.md'), [
      '# wayfinder:map',
      '',
      '- [Graph node identity](https://github.com/Blackman99/codsh/issues/107)',
    ].join('\n'))
    writeFileSync(join(dir, '01-repo-facts.md'), '# Repo facts\n\nType: research\nStatus: open\n')
    const collected = collectJoinSources(cwd, spec, markdown)
    expect(isShipGraphJoinError(collected)).toBe(false)
    if (isShipGraphJoinError(collected)) return
    expect(collected.mapChildren?.map(child => child.id)).toEqual([
      'decision:local:1',
      'decision:github:Blackman99/codsh#107',
    ])
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

  it('pins the loopback URL on the teaser and drops the key hint first', () => {
    const url = 'http://127.0.0.1:49152'
    const wide = panoramaTeaser(buckets, theme, 120, 0, url)
    expect(wide).toContain('待认领 1')
    expect(wide).toContain(url)
    expect(wide).toContain('click or Ctrl+G')
    expect(displayWidth(wide)).toBeLessThanOrEqual(120)

    const narrow = panoramaTeaser(buckets, theme, 80, 2, url)
    expect(narrow).toContain('待认领 1')
    expect(narrow).toContain('in-flight 2')
    expect(narrow).toContain(url)
    expect(narrow).not.toContain('click or Ctrl+G')
    expect(displayWidth(narrow)).toBeLessThanOrEqual(80)
  })
})
