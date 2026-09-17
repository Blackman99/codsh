/** Loopback Web panorama: a local, read-only flowchart of the rebuilt Ship graph. */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { SHIP_GRAPH_VERSION, type ShipGraph } from './ship-graph.ts'

export {
  flowRelationWaypoints,
  relationRunOverlap,
  webPanoramaLayout,
  webPanoramaTitle,
  WEB_PANORAMA_TRACK_STUB,
  WEB_PANORAMA_TICKET_BRIEF_STUB,
  WEB_PANORAMA_TICKET_EVIDENCE_STUB,
} from './ship-flow.ts'

/** HTTP bits the loopback handler needs; tests fake these without a socket. */
export interface WebPanoramaRequest { url?: string | undefined }
export interface WebPanoramaResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): unknown
}

export const WEB_PANORAMA_LISTEN = { host: '127.0.0.1', port: 0 } as const
export interface WebPanoramaHandle { url: string; close(): void | Promise<void> }
const EMPTY_GRAPH: ShipGraph = { version: SHIP_GRAPH_VERSION, specPath: '', nodes: [], edges: [] }
const assetCache = new Map<string, string>()

/** Published modules live in lib; source-based tests use the same built assets. */
function readWebAsset(name: 'ship-web.js' | 'ship-web.css'): string {
  const cached = assetCache.get(name)
  if (cached !== undefined) return cached
  const body = readFileSync(new URL(`../lib/web/${name}`, import.meta.url), 'utf8')
  assetCache.set(name, body)
  return body
}

/** Bind once per TTY session; the getter remains the runner's rebuilt cache. */
export function bindWebPanorama(graph: () => ShipGraph | undefined): Promise<WebPanoramaHandle> {
  const server = createServer((request, response) => { handleWebPanoramaRequest(request, response, graph) })
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    server.listen({ host: WEB_PANORAMA_LISTEN.host, port: WEB_PANORAMA_LISTEN.port }, () => {
      server.off('error', onError)
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      let closed = false
      resolve({
        url: `http://${WEB_PANORAMA_LISTEN.host}:${String(port)}`,
        close: () => new Promise<void>((done, fail) => {
          if (closed) { done(); return }
          closed = true
          server.close(error => { if (error) fail(error); else done() })
        }),
      })
    })
  })
}

/** Only the page, its two packaged assets, and the live graph are served. */
export function handleWebPanoramaRequest(request: WebPanoramaRequest, response: WebPanoramaResponse, graph: () => ShipGraph | undefined): void {
  let path = '/'
  try { path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname } catch { path = '/' }
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  if (path === '/graph.json') {
    response.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' })
    response.end(`${JSON.stringify(graph() ?? EMPTY_GRAPH)}\n`)
    return
  }
  if (path === '/assets/ship-web.js' || path === '/assets/ship-web.css') {
    try {
      const script = path.endsWith('.js')
      const body = readWebAsset(script ? 'ship-web.js' : 'ship-web.css')
      response.writeHead(200, { ...headers, 'content-type': script ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' })
      response.end(body)
    } catch {
      response.writeHead(503, { ...headers, 'content-type': 'text/plain; charset=utf-8' })
      response.end('Ship Web assets are unavailable. Rebuild or reinstall codsh-bundle.')
    }
    return
  }
  if (path === '/' || path === '/index.html') {
    response.writeHead(200, {
      ...headers, 'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    })
    response.end(webPanoramaHtml())
    return
  }
  response.writeHead(404, headers)
  response.end()
}

/** Open is optional: the printed URL remains usable when the OS opener fails. */
export function openWebPanorama(url: string, run: typeof execFile = execFile, platform: NodeJS.Platform = process.platform): void {
  const command = platform === 'darwin' ? { file: 'open', args: [url] }
    : platform === 'win32' ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : { file: 'xdg-open', args: [url] }
  try { run(command.file, command.args, { timeout: 5_000 }, () => undefined) } catch { /* Optional open must not fail the run. */ }
}

export function webPanoramaHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Ship Flow · Web panorama</title>
<link rel="icon" href="data:,"/>
<link rel="stylesheet" href="/assets/ship-web.css"/>
</head>
<body>
<div id="root"><p>Loading Ship Flow. If this message remains, rebuild or reinstall codsh-bundle and reload this page.</p></div>
<noscript>Enable JavaScript to explore the Ship workflow.</noscript>
<script type="module" src="/assets/ship-web.js"></script>
</body>
</html>
`
}
