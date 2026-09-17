/** Loopback HTTP contract and pure nested-flow projection. */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { joinShipGraph, type JoinSources, type ShipGraph, type ShipGraphJoinError, type ShipUserAnswer } from '../src/ship-graph.ts'
import {
  handleWebPanoramaRequest,
  openWebPanorama,
  WEB_PANORAMA_LISTEN,
  webPanoramaHtml,
  webPanoramaLayout,
} from '../src/ship-web.ts'

import {
  FLOW_CLAIM,
  SHIP_FLOW_GEOMETRY,
  flowAnswers,
  flowRelationWaypoints,
  relationRunOverlap,
  ticketFlowState,
  webPanoramaTitle,
} from '../src/ship-flow.ts'

const ticketHandle = (
  nodes: ReturnType<typeof webPanoramaLayout>['nodes'],
  id: string,
  which: 'out' | 'in',
): { x: number; y: number } => {
  const node = nodes.find(item => item.id === id)!
  return {
    x: node.position.x + Number(node.style?.width) / 2,
    y: which === 'out' ? node.position.y + Number(node.style?.height) : node.position.y,
  }
}

const relationPoints = (
  nodes: ReturnType<typeof webPanoramaLayout>['nodes'],
  edge: ReturnType<typeof webPanoramaLayout>['edges'][number],
): { x: number; y: number }[] => {
  const source = ticketHandle(nodes, edge.source, 'out')
  const target = ticketHandle(nodes, edge.target, 'in')
  return flowRelationWaypoints(source.x, source.y, target.x, target.y, {
    ...(Number.isFinite(Number(edge.data?.laneX)) ? { laneX: Number(edge.data?.laneX) } : {}),
    ...(Number.isFinite(Number(edge.data?.exitOffset)) ? { exitOffset: Number(edge.data?.exitOffset) } : {}),
    ...(Number.isFinite(Number(edge.data?.entryOffset)) ? { entryOffset: Number(edge.data?.entryOffset) } : {}),
  })
}

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

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

describe('ticketFlowState', () => {
  it.each(['decision', 'landing'] as const)('keeps %s claim colors distinct and updates with live claims', kind => {
    const ticket = { id: `${kind}:1`, kind, title: 'Ticket' }
    expect(ticketFlowState(ticket)).toBe('unknown')
    expect(['unclaimed', 'claimed', 'closed'].map(claim => ticketFlowState({ ...ticket, claim: claim as 'unclaimed' | 'claimed' | 'closed' }))).toEqual(['unclaimed', 'claimed', 'closed'])
  })

  it('keeps Track anchors separate even if a payload includes a claim', () => {
    expect(ticketFlowState({ id: 'track:1', kind: 'track', title: 'Anchor' })).toBe('anchor')
    expect(ticketFlowState({ id: 'track:1', kind: 'track', title: 'Anchor', claim: 'closed' })).toBe('anchor')
  })
})

