/**
 * Loopback Web panorama: one `127.0.0.1` server of the rebuilt Ship graph.
 * Look is unspecified; this page is a node-link plus stub briefs.
 * @module codsh-bundle/src/ship-web
 */

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { SHIP_GRAPH_VERSION, type ShipGraph, type ShipGraphNode } from './ship-graph.ts'

/** HTTP bits the loopback handler needs; tests fake these without a socket. */
export interface WebPanoramaRequest {
  url?: string | undefined
}

export interface WebPanoramaResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): unknown
}

/** Loopback bind: never `0.0.0.0` or a LAN address. */
export const WEB_PANORAMA_LISTEN = { host: '127.0.0.1', port: 0 } as const

/** Track-anchor click stub: not a ticket, no proof. */
export const WEB_PANORAMA_TRACK_STUB = 'This Track anchor is not a ticket and has no proof.'

/** Ticket-node brief slot until a later ticket fills it. */
export const WEB_PANORAMA_TICKET_BRIEF_STUB = 'Brief (stub)'

/** Ticket-node evidence slot until a later ticket fills it. */
export const WEB_PANORAMA_TICKET_EVIDENCE_STUB = 'Evidence (stub)'

/** One live loopback handle. */
export interface WebPanoramaHandle {
  url: string
  close(): void | Promise<void>
}

const EMPTY_GRAPH: ShipGraph = {
  version: SHIP_GRAPH_VERSION,
  specPath: '',
  nodes: [],
  edges: [],
}

/**
 * Bind `127.0.0.1` on an ephemeral port and serve the live graph plus a
 * minimal node-link page. The getter is the rebuilt cache, not a second store.
 */
