/**
 * Loopback Web panorama helper: bind shape, served graph, stub copy.
 * Look is unspecified; do not mock a browser.
 */

import { describe, expect, it } from 'vitest'
import { joinShipGraph, type JoinSources, type ShipGraph, type ShipGraphJoinError } from '../src/ship-graph.ts'
import {
  handleWebPanoramaRequest,
  openWebPanorama,
  WEB_PANORAMA_LISTEN,
  WEB_PANORAMA_TICKET_BRIEF_STUB,
  WEB_PANORAMA_TICKET_EVIDENCE_STUB,
  WEB_PANORAMA_TRACK_STUB,
  webPanoramaHtml,
  webPanoramaLayout,
} from '../src/ship-web.ts'

const isJoinError = (value: ShipGraph | ShipGraphJoinError): value is ShipGraphJoinError =>
  'error' in value

const sources = (partial: Partial<JoinSources> & Pick<JoinSources, 'specPath' | 'markdown'>): JoinSources => ({
  mapChildren: [],
  landingScratch: [],
  ...partial,
})

const response = () => {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' }
  return {
    state,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      state.headers = headers ?? {}
      return this
    },
    end(body?: string) {
      state.body = body ?? ''
    },
  }
}

describe('WEB_PANORAMA_LISTEN', () => {
  it('is loopback on an ephemeral port, never LAN', () => {
    expect(WEB_PANORAMA_LISTEN).toEqual({ host: '127.0.0.1', port: 0 })
  })
})

describe('handleWebPanoramaRequest', () => {
  const graph = joinShipGraph(sources({
    specPath: '/repo/docs/specs/widget.md',
    markdown: [
      'Status: landing',
      '',
      '## Main Track',
      '',
      '**Track-1.** Hybrid compass.',
      '',
      '## Plan',
      '',
      '- [x] Ticket 1: Graph join (Track: 1)',
      '- [ ] Ticket 2: Teaser paint (Blocked by: 1) (Track: 1)',
    ].join('\n'),
    mapChildren: [],
  }))

  it('serves the join envelope on /graph.json — same nodes, edges, Claim', () => {
    expect(isJoinError(graph)).toBe(false)
    if (isJoinError(graph)) return
    const res = response()
    handleWebPanoramaRequest({ url: '/graph.json' }, res, () => graph)
    expect(res.state.status).toBe(200)
    expect(res.state.headers['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(res.state.body)).toEqual(graph)
    expect(graph.nodes.filter(node => node.kind === 'decision')).toEqual([])
    expect(graph.nodes.find(node => node.id === 'track:1')).not.toHaveProperty('claim')
    expect(graph.nodes.some(node => node.id === 'hub')).toBe(false)
    expect(graph.nodes.find(node => node.id === 'landing:1')?.claim).toBe('closed')
    expect(graph.nodes.find(node => node.id === 'landing:2')?.claim).toBe('unclaimed')
  })

  it('serves the node-link page with Track and ticket stubs, no hub', () => {
    const res = response()
    handleWebPanoramaRequest({ url: '/' }, res, () => graph as ShipGraph)
    expect(res.state.status).toBe(200)
    expect(res.state.headers['content-type']).toMatch(/text\/html/)
    expect(res.state.body).toContain(WEB_PANORAMA_TRACK_STUB)
    expect(res.state.body).toContain(WEB_PANORAMA_TICKET_BRIEF_STUB)
    expect(res.state.body).toContain(WEB_PANORAMA_TICKET_EVIDENCE_STUB)
    expect(res.state.body).toContain('empty inner ring')
    expect(res.state.body).not.toMatch(/\bhub\b/i)
    expect(res.state.body).toContain('not time')
  })
})

describe('webPanoramaHtml', () => {
  it('keeps Track-anchor stub copy out of the three Claim buckets', () => {
    const html = webPanoramaHtml()
    expect(html).toContain(WEB_PANORAMA_TRACK_STUB)
    expect(html).toContain('CLAIM = { unclaimed: "待认领", claimed: "已认领", closed: "已关闭" }')
    expect(html).toContain('n.kind === "track"')
  })
})

describe('webPanoramaLayout', () => {
  it('places rings by kind, not as time, priority, or merge order', () => {
    const layout = webPanoramaLayout([
      { id: 'landing:2', kind: 'landing', title: 'later-N', claim: 'unclaimed' },
      { id: 'track:1', kind: 'track', title: 'Hybrid' },
      { id: 'decision:local:1', kind: 'decision', title: 'A', claim: 'claimed' },
      { id: 'landing:1', kind: 'landing', title: 'earlier-N', claim: 'closed' },
    ])
    expect(layout['decision:local:1']?.ring).toBe('inner')
    expect(layout['track:1']?.ring).toBe('track')
    expect(layout['landing:2']?.ring).toBe('outer')
    expect(layout['landing:1']?.ring).toBe('outer')
    expect(layout['hub']).toBeUndefined()
  })
})

describe('openWebPanorama', () => {
  it('opens with the platform command and ignores spawn failures', () => {
    const calls: { file: string; args: readonly string[] }[] = []
    const run = ((file: string, args: readonly string[], _options: unknown, done: (error: Error | null) => void) => {
      calls.push({ file, args })
      done(new Error('not installed'))
    }) as never
    openWebPanorama('http://127.0.0.1:49152', run, 'darwin')
    expect(calls).toEqual([{ file: 'open', args: ['http://127.0.0.1:49152'] }])
    calls.length = 0
    openWebPanorama('http://127.0.0.1:49152', run, 'linux')
    expect(calls).toEqual([{ file: 'xdg-open', args: ['http://127.0.0.1:49152'] }])
    calls.length = 0
    openWebPanorama('http://127.0.0.1:49152', run, 'win32')
    expect(calls).toEqual([{ file: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:49152'] }])
    const throwing = (() => { throw new Error('spawn ENOENT') }) as never
    expect(() => openWebPanorama('http://127.0.0.1:1', throwing, 'darwin')).not.toThrow()
  })
})