describe('Ship context and decision answers', () => {
  const graph: ShipGraph = {
    version: 1, specPath: 'answers.md', status: 'grilling',
    originalRequirement: 'Keep the original wording.\nInclude every user answer.',
    objective: 'Deliver a complete Ship decision history.',
    nodes: [{ id: 'decision:local:1', kind: 'decision', title: 'Choose storage', claim: 'closed' }],
    edges: [],
    answers: [
      { id: 'a1', phase: 'wayfinder', ticketId: 'decision:local:1', question: 'Where should history live?', answer: 'In the repository.\nKeep it local.' },
      { id: 'a2', phase: 'grill', question: 'How long should we retain answers?', answer: 'For the whole run.' },
      { id: 'a3', phase: 'grill', question: 'Should skipped questions be visible?' },
    ],
  }

  it('uses English claim labels throughout the Web view', () => {
    expect(FLOW_CLAIM).toEqual({ unclaimed: 'Unclaimed', claimed: 'Claimed', closed: 'Closed' })
    for (const file of ['ship-flow.ts', 'ship-web-app.tsx', 'ship-web.ts']) {
      expect(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).not.toMatch(/[\u3400-\u9fff]/u)
    }
  })

  it('uses the typed /ship idea as the Web page title', () => {
    expect(webPanoramaTitle({ originalRequirement: '做一个 web 音乐播放器，但是要像本地应用一样' }))
      .toBe('做一个 web 音乐播放器，但是要像本地应用一样')
    expect(webPanoramaTitle({ originalRequirement: '  Build a player\nlike a native app  ' }))
      .toBe('Build a player like a native app')
    expect(webPanoramaTitle({})).toBe('Ship Flow')
    expect(webPanoramaTitle({ originalRequirement: ' \n ' })).toBe('Ship Flow')
    const source = readFileSync(new URL('../src/ship-web-app.tsx', import.meta.url), 'utf8')
    expect(source).toContain('webPanoramaTitle(graph)')
    expect(source).toContain('document.title')
    expect(source).not.toMatch(/<h1>\s*Ship <span>Flow<\/span>/)
  })

  it('keeps ticket claim colors only in the status legend', () => {
    const source = readFileSync(new URL('../src/ship-web-app.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('Ticket claims')
    expect(source).not.toContain('claim-summary')
    expect(source).toContain('Node status')
    expect(source).toContain('Track anchor')
    expect(source).toContain("aria-label=\"Node status colors\"")
  })

  it('puts the complete requirement and goal before Wayfinder and connects them to the workflow', () => {
    const { nodes, edges } = webPanoramaLayout(graph)
    expect(nodes.find(node => node.id === 'context:requirement')?.data.text).toBe(graph.originalRequirement)
    expect(nodes.find(node => node.id === 'context:objective')?.data.text).toBe(graph.objective)
    expect(nodes.find(node => node.id === 'context:objective')!.position.y).toBeLessThan(nodes.find(node => node.id === 'phase:wayfinder')!.position.y)
    expect(edges).toContainEqual(expect.objectContaining({ source: 'context:requirement', target: 'context:objective' }))
    expect(edges).toContainEqual(expect.objectContaining({ source: 'context:objective', target: 'phase:wayfinder' }))
    const res = response()
    handleWebPanoramaRequest({ url: '/graph.json' }, res, () => graph)
    expect(JSON.parse(res.state.body)).toEqual(graph)
  })

  it.each(['wayfinder', 'grill', 'spec', 'tickets', 'landing', 'done'] as const)('retains answer nodes in the %s phase', phase => {
    const answer = { id: 'human-response', phase, question: 'Keep this decision?', answer: 'Yes.' }
    const { nodes } = webPanoramaLayout({ ...graph, nodes: [], answers: [answer] })
    expect(nodes.find(node => node.id === 'answer:human-response')).toEqual(expect.objectContaining({ parentId: `phase:${phase}`, data: expect.objectContaining({ answer }) }))
  })

  it('renders every answer in its phase, preserving multiline answers and explicit missing responses', () => {
    const { nodes, edges } = webPanoramaLayout(graph)
    expect(nodes.filter(node => node.type === 'answer').map(node => node.data.answer)).toEqual(graph.answers)
    expect(nodes.find(node => node.id === 'answer:a1')?.parentId).toBe('phase:wayfinder')
    expect(nodes.find(node => node.id === 'answer:a2')?.parentId).toBe('phase:grill')
    expect(nodes.find(node => node.id === 'answer:a3')?.data.answer?.answer).toBeUndefined()
    expect(edges).toContainEqual(expect.objectContaining({ source: 'decision:local:1', target: 'answer:a1' }))
    expect(flowAnswers({ ...graph, answers: [] })[0]).toEqual(expect.objectContaining({ ticketId: 'decision:local:1', question: 'Choose storage' }))
    expect(flowAnswers({ ...graph, answers: [] })[0]?.answer).toBeUndefined()
  })

  it('shows one decision for a translated local-ticket copy of a captured Wayfinder answer', () => {
    const joined = joinShipGraph(sources({
      specPath: 'game.md',
      markdown: 'Status: grilling\n',
      mapChildren: [{
        id: 'decision:local:1', title: 'Game Format and Visual Presentation', closed: true, ticketType: 'grilling',
        question: 'Which gameplay perspective and visual presentation would you prefer for this web Medal of Honor game?',
        userAnswer: '3D 第一人称射击 (FPS) (Recommended)',
      }],
      answers: [
        { id: 'game_format', phase: 'wayfinder', question: '请问您期望这款 Web 版《荣誉勋章》游戏采用哪种视角与表现形式？', answer: '3D 第一人称射击 (FPS) (Recommended)' },
        { id: 'continue', phase: 'wayfinder', question: '是否继续进入深度需求细化阶段？', answer: 'Continue to grill (recommended, first)' },
      ],
    }))
    expect(isJoinError(joined)).toBe(false)
    if (isJoinError(joined)) return
    const before = JSON.stringify(joined)
    const { nodes, edges } = webPanoramaLayout(joined)
    const decisions = nodes.filter(node => node.type === 'answer')
    expect(decisions).toHaveLength(2)
    expect(decisions[0]?.data.answer).toMatchObject({
      ticketId: 'decision:local:1',
      question: '请问您期望这款 Web 版《荣誉勋章》游戏采用哪种视角与表现形式？',
      answer: '3D 第一人称射击 (FPS) (Recommended)',
    })
    expect(edges).toContainEqual(expect.objectContaining({ source: 'decision:local:1', target: decisions[0]?.id }))
    expect(decisions[1]?.data.answer?.id).toBe('continue')
    expect(JSON.stringify(joined)).toBe(before)
  })

  const localCopy = {
    id: 'decision:local:1', phase: 'wayfinder', ticketId: 'decision:local:1',
    question: 'Which gameplay perspective?', answer: '3D 第一人称射击 (FPS) (Recommended)', source: 'Which gameplay perspective?',
  } satisfies ShipUserAnswer
  const captured: ShipUserAnswer = {
    id: 'perspective', phase: 'wayfinder', question: '采用哪种视角？',
    answer: localCopy.answer, source: '采用哪种视角？', detail: '请选择一种游戏视角。',
  }

  it('keeps the ticket card id stable and uses the captured question, source and detail on refresh', () => {
    const before = flowAnswers({ ...graph, answers: [localCopy] })
    const answers = [localCopy, captured]
    const original = JSON.stringify(answers)
    const after = flowAnswers({ ...graph, answers })
    expect(after).toEqual([{ ...captured, id: localCopy.id, ticketId: localCopy.ticketId }])
    expect(after[0]?.id).toBe(before[0]?.id)
    expect(JSON.stringify(answers)).toBe(original)
    expect(flowAnswers({ ...graph, answers: [...answers].reverse() })).toEqual(after)
  })

  it.each(['', 'Yes', 'Yes (Recommended)', 'Continue to grill (recommended, first)', 'No user answer recorded', '(Pending user answer)'])(
    'keeps unrelated translated questions with a generic or missing response: %s', answer => {
      expect(flowAnswers({ ...graph, answers: [{ ...localCopy, answer }, { ...captured, answer }] })).toHaveLength(2)
    },
  )

  it('keeps answers in other phases and answers explicitly attached to another ticket', () => {
    for (const answer of [{ ...captured, phase: 'grill' as const }, { ...captured, ticketId: 'decision:local:2' }]) {
      expect(flowAnswers({ ...graph, answers: [localCopy, answer] })).toEqual([localCopy, answer])
    }
  })

  it('keeps distinct captured questions and repeated rounds when their response matches one ticket copy', () => {
    for (const second of [{ ...captured, id: 'other', question: '另一项选择？' }, { ...captured, detail: 'Asked again.' }]) {
      const answers = [localCopy, captured, second]
      expect(flowAnswers({ ...graph, answers })).toHaveLength(3)
    }
    const answers = [localCopy, { ...captured, question: localCopy.question }, { ...captured, question: localCopy.question, detail: 'Asked again.' }]
    expect(flowAnswers({ ...graph, answers })).toHaveLength(3)
  })

  it('keeps ambiguous translated copies on multiple tickets instead of guessing a parent', () => {
    const second = { ...localCopy, id: 'decision:local:2', ticketId: 'decision:local:2', question: 'Which rendering style?' }
    const result = flowAnswers({
      ...graph,
      nodes: [...graph.nodes, { id: second.id, kind: 'decision', title: 'Rendering style', claim: 'closed' }],
      answers: [localCopy, second, captured],
    })
    expect(result).toEqual([localCopy, second, captured])
  })

  it('keeps changed answers as history while reconciling only the current ticket copy', () => {
    const earlier = { ...captured, answer: '2D side-scrolling action' }
    expect(flowAnswers({ ...graph, answers: [localCopy, earlier, captured] })).toEqual([
      { ...captured, id: localCopy.id, ticketId: localCopy.ticketId }, earlier,
    ])
  })

  it('does not merge translated captured responses that already belong to a ticket', () => {
    const answer = { ...captured, ticketId: localCopy.ticketId }
    expect(flowAnswers({ ...graph, answers: [localCopy, answer] })).toEqual([localCopy, answer])
  })

  it('keeps repeated question ids from different rounds as distinct selectable answer nodes', () => {
    const repeated = { ...graph, answers: [
      { id: 'route', phase: 'wayfinder' as const, question: 'Is the route clear?', answer: 'Continue' },
      { id: 'route', phase: 'grill' as const, question: 'Confirm the handoff?', answer: 'Continue' },
      { id: 'route', phase: 'grill' as const, question: 'Confirm the handoff?', answer: 'Revise the storage choice.' },
    ] }
    const { nodes } = webPanoramaLayout(repeated)
    const actual = nodes.filter(node => node.type === 'answer' && node.data.answer?.answer)
    expect(actual).toHaveLength(3)
    expect(new Set(nodes.map(node => node.id)).size).toBe(nodes.length)
    expect(actual.map(node => node.data.answer?.answer)).toEqual(['Continue', 'Continue', 'Revise the storage choice.'])
    expect(repeated.answers.every(answer => answer.id === 'route')).toBe(true)
  })

  it('keeps context visible when phases collapse and restores answers with no graph mutation', () => {
    const before = JSON.stringify(graph)
    const { nodes, edges } = webPanoramaLayout(graph, new Set(['wayfinder', 'grill']))
    expect(nodes.filter(node => node.type === 'context').every(node => !node.hidden)).toBe(true)
    expect(nodes.filter(node => node.type === 'answer').every(node => node.hidden)).toBe(true)
    expect(edges.filter(edge => edge.className === 'answer-edge').every(edge => edge.hidden)).toBe(true)
    expect(webPanoramaLayout(graph).nodes.filter(node => node.type === 'answer').every(node => !node.hidden)).toBe(true)
    expect(JSON.stringify(graph)).toBe(before)
  })

  it('preserves very long text and keeps answer cards within non-overlapping phase bounds', () => {
    const text = 'Detailed source text.\n'.repeat(120)
    const { nodes } = webPanoramaLayout({ ...graph, originalRequirement: text, answers: graph.answers!.map(answer => ({ ...answer, answer: text })) })
    expect(nodes.find(node => node.id === 'context:requirement')?.data.text).toBe(text)
    for (const phase of nodes.filter(node => node.type === 'phase')) {
      const children = nodes.filter(node => node.parentId === phase.id && node.type === 'answer')
      for (const [index, node] of children.entries()) {
        expect(node.data.answer?.answer).toBe(text)
        expect(node.position.x + Number(node.style?.width)).toBeLessThan(Number(phase.style?.width))
        expect(node.position.y + Number(node.style?.height)).toBeLessThan(Number(phase.style?.height))
        for (const other of children.slice(index + 1)) {
          const separateX = node.position.x + Number(node.style?.width) <= other.position.x || other.position.x + Number(other.style?.width) <= node.position.x
          const separateY = node.position.y + Number(node.style?.height) <= other.position.y || other.position.y + Number(other.style?.height) <= node.position.y
          expect(separateX || separateY).toBe(true)
        }
      }
    }
  })

  it('clusters a ticket with its answers: ticket on the left, answers stacked on the right', () => {
    const sibling: ShipGraph = {
      version: 1, specPath: 'siblings.md', status: 'wayfinding',
      nodes: [{ id: 'decision:local:1', kind: 'decision', title: 'Game Perspective and Genre', claim: 'closed' }],
      edges: [],
      answers: [
        { id: 'q1', phase: 'wayfinder', ticketId: 'decision:local:1', question: 'Which perspective?', answer: 'FPS' },
        { id: 'q2', phase: 'wayfinder', question: 'Which core loop?' },
      ],
    }
    const { nodes, edges } = webPanoramaLayout(sibling)
    const ticket = nodes.find(node => node.id === 'decision:local:1')!
    const first = nodes.find(node => node.id === 'answer:q1')!
    const second = nodes.find(node => node.id === 'answer:q2')!
    const answerX = SHIP_FLOW_GEOMETRY.padding + SHIP_FLOW_GEOMETRY.ticketColumn + SHIP_FLOW_GEOMETRY.clusterGap
    const answerWidth = SHIP_FLOW_GEOMETRY.width - answerX - SHIP_FLOW_GEOMETRY.padding
    expect(ticket.position.x).toBe(SHIP_FLOW_GEOMETRY.padding)
    expect(Number(ticket.style?.width)).toBe(SHIP_FLOW_GEOMETRY.ticketColumn)
    expect(first.position.x).toBe(answerX)
    expect(second.position.x).toBe(answerX)
    expect(first.position.y).toBe(ticket.position.y)
    expect(second.position.y).toBeGreaterThan(first.position.y + Number(first.style?.height))
    expect(Number(first.style?.width)).toBe(answerWidth)
    expect(Number(second.style?.width)).toBe(answerWidth)
    expect(edges.filter(edge => edge.className === 'answer-edge')).toEqual([
      expect.objectContaining({ source: 'decision:local:1', target: 'answer:q1', type: 'straight', sourceHandle: 'answer-out', targetHandle: 'answer-in' }),
      expect.objectContaining({ source: 'answer:q1', target: 'answer:q2', type: 'smoothstep' }),
    ])
    const ticketOut = ticket.handles?.find(handle => handle.id === 'answer-out')
    const answerIn = first.handles?.find(handle => handle.id === 'answer-in')
    expect(ticketOut?.y).toBe(SHIP_FLOW_GEOMETRY.ticketHeight / 2)
    expect(answerIn?.y).toBe(ticketOut?.y)
    expect(Number(first.style?.height)).toBeGreaterThan(SHIP_FLOW_GEOMETRY.ticketHeight)
    expect(edges.some(edge => edge.sourceHandle === null || edge.targetHandle === null)).toBe(false)
    expect(edges.some(edge => edge.type === 'relation' && edge.className === 'answer-edge')).toBe(false)
  })

  it('stacks a third answer under the second in the answer column', () => {
    const { nodes, edges } = webPanoramaLayout({
      version: 1, specPath: 'wrap.md', status: 'wayfinding',
      nodes: [{ id: 'decision:local:1', kind: 'decision', title: 'Route', claim: 'claimed' }],
      edges: [],
      answers: [
        { id: 'q1', phase: 'wayfinder', ticketId: 'decision:local:1', question: 'One' },
        { id: 'q2', phase: 'wayfinder', ticketId: 'decision:local:1', question: 'Two' },
        { id: 'q3', phase: 'wayfinder', ticketId: 'decision:local:1', question: 'Three' },
      ],
    })
    const first = nodes.find(node => node.id === 'answer:q1')!
    const second = nodes.find(node => node.id === 'answer:q2')!
    const third = nodes.find(node => node.id === 'answer:q3')!
    expect(third.position.y).toBeGreaterThan(second.position.y + Number(second.style?.height))
    expect(third.position.x).toBe(first.position.x)
    expect(Number(third.style?.width)).toBe(Number(first.style?.width))
    expect(edges).toContainEqual(expect.objectContaining({ source: 'answer:q2', target: 'answer:q3', type: 'smoothstep' }))
    expect(edges).toContainEqual(expect.objectContaining({ source: 'decision:local:1', target: 'answer:q1', type: 'straight' }))
  })

  it('keeps unlinked answers stacked and later tickets in their own cluster', () => {
    const { nodes, edges } = webPanoramaLayout(graph)
    const grill = nodes.filter(node => node.data.answer?.phase === 'grill')
    expect(grill[1]!.position.y).toBeGreaterThan(grill[0]!.position.y + Number(grill[0]!.style?.height))
    expect(grill[1]!.position.x).toBe(grill[0]!.position.x)
    expect(edges).toContainEqual(expect.objectContaining({ source: 'phase:grill:step:2', target: 'answer:a2', type: 'smoothstep' }))
    expect(edges).toContainEqual(expect.objectContaining({ source: 'answer:a2', target: 'answer:a3', type: 'smoothstep' }))
    const later = webPanoramaLayout({
      version: 1, specPath: 'later.md', status: 'wayfinding',
      nodes: [
        { id: 'decision:local:1', kind: 'decision', title: 'First', claim: 'closed' },
        { id: 'decision:local:2', kind: 'decision', title: 'Second', claim: 'claimed' },
      ],
      edges: [{ from: 'decision:local:2', to: 'decision:local:1', kind: 'blocked-by' }],
      answers: [
        { id: 'a', phase: 'wayfinder', ticketId: 'decision:local:1', question: 'A1' },
        { id: 'b', phase: 'wayfinder', ticketId: 'decision:local:1', question: 'A2' },
        { id: 'c', phase: 'wayfinder', ticketId: 'decision:local:2', question: 'B1' },
      ],
    })
    const ticket1 = later.nodes.find(node => node.id === 'decision:local:1')!
    const ticket2 = later.nodes.find(node => node.id === 'decision:local:2')!
    const first = later.nodes.find(node => node.id === 'answer:a')!
    const second = later.nodes.find(node => node.id === 'answer:b')!
    const third = later.nodes.find(node => node.id === 'answer:c')!
    expect(first.position.x).toBe(second.position.x)
    expect(first.position.x).toBeGreaterThan(ticket1.position.x + Number(ticket1.style?.width))
    expect(second.position.y).toBeGreaterThan(first.position.y)
    expect(ticket2.position.y).toBeGreaterThan(ticket1.position.y)
    expect(third.position.y).toBe(ticket2.position.y)
    expect(third.position.x).toBe(first.position.x)
    expect(later.edges).toContainEqual(expect.objectContaining({
      source: 'decision:local:2',
      target: 'answer:c',
      type: 'straight',
      sourceHandle: 'answer-out',
      targetHandle: 'answer-in',
    }))
    expect(later.edges).toContainEqual(expect.objectContaining({
      source: 'decision:local:1',
      target: 'decision:local:2',
      type: 'relation',
      className: 'blocked-by',
    }))
    expect(later.edges.filter(edge => edge.className === 'blocked-by').every(edge => !edge.data?.outside)).toBe(true)
  })

  it('joins an unlinked continuation from each ticket column instead of the last workflow step', () => {
    const graph: ShipGraph = {
      version: 1, specPath: 'advance.md', status: 'wayfinding',
      nodes: [
        { id: 'decision:local:1', kind: 'decision', title: '01-core', claim: 'closed' },
        { id: 'decision:local:2', kind: 'decision', title: '02-mission', claim: 'closed' },
        { id: 'decision:local:3', kind: 'decision', title: '03-weapons', claim: 'closed' },
      ],
      edges: [],
      answers: [
        { id: 'a1', phase: 'wayfinder', ticketId: 'decision:local:1', question: '视角与核心玩法形态怎样？', answer: '3D FPS' },
        { id: 'a2', phase: 'wayfinder', ticketId: 'decision:local:2', question: '战役场景与通关目标链？', answer: '要塞渗透' },
        { id: 'a3', phase: 'wayfinder', ticketId: 'decision:local:3', question: '武器配置与战斗机制？', answer: 'M1 加兰德' },
        { id: 'advance', phase: 'wayfinder', question: '路线图与核心决策已就绪。是否继续推进到 Grilling 阶段？', answer: 'Continue to grill' },
      ],
    }
    const { nodes, edges } = webPanoramaLayout(graph)
    const continuation = nodes.find(node => node.id === 'answer:advance')!
    const first = nodes.find(node => node.id === 'answer:a1')!
    const second = nodes.find(node => node.id === 'answer:a2')!
    const third = nodes.find(node => node.id === 'answer:a3')!
    expect(continuation.position.y).toBeGreaterThan(Math.max(
      first.position.y + Number(first.style?.height),
      second.position.y + Number(second.style?.height),
      third.position.y + Number(third.style?.height),
    ))
    expect(Number(continuation.style?.width)).toBeGreaterThan(Number(first.style?.width))
    expect(edges.filter(edge => edge.target === 'answer:advance')).toEqual([
      expect.objectContaining({ source: 'answer:a1', type: 'smoothstep' }),
      expect.objectContaining({ source: 'answer:a2', type: 'smoothstep' }),
      expect.objectContaining({ source: 'answer:a3', type: 'smoothstep' }),
    ])
    expect(edges.some(edge => edge.source === 'phase:wayfinder:step:2' && edge.target === 'answer:advance')).toBe(false)
    expect(Number(first.style?.height)).toBeGreaterThan(SHIP_FLOW_GEOMETRY.ticketHeight)
    expect(Number(second.style?.height)).toBeGreaterThan(SHIP_FLOW_GEOMETRY.ticketHeight)
  })

  it('draws a straight parent-to-answer edge at ticket mid-height when the answer card is taller', () => {
    const aligned: ShipGraph = {
      version: 1, specPath: 'aligned.md', status: 'wayfinding',
      nodes: [
        { id: 'decision:local:1', kind: 'decision', title: 'Research: Tech Stack and Rendering Engine', claim: 'closed', ticketType: 'research' },
        { id: 'decision:local:2', kind: 'decision', title: 'Grilling: Confirm Destination Route', claim: 'closed', ticketType: 'grilling' },
      ],
      edges: [],
      answers: [
        {
          id: 'a1', phase: 'wayfinder', ticketId: 'decision:local:1',
          question: 'Which web graphics library and build setup are best suited for building a responsive, self-contained 3D Medal of Honor FPS?',
        },
        {
          id: 'a2', phase: 'wayfinder', ticketId: 'decision:local:2',
          question: 'The wayfinder destination has been charted: a 3D WebGL WWII First-Person Shooter inspired by Medal of Honor.',
          answer: 'Continue with Vite, TypeScript, Three.js, and Web Audio.',
        },
      ],
    }
    const { nodes, edges } = webPanoramaLayout(aligned)
    const ticket1 = nodes.find(node => node.id === 'decision:local:1')!
    const ticket2 = nodes.find(node => node.id === 'decision:local:2')!
    const first = nodes.find(node => node.id === 'answer:a1')!
    const second = nodes.find(node => node.id === 'answer:a2')!
    const mid = SHIP_FLOW_GEOMETRY.ticketHeight / 2
    expect(ticket2.position.y).toBe(ticket1.position.y)
    expect(first.position.y).toBe(ticket1.position.y)
    expect(second.position.y).toBe(ticket2.position.y)
    expect(Number(first.style?.height)).toBeGreaterThan(SHIP_FLOW_GEOMETRY.ticketHeight)
    expect(Number(second.style?.height)).toBeGreaterThan(SHIP_FLOW_GEOMETRY.ticketHeight)
    expect(ticket1.handles?.find(handle => handle.id === 'answer-out')?.y).toBe(mid)
    expect(first.handles?.find(handle => handle.id === 'answer-in')?.y).toBe(mid)
    expect(ticket2.handles?.find(handle => handle.id === 'answer-out')?.y).toBe(mid)
    expect(second.handles?.find(handle => handle.id === 'answer-in')?.y).toBe(mid)
    expect(edges.filter(edge => edge.className === 'answer-edge')).toEqual([
      expect.objectContaining({ source: 'decision:local:1', target: 'answer:a1', type: 'straight', sourceHandle: 'answer-out', targetHandle: 'answer-in' }),
      expect.objectContaining({ source: 'decision:local:2', target: 'answer:a2', type: 'straight', sourceHandle: 'answer-out', targetHandle: 'answer-in' }),
    ])
  })

  it('forks sibling dependents in one rank instead of stacking and wrapping the prerequisite', () => {
    const medal: ShipGraph = {
      version: 1, specPath: 'medal-of-honor-web.md', status: 'wayfinding',
      nodes: [
        { id: 'decision:local:1', kind: 'decision', title: '01-gameplay-style: Web版荣誉勋章的核心玩法与视点风格', claim: 'closed', ticketType: 'grilling' },
        { id: 'decision:local:2', kind: 'decision', title: '02-tech-stack: Web 3D/2D 渲染引擎与技术栈选型', claim: 'claimed', ticketType: 'research' },
        { id: 'decision:local:3', kind: 'decision', title: '03-mission-scope: 战役关卡与核心战术要素', claim: 'unclaimed', ticketType: 'grilling' },
      ],
      edges: [
        { from: 'decision:local:2', to: 'decision:local:1', kind: 'blocked-by' },
        { from: 'decision:local:3', to: 'decision:local:1', kind: 'blocked-by' },
      ],
      answers: [
        { id: 'decision:local:1', phase: 'wayfinder', ticketId: 'decision:local:1', question: '您期望打造什么核心视觉风格与玩法形态的 Web 版《荣誉勋章》游戏？', answer: '3D 第一人称战术射击 (3D FPS，推荐)' },
        { id: 'decision:local:3', phase: 'wayfinder', ticketId: 'decision:local:3', question: '核心关卡目标与战术要素的偏好。', answer: '(Pending user answer)' },
        { id: 'gameplay_style', phase: 'wayfinder', question: '您期望打造什么核心视觉风格与玩法形态的 Web 版《荣誉勋章》游戏？', answer: '3D 第一人称战术射击 (3D FPS，推荐)' },
      ],
    }
    expect(flowAnswers(medal).map(answer => answer.id)).toEqual(['decision:local:1', 'decision:local:3'])
    const { nodes, edges } = webPanoramaLayout(medal)
    const ticket1 = nodes.find(node => node.id === 'decision:local:1')!
    const ticket2 = nodes.find(node => node.id === 'decision:local:2')!
    const ticket3 = nodes.find(node => node.id === 'decision:local:3')!
    const recorded = nodes.find(node => node.id === 'answer:decision:local:1')!
    const pending = nodes.find(node => node.id === 'answer:decision:local:3')!
    expect(ticket2.position.y).toBe(ticket3.position.y)
    expect(ticket2.position.x).not.toBe(ticket3.position.x)
    expect(ticket2.position.y).toBeGreaterThan(ticket1.position.y + Number(ticket1.style?.height))
    expect(recorded.position.x).toBeGreaterThan(ticket1.position.x + Number(ticket1.style?.width))
    expect(recorded.position.y).toBe(ticket1.position.y)
    expect(pending.position.x).toBeGreaterThan(ticket3.position.x + Number(ticket3.style?.width))
    expect(pending.position.y).toBe(ticket3.position.y)
    expect(nodes.some(node => node.id === 'answer:unrecorded:decision:local:2')).toBe(false)
    expect(nodes.some(node => node.id === 'answer:gameplay_style')).toBe(false)
    expect(edges.filter(edge => edge.className === 'blocked-by')).toEqual([
      expect.objectContaining({ source: 'decision:local:1', target: 'decision:local:2', type: 'relation' }),
      expect.objectContaining({ source: 'decision:local:1', target: 'decision:local:3', type: 'relation' }),
    ])
    expect(edges.filter(edge => edge.className === 'blocked-by').every(edge => !edge.data?.outside)).toBe(true)
    const first = edges.find(edge => edge.target === 'decision:local:2')!
    const second = edges.find(edge => edge.target === 'decision:local:3')!
    expect(Number(first.data?.exitOffset)).not.toBe(Number(second.data?.exitOffset))
    const phase = nodes.find(node => node.id === 'phase:wayfinder')!
    expect(Number(phase.style?.width)).toBeGreaterThan(SHIP_FLOW_GEOMETRY.width)
    for (const child of nodes.filter(node => node.parentId === 'phase:wayfinder' && (node.type === 'ticket' || node.type === 'answer'))) {
      expect(child.position.x + Number(child.style?.width)).toBeLessThan(Number(phase.style?.width))
      expect(child.position.y + Number(child.style?.height)).toBeLessThan(Number(phase.style?.height))
    }
  })

  it('keeps a same-column prerequisite in the ticket lane when a later sibling sits to the right', () => {
    const scratch: ShipGraph = {
      version: 1, specPath: 'spec.md', status: 'wayfinding',
      nodes: [
        { id: 'decision:local:1', kind: 'decision', title: '01-gameplay-style', claim: 'closed', ticketType: 'grilling' },
        { id: 'decision:local:2', kind: 'decision', title: '02-tech-stack', claim: 'claimed', ticketType: 'research' },
        { id: 'decision:local:3', kind: 'decision', title: '03-mission-scope', claim: 'unclaimed', ticketType: 'grilling' },
      ],
      edges: [{ from: 'decision:local:3', to: 'decision:local:1', kind: 'blocked-by' }],
      answers: [
        { id: 'decision:local:1', phase: 'wayfinder', ticketId: 'decision:local:1', question: '您期望打造什么核心视觉风格与玩法形态的 Web 版《荣誉勋章》游戏？', answer: '3D 第一人称战术射击 (3D FPS，推荐)' },
        { id: 'decision:local:3', phase: 'wayfinder', ticketId: 'decision:local:3', question: '核心关卡目标与战术要素的偏好。' },
        { id: 'decision:local:1', phase: 'wayfinder', ticketId: 'decision:local:1', question: '你想打造哪种类型的 Web 版《荣誉勋章》游戏？', answer: '(Pending user answer)' },
        { id: 'gameplay_style', phase: 'wayfinder', question: '您期望打造什么核心视觉风格与玩法形态的 Web 版《荣誉勋章》游戏？', answer: '3D 第一人称战术射击 (3D FPS，推荐)' },
      ],
    }
    expect(flowAnswers(scratch).map(answer => answer.id)).toEqual([
      'decision:local:1',
      'decision:local:3',
      'decision:local:1:occurrence:2',
    ])
    const { nodes, edges } = webPanoramaLayout(scratch)
    const ticket1 = nodes.find(node => node.id === 'decision:local:1')!
    const ticket2 = nodes.find(node => node.id === 'decision:local:2')!
    const ticket3 = nodes.find(node => node.id === 'decision:local:3')!
    expect(ticket2.position.y).toBe(ticket1.position.y)
    expect(ticket2.position.x).toBeGreaterThan(ticket1.position.x)
    expect(ticket3.position.y).toBeGreaterThan(ticket1.position.y + Number(ticket1.style?.height))
    expect(ticket3.position.x).toBe(ticket1.position.x)
    expect(nodes.some(node => node.id === 'answer:gameplay_style')).toBe(false)
    expect(nodes.some(node => node.id === 'answer:unrecorded:decision:local:2')).toBe(false)
    expect(edges).toContainEqual(expect.objectContaining({
      source: 'decision:local:1',
      target: 'decision:local:3',
      type: 'relation',
      className: 'blocked-by',
    }))
    expect(edges.filter(edge => edge.className === 'blocked-by').every(edge => !edge.data?.outside)).toBe(true)
  })
})

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
    expect(res.state.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(res.state.body)).toEqual(graph)
    expect(graph.nodes.filter(node => node.kind === 'decision')).toEqual([])
    expect(graph.nodes.find(node => node.id === 'track:1')).not.toHaveProperty('claim')
    expect(graph.nodes.some(node => node.id === 'hub')).toBe(false)
    expect(graph.nodes.find(node => node.id === 'landing:1')?.claim).toBe('closed')
    expect(graph.nodes.find(node => node.id === 'landing:2')?.claim).toBe('unclaimed')
  })

  it.each(['/', '/index.html'])('serves the local flowchart shell on %s', url => {
    const res = response()
    handleWebPanoramaRequest({ url }, res, () => graph as ShipGraph)
    expect(res.state.status).toBe(200)
    expect(res.state.headers['content-type']).toMatch(/text\/html/)
    expect(res.state.headers['content-security-policy']).toContain("script-src 'self'")
    expect(res.state.body).toContain('/assets/ship-web.js')
    expect(res.state.body).toContain('/assets/ship-web.css')
    expect(res.state.body).toContain('name="viewport" content="width=device-width, initial-scale=1"')
    expect(res.state.body).not.toContain('<svg')
  })

  it.each(['/assets/ship-web.js', '/assets/ship-web.css'])('reports missing packaged assets without crashing: %s', url => {
    const read = vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    try {
      const res = response()
      handleWebPanoramaRequest({ url }, res, () => undefined)
      expect(res.state.status).toBe(503)
      expect(res.state.body).toContain('Rebuild or reinstall')
    } finally { read.mockRestore() }
  })

  it.each([
    ['/assets/ship-web.js', 'text/javascript', 'console.log("flow")'],
    ['/assets/ship-web.css', 'text/css', 'body{margin:0}'],
  ])('serves only the packaged asset with the right MIME type: %s', (url, mime, asset) => {
    const read = vi.mocked(readFileSync).mockReturnValue(asset)
    try {
      const res = response()
      handleWebPanoramaRequest({ url }, res, () => undefined)
      expect(res.state.status).toBe(200)
      expect(res.state.headers['content-type']).toContain(mime)
      expect(res.state.headers['x-content-type-options']).toBe('nosniff')
      expect(res.state.body).toBe(asset)
    } finally { read.mockRestore() }
  })

  it('serves an empty graph without inventing a phase or tickets', () => {
    const res = response()
    handleWebPanoramaRequest({ url: '/graph.json' }, res, () => undefined)
    expect(JSON.parse(res.state.body)).toEqual({ version: 1, specPath: '', nodes: [], edges: [] })
  })

  it.each(['/assets/../package.json', '/package.json', '/assets/unknown.js'])('refuses unlisted paths: %s', url => {
    const res = response()
    handleWebPanoramaRequest({ url }, res, () => undefined)
    expect(res.state.status).toBe(404)
  })
})

