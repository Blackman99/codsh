/**
 * Browser graph for the optional Ship extension (ticket 196): the legacy
 * React Flow panorama, served from the same persisted state the terminal
 * hooks write, so the browser and the terminal cannot drift.
 *
 * - One loopback server per workspace, bound to the dsh session that ran
 *   `/ship`. It listens on `127.0.0.1` only, serves only under a random
 *   128-bit path prefix (`http://127.0.0.1:<port>/<token>/`), answers GET and
 *   HEAD for the page, its two packaged assets, and `graph.json`, and refuses
 *   any other Host header (DNS rebinding) or path.
 * - `graph.json` is joined on every request from the files the hooks own:
 *   the run state (typed idea, answers held before the ledger), the spec,
 *   `<spec>.ship.answers.json`, `<spec>.ship.json`, and local wayfinder
 *   tickets. It never reads the graph cache, so a deleted or corrupt cache
 *   cannot lose an answer, and the spec Status is reported as written, never
 *   inferred from ticket claims.
 * - The server exits when the dsh process that owns it exits, when the
 *   session ends (SessionEnd), or when its record disappears (the plugin was
 *   uninstalled with its data). The record keeps the port and token, so a
 *   resumed session (SessionStart) reopens the same URL and an open tab
 *   reconnects by itself.
 * - The hooks rebuild `<spec>.ship.graph.json` like the legacy runner
 *   (discard an invalid cache, join, write, fold ticket answers into the
 *   answer record) and print one summary line with the same counts the page
 *   shows, only when it changes.
 * @module codsh-bundle/src/ship-extension-web
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { freezeText } from './ship-snapshot.ts'
import { isShipAnswersError, mergeShipAnswers, readShipAnswers, shipAnswerListsEqual, writeShipAnswers } from './ship-answers.ts'
import { flowAnswers } from './ship-flow.ts'
import {
  collectJoinSources,
  graphPathFor,
  isShipGraphDiscard,
  isShipGraphJoinError,
  joinShipGraph,
  readShipGraph,
  SHIP_GRAPH_VERSION,
  teaserCounts,
  writeShipGraph,
  type ShipGraph,
  type ShipUserAnswer,
} from './ship-graph.ts'
import { isShipSnapshotError, readShipSnapshot } from './ship-snapshot.ts'
import {
  block,
  handleShipHook,
  readRunState,
  runStatePath,
  writeRunState,
  type ShipHookInput,
  type ShipHookOutput,
  type ShipRunState,
} from './ship-extension.ts'
import { WEB_PANORAMA_CSP, webPanoramaHtml } from './ship-web.ts'
import { setShipGraphCacheHook } from './ship-extension-runner.ts'

export const SHIP_WEB_HOST = '127.0.0.1'
const EMPTY_GRAPH: ShipGraph = { version: SHIP_GRAPH_VERSION, specPath: '', nodes: [], edges: [] }

/** The persisted record of a workspace's browser server (`<data>/web/<key>.json`). */
export interface ShipWebRecord {
  version: 1
  cwd: string
  sessionId: string
  /** 32 hex chars; the only path prefix the server answers. */
  token: string
  /** Last bound port; a restart for the same session asks for it again. */
  port: number
  /** dsh process that owns the server; 0 when unknown. */
  ownerPid: number
  /** Set by the running server; cleared when it exits. */
  pid?: number
  url?: string
  /** Ties a starting server to the hook that spawned it. */
  nonce: string
  /** Last summary line printed to the terminal. */
  summary?: string
}

/** Where a workspace's server record lives (same key as its run state). */
export function webRecordPath(dataDir: string, cwd: string): string {
  return join(dataDir, 'web', basename(runStatePath(dataDir, cwd)))
}

export function readWebRecord(path: string): ShipWebRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ShipWebRecord
    if (value?.version !== 1 || typeof value.token !== 'string' || !/^[0-9a-f]{32}$/u.test(value.token)) return undefined
    return value
  } catch {
    return undefined
  }
}

