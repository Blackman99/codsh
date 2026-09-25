/** Ticket 196: the Ship extension's browser graph reads the terminal's own files. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleShipHook, readRunState, shipExtensionCommand } from '../src/ship-extension.ts'
import {
  handleShipWebRequest,
  rebuildShipGraphCache,
  rememberSummary,
  shipExtensionGraph,
  shipGraphLine,
  shipGraphSummary,
  shipRunGraph,
  webRecordPath,
  writeWebRecord,
  type ShipWebContext,
} from '../src/ship-extension-web.ts'
import type { ShipGraph } from '../src/ship-graph.ts'
import { WEB_PANORAMA_CSP, webPanoramaHtml } from '../src/ship-web.ts'

const SESSION = 'browser-session'
const TOKEN = '0123456789abcdef0123456789abcdef'
let cwd = ''
let data = ''

function invocation(args: string): string {
  const body = shipExtensionCommand().replace(/^---[\s\S]*?---\n/u, '')
  return `Run the custom command \`ship:ship\` from /x/ship/commands/ship.md. Arguments: ${args}\n\n${body}`
}

function prompt(text: string) {
  return handleShipHook({ event: 'user_prompt_submit', payload: { sessionId: SESSION, prompt: text, cwd }, dataDir: data, cwd })
}

function tool(name: string, input: unknown, result: string) {
  return handleShipHook({
    event: 'post_tool_use',
    payload: { sessionId: SESSION, tool_name: name, tool_input: input, tool_response: result, permissionMode: 'default', cwd },
    dataDir: data,
    cwd,
  })
}

function ask(id: string, question: string, answer: string) {
  return tool('ask_user_question', { questions: [{ id, header: 'ship · wayfinder', question, options: [{ label: answer }] }] }, JSON.stringify({ answers: [{ id, selected: [answer] }] }))
}

const spec = () => join(cwd, 'docs', 'specs', 'wayfinder-e2e.md')
const cache = () => join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.graph.json')
const answersFile = () => join(cwd, 'docs', 'specs', 'wayfinder-e2e.ship.answers.json')
const map = () => join(cwd, '.scratch', 'wayfinder-e2e', 'wayfinder')

function writeLedger(): void {
  mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true })
  writeFileSync(spec(), '# Wayfinder fixture\n\nStatus: wayfinding\n\n## Original Requirement\n\nMAP_WAYFINDER notes\n\n## Main Track\n\n**Idea.** MAP_WAYFINDER notes\n**Track-1.** Keep the original wording.\n\n## Wayfinder\n\nPending research remains.\n')
}

function writeMap(): void {
  mkdirSync(map(), { recursive: true })
  writeFileSync(join(map(), '01-repo-facts.md'), '# Repo facts\n\nType: research\nStatus: closed\n')
  writeFileSync(join(map(), '02-storage-choice.md'), `# Storage choice\n\nType: grilling\nStatus: resolved\nBlocked by: 1\n\n## Question\n\nWhich store?\n\n## User answer\n\n${'Append-only log. '.repeat(80)}\n`)
  writeFileSync(join(map(), '03-sync-policy.md'), '# Sync policy\n\nType: task\nStatus: claimed\nBlocked by: 1, 2\n\n## Question\n\nHow to merge?\n')
  writeFileSync(join(map(), '04-offline-prototype.md'), '# Offline prototype\n\nType: prototype\nStatus: open\nBlocked by: 3\n')
}

/** The run the hooks leave after `/ship`, the route answer, the ledger, and the map. */
function mappedRun(): void {
  expect(prompt(invocation('MAP_WAYFINDER notes')).stdout).toBe('')
  expect(ask('route', 'Is the route clear?', 'Continue').stdout).toBe('')
  writeLedger()
  expect(tool('write', { file_path: spec() }, 'ok').stdout).toBe('')
  writeMap()
  expect(tool('write', { file_path: join(map(), '04-offline-prototype.md') }, 'ok').stdout).toBe('')
}

function fakeResponse() {
  const out: { status?: number; headers?: Record<string, string> | undefined; body?: string | undefined } = {}
  return {
    out,
    writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers },
    end(body?: string) { out.body = body },
  }
}