describe('webPanoramaHtml', () => {
  it('uses only local assets and includes a recoverable loading fallback', () => {
    expect(webPanoramaHtml()).toContain('rebuild or reinstall codsh-bundle')
    expect(webPanoramaHtml()).not.toMatch(/https?:\/\//)
    expect(webPanoramaHtml()).toContain('<noscript>')
  })
})

describe('webPanoramaLayout', () => {
  const graph: ShipGraph = { version: 1, specPath: 'widget.md', status: 'landing', nodes: [
    { id: 'landing:2', kind: 'landing', title: 'Dependent', claim: 'unclaimed' },
    { id: 'track:1', kind: 'track', title: 'Hybrid' },
    { id: 'decision:local:1', kind: 'decision', title: 'A', claim: 'claimed' },
    { id: 'landing:1', kind: 'landing', title: 'Prerequisite', claim: 'closed' },
  ], edges: [
    { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
    { from: 'landing:2', to: 'track:1', kind: 'hangs-off' },
  ] }

  it('starts with Wayfinder and nests steps/tickets under all six ordered phases', () => {
    const { nodes } = webPanoramaLayout(graph)
    expect(nodes.filter(node => node.type === 'phase').map(node => node.data.title)).toEqual(['Wayfinder', 'Grill', 'Spec · Gate 1', 'Tickets · Gate 2', 'Landing', 'Done'])
    expect(nodes.filter(node => node.type === 'step')).toHaveLength(18)
    expect(nodes.find(node => node.id === 'decision:local:1')?.parentId).toBe('phase:wayfinder')
    expect(nodes.find(node => node.id === 'track:1')?.parentId).toBe('phase:spec')
    expect(nodes.find(node => node.id === 'landing:2')?.parentId).toBe('phase:landing')
    for (const node of nodes.filter(node => node.parentId)) {
      expect(nodes.findIndex(parent => parent.id === node.parentId)).toBeLessThan(nodes.indexOf(node))
      expect(node.extent).toBe('parent')
      const parent = nodes.find(parent => parent.id === node.parentId)!
      expect(node.position.y + Number(node.style?.height)).toBeLessThan(Number(parent.style?.height))
    }
    expect(new Set(nodes.map(node => node.id)).size).toBe(nodes.length)
  })

  it('lays out prerequisites above dependents with arrows from prerequisite/anchor to ticket', () => {
    const { nodes, edges } = webPanoramaLayout(graph)
    expect(nodes.find(node => node.id === 'landing:1')!.position.y).toBeLessThan(nodes.find(node => node.id === 'landing:2')!.position.y)
    expect(edges).toContainEqual(expect.objectContaining({ source: 'landing:1', target: 'landing:2', className: 'blocked-by' }))
    expect(edges).toContainEqual(expect.objectContaining({ source: 'track:1', target: 'landing:2', className: 'hangs-off' }))
  })

  it('collapses children and redirects cross-phase relations without altering the graph', () => {
    const before = JSON.stringify(graph)
    const { nodes, edges } = webPanoramaLayout(graph, new Set(['landing']))
    expect(nodes.filter(node => node.parentId === 'phase:landing').every(node => node.hidden)).toBe(true)
    expect(edges).toContainEqual(expect.objectContaining({ source: 'track:1', target: 'phase:landing' }))
    expect(edges.some(edge => edge.source === 'landing:1' && edge.target === 'landing:2')).toBe(false)
    expect(JSON.stringify(graph)).toBe(before)
  })

  it.each([
    ['wayfinding', 'wayfinder'], ['grilling', 'grill'], ['interviewing', 'spec'],
    ['confirmed', 'tickets'], ['planned', 'landing'], ['landing', 'landing'],
  ] as const)('maps ledger status %s to the current phase %s', (status, phase) => {
    const { nodes } = webPanoramaLayout({ ...graph, status })
    expect(nodes.filter(node => node.data.state === 'current').map(node => node.id)).toEqual([`phase:${phase}`])
  })

  it('keeps unknown/empty phases explicit and never equates closed tickets with shipped', () => {
    const { status: _status, ...unknown } = graph
    expect(webPanoramaLayout(unknown).nodes.filter(node => node.type === 'phase').every(node => node.data.state === 'unknown')).toBe(true)
    const empty = webPanoramaLayout({ version: 1, specPath: '', nodes: [], edges: [] })
    expect(empty.nodes.filter(node => node.type === 'phase')).toHaveLength(6)
    expect(empty.nodes.filter(node => node.type === 'ticket')).toHaveLength(0)
    expect(webPanoramaLayout({ ...graph, status: 'shipped' }).nodes.filter(node => node.type === 'phase').every(node => node.data.state === 'passed')).toBe(true)
  })

  it('keeps large and cyclic ticket sets inside their parent and ignores dangling edges', () => {
    const many: ShipGraph = { ...graph, nodes: Array.from({ length: 17 }, (_, i) => ({ id: `landing:${i}`, kind: 'landing', title: String(i) })), edges: [
      { from: 'landing:0', to: 'landing:1', kind: 'blocked-by' }, { from: 'landing:1', to: 'landing:0', kind: 'blocked-by' },
      { from: 'missing', to: 'landing:1', kind: 'blocked-by' },
    ] }
    const { nodes, edges } = webPanoramaLayout(many)
    const tickets = nodes.filter(node => node.type === 'ticket')
    expect(tickets).toHaveLength(17)
    expect(new Set(tickets.map(node => `${node.position.x}:${node.position.y}`)).size).toBe(17)
    expect(edges.some(edge => edge.source === 'missing' || edge.target === 'missing')).toBe(false)
  })
})

describe('flow motion and compact geometry', () => {
  const graph: ShipGraph = {
    version: 1, specPath: 'motion.md', status: 'landing',
    nodes: [
      { id: 'track:1', kind: 'track', title: 'Acceptance' },
      { id: 'decision:1', kind: 'decision', title: 'Old claim', claim: 'claimed' },
      { id: 'landing:1', kind: 'landing', title: 'Prerequisite', claim: 'closed' },
      { id: 'landing:2', kind: 'landing', title: 'Implement', claim: 'claimed' },
      { id: 'landing:3', kind: 'landing', title: 'Wait', claim: 'unclaimed' },
    ],
    edges: [
      { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
      { from: 'landing:3', to: 'landing:2', kind: 'blocked-by' },
      { from: 'landing:3', to: 'track:1', kind: 'hangs-off' },
      { from: 'landing:2', to: 'track:1', kind: 'hangs-off' },
    ],
  }

  it('animates only the current phase, its claimed tickets, and supported incoming flow', () => {
    const { nodes, edges } = webPanoramaLayout(graph)
    expect(nodes.filter(node => node.data.active).map(node => node.id)).toEqual(['phase:landing', 'landing:2'])
    expect(edges.filter(edge => edge.animated).map(edge => edge.id)).toEqual([
      'sequence:4', 'phase:landing:step:1:next', 'phase:landing:step:2:next',
      'relation:blocked-by:landing:1:landing:2', 'relation:hangs-off:track:1:landing:2',
    ])
    expect(nodes.filter(node => node.type === 'step').every(node => node.data.state === undefined && !node.data.active)).toBe(true)
    expect(edges.filter(edge => edge.className === 'answer-edge').every(edge => !edge.animated)).toBe(true)
  })

  it('moves motion with live status and claim changes, stopping at shipped or unrecorded status', () => {
    const { nodes, edges } = webPanoramaLayout({ ...graph, status: 'wayfinding' })
    expect(nodes.filter(node => node.data.active).map(node => node.id)).toEqual(['phase:wayfinder', 'decision:1'])
    expect(edges.find(edge => edge.id === 'context:1')?.animated).toBe(true)
    const closed = webPanoramaLayout({ ...graph, nodes: graph.nodes.map(node => ({ ...node, claim: 'closed' as const })) })
    expect(closed.nodes.filter(node => node.type === 'ticket').some(node => node.data.active)).toBe(false)
    expect(closed.edges.filter(edge => edge.id.startsWith('relation:')).some(edge => edge.animated)).toBe(false)
    const { status: _status, ...unknown } = graph
    for (const stopped of [unknown, { ...graph, status: 'shipped' as const }]) {
      const layout = webPanoramaLayout(stopped)
      expect(layout.nodes.some(node => node.data.active)).toBe(false)
      expect(layout.edges.some(edge => edge.animated)).toBe(false)
    }
  })

  it('keeps unresolved prerequisites static and combines collapsed relation activity', () => {
    const blocked = webPanoramaLayout({ ...graph, nodes: graph.nodes.map(node => node.id === 'landing:1' ? { ...node, claim: 'unclaimed' as const } : node) })
    expect(blocked.edges.find(edge => edge.id === 'relation:blocked-by:landing:1:landing:2')?.animated).toBe(false)
    const collapsed = webPanoramaLayout(graph, new Set(['landing', 'spec']))
    expect(collapsed.edges.filter(edge => edge.hidden).every(edge => !edge.animated)).toBe(true)
    expect(collapsed.edges.find(edge => edge.id === 'relation:hangs-off:phase:spec:phase:landing')?.animated).toBe(true)
    expect(collapsed.nodes.find(node => node.id === 'phase:landing')?.data.active).toBe(true)
  })

  it('shrinks cards while reserving readable horizontal, vertical, and phase connection gaps', () => {
    const { nodes } = webPanoramaLayout(graph)
    const steps = nodes.filter(node => node.parentId === 'phase:landing' && node.type === 'step')
    expect(Number(steps[0]!.style?.width)).toBe(200)
    expect(Number(steps[0]!.style?.height)).toBe(48)
    expect(steps[1]!.position.x - steps[0]!.position.x - Number(steps[0]!.style?.width)).toBe(56)
    const prerequisite = nodes.find(node => node.id === 'landing:1')!
    const dependent = nodes.find(node => node.id === 'landing:2')!
    expect(Number(prerequisite.style?.height)).toBe(96)
    expect(dependent.position.y - prerequisite.position.y - Number(prerequisite.style?.height)).toBe(SHIP_FLOW_GEOMETRY.ticketDagRowGap)
    const phases = nodes.filter(node => node.type === 'phase')
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]!.position.y - phases[i - 1]!.position.y - Number(phases[i - 1]!.style?.height)).toBe(96)
    }
    expect(Number(nodes.find(node => node.id === 'phase:grill')?.style?.height)).toBe(196)
    for (const node of nodes.filter(node => node.parentId)) {
      const parent = nodes.find(item => item.id === node.parentId)!
      expect(node.position.x + Number(node.style?.width)).toBeLessThan(Number(parent.style?.width))
      expect(node.position.y + Number(node.style?.height)).toBeLessThan(Number(parent.style?.height))
    }
  })

  it('routes cross-phase, skipping, and cyclic relations outside the node columns', () => {
    const { nodes, edges } = webPanoramaLayout({ ...graph, edges: [
      ...graph.edges,
      { from: 'landing:3', to: 'landing:1', kind: 'blocked-by' },
    ] })
    const width = Number(nodes.find(node => node.id === 'phase:landing')!.style?.width)
    const outer = edges.filter(edge => edge.data?.outside)
    expect(outer.map(edge => `${edge.source}->${edge.target}`).sort()).toEqual([
      'track:1->landing:2',
      'track:1->landing:3',
    ])
    expect(edges.find(edge => edge.source === 'landing:1' && edge.target === 'landing:3')?.data?.outside).toBeUndefined()
    expect(outer.every(edge => Number(edge.data?.laneX) < 0 || Number(edge.data?.laneX) > width)).toBe(true)
    expect(new Set(outer.map(edge => edge.data?.laneX)).size).toBe(outer.length)
    expect(outer.every(edge => edge.sourceHandle === 'relation-out' && edge.targetHandle === 'relation-in')).toBe(true)
    const cycle = webPanoramaLayout({ ...graph, edges: [
      { from: 'landing:1', to: 'landing:2', kind: 'blocked-by' },
      { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
    ] })
    expect(cycle.edges.filter(edge => edge.className === 'blocked-by').every(edge => edge.type === 'relation')).toBe(true)
    expect(cycle.edges.some(edge => edge.data?.outside)).toBe(true)
  })

  it('spaces a landing DAG so skipped-rank edges leave the columns and cards do not overlap', () => {
    const medal: ShipGraph = {
      version: 1, specPath: 'medal-of-honor-web.md', status: 'planned',
      nodes: [
        { id: 'landing:1', kind: 'landing', title: 'Project Scaffolding & Headless Game Engine Core', claim: 'claimed' },
        { id: 'landing:2', kind: 'landing', title: '3D FPS Player Controller & Pointer Lock Input System', claim: 'unclaimed' },
        { id: 'landing:3', kind: 'landing', title: 'Fortress Level Geometry & Spatial Collision World', claim: 'unclaimed' },
        { id: 'landing:4', kind: 'landing', title: 'WWII Arsenal, Ballistics & M1 Garand Ping System', claim: 'unclaimed' },
        { id: 'landing:5', kind: 'landing', title: 'Enemy Sentry AI FSM & Tactical Firefight System', claim: 'unclaimed' },
        { id: 'landing:6', kind: 'landing', title: 'Player Survival & Battlefield Resource Pickup System', claim: 'unclaimed' },
        { id: 'landing:7', kind: 'landing', title: '4-Phase Infiltration Mission Chain & Extraction Director', claim: 'unclaimed' },
        { id: 'landing:8', kind: 'landing', title: 'Medal of Honor Military Citation & After-Action Scoring', claim: 'unclaimed' },
        { id: 'landing:9', kind: 'landing', title: 'Web Audio API Procedural Battlefield Audio Engine', claim: 'unclaimed' },
        { id: 'landing:10', kind: 'landing', title: '3D Viewport Presentation, Retro HUD & Full Game Assembly', claim: 'unclaimed' },
        { id: 'landing:11', kind: 'landing', title: 'Release & Documentation Compliance', claim: 'unclaimed' },
      ],
      edges: [
        { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
        { from: 'landing:3', to: 'landing:1', kind: 'blocked-by' },
        { from: 'landing:4', to: 'landing:2', kind: 'blocked-by' },
        { from: 'landing:5', to: 'landing:3', kind: 'blocked-by' },
        { from: 'landing:5', to: 'landing:4', kind: 'blocked-by' },
        { from: 'landing:6', to: 'landing:2', kind: 'blocked-by' },
        { from: 'landing:6', to: 'landing:3', kind: 'blocked-by' },
        { from: 'landing:7', to: 'landing:3', kind: 'blocked-by' },
        { from: 'landing:7', to: 'landing:5', kind: 'blocked-by' },
        { from: 'landing:7', to: 'landing:6', kind: 'blocked-by' },
        { from: 'landing:8', to: 'landing:7', kind: 'blocked-by' },
        { from: 'landing:9', to: 'landing:4', kind: 'blocked-by' },
        { from: 'landing:10', to: 'landing:8', kind: 'blocked-by' },
        { from: 'landing:10', to: 'landing:9', kind: 'blocked-by' },
        { from: 'landing:11', to: 'landing:10', kind: 'blocked-by' },
      ],
    }
    const { nodes, edges } = webPanoramaLayout(medal)
    const tickets = nodes.filter(node => node.parentId === 'phase:landing' && node.type === 'ticket')
    const one = nodes.find(node => node.id === 'landing:1')!
    const two = nodes.find(node => node.id === 'landing:2')!
    const three = nodes.find(node => node.id === 'landing:3')!
    const four = nodes.find(node => node.id === 'landing:4')!
    const six = nodes.find(node => node.id === 'landing:6')!
    expect(two.position.y).toBe(three.position.y)
    expect(four.position.y).toBe(six.position.y)
    expect(two.position.y).toBeGreaterThan(one.position.y + Number(one.style?.height))
    expect(four.position.y - two.position.y).toBe(SHIP_FLOW_GEOMETRY.ticketHeight + SHIP_FLOW_GEOMETRY.ticketDagRowGap)
    expect(three.position.x - two.position.x).toBeGreaterThanOrEqual(SHIP_FLOW_GEOMETRY.ticketDagWidth + SHIP_FLOW_GEOMETRY.ticketDagGap)
    expect(edges.find(edge => edge.source === 'landing:3' && edge.target === 'landing:7')?.data?.outside).toBe(true)
    expect(edges.find(edge => edge.source === 'landing:9' && edge.target === 'landing:10')?.data?.outside).toBe(true)
    expect(edges.find(edge => edge.source === 'landing:1' && edge.target === 'landing:2')?.type).toBe('relation')
    expect(edges.find(edge => edge.source === 'landing:1' && edge.target === 'landing:2')?.data?.outside).toBeUndefined()
    expect(edges.find(edge => edge.source === 'landing:1' && edge.target === 'landing:2')?.label).toBeUndefined()
    expect(edges.find(edge => edge.source === 'landing:2' && edge.target === 'landing:4')?.type).toBe('relation')
    expect(edges.find(edge => edge.source === 'landing:2' && edge.target === 'landing:4')?.data?.outside).toBeUndefined()
    for (const [index, node] of tickets.entries()) {
      expect(node.position.x + Number(node.style?.width)).toBeLessThan(Number(nodes.find(item => item.id === 'phase:landing')!.style?.width))
      for (const other of tickets.slice(index + 1)) {
        const separateX = node.position.x + Number(node.style?.width) <= other.position.x || other.position.x + Number(other.style?.width) <= node.position.x
        const separateY = node.position.y + Number(node.style?.height) <= other.position.y || other.position.y + Number(other.style?.height) <= node.position.y
        expect(separateX || separateY).toBe(true)
      }
    }
  })

  it('staggers horizontal channels and splits outer lanes so concurrent prerequisites stay distinct', () => {
    const medal: ShipGraph = {
      version: 1, specPath: 'medal-of-honor-web.md', status: 'planned',
      nodes: [
        { id: 'landing:1', kind: 'landing', title: 'Project Scaffolding & 3D First-Person Core', claim: 'closed' },
        { id: 'landing:2', kind: 'landing', title: 'WWII Weaponry & Ballistics System', claim: 'claimed' },
        { id: 'landing:3', kind: 'landing', title: 'Normandy Environment & Tactical Level Construction', claim: 'closed' },
        { id: 'landing:4', kind: 'landing', title: 'Axis Enemy AI & Combat Health System', claim: 'unclaimed' },
        { id: 'landing:5', kind: 'landing', title: 'Mission Progression, Sabotage Objectives & Checkpoints', claim: 'unclaimed' },
        { id: 'landing:6', kind: 'landing', title: 'Procedural Web Audio Engine & Victory Decoration Ceremony', claim: 'unclaimed' },
        { id: 'landing:7', kind: 'landing', title: 'Release & Documentation Compliance', claim: 'unclaimed' },
      ],
      edges: [
        { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
        { from: 'landing:3', to: 'landing:1', kind: 'blocked-by' },
        { from: 'landing:4', to: 'landing:2', kind: 'blocked-by' },
        { from: 'landing:4', to: 'landing:3', kind: 'blocked-by' },
        { from: 'landing:5', to: 'landing:3', kind: 'blocked-by' },
        { from: 'landing:5', to: 'landing:4', kind: 'blocked-by' },
        { from: 'landing:6', to: 'landing:2', kind: 'blocked-by' },
        { from: 'landing:6', to: 'landing:5', kind: 'blocked-by' },
        { from: 'landing:7', to: 'landing:6', kind: 'blocked-by' },
      ],
    }
    const { nodes, edges } = webPanoramaLayout(medal)
    const width = Number(nodes.find(node => node.id === 'phase:landing')!.style?.width)
    const relations = edges.filter(edge => edge.className === 'blocked-by')
    const left = relations.filter(edge => Number(edge.data?.laneX) < 0)
    const right = relations.filter(edge => Number(edge.data?.laneX) > width)
    expect(relations.every(edge => edge.type === 'relation')).toBe(true)
    expect(left.map(edge => `${edge.source}->${edge.target}`)).toEqual(['landing:2->landing:6'])
    expect(right.map(edge => `${edge.source}->${edge.target}`)).toEqual(['landing:3->landing:5'])
    expect(new Set(left.map(edge => edge.data?.laneX)).size).toBe(left.length)
    expect(new Set(right.map(edge => edge.data?.laneX)).size).toBe(right.length)
    const fromOne = relations.filter(edge => edge.source === 'landing:1')
    expect(new Set(fromOne.map(edge => Number(edge.data?.exitOffset))).size).toBe(fromOne.length)
    const fromThree = relations.filter(edge => edge.source === 'landing:3')
    expect(new Set(fromThree.map(edge => Number(edge.data?.exitOffset))).size).toBe(fromThree.length)
    const intoFour = relations.filter(edge => edge.target === 'landing:4')
    expect(new Set(intoFour.map(edge => Number(edge.data?.entryOffset))).size).toBe(intoFour.length)
    for (const [index, edge] of relations.entries()) {
      const points = relationPoints(nodes, edge)
      for (const other of relations.slice(index + 1)) {
        expect(relationRunOverlap(points, relationPoints(nodes, other))).toBeLessThan(8)
      }
    }
  })

  it('fans sibling landing tickets beside a shared prerequisite and stacks a true wait below', () => {
    const honor: ShipGraph = {
      version: 1, specPath: 'honor.md', status: 'landing',
      nodes: [
        { id: 'landing:1', kind: 'landing', title: 'Engine Core', claim: 'closed' },
        { id: 'landing:2', kind: 'landing', title: 'Audio', claim: 'closed' },
        { id: 'landing:3', kind: 'landing', title: 'Arsenal', claim: 'closed' },
        { id: 'landing:4', kind: 'landing', title: 'Soldier AI', claim: 'closed' },
        { id: 'landing:5', kind: 'landing', title: 'Mission Director', claim: 'claimed' },
        { id: 'landing:6', kind: 'landing', title: 'HUD', claim: 'unclaimed' },
        { id: 'landing:7', kind: 'landing', title: 'Release', claim: 'unclaimed' },
      ],
      edges: [
        { from: 'landing:2', to: 'landing:1', kind: 'blocked-by' },
        { from: 'landing:3', to: 'landing:1', kind: 'blocked-by' },
        { from: 'landing:3', to: 'landing:2', kind: 'blocked-by' },
        { from: 'landing:4', to: 'landing:1', kind: 'blocked-by' },
        { from: 'landing:4', to: 'landing:2', kind: 'blocked-by' },
        { from: 'landing:4', to: 'landing:3', kind: 'blocked-by' },
        { from: 'landing:5', to: 'landing:4', kind: 'blocked-by' },
        { from: 'landing:6', to: 'landing:5', kind: 'blocked-by' },
        { from: 'landing:7', to: 'landing:6', kind: 'blocked-by' },
      ],
    }
    const { nodes, edges } = webPanoramaLayout(honor)
    const one = nodes.find(node => node.id === 'landing:1')!
    const two = nodes.find(node => node.id === 'landing:2')!
    const three = nodes.find(node => node.id === 'landing:3')!
    const four = nodes.find(node => node.id === 'landing:4')!
    const five = nodes.find(node => node.id === 'landing:5')!
    expect(two.position.y).toBe(three.position.y)
    expect(three.position.y).toBe(four.position.y)
    expect(new Set([two.position.x, three.position.x, four.position.x]).size).toBe(3)
    expect(two.position.y).toBeGreaterThan(one.position.y + Number(one.style?.height))
    expect(five.position.y).toBeGreaterThan(four.position.y + Number(four.style?.height))
    expect(edges.some(edge => edge.source === 'landing:2' && edge.target === 'landing:3')).toBe(false)
    expect(edges.some(edge => edge.source === 'landing:3' && edge.target === 'landing:4')).toBe(false)
    expect(edges.filter(edge => edge.className === 'blocked-by')).toEqual([
      expect.objectContaining({ source: 'landing:1', target: 'landing:2' }),
      expect.objectContaining({ source: 'landing:1', target: 'landing:3' }),
      expect.objectContaining({ source: 'landing:1', target: 'landing:4' }),
      expect.objectContaining({ source: 'landing:4', target: 'landing:5' }),
      expect.objectContaining({ source: 'landing:5', target: 'landing:6' }),
      expect.objectContaining({ source: 'landing:6', target: 'landing:7' }),
    ])
    expect(readFileSync(new URL('../src/ship-web-app.tsx', import.meta.url), 'utf8')).toContain('essentialBlockedBy(graph.edges)')
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
