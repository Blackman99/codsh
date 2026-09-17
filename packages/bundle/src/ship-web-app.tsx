import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Background,
  BaseEdge,
  ControlButton,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeProps,
  type EdgeProps,
} from '@xyflow/react'
import { essentialBlockedBy } from './ship-dag.ts'
import type { ShipGraph } from './ship-graph.ts'
import {
  currentFlowPhase,
  flowAnswers,
  FLOW_CLAIM,
  FLOW_PHASE_STATE,
  ticketFlowState,
  SHIP_FLOW_PHASES,
  SHIP_FLOW_GEOMETRY,
  flowRelationPath,
  flowRelationWaypoints,
  webPanoramaLayout,
  webPanoramaTitle,
  WEB_PANORAMA_TRACK_STUB,
  WEB_PANORAMA_TICKET_BRIEF_STUB,
  WEB_PANORAMA_TICKET_EVIDENCE_STUB,
  type ShipFlowNode,
} from './ship-flow.ts'
import '@xyflow/react/dist/style.css'
import './ship-web.css'

const Actions = createContext({
  toggle: (_id: string) => {},
  inspect: (_id: string) => {},
})

function PhaseNode({ id, data }: NodeProps<ShipFlowNode>) {
  const actions = useContext(Actions)
  return (
    <section className={`phase-group ${data.state} ${data.active ? 'flow-active' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <header className="phase-heading">
        <button
          className="phase-title nodrag"
          onClick={(event) => {
            event.stopPropagation()
            actions.inspect(id)
          }}
        >
          <span className="level">{String(data.level).padStart(2, '0')}</span>
          <span>
            {data.title}
            <small>{data.description}</small>
          </span>
        </button>
        <div className="phase-tools">
          <span className={`phase-state ${data.state}`}>
            {FLOW_PHASE_STATE[data.state ?? 'unknown']}
          </span>
          <button
            className="fold nodrag"
            aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.title}`}
            aria-expanded={!data.collapsed}
            onClick={(event) => {
              event.stopPropagation()
              actions.toggle(data.phase)
            }}
          >
            {data.collapsed ? '+' : '−'}
          </button>
        </div>
      </header>
      {!data.collapsed && (
        <>
          <span className="steps-caption">Workflow steps</span>
          <p className="group-note">
            {data.empty ||
              (data.phase === 'spec'
                ? `${data.count} Main Track anchors`
                : `${data.closed}/${data.count} tickets closed`)}
          </p>
        </>
      )}
      <Handle type="source" position={Position.Bottom} />
    </section>
  )
}

