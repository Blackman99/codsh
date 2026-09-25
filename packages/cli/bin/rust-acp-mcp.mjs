/**
 * Grok's MCP surface over dsh's own MCP client.
 *
 * dsh mounts the servers from the plan codsh-rust wrote (CODSH_MCP_PLAN) and
 * registers each tool as `mcp__<server>__<tool>`. This plugin adds what Grok
 * exposes on top of that, without a second MCP client:
 *
 *  - `search_tool` / `use_tool`: keyword search over the live MCP tools and a
 *    dispatcher that re-enters dsh's tool pipeline as the named tool, so the
 *    permission gate, hooks and cancellation see the real tool once.
 *  - the per-session catalog file the Rust TUI reads for `/mcps`.
 *  - the MCP output cap (`max_output_bytes`), spilling the full text to disk.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'rust-acp-mcp'
export const inject = ['tools']

export const MAX_DESCRIPTION = 2048
const TRUNCATION_SUFFIX = '\u2026 [truncated]'

export function loadPlan(env = process.env) {
  const path = env.CODSH_MCP_PLAN
  if (!path) return null
  try {
    const plan = JSON.parse(readFileSync(path, 'utf8'))
    return plan && typeof plan === 'object' ? plan : null
  } catch {
    return null
  }
}

/** Split a dsh public name into Grok's server and tool parts. */
export function splitPublicName(publicName, serverNames = []) {
  if (typeof publicName !== 'string' || !publicName.startsWith('mcp__')) return null
  const rest = publicName.slice(5)
  const known = [...serverNames].sort((a, b) => b.length - a.length)
  for (const server of known) {
    if (rest.startsWith(`${server}__`) && rest.length > server.length + 2) {
      return { server, tool: rest.slice(server.length + 2) }
    }
  }
  const at = rest.indexOf('__')
  if (at <= 0 || at + 2 >= rest.length) return null
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) }
}

export function truncateDescription(text) {
  const value = String(text ?? '')
  const chars = [...value]
  if (chars.length <= MAX_DESCRIPTION) return value
  return chars.slice(0, MAX_DESCRIPTION - TRUNCATION_SUFFIX.length).join('') + TRUNCATION_SUFFIX
}

function sanitize(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean).join(' ')
}

/** Group the visible MCP tool schemas by server. */
export function catalogOf(schemas, serverNames = []) {
  const servers = new Map()
  for (const name of serverNames) servers.set(name, [])
  for (const schema of schemas) {
    const parts = splitPublicName(schema?.name, serverNames)
    if (parts === null) continue
    if (!servers.has(parts.server)) servers.set(parts.server, [])
    servers.get(parts.server).push({
      name: `${parts.server}__${parts.tool}`,
      tool: parts.tool,
      publicName: schema.name,
      description: String(schema.description ?? ''),
      inputSchema: schema.parameters ?? { type: 'object' },
    })
  }
  for (const tools of servers.values()) tools.sort((a, b) => a.name.localeCompare(b.name))
  return servers
}

export function tokenize(text) {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * BM25 over tool name (weighted), server name and description. A query that
 * names a tool exactly (`server__tool` or `tool`) ranks it first.
 */
export function searchCatalog(catalog, query, limit = 5) {
  const docs = []
  for (const [server, tools] of catalog) {
    for (const tool of tools) {
      const nameTokens = tokenize(tool.tool)
      const terms = [...nameTokens, ...nameTokens, ...tokenize(server), ...tokenize(tool.description)]
      docs.push({ server, tool, terms })
    }
  }
  const queryTerms = [...new Set(tokenize(query))]
  const total = docs.length
  if (total === 0 || queryTerms.length === 0) return []
  const avg = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / total
  const df = new Map()
  for (const term of queryTerms) df.set(term, docs.filter(doc => doc.terms.includes(term)).length)
  const k1 = 1.2
  const b = 0.75
  const wanted = String(query ?? '').trim().toLowerCase()
  const scored = []
  for (const doc of docs) {
    let score = 0
    for (const term of queryTerms) {
      const tf = doc.terms.filter(item => item === term).length
      if (tf === 0) continue
      const n = df.get(term)
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5))
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.terms.length / (avg || 1)))
    }
    if (wanted === doc.tool.name.toLowerCase() || wanted === doc.tool.tool.toLowerCase()) score += 10
    if (score > 0) scored.push({ ...doc, score: Math.round(score * 1000) / 1000 })
  }
  scored.sort((a, b2) => b2.score - a.score || a.tool.name.localeCompare(b2.tool.name))
  const max = Number.isInteger(limit) && limit > 0 ? limit : 5
  return scored.slice(0, max)
}

export function searchResponse(catalog, query, limit) {
  const hits = searchCatalog(catalog, query, limit)
  let totalTools = 0
  for (const tools of catalog.values()) totalTools += tools.length
  const groups = []
  for (const hit of hits) {
    const entry = {
      tool_name: hit.tool.name,
      description: truncateDescription(sanitize(hit.tool.description)),
      score: hit.score,
      input_schema: hit.tool.inputSchema,
    }
    const group = groups.find(item => item.server === hit.server)
    if (group) group.tools.push(entry)
    else groups.push({ server: hit.server, tools: [entry] })
  }
  return {
    results: groups,
    total_hidden_tools: totalTools,
    status: 'ready',
    note: totalTools === 0
      ? 'No MCP tools are available in this session. Connect MCP servers here, or run `codsh mcp list` to see why a server is not connected.'
      : null,
  }
}