export function bindWebPanorama(graph: () => ShipGraph | undefined): Promise<WebPanoramaHandle> {
  const server = createServer((request, response) => {
    handleWebPanoramaRequest(request, response, graph)
  })
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    // Never `0.0.0.0` / LAN — loopback ephemeral only.
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

/** Route `/` and `/graph.json` for the loopback page. */
export function handleWebPanoramaRequest(
  request: WebPanoramaRequest,
  response: WebPanoramaResponse,
  graph: () => ShipGraph | undefined,
): void {
  let path = '/'
  try {
    path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    path = '/'
  }
  if (path === '/graph.json') {
    const payload = graph() ?? EMPTY_GRAPH
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(`${JSON.stringify(payload)}\n`)
    return
  }
  if (path === '/' || path === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(webPanoramaHtml())
    return
  }
  response.writeHead(404)
  response.end()
}

/**
 * Open the loopback URL. Darwin `open`, Linux `xdg-open`, Windows `cmd /c start`.
 * Failures are silent: the printed URL still stands.
 */
export function openWebPanorama(
  url: string,
  run: typeof execFile = execFile,
  platform: NodeJS.Platform = process.platform,
): void {
  const command = platform === 'darwin'
    ? { file: 'open', args: [url] }
    : platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : { file: 'xdg-open', args: [url] }
  try {
    run(command.file, command.args, { timeout: 5_000 }, () => undefined)
  } catch {
    // Optional open must not fail the run.
  }
}

/** Minimal node-link page. Palette and chrome are not specified. */
export function webPanoramaHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Web panorama</title>
<style>
  html,body{margin:0;font:13px/1.4 ui-monospace,monospace}
  main{display:grid;grid-template-columns:1fr 22rem;min-height:100vh}
  svg{width:100%;height:100vh;display:block}
  aside{border-left:1px solid #444;padding:1rem}
  .stub{opacity:.7}
</style>
</head>
<body>
<main>
  <svg id="g" viewBox="0 0 640 640" role="img" aria-label="Ship graph"></svg>
  <aside id="brief"><p class="stub">Click a node.</p></aside>
</main>
<script>
const TRACK_STUB = ${JSON.stringify(WEB_PANORAMA_TRACK_STUB)};
const BRIEF_STUB = ${JSON.stringify(WEB_PANORAMA_TICKET_BRIEF_STUB)};
const EVIDENCE_STUB = ${JSON.stringify(WEB_PANORAMA_TICKET_EVIDENCE_STUB)};
const CLAIM = { unclaimed: "待认领", claimed: "已认领", closed: "已关闭" };
const CX = 320, CY = 320;
// Ring radius is layout, not time, priority, or merge order. The inner-ring hole stays empty.
const svg = document.getElementById("g");
const brief = document.getElementById("brief");
let selected = null;
function polar(r, i, n) {
  const a = n <= 0 ? 0 : (Math.PI * 2 * i) / n - Math.PI / 2;
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
}
function posOf(nodes) {
  const inner = nodes.filter(n => n.kind === "decision");
  const tracks = nodes.filter(n => n.kind === "track");
  const outer = nodes.filter(n => n.kind === "landing");
  const pos = {};
  inner.forEach((n, i) => { pos[n.id] = polar(90, i, inner.length); });
  tracks.forEach((n, i) => { pos[n.id] = polar(160, i, tracks.length); });
  outer.forEach((n, i) => { pos[n.id] = polar(230, i, outer.length); });
  return pos;
}
function draw(graph) {
  const ns = "http://www.w3.org/2000/svg";
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const ring = (r) => {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", CX); c.setAttribute("cy", CY); c.setAttribute("r", r);
    c.setAttribute("fill", "none"); c.setAttribute("stroke", "#ddd");
    svg.appendChild(c);
  };
  ring(90); ring(160); ring(230);
  const nodes = graph.nodes || [];
  const inner = nodes.filter(n => n.kind === "decision");
  if (inner.length === 0) {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", CX); t.setAttribute("y", CY - 6);
    t.setAttribute("text-anchor", "middle");
    t.textContent = "empty inner ring";
    svg.appendChild(t);
  }
  const pos = posOf(nodes);
  for (const e of graph.edges || []) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const l = document.createElementNS(ns, "line");
    l.setAttribute("x1", a.x); l.setAttribute("y1", a.y);
    l.setAttribute("x2", b.x); l.setAttribute("y2", b.y);
    l.setAttribute("stroke", e.kind === "hangs-off" ? "#6ad" : "#999");
    svg.appendChild(l);
  }
  for (const n of nodes) {
    const p = pos[n.id];
    if (!p) continue;
    const g = document.createElementNS(ns, "g");
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", p.x); c.setAttribute("cy", p.y); c.setAttribute("r", 8);
    c.setAttribute("fill", n.kind === "track" ? "#6ad" : n.kind === "landing" ? "#8af" : "#d8e");
    g.appendChild(c);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", p.x + 12); label.setAttribute("y", p.y + 4);
    label.textContent = n.id;
    g.appendChild(label);
    const show = () => { selected = n.id; renderBrief(n); };
    g.addEventListener("click", show);
    g.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); show(); } });
    svg.appendChild(g);
  }
}
function renderBrief(n) {
  if (!n) { brief.innerHTML = "<p class=\\"stub\\">Click a node.</p>"; return; }
  if (n.kind === "track") {
    brief.innerHTML = "<h2>" + n.id + "</h2><p>" + TRACK_STUB + "</p>";
    return;
  }
  const claim = n.claim ? (CLAIM[n.claim] || n.claim) : "—";
  brief.innerHTML = "<h2>" + n.id + "</h2><p>" + n.title + "</p><p>Claim: " + claim +
    "</p><p class=\\"stub\\">" + BRIEF_STUB + "</p><p class=\\"stub\\">" + EVIDENCE_STUB + "</p>";
}
async function load() {
  const graph = await (await fetch("/graph.json")).json();
  draw(graph);
  const still = selected && (graph.nodes || []).find(n => n.id === selected);
  renderBrief(still);
}
load();
setInterval(load, 1000);
</script>
</body>
</html>
`
}

/** Layout helper: ring radius is not time, priority, or merge order. */
export function webPanoramaLayout(nodes: readonly ShipGraphNode[]): Record<string, { ring: 'inner' | 'track' | 'outer'; index: number }> {
  const inner = nodes.filter(node => node.kind === 'decision')
  const tracks = nodes.filter(node => node.kind === 'track')
  const outer = nodes.filter(node => node.kind === 'landing')
  const layout: Record<string, { ring: 'inner' | 'track' | 'outer'; index: number }> = {}
  inner.forEach((node, index) => { layout[node.id] = { ring: 'inner', index } })
  tracks.forEach((node, index) => { layout[node.id] = { ring: 'track', index } })
  outer.forEach((node, index) => { layout[node.id] = { ring: 'outer', index } })
  return layout
}