function context(graph: () => ShipGraph | { error: string } = () => ({ version: 1, specPath: '', nodes: [], edges: [] })): ShipWebContext {
  return { token: TOKEN, port: 4321, graph, asset: name => `/* ${name} */` }
}

function get(url: string, extra: { host?: string; method?: string; context?: ShipWebContext } = {}) {
  const res = fakeResponse()
  handleShipWebRequest({ url, method: extra.method ?? 'GET', headers: { host: extra.host ?? '127.0.0.1:4321' } }, res, extra.context ?? context())
  return res.out
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'codsh-ship-web-'))
  data = join(cwd, '.plugin-data')
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('Ship extension browser server: access boundary', () => {
  it('serves the page, both assets, and graph.json only under the token', () => {
    for (const path of ['/', '/index.html']) {
      const page = get(`/${TOKEN}${path}`)
      expect(page.status).toBe(200)
      expect(page.headers?.['content-security-policy']).toBe(WEB_PANORAMA_CSP)
      expect(page.headers?.['cache-control']).toBe('no-store')
      expect(page.body).toBe(webPanoramaHtml('assets/'))
      expect(page.body).toContain('src="assets/ship-web.js"')
      expect(page.body).not.toContain('"/assets/')
    }
    expect(get(`/${TOKEN}/assets/ship-web.js`)).toMatchObject({ status: 200, body: '/* ship-web.js */' })
    expect(get(`/${TOKEN}/assets/ship-web.css`).headers?.['content-type']).toContain('text/css')
    const graph = get(`/${TOKEN}/graph.json`)
    expect(graph.status).toBe(200)
    expect(JSON.parse(graph.body ?? '')).toEqual({ version: 1, specPath: '', nodes: [], edges: [] })
    expect(get(`/${TOKEN}`)).toMatchObject({ status: 308, headers: expect.objectContaining({ location: `/${TOKEN}/` }) })
  })

  it('refuses other paths, other hosts, and writes', () => {
    for (const path of ['/', '/index.html', '/graph.json', '/assets/ship-web.js', `/${TOKEN.slice(1)}/graph.json`, `/${TOKEN}/../graph.json`, `/${TOKEN}/secret.json`, `/${TOKEN}x/`]) {
      expect(get(path).status, path).toBe(404)
    }
    expect(get(`/${TOKEN}/graph.json`, { host: 'evil.example:4321' }).status).toBe(421)
    expect(get(`/${TOKEN}/graph.json`, { host: '127.0.0.1:9999' }).status).toBe(421)
    expect(get(`/${TOKEN}/graph.json`, { host: 'localhost:4321' }).status).toBe(200)
    expect(get(`/${TOKEN}/graph.json`, { method: 'POST' }).status).toBe(405)
    const head = get(`/${TOKEN}/graph.json`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBeUndefined()
  })

  it('answers 503 on a join error so the page keeps its last graph', () => {
    const failed = get(`/${TOKEN}/graph.json`, { context: context(() => ({ error: 'Duplicate decision key decision:local:1.' })) })
    expect(failed.status).toBe(503)
    expect(failed.body).toContain('Duplicate decision key')
    const broken = { ...context(), asset: () => { throw new Error('missing') } }
    expect(get(`/${TOKEN}/assets/ship-web.js`, { context: broken }).status).toBe(503)
  })

  it('keeps the legacy page on absolute /assets/', () => {
    expect(webPanoramaHtml()).toContain('href="/assets/ship-web.css"')
    expect(webPanoramaHtml()).toContain('src="/assets/ship-web.js"')
  })

  it('writes the record owner-only', () => {
    const path = webRecordPath(data, cwd)
    writeWebRecord(path, { version: 1, cwd, sessionId: SESSION, token: TOKEN, port: 0, ownerPid: 0, nonce: 'n' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(data, 'web')).mode & 0o777).toBe(0o700)
    expect(rememberSummary(data, cwd, 'one')).toBe(true)
    expect(rememberSummary(data, cwd, 'one')).toBe(false)
    expect(rememberSummary(data, cwd, 'two')).toBe(true)
  })
})

describe('Ship extension browser graph: one persisted source', () => {
  it('shows the typed original and held answers before the ledger, with no guessed tickets', () => {
    expect(shipExtensionGraph(data, cwd)).toEqual({ version: 1, specPath: '', nodes: [], edges: [] })
    prompt(invocation('MAP_WAYFINDER notes'))
    ask('route', 'Is the route clear?', 'Continue')
    const graph = shipExtensionGraph(data, cwd) as ShipGraph
    expect(graph.specPath).toBe('')
    expect(graph.originalRequirement).toBe('MAP_WAYFINDER notes')
    expect(graph.nodes).toEqual([])
    expect(graph.answers?.map(answer => `${answer.id}=${answer.answer}`)).toEqual(['route=Continue'])
    expect(shipGraphSummary(graph)).toBe('Waiting for a Ship specification · 待认领 0 · 已认领 0 · 已关闭 0 · 1 of 1 decision answers recorded')
  })

  it('joins the ledger, answers, snapshot, and local tickets; the Status is the ledger, not ticket claims', () => {
    mappedRun()
    const graph = shipExtensionGraph(data, cwd) as ShipGraph
    expect(graph.specPath).toBe('wayfinder-e2e.md')
    expect(graph.status).toBe('wayfinding')
    expect(graph.originalRequirement).toBe('MAP_WAYFINDER notes')
    expect(graph.nodes.filter(node => node.kind === 'decision').map(node => `${node.id}:${node.claim}`)).toEqual([
      'decision:local:1:closed', 'decision:local:2:closed', 'decision:local:3:claimed', 'decision:local:4:unclaimed',
    ])
    expect(graph.edges.filter(edge => edge.kind === 'blocked-by').length).toBeGreaterThanOrEqual(3)
    expect(shipGraphSummary(graph)).toBe('wayfinder-e2e.md · Status: wayfinding · 待认领 1 · 已认领 1 · 已关闭 2 · 2 of 4 decision answers recorded')
    expect(shipGraphLine(graph, 'http://127.0.0.1:1/t/')).toBe(`Ship graph · ${shipGraphSummary(graph)} · http://127.0.0.1:1/t/`)
    expect(shipGraphLine(graph, undefined)).toContain('browser graph unavailable')
  })

  it('never reads the cache: a corrupt or deleted cache loses no answer, and a rebuild restores it', () => {
    mappedRun()
    const before = shipExtensionGraph(data, cwd) as ShipGraph
    const state = readRunState(data, cwd)!
    const rebuilt = rebuildShipGraphCache(state) as ShipGraph
    expect(rebuilt).toEqual(before)
    expect(JSON.parse(readFileSync(cache(), 'utf8'))).toEqual(before)
    // Ticket answers are folded into the answer record, never the reverse.
    const recorded = JSON.parse(readFileSync(answersFile(), 'utf8')).answers.map((row: { id: string }) => row.id)
    expect(recorded).toEqual(expect.arrayContaining(['route', 'decision:local:2', 'decision:local:3']))

    writeFileSync(cache(), '{ not json')
    expect(shipExtensionGraph(data, cwd)).toEqual(before)
    const again = rebuildShipGraphCache(state) as ShipGraph
    expect(again).toEqual(before)
    expect(JSON.parse(readFileSync(cache(), 'utf8')).answers).toEqual(before.answers)

    rmSync(cache())
    expect(shipExtensionGraph(data, cwd)).toEqual(before)
    // A later answer appears in the next request without any cache.
    ask('storage', 'Keep the append-only log?', 'Keep it')
    const after = shipExtensionGraph(data, cwd) as ShipGraph
    expect(after.answers?.find(answer => answer.id === 'storage')?.answer).toBe('Keep it')
    expect(shipGraphSummary(after)).toContain('3 of 5 decision answers recorded')
    expect(existsSync(cache())).toBe(false)
  })

  it('reports a join failure instead of guessing', () => {
    mappedRun()
    writeFileSync(join(map(), '01-duplicate.md'), '# Duplicate\n\nType: research\n')
    const state = readRunState(data, cwd)!
    expect(shipRunGraph(state)).toEqual({ error: expect.stringContaining('Duplicate decision key decision:local:1') })
    expect(rebuildShipGraphCache(state)).toEqual({ error: expect.stringContaining('Duplicate decision key') })
  })
})