function StepNode({ id, data }: NodeProps<ShipFlowNode>) {
  const actions = useContext(Actions)
  return (
    <button
      className="step-node nodrag"
      onClick={(event) => {
        event.stopPropagation()
        actions.inspect(id)
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span>{data.level}</span>
      {data.title}
      <Handle type="source" position={Position.Right} />
    </button>
  )
}

function TicketNode({ id, data }: NodeProps<ShipFlowNode>) {
  const actions = useContext(Actions)
  const ticket = data.ticket!
  const state = ticketFlowState(ticket)
  return (
    <button
      className={`ticket-node nodrag ${ticket.kind} ${state} ${data.active ? 'flow-active' : ''}`}
      title={ticket.title}
      onClick={(event) => {
        event.stopPropagation()
        actions.inspect(id)
      }}
    >
      <Handle id="relation-in" type="target" position={Position.Top} />
      <span className="ticket-id">{id}</span>
      <strong>{ticket.title}</strong>
      <span className={`claim ${state}`}>
        {ticket.kind === 'track'
          ? 'Main Track anchor'
          : ticket.claim
            ? FLOW_CLAIM[ticket.claim]
            : 'Claim not recorded'}
        {ticket.ticketType && ` · ${ticket.ticketType}`}
      </span>
      <Handle
        id="answer-out"
        type="source"
        position={Position.Right}
        style={{ top: SHIP_FLOW_GEOMETRY.ticketHeight / 2 }}
      />
      <Handle id="relation-out" type="source" position={Position.Bottom} />
    </button>
  )
}

function ContextNode({ id, data }: NodeProps<ShipFlowNode>) {
  const actions = useContext(Actions)
  return (
    <section className="context-node">
      <Handle type="target" position={Position.Top} />
      <button className="content-heading nodrag" onClick={() => actions.inspect(id)}>
        {data.title}
      </button>
      <div className="node-content nodrag nowheel" tabIndex={0} aria-label={data.title}>
        <p className={data.text ? 'source-text' : 'muted'}>{data.text || data.empty}</p>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </section>
  )
}

function AnswerNode({ id, data }: NodeProps<ShipFlowNode>) {
  const actions = useContext(Actions)
  const answer = data.answer!
  return (
    <section className={`answer-node ${answer.answer ? 'answered' : 'unanswered'}`}>
      <Handle type="target" position={Position.Top} />
      <Handle
        id="answer-in"
        type="target"
        position={Position.Left}
        style={{ top: SHIP_FLOW_GEOMETRY.ticketHeight / 2 }}
      />
      <button className="content-heading nodrag" aria-label={`Inspect decision: ${answer.question}`} onClick={() => actions.inspect(id)}>
        Decision · {answer.answer ? 'User answer recorded' : 'No user answer recorded'}
      </button>
      <div className="node-content nodrag nowheel" tabIndex={0} aria-label={`Decision: ${answer.question}`}>
        <h3 className="source-text">{answer.question}</h3>
        {answer.detail && <p className="source-text muted">{answer.detail}</p>}
        <span className="answer-label">User answer</span>
        <p className={answer.answer ? 'source-text' : 'muted'}>{answer.answer || 'No user answer recorded. Ticket status does not imply a user response.'}</p>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </section>
  )
}

function RelationEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, label, data }: EdgeProps) {
  const route = {
    ...(Number.isFinite(Number(data?.laneX)) ? { laneX: Number(data?.laneX) } : {}),
    ...(Number.isFinite(Number(data?.exitOffset)) ? { exitOffset: Number(data?.exitOffset) } : {}),
    ...(Number.isFinite(Number(data?.entryOffset)) ? { entryOffset: Number(data?.entryOffset) } : {}),
  }
  const points = flowRelationWaypoints(sourceX, sourceY, targetX, targetY, route)
  const path = flowRelationPath(points)
  const laneStart = points[Math.min(2, points.length - 1)]!
  const laneEnd = points[Math.min(3, points.length - 1)]!
  return (
    <BaseEdge
      id={id}
      path={path}
      {...(markerEnd ? { markerEnd } : {})}
      label={label}
      labelX={laneStart.x}
      labelY={(laneStart.y + laneEnd.y) / 2}
      labelBgPadding={[6, 4]}
      labelBgBorderRadius={4}
    />
  )
}

const edgeTypes = { relation: RelationEdge }
const nodeTypes = { phase: PhaseNode, step: StepNode, ticket: TicketNode, context: ContextNode, answer: AnswerNode }
const EMPTY_GRAPH: ShipGraph = {
  version: 1,
  specPath: '',
  nodes: [],
  edges: [],
}