/** Atomic, owner-only write: the token is the access boundary. */
export function writeWebRecord(path: string, record: ShipWebRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try { chmodSync(dirname(path), 0o700) } catch { /* best effort */ }
  const tmp = `${path}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

/** True when a process exists (EPERM still means it exists). */
export function processAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function answersExtras(state: ShipRunState, specPath: string): { answers?: ShipUserAnswer[]; originalRequirement?: string } | { error: string } {
  const loaded = readShipAnswers(specPath)
  if (isShipAnswersError(loaded)) return loaded
  const answers = mergeShipAnswers(loaded?.answers, state.pending)
  const snapshot = readShipSnapshot(specPath)
  const original = !isShipSnapshotError(snapshot) && snapshot !== undefined && snapshot.limitedHistory !== true && snapshot.originalRequirement !== ''
    ? snapshot.originalRequirement
    : undefined
  return {
    ...(answers.length === 0 ? {} : { answers }),
    ...(original === undefined ? {} : { originalRequirement: original }),
  }
}

/**
 * The graph for a run, joined from persisted sources only. Before a spec is
 * bound it is the legacy pre-spec graph: the typed original and the answers
 * held so far, with no guessed tickets.
 */
export function shipRunGraph(state: ShipRunState | undefined): ShipGraph | { error: string } {
  if (state === undefined) return EMPTY_GRAPH
  if (state.specPath === undefined) {
    const original = freezeText(state.idea)
    return {
      version: SHIP_GRAPH_VERSION,
      specPath: '',
      ...(original === '' ? {} : { originalRequirement: original, objective: original }),
      ...(state.pending.length === 0 ? {} : { answers: state.pending }),
      nodes: [],
      edges: [],
    }
  }
  let markdown: string
  try {
    markdown = readFileSync(state.specPath, 'utf8')
  } catch {
    return { error: `Bound spec is unreadable at ${state.specPath}.` }
  }
  const extras = answersExtras(state, state.specPath)
  if ('error' in extras) return extras
  const collected = collectJoinSources(state.cwd, state.specPath, markdown, extras)
  if (isShipGraphJoinError(collected)) return collected
  return joinShipGraph(collected)
}

/** The workspace's graph as the server sees it on each request. */
export function shipExtensionGraph(dataDir: string, cwd: string): ShipGraph | { error: string } {
  return shipRunGraph(readRunState(dataDir, cwd))
}

/**
 * Hook side, after the run state changed: rebuild the graph cache beside
 * the spec as the legacy runner does. An invalid cache is discarded; answers
 * found in local tickets are folded into the answer record, never the
 * reverse. A join failure is returned so `/ship` stops instead of guessing.
 */
export function rebuildShipGraphCache(state: ShipRunState): ShipGraph | { error: string } {
  const specPath = state.specPath
  if (specPath !== undefined) {
    const loaded = readShipGraph(specPath)
    if (isShipGraphDiscard(loaded)) {
      try { unlinkSync(graphPathFor(specPath)) } catch { /* leftover cache is not identity */ }
    }
  }
  const graph = shipRunGraph(state)
  if ('error' in graph || specPath === undefined) return graph
  const existing = readShipAnswers(specPath)
  if (isShipAnswersError(existing)) return existing
  const merged = mergeShipAnswers(existing?.answers, graph.answers)
  if (merged.length > 0 && (existing === undefined || !shipAnswerListsEqual(merged, existing.answers))) {
    try {
      writeShipAnswers({ version: 1, specPath: basename(specPath), answers: merged }, specPath)
    } catch {
      return { error: `Ship answers record could not be written beside ${specPath}. Stopped.` }
    }
  }
  try {
    writeShipGraph(graph, specPath)
  } catch {
    // The graph is rebuilt from sources on the next hook and on every request.
  }
  return graph
}

// Every runner commit carries a current cache (the browser and a resume read it).
setShipGraphCacheHook(state => {
  rebuildShipGraphCache(state)
})

/**
 * One line with what the page shows: the ledger Status (never inferred),
 * the legacy teaser buckets, and the recorded decision answers.
 */
export function shipGraphSummary(graph: ShipGraph): string {
  const counts = teaserCounts(graph)
  const answers = flowAnswers(graph)
  const recorded = answers.filter(item => item.answer).length
  const status = graph.specPath === ''
    ? 'Waiting for a Ship specification'
    : `${graph.specPath} · Status: ${graph.status ?? 'not recorded'}`
  return `${status} · 待认领 ${String(counts.unclaimed)} · 已认领 ${String(counts.claimed)} · 已关闭 ${String(counts.closed)} · ${String(recorded)} of ${String(answers.length)} decision answers recorded`
}

/** What the terminal prints: the summary and the page URL. */
export function shipGraphLine(graph: ShipGraph, url: string | undefined): string {
  return `Ship graph · ${shipGraphSummary(graph)}${url === undefined ? ' · browser graph unavailable' : ` · ${url}`}`
}

/** HTTP bits the handler needs; tests fake these without a socket. */
export interface ShipWebRequest { url?: string | undefined; method?: string | undefined; headers: Record<string, string | string[] | undefined> }
export interface ShipWebResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): unknown
}

export interface ShipWebContext {
  token: string
  port: number
  graph: () => ShipGraph | { error: string }
  asset: (name: 'ship-web.js' | 'ship-web.css') => string
}

/**
 * Serve `/<token>/`, `/<token>/index.html`, `/<token>/graph.json`, and
 * `/<token>/assets/ship-web.{js,css}`; everything else is 404. Only GET and
 * HEAD, only for a loopback Host naming this port.
 */
export function handleShipWebRequest(request: ShipWebRequest, response: ShipWebResponse, context: ShipWebContext): void {
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
  const head = request.method === 'HEAD'
  const send = (status: number, extra: Record<string, string>, body = ''): void => {
    response.writeHead(status, { ...headers, ...extra })
    response.end(head ? undefined : body)
  }
  const host = String(request.headers.host ?? '').toLowerCase()
  const port = String(context.port)
  if (host !== `${SHIP_WEB_HOST}:${port}` && host !== `localhost:${port}`) {
    send(421, { 'content-type': 'text/plain; charset=utf-8' }, 'Misdirected request.')
    return
  }
  if (request.method !== 'GET' && !head) {
    send(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, 'Method not allowed.')
    return
  }
  let path = '/'
  try { path = new URL(request.url ?? '/', `http://${SHIP_WEB_HOST}`).pathname } catch { path = '' }
  const base = `/${context.token}`
  if (path === base) {
    send(308, { location: `${base}/` })
    return
  }
  if (!path.startsWith(`${base}/`)) {
    send(404, {})
    return
  }
  const rest = path.slice(base.length)
  if (rest === '/graph.json') {
    const graph = context.graph()
    if ('error' in graph) {
      // The page keeps the last graph it received and retries.
      send(503, { 'content-type': 'text/plain; charset=utf-8' }, graph.error)
      return
    }
    send(200, { 'content-type': 'application/json; charset=utf-8' }, `${JSON.stringify(graph)}\n`)
    return
  }
  if (rest === '/assets/ship-web.js' || rest === '/assets/ship-web.css') {
    const script = rest.endsWith('.js')
    let body: string
    try {
      body = context.asset(script ? 'ship-web.js' : 'ship-web.css')
    } catch {
      send(503, { 'content-type': 'text/plain; charset=utf-8' }, 'Ship Web assets are unavailable. Rebuild or reinstall the Ship extension.')
      return
    }
    send(200, { 'content-type': script ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }, body)
    return
  }
  if (rest === '/' || rest === '/index.html') {
    send(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': WEB_PANORAMA_CSP }, webPanoramaHtml('assets/'))
    return
  }
  send(404, {})
}

export function shipWebUrl(port: number, token: string): string {
  return `http://${SHIP_WEB_HOST}:${String(port)}/${token}/`
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    server.listen({ host: SHIP_WEB_HOST, port }, () => {
      server.off('error', onError)
      const address = server.address()
      resolvePort(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

export interface ShipWebServerOptions {
  recordPath: string
  nonce: string
  dataDir: string
  assetsDir: string
  /** Owner poll interval; tests shorten it. */
  pollMs?: number
  /** Exit after this long without a request when the owner is unknown. */
  idleMs?: number
}

/**
 * The server process body (`hooks/ship-web.mjs`). Resolves when the server
 * has stopped. The record written by the spawning hook names the workspace,
 * session, token, preferred port, and owner.
 */
export async function runShipWebServer(options: ShipWebServerOptions): Promise<void> {
  const initial = readWebRecord(options.recordPath)
  if (initial === undefined || initial.nonce !== options.nonce) return
  const assets = new Map<string, string>()
  const asset = (name: 'ship-web.js' | 'ship-web.css'): string => {
    const cached = assets.get(name)
    if (cached !== undefined) return cached
    const body = readFileSync(join(options.assetsDir, name), 'utf8')
    assets.set(name, body)
    return body
  }
  let lastRequest = Date.now()
  let port = 0
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    lastRequest = Date.now()
    handleShipWebRequest(request, response, {
      token: initial.token,
      port,
      graph: () => shipExtensionGraph(options.dataDir, initial.cwd),
      asset,
    })
  })
  try {
    port = await listen(server, initial.port)
  } catch {
    port = await listen(server, 0)
  }
  const url = shipWebUrl(port, initial.token)
  writeWebRecord(options.recordPath, { ...initial, port, pid: process.pid, url })
  const idleMs = options.idleMs ?? 30 * 60_000
  await new Promise<void>((done) => {
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      clearInterval(timer)
      const current = readWebRecord(options.recordPath)
      if (current !== undefined && current.pid === process.pid) {
        const { pid: _pid, url: _url, ...rest } = current
        try { writeWebRecord(options.recordPath, rest) } catch { /* record directory removed */ }
      }
      server.close(() => { done() })
      server.closeAllConnections()
    }
    const timer = setInterval(() => {
      const current = readWebRecord(options.recordPath)
      if (current === undefined || current.pid !== process.pid || current.token !== initial.token) { stop(); return }
      if (initial.ownerPid > 0 ? !processAlive(initial.ownerPid) : Date.now() - lastRequest > idleMs) stop()
    }, options.pollMs ?? 1000)
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    process.once('SIGHUP', stop)
  })
}

export interface EnsureShipWebOptions {
  dataDir: string
  cwd: string
  sessionId: string
  ownerPid: number
  /** Absolute path of the bundled server script. */
  serverScript: string
  /** Node executable for the server. */
  node?: string
  timeoutMs?: number
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(done => setTimeout(done, 50))
  }
  return check()
}

/** Stop the workspace's server, keeping its port and token for a resume. */
export async function stopShipWeb(dataDir: string, cwd: string, sessionId?: string): Promise<boolean> {
  const path = webRecordPath(dataDir, cwd)
  const record = readWebRecord(path)
  if (record === undefined || record.pid === undefined) return false
  if (sessionId !== undefined && record.sessionId !== sessionId) return false
  const pid = record.pid
  if (processAlive(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    await waitFor(() => !processAlive(pid), 3000)
  }
  const current = readWebRecord(path)
  if (current !== undefined && current.pid === pid) {
    const { pid: _pid, url: _url, ...rest } = current
    writeWebRecord(path, rest)
  }
  return true
}

/**
 * Start (or reuse) the workspace's server for this session and owner. A
 * server owned by another session or dsh process is stopped first. The same
 * session keeps its token and asks for its previous port, so an open tab
 * reconnects to the same URL.
 */
export async function ensureShipWeb(options: EnsureShipWebOptions): Promise<{ url: string } | { error: string }> {
  const path = webRecordPath(options.dataDir, options.cwd)
  const record = readWebRecord(path)
  if (record?.pid !== undefined && processAlive(record.pid) && record.url !== undefined
    && record.sessionId === options.sessionId && record.ownerPid === options.ownerPid) {
    return { url: record.url }
  }
  if (record?.pid !== undefined) await stopShipWeb(options.dataDir, options.cwd)
  const same = record !== undefined && record.sessionId === options.sessionId
  const nonce = randomBytes(8).toString('hex')
  const next: ShipWebRecord = {
    version: 1,
    cwd: resolve(options.cwd),
    sessionId: options.sessionId,
    token: same ? record.token : randomBytes(16).toString('hex'),
    port: same ? record.port : 0,
    ownerPid: options.ownerPid,
    nonce,
    ...(same && record.summary !== undefined ? { summary: record.summary } : {}),
  }
  writeWebRecord(path, next)
  const child = spawn(options.node ?? process.execPath, [options.serverScript, '--record', path, '--nonce', nonce], {
    cwd: dirname(options.serverScript),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, GROK_PLUGIN_DATA: options.dataDir },
  })
  child.unref()
  let url: string | undefined
  const started = await waitFor(() => {
    const current = readWebRecord(path)
    if (current?.nonce !== nonce || current.pid === undefined || current.url === undefined) return false
    url = current.url
    return true
  }, options.timeoutMs ?? 8000)
  if (!started || url === undefined) return { error: 'the local browser server did not start' }
  return { url }
}

/** Remember the summary last printed; true when it changed. */
export function rememberSummary(dataDir: string, cwd: string, line: string): boolean {
  const path = webRecordPath(dataDir, cwd)
  const record = readWebRecord(path)
  if (record === undefined || record.summary === line) return false
  writeWebRecord(path, { ...record, summary: line })
  return true
}

/** How the hook process reaches the browser server. */
export interface ShipWebHookOptions {
  /** Absolute path of `hooks/ship-web.mjs`. */
  serverScript: string
  /** dsh process running the hook (`CODSH_HOOK_HOST_PID`); 0 when unknown. */
  ownerPid: number
  node?: string
}

function field(payload: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = payload[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function note(line: string): ShipHookOutput {
  return { stdout: `${JSON.stringify({ systemMessage: line })}\n`, exitCode: 0 }
}

const QUIET: ShipHookOutput = { stdout: '', exitCode: 0 }

async function serve(input: ShipHookInput, sessionId: string, web: ShipWebHookOptions): Promise<string | undefined> {
  const started = await ensureShipWeb({
    dataDir: input.dataDir,
    cwd: input.cwd,
    sessionId,
    ownerPid: web.ownerPid,
    serverScript: web.serverScript,
    ...(web.node === undefined ? {} : { node: web.node }),
  })
  return 'url' in started ? started.url : undefined
}

function remember(input: ShipHookInput, line: string): boolean {
  try {
    return rememberSummary(input.dataDir, input.cwd, line)
  } catch {
    return true
  }
}

function liveUrl(input: ShipHookInput): string | undefined {
  const record = readWebRecord(webRecordPath(input.dataDir, input.cwd))
  return record?.pid !== undefined && processAlive(record.pid) ? record.url : undefined
}

/**
 * {@link handleShipHook} plus the browser graph: `/ship` starts or reuses
 * the server and prints the summary with its URL; a tool that changed the
 * run rebuilds the cache and prints the summary only when it changed;
 * SessionStart reopens the same URL for a resumed session; SessionEnd stops
 * the server.
 */
/** The systemMessage of a non-blocking prompt result, if that is all it is. */
function promptNotice(out: ShipHookOutput): string | undefined {
  if (out.stdout === '') return undefined
  try {
    const value = JSON.parse(out.stdout) as { decision?: unknown; systemMessage?: unknown }
    return value.decision === undefined && typeof value.systemMessage === 'string' ? value.systemMessage : undefined
  } catch {
    return undefined
  }
}

export async function handleShipHookWithWeb(input: ShipHookInput, web: ShipWebHookOptions): Promise<ShipHookOutput> {
  const sessionId = field(input.payload, 'sessionId', 'session_id')
  const event = input.event || field(input.payload, 'hook_event_name')
  if (event === 'SessionEnd' || event === 'session_end') {
    await stopShipWeb(input.dataDir, input.cwd, sessionId)
    return QUIET
  }
  if (event === 'SessionStart' || event === 'session_start') {
    const record = readWebRecord(webRecordPath(input.dataDir, input.cwd))
    const state = readRunState(input.dataDir, input.cwd)
    if (record === undefined || state === undefined || record.sessionId !== sessionId || state.sessionId !== sessionId) return QUIET
    const url = await serve(input, sessionId, web)
    const graph = shipRunGraph(state)
    const line = 'error' in graph ? `Ship graph · ${graph.error}` : shipGraphLine(graph, url)
    remember(input, line)
    return note(line)
  }
  const out = handleShipHook(input)
  const prompt = event === 'UserPromptSubmit' || event === 'user_prompt_submit'
  const tool = event === 'PostToolUse' || event === 'post_tool_use'
  if (field(input.payload, 'permissionMode') === 'plan') return out
  // A /ship notice (a rolled-back conflict resolution) still gets the graph line.
  const notice = prompt ? promptNotice(out) : undefined
  if ((out.stdout !== '' && notice === undefined) || (!prompt && !tool)) {
    // The runner spoke (a note, a gate, a Stop continuation) or this is a
    // runner-only event: refresh the cache the browser and a resume read,
    // and never add a line. A Stop note without a continuation would make
    // the host take another model step.
    const after = readRunState(input.dataDir, input.cwd)
    if (after !== undefined && after.sessionId === sessionId && after.specPath !== undefined) {
      try { rebuildShipGraphCache(after) } catch { /* the cache is disposable */ }
    }
    return out
  }
  const state = readRunState(input.dataDir, input.cwd)
  // handleShipHook ends the run on any other prompt, so an active run here
  // for this session means this prompt was /ship.
  if (state === undefined || !state.active || state.sessionId !== sessionId) return out
  const graph = rebuildShipGraphCache(state)
  if ('error' in graph) {
    writeRunState(input.dataDir, { ...state, active: false })
    return block(graph.error)
  }
  if (prompt) {
    const url = await serve(input, sessionId, web)
    const line = shipGraphLine(graph, url)
    remember(input, line)
    return note(notice === undefined ? line : `${notice}\n${line}`)
  }
  const line = shipGraphLine(graph, liveUrl(input))
  return remember(input, line) ? note(line) : out
}