/** Resolve Grok's `server__tool` (or a dsh public name) to the dsh tool. */
export function resolveToolName(catalog, requested) {
  const wanted = String(requested ?? '').trim()
  if (!wanted) return null
  for (const tools of catalog.values()) {
    for (const tool of tools) {
      if (tool.name === wanted || tool.publicName === wanted) return tool
    }
  }
  return null
}

export function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .filter(block => block && block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `max` bytes. */
export function truncateUtf8(text, max) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= max) return text
  let end = max
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

function isJson(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/**
 * Cap one MCP text result at `max` bytes. The full text goes to
 * `<outputDir>/<callId>.<ext>` and the model sees Grok's truncation notice.
 */
export function capOutput(text, max, outputDir, callId) {
  const total = Buffer.byteLength(text, 'utf8')
  if (!(max > 0) || total <= max) return null
  let hint = ''
  if (outputDir) {
    const stem = String(callId || 'call').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96)
    const path = join(outputDir, `${stem}.${isJson(text) ? 'json' : 'txt'}`)
    try {
      mkdirSync(outputDir, { recursive: true, mode: 0o700 })
      writeFileSync(path, text, { mode: 0o600 })
      hint = ` Full output written to: ${path}.`
    } catch {
      hint = ''
    }
  }
  return `${truncateUtf8(text, max)}\n\n[MCP output truncated: showing first ${formatBytes(max)} of ${formatBytes(total)}.${hint}]`
}

function sessionIdOf(agent) {
  return agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id ?? 'unknown'
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function apply(ctx) {
  const plan = loadPlan()
  const serverNames = Array.isArray(plan?.servers) ? plan.servers.map(server => String(server.name)) : []
  const maxOutput = Number(plan?.maxOutputBytes) > 0 ? Number(plan.maxOutputBytes) : 20000
  const runDir = typeof plan?.runDir === 'string' ? plan.runDir : null
  const outputDir = runDir ? join(dirname(runDir), 'output') : null
  const agents = new Set()
  // dsh outlives codsh-rust by a few seconds while it shuts down, and tools
  // unregister then. Nobody reads the catalog after the client is gone, so
  // nothing is written into its run directory once the parent has exited.
  const parent = process.ppid

  const catalogFor = agent => catalogOf(ctx.tools.schemas(agent), serverNames)

  const writeCatalog = agent => {
    if (!runDir || process.ppid !== parent) return
    try {
      const catalog = catalogFor(agent)
      const servers = {}
      for (const [server, tools] of catalog) servers[server] = { tools }
      writeJsonAtomic(join(runDir, `catalog-${sessionIdOf(agent)}.json`), {
        sessionId: sessionIdOf(agent),
        updatedAt: new Date().toISOString(),
        servers,
      })
    } catch (error) {
      ctx.logger?.warn?.(`rust-acp-mcp: catalog not written: ${error?.message ?? error}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    agents.add(agent)
    writeCatalog(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    agents.delete(agent)
  })
  ctx.on('tools/change', () => {
    for (const agent of agents) writeCatalog(agent)
  })

  ctx.tools.register({
    name: 'search_tool',
    description: 'Search for MCP tools by keyword and retrieve their input schemas.\n\nIf status is "partial", some servers may still be connecting.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to match against tool names, server names, and descriptions. Include the server name and action for best results (e.g. "linear create issue", "slack read thread history").',
        },
        limit: { type: 'integer', description: 'Maximum number of results to return (default 5).' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const catalog = catalogFor(exec.agent)
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 255) : 5
      return JSON.stringify(searchResponse(catalog, String(args?.query ?? ''), limit), null, 2)
    },
  })

  ctx.tools.register({
    name: 'use_tool',
    description: 'Call an MCP integration tool.\n\nThe `tool_name` must be the qualified `server__tool` name (e.g., `linear__save_issue`). The `tool_input` must conform exactly to the tool\'s input schema as returned by `search_tool`.',
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Qualified MCP tool name, `server__tool`.' },
        tool_input: { type: 'object', description: 'Arguments for the tool, matching its input schema.' },
      },
      required: ['tool_name'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const catalog = catalogFor(exec.agent)
      const tool = resolveToolName(catalog, args?.tool_name)
      if (tool === null) {
        throw new Error(`Unknown MCP tool "${args?.tool_name ?? ''}". Use search_tool to find the qualified server__tool name.`)
      }
      const input = args?.tool_input && typeof args.tool_input === 'object' && !Array.isArray(args.tool_input)
        ? args.tool_input
        : {}
      const result = await ctx.tools.execute({
        callId: `${exec.callId}:use_tool`,
        rootCallId: exec.rootCallId ?? exec.callId,
        name: tool.publicName,
        arguments: input,
        agent: exec.agent,
        parent: exec.token,
        signal: exec.signal,
      })
      const text = textOf(result?.content)
      if (result?.isError) throw new Error(text || `MCP tool ${tool.name} failed`)
      const structured = result?.value?.structuredContent
      if (!text && structured !== undefined) return JSON.stringify(structured)
      return text
    },
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (result?.isError || typeof exec?.name !== 'string' || !exec.name.startsWith('mcp__')) return next()
    const capped = capOutput(textOf(result?.content), maxOutput, outputDir, exec.callId)
    if (capped === null) return next()
    return { kind: 'accept', content: [{ type: 'text', text: capped }] }
  })
}