function App() {
  const [graph, setGraph] = useState<ShipGraph>(EMPTY_GRAPH)
  const [connected, setConnected] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const flow = useReactFlow<ShipFlowNode>()
  const layout = useMemo(
    () => webPanoramaLayout(graph, collapsed),
    [graph, collapsed],
  )
  const selectedNode = layout.nodes.find((node) => node.id === selected)
  const current = currentFlowPhase(graph)
  const answers = useMemo(() => flowAnswers(graph), [graph])
  const title = useMemo(() => webPanoramaTitle(graph), [graph])

  useEffect(() => {
    document.title = title
  }, [title])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let request: AbortController | undefined
    async function load() {
      request = new AbortController()
      const deadline = setTimeout(() => request?.abort(), 5000)
      try {
        const response = await fetch('/graph.json', {
          cache: 'no-store',
          signal: request.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const next = (await response.json()) as ShipGraph
        if (
          next.version !== 1 ||
          !Array.isArray(next.nodes) ||
          !Array.isArray(next.edges)
        )
          throw new Error('Invalid graph')
        if (!stopped) {
          setGraph((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          )
          setConnected(true)
          setLoaded(true)
        }
      } catch {
        if (!stopped) setConnected(false)
      } finally {
        clearTimeout(deadline)
        if (!stopped)
          timer = setTimeout(() => {
            void load()
          }, 1000)
      }
    }
    void load()
    return () => {
      stopped = true
      clearTimeout(timer)
      request?.abort()
    }
  }, [])

  useEffect(() => {
    setSelected(undefined)
    setCollapsed(new Set())
  }, [graph.specPath])

  const fit = (id?: string, nodes = layout.nodes, duration = 600) => {
    const node = id ? nodes.find((item) => item.id === id) : undefined
    const lanes = layout.edges
      .filter(edge => !edge.hidden)
      .map(edge => Number(edge.data?.laneX))
      .filter(lane => Number.isFinite(lane))
    if (node) {
      const parent = nodes.find((item) => item.id === node.parentId)
      const x = node.position.x + (parent?.position.x ?? 0)
      const phaseLanes = node.type === 'phase'
        ? layout.edges.filter(edge =>
          !edge.hidden
          && nodes.some(item =>
            (item.id === node.id || item.parentId === node.id)
            && (item.id === edge.source || item.id === edge.target),
          )
          && Number.isFinite(Number(edge.data?.laneX)),
        ).map(edge => Number(edge.data?.laneX))
        : []
      const minX = node.type === 'phase' ? Math.min(x, ...phaseLanes.map(lane => lane - 64)) : x
      const maxX = node.type === 'phase'
        ? Math.max(x + Number(node.style?.width), ...phaseLanes.map(lane => lane + 64))
        : x + Number(node.style?.width)
      void flow.fitBounds(
        {
          x: minX,
          y: node.position.y + (parent?.position.y ?? 0),
          width: Math.max(Number(node.style?.width), maxX - minX),
          height: Number(node.style?.height),
        },
        { padding: 0.18, duration },
      )
    } else {
      const phases = nodes.filter((item) => item.type === 'phase')
      const last = phases.at(-1)!
      const minX = Math.min(0, ...lanes.map(lane => lane - 64))
      const maxX = Math.max(
        SHIP_FLOW_GEOMETRY.width,
        ...nodes.filter(item => item.type === 'phase' || item.type === 'context').map(item => Number(item.style?.width)),
        ...lanes.map(lane => lane + 64),
      )
      void flow.fitBounds(
        {
          x: minX,
          y: 0,
          width: maxX - minX,
          height: last.position.y + Number(last.style?.height),
        },
        { padding: 0.12, duration },
      )
    }
  }
  const focus = (id: string, duration = 600) => {
    setSelected(id)
    const phaseId = id.startsWith('phase:') ? id.slice('phase:'.length) : undefined
    const node = layout.nodes.find(item => item.id === id)
    const targetPhase = phaseId || (node?.parentId && node.data?.phase)
    if (targetPhase && collapsed.has(targetPhase)) {
      const next = new Set(collapsed)
      next.delete(targetPhase)
      setCollapsed(next)
      fit(id, webPanoramaLayout(graph, next).nodes, duration)
    } else {
      fit(id, layout.nodes, duration)
    }
  }
  const inspect = (id: string) => {
    setSelected(id)
  }
  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const related = essentialBlockedBy(graph.edges).filter(
    (edge) => edge.from === selected || edge.to === selected,
  )
  const ticket = selectedNode?.data.ticket
  const phase = SHIP_FLOW_PHASES.find(
    (item) => item.id === selectedNode?.data.phase,
  )
  const answer = selectedNode?.data.answer
  const ticketAnswers = ticket ? answers.filter(item => item.ticketId === ticket.id) : []

  return (
    <Actions.Provider value={{ toggle, inspect }}>
      <main className="ship-layout">
        <aside className="sidebar-left" aria-label="Workflow navigation and controls">
          <div className="sidebar-header">
            <div className="brand">
              <span className="brand-mark">/</span>
              <h1 title={title}>{title}</h1>
            </div>
            <span
              className={`connection ${connected ? 'live' : ''}`}
              role="status"
            >
              {connected
                ? 'Live · local'
                : loaded
                  ? 'Disconnected · retrying'
                  : 'Connecting · retrying'}
            </span>
          </div>

          <div className="spec-card" title={graph.specPath}>
            <span className="spec-label">Specification</span>
            <span className="spec-name">
              {graph.specPath || 'Waiting for a Ship specification'}
            </span>
          </div>

          <div className="sidebar-section controls-section">
            <div className="current-phase-row">
              <span>Current phase</span>
              <span className="current-phase-badge">
                {current
                  ? SHIP_FLOW_PHASES.find((item) => item.id === current)!.title
                  : 'Phase not recorded'}
              </span>
            </div>
            <div className="canvas-actions">
              <button
                type="button"
                onClick={() => setCollapsed(new Set())}
              >
                Expand all
              </button>
              <button
                type="button"
                onClick={() =>
                  setCollapsed(
                    new Set(SHIP_FLOW_PHASES.map((item) => item.id)),
                  )
                }
              >
                Collapse all
              </button>
              <button
                type="button"
                onClick={() => fit()}
              >
                Fit view
              </button>
            </div>
          </div>

          <nav className="context-nav" aria-label="Ship context">
            <h2>Ship context</h2>
            <button onClick={() => focus('context:requirement')}>Original requirement</button>
            <button onClick={() => focus('context:objective')}>Ship goal</button>
            <p>{answers.filter(item => item.answer).length} of {answers.length} decision answers recorded</p>
          </nav>

          <nav className="phase-nav" aria-label="Ship phases">
            <div className="phase-nav-header">
              <h2>Ship workflow</h2>
              <p>Layers follow the Ship process.</p>
            </div>
            <div className="nav-phase-list">
              {SHIP_FLOW_PHASES.map((item, i) => (
                <button
                  key={item.id}
                  className={`nav-phase ${layout.nodes.find((node) => node.id === `phase:${item.id}`)?.data.state ?? 'unknown'} ${current === item.id ? 'active' : ''}`}
                  title={
                    FLOW_PHASE_STATE[
                      layout.nodes.find((node) => node.id === `phase:${item.id}`)
                        ?.data.state ?? 'unknown'
                    ]
                  }
                  aria-current={current === item.id ? 'step' : undefined}
                  onClick={() => focus(`phase:${item.id}`)}
                >
                  <span>{String(i + 1).padStart(2, '0')}</span>
                  {item.title}
                </button>
              ))}
            </div>
          </nav>

          {!connected && (
            <p className="connection-notice" role="alert">
              {loaded
                ? 'Showing the last received graph. Keep the codsh session open; reconnecting automatically.'
                : 'Waiting for the local Ship server. The workflow guide remains available.'}
            </p>
          )}
        </aside>

        <section className="canvas-section" aria-label="Ship flowchart">
          <div className={`flow-canvas ${connected ? 'is-live' : ''}`}>
            <ReactFlow<ShipFlowNode>
              nodes={layout.nodes}
              edges={layout.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              onNodeClick={(_event, node) => inspect(node.id)}
              deleteKeyCode={null}
              minZoom={0.1}
              maxZoom={1.5}
              nodeOrigin={[0, 0]}
              defaultViewport={{ x: 24, y: 24, zoom: 0.75 }}
              onInit={(instance) => {
                void instance.fitView({
                  nodes: [{ id: 'context:requirement' }, { id: 'context:objective' }],
                  padding: 0.14,
                  maxZoom: 1,
                })
              }}
              onPaneClick={() => setSelected(undefined)}
            >
              <Background gap={24} size={1} color="#c9d4df" />
              <Controls position="bottom-right" showInteractive={false} showFitView={false}>
                <ControlButton
                  title="Fit view"
                  aria-label="Fit view"
                  onClick={() => fit()}
                >
                  ⊡
                </ControlButton>
              </Controls>
            </ReactFlow>
          </div>
        </section>

        <aside className="sidebar-right details" aria-label="Node details and legend">
          <div className="details-section">
            <h2>Node details</h2>
            {selectedNode ? (
              <>
                <p className="detail-label">
                  {selectedNode.type === 'context' ? 'Ship context' : `Layer ${SHIP_FLOW_PHASES.findIndex(item => item.id === phase?.id) + 1} · ${phase?.title}`}
                </p>
                <h3 className="source-text">{selectedNode.data.title}</h3>
                {selectedNode.type === 'context' ? (
                  <>
                    <p className="source-text">{selectedNode.data.text || selectedNode.data.empty}</p>
                    <p className="muted">Recorded source text is shown without translation or summarization.</p>
                  </>
                ) : answer ? (
                  <>
                    {answer.detail && <><h4>Question context</h4><p className="source-text">{answer.detail}</p></>}
                    <h4>User answer</h4>
                    <p className="source-text">{answer.answer || 'No user answer recorded.'}</p>
                    {answer.source && <><h4>Source</h4><p className="source-text">{answer.source}</p></>}
                    {answer.ticketId && <><h4>Decision ticket</h4><code>{answer.ticketId}</code></>}
                    <p className="muted">User responses are separate from ticket claims and automated approvals.</p>
                  </>
                ) : ticket ? (
                  <>
                    <code>{ticket.id}</code>
                    {ticket.kind === 'track' ? (
                      <p>{WEB_PANORAMA_TRACK_STUB}</p>
                    ) : (
                      <>
                        <p className={`claim ${ticketFlowState(ticket)}`}>
                          {ticket.claim
                            ? FLOW_CLAIM[ticket.claim]
                            : 'Claim not recorded'}
                        </p>
                        {ticket.ticketType && <p>Type: {ticket.ticketType}</p>}
                        {ticket.kind === 'landing' && (
                          <>
                            <h4>{WEB_PANORAMA_TICKET_BRIEF_STUB}</h4>
                            <p className="muted">A brief has not been attached to this graph.</p>
                            <h4>{WEB_PANORAMA_TICKET_EVIDENCE_STUB}</h4>
                            <p className="muted">Proof is not included in this view.</p>
                          </>
                        )}
                      </>
                    )}
                    {ticketAnswers.length > 0 && (
                      <>
                        <h4>Decision answers</h4>
                        {ticketAnswers.map(item => (
                          <div key={item.id} className="detail-answer">
                            <strong className="source-text">{item.question}</strong>
                            <p className="source-text">{item.answer || 'No user answer recorded.'}</p>
                          </div>
                        ))}
                      </>
                    )}
                    {related.length > 0 && (
                      <>
                        <h4>Relations</h4>
                        <ul className="relations">
                          {related.map((edge, i) => {
                            const other =
                              edge.from === ticket.id ? edge.to : edge.from
                            return (
                              <li key={i}>
                                <span>
                                  {edge.kind === 'blocked-by'
                                    ? edge.from === ticket.id
                                      ? 'Blocked by'
                                      : 'Unblocks'
                                    : edge.from === ticket.id
                                      ? 'Main Track'
                                      : 'Supports'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const node = layout.nodes.find(
                                      (item) => item.id === other,
                                    )
                                    if (node) {
                                      const next = new Set(collapsed)
                                      next.delete(node.data.phase)
                                      setCollapsed(next)
                                      setSelected(other)
                                      fit(
                                        other,
                                        webPanoramaLayout(graph, next).nodes,
                                      )
                                    }
                                  }}
                                >
                                  {other}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <p>{phase?.description}</p>
                    {selectedNode.type === 'phase' && (
                      <p
                        className={`phase-state ${selectedNode.data.state ?? 'unknown'}`}
                      >
                        {FLOW_PHASE_STATE[selectedNode.data.state ?? 'unknown']}
                      </p>
                    )}
                    <h4>Workflow steps</h4>
                    <ol>
                      {phase?.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    <p className="muted">
                      These steps describe the phase contract. Phase status, ticket claims, and recorded decision answers update live; individual step completion is not inferred.
                    </p>
                    {answers.some(item => item.phase === phase?.id) && (
                      <>
                        <h4>Decision answers</h4>
                        <ul className="relations">
                          {answers.filter(item => item.phase === phase?.id).map(item => (
                            <li key={item.id}>
                              <button onClick={() => focus(`answer:${item.id}`)}>{item.question}</button>
                              <span>{item.answer ? 'User answer recorded' : 'No user answer recorded'}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <h3>From decisions to delivery.</h3>
                <p>
                  Select a requirement, goal, decision answer, phase, step, or ticket to inspect its place in the workflow.
                </p>
                <p className="muted">
                  Start with the original requirement and Ship goal, then follow the arrows through all six phases. Decision cards show the recorded questions and user answers directly in the graph.
                </p>
                {graph.nodes.length === 0 && (
                  <p className="empty-note">
                    No tickets yet. The phase structure stays visible while Ship
                    prepares the specification.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="sidebar-legends">
            <div className="status-legend" aria-label="Node status colors">
              <h3>Node status</h3>
              <div className="legend-group">
                <strong>Phases</strong>
                <div className="legend-pills">
                  {(['current', 'passed', 'upcoming', 'unknown'] as const).map(
                    (state) => (
                      <span key={state} className={`phase-state ${state}`}>
                        {FLOW_PHASE_STATE[state]}
                      </span>
                    ),
                  )}
                </div>
              </div>
              <div className="legend-group">
                <strong>Tickets</strong>
                <div className="legend-pills">
                  {(['unclaimed', 'claimed', 'closed'] as const).map((claim) => (
                    <span key={claim} className={`claim ${claim}`}>
                      {FLOW_CLAIM[claim]}
                    </span>
                  ))}
                  <span className="claim anchor">Track anchor</span>
                </div>
              </div>
            </div>

            <div className="canvas-legend" aria-label="Connection types">
              <h3>Connections</h3>
              <div className="legend-lines">
                <span>
                  <i className="line" /> Phase sequence
                </span>
                <span>
                  <i className="line dependency" /> Prerequisite → dependent
                </span>
                <span>
                  <i className="line track-line" /> Track → ticket
                </span>
                <span>
                  <i className="line answer-line" /> Decision answer
                </span>
              </div>
            </div>
          </div>
        </aside>
      </main>
    </Actions.Provider>
  )
}

createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
)
