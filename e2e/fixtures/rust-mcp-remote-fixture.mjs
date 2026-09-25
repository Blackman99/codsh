#!/usr/bin/env node
// Keyless loopback remote MCP server for codsh tests (ticket 168). One
// process serves, on 127.0.0.1 only:
//   - MCP streamable HTTP at /mcp (JSON or SSE replies, Mcp-Session-Id),
//   - the legacy HTTP+SSE transport at /sse + /messages,
//   - an OAuth 2.1 authorization server (RFC 9728 protected-resource
//     metadata, RFC 8414 metadata, RFC 7591 registration, authorization code
//     + PKCE S256 with auto-consent, refresh, RFC 7009 revocation) when
//     started with --oauth.
// Tools exercise elicitation (form and URL), image content, resources,
// session loss (404) and token expiry (401). Every request is appended to
// $MCP_REMOTE_DIR/requests.log (secrets redacted) and tool calls to
// calls.log. Prints `LISTENING <port>` once ready.
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=')
  return [key, rest.length ? rest.join('=') : 'true']
}))
const OAUTH = args.has('oauth')
const NO_DCR = args.has('no-dcr')
const TOKEN_TTL = Number(args.get('token-ttl') ?? 3600)
const PORT = Number(args.get('port') ?? 0)
const DIR = process.env.MCP_REMOTE_DIR ?? process.cwd()
mkdirSync(DIR, { recursive: true })
let base = ''

// 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const clients = new Map() // client_id -> { redirect_uris }
const codes = new Map() // code -> { client_id, redirect_uri, challenge, resource, scope }
const tokens = new Map() // access token -> { client_id, expires, revoked }
const refreshTokens = new Map() // refresh token -> { client_id, revoked }
const sessions = new Map() // Mcp-Session-Id -> { capabilities }
const legacy = new Map() // legacy sessionId -> { res, capabilities }
const waiting = new Map() // server request id -> resolve(message)
let nextServerId = 1

function log(file, entry) {
  appendFileSync(join(DIR, file), `${JSON.stringify(entry)}\n`)
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers })
  res.end(text)
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function challenge(error) {
  const parts = [`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`]
  if (error) parts.push(`error="${error}"`)
  return `Bearer ${parts.join(', ')}`
}

// Returns the token record, or answers 401 and returns null.
function authorize(req, res) {
  if (!OAUTH) return { client_id: 'none' }
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const record = tokens.get(token)
  if (!record) {
    send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': challenge(token ? 'invalid_token' : '') })
    return null
  }
  if (record.revoked || record.expires < Date.now()) {
    send(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': challenge('invalid_token') })
    return null
  }
  return record
}

function issueTokens(clientId, scope) {
  const access = b64url(randomBytes(24))
  const refresh = b64url(randomBytes(24))
  tokens.set(access, { client_id: clientId, expires: Date.now() + TOKEN_TTL * 1000, revoked: false })
  refreshTokens.set(refresh, { client_id: clientId, revoked: false, scope })
  return { access_token: access, token_type: 'Bearer', expires_in: TOKEN_TTL, refresh_token: refresh, scope }
}

async function oauthRoute(req, res, url) {
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp'] })
  }
  if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
    const metadata = {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    }
    if (!NO_DCR) metadata.registration_endpoint = `${base}/register`
    return send(res, 200, metadata)
  }
  if (url.pathname === '/register' && req.method === 'POST' && !NO_DCR) {
    const body = JSON.parse(await readBody(req) || '{}')
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
    if (!uris.length || !uris.every(uri => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(uri))) {
      return send(res, 400, { error: 'invalid_redirect_uri' })
    }
    const id = `client-${clients.size + 1}`
    clients.set(id, { redirect_uris: uris })
    log('oauth.log', { event: 'register', client_id: id, token_endpoint_auth_method: body.token_endpoint_auth_method })
    return send(res, 201, { client_id: id, redirect_uris: uris, token_endpoint_auth_method: 'none' })
  }
  if (url.pathname === '/authorize' && req.method === 'GET') {
    const q = url.searchParams
    const client = clients.get(q.get('client_id'))
    const redirect = q.get('redirect_uri')
    if (!client || !client.redirect_uris.includes(redirect)) return send(res, 400, 'unknown client or redirect_uri')
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) {
      return send(res, 400, 'PKCE S256, state and response_type=code are required')
    }
    const code = b64url(randomBytes(16))
    codes.set(code, { client_id: q.get('client_id'), redirect_uri: redirect, challenge: q.get('code_challenge'), resource: q.get('resource'), scope: q.get('scope') ?? '' })
    log('oauth.log', { event: 'authorize', client_id: q.get('client_id'), resource: q.get('resource'), scope: q.get('scope') })
    const target = new URL(redirect)
    target.searchParams.set('code', code)
    target.searchParams.set('state', q.get('state'))
    target.searchParams.set('iss', base)
    res.writeHead(302, { Location: target.toString() })
    return res.end()
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req))
    const grant = form.get('grant_type')
    if (grant === 'authorization_code') {
      const entry = codes.get(form.get('code') ?? '')
      codes.delete(form.get('code') ?? '')
      if (!entry || entry.client_id !== form.get('client_id') || entry.redirect_uri !== form.get('redirect_uri')) {
        return send(res, 400, { error: 'invalid_grant' })
      }
      const computed = b64url(createHash('sha256').update(form.get('code_verifier') ?? '').digest())
      if (computed !== entry.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
      if (entry.resource && form.get('resource') && form.get('resource') !== entry.resource) return send(res, 400, { error: 'invalid_target' })
      log('oauth.log', { event: 'token', grant, client_id: entry.client_id, resource: form.get('resource') })
      return send(res, 200, issueTokens(entry.client_id, entry.scope))
    }
    if (grant === 'refresh_token') {
      const entry = refreshTokens.get(form.get('refresh_token') ?? '')
      if (!entry || entry.revoked || entry.client_id !== form.get('client_id')) return send(res, 400, { error: 'invalid_grant' })
      entry.revoked = true
      log('oauth.log', { event: 'token', grant, client_id: entry.client_id })
      return send(res, 200, issueTokens(entry.client_id, entry.scope))
    }
    return send(res, 400, { error: 'unsupported_grant_type' })
  }
  if (url.pathname === '/revoke' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req))
    const token = form.get('token') ?? ''
    const hint = form.get('token_type_hint') ?? ''
    if (tokens.has(token)) tokens.get(token).revoked = true
    if (refreshTokens.has(token)) refreshTokens.get(token).revoked = true
    log('oauth.log', { event: 'revoke', hint })
    res.writeHead(200)
    return res.end()
  }
  return false
}

const TOOLS = [
  { name: 'echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'whoami', description: 'Report the request headers the server saw.', inputSchema: { type: 'object', properties: {} } },
  { name: 'picture', description: 'Return a tiny PNG image.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ask_name', description: 'Ask the user for a name with a form elicitation.', inputSchema: { type: 'object', properties: {} } },
  { name: 'open_link', description: 'Ask the user to visit a URL (URL elicitation).', inputSchema: { type: 'object', properties: {} } },
  { name: 'forget_session', description: 'Drop every MCP session (the next request gets 404).', inputSchema: { type: 'object', properties: {} } },
  { name: 'expire_tokens', description: 'Expire every access token (the next request gets 401).', inputSchema: { type: 'object', properties: {} } },
]

const text = value => ({ content: [{ type: 'text', text: value }] })

async function callTool(name, input, ctx) {
  log('calls.log', { tool: name, input })
  switch (name) {
    case 'echo':
      return text(`echo:${input.text ?? ''}`)
    case 'whoami':
      return text(JSON.stringify({
        codshSession: ctx.headers['x-codsh-session'] ?? null,
        authorized: Boolean(ctx.headers.authorization),
        protocol: ctx.headers['mcp-protocol-version'] ?? null,
        transport: ctx.transport,
      }))
    case 'picture':
      return { content: [{ type: 'text', text: 'a picture' }, { type: 'image', data: PNG, mimeType: 'image/png' }] }
    case 'ask_name': {
      if (!ctx.capabilities?.elicitation) return { ...text('client did not advertise elicitation'), isError: true }
      const reply = await ctx.request('elicitation/create', {
        message: 'Who is asking?',
        requestedSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name', minLength: 1 },
            color: { type: 'string', title: 'Color', enum: ['red', 'blue'] },
          },
          required: ['name'],
        },
      })
      const result = reply.result ?? {}
      log('calls.log', { tool: name, elicitation: result })
      if (result.action === 'accept') return text(`hello ${result.content?.name}${result.content?.color ? ` (${result.content.color})` : ''}`)
      return text(result.action === 'cancel' ? 'cancelled' : reply.error ? `error:${reply.error.message}` : 'declined')
    }
    case 'open_link': {
      const url = ctx.capabilities?.elicitation?.url
      if (!url) return { ...text('client did not advertise URL elicitation'), isError: true }
      const elicitationId = `link-${nextServerId}`
      const reply = await ctx.request('elicitation/create', {
        mode: 'url',
        message: 'Confirm on the fixture page',
        url: `${base}/confirm/${elicitationId}`,
        elicitationId,
      })
      const action = reply.result?.action ?? 'error'
      log('calls.log', { tool: name, elicitation: reply.result ?? reply.error })
      if (action === 'accept') {
        ctx.emit({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId } })
        return text('url accepted')
      }
      return text(action === 'cancel' ? 'cancelled' : 'declined')
    }
    case 'forget_session':
      sessions.clear()
      return text('forgotten')
    case 'expire_tokens':
      for (const record of tokens.values()) record.expires = 0
      return text('expired')
    default:
      return { ...text(`unknown tool ${name}`), isError: true }
  }
}

const RESOURCES = [{ uri: 'fixture://readme', name: 'readme', mimeType: 'text/plain' }]

async function handle(message, ctx) {
  const { id, method, params = {} } = message
  const reply = result => ({ jsonrpc: '2.0', id, result })
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'codsh-remote-fixture', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call':
      return reply(await callTool(params.name, params.arguments ?? {}, ctx))
    case 'resources/list':
      return reply({ resources: RESOURCES })
    case 'resources/templates/list':
      return reply({ resourceTemplates: [] })
    case 'resources/read':
      if (params.uri === 'fixture://readme') return reply({ contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'remote readme' }] })
      return { jsonrpc: '2.0', id, error: { code: -32002, message: `resource not found: ${params.uri}` } }
    case 'prompts/list':
      return reply({ prompts: [] })
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
}

function makeRequest(emit) {
  return (method, params) => new Promise(resolve => {
    const id = `srv-${nextServerId++}`
    waiting.set(id, resolve)
    emit({ jsonrpc: '2.0', id, method, params })
  })
}

function deliverResponse(message) {
  const resolve = waiting.get(String(message.id))
  if (!resolve) return false
  waiting.delete(String(message.id))
  resolve(message)
  return true
}

function logRequest(transport, req, message) {
  log('requests.log', {
    transport,
    http: req.method,
    rpc: message?.method ?? (message?.id != null ? 'response' : null),
    session: req.headers['mcp-session-id'] ?? null,
    protocol: req.headers['mcp-protocol-version'] ?? null,
    bearer: Boolean(req.headers.authorization),
    codshSession: req.headers['x-codsh-session'] ?? null,
  })
}

async function streamable(req, res) {
  if (req.method === 'GET') return send(res, 405, 'no standalone stream')
  if (req.method === 'DELETE') {
    sessions.delete(req.headers['mcp-session-id'])
    log('requests.log', { transport: 'http', http: 'DELETE', session: req.headers['mcp-session-id'] ?? null })
    res.writeHead(200)
    return res.end()
  }
  if (req.method !== 'POST') return send(res, 405, 'method not allowed')
  const auth = authorize(req, res)
  if (!auth) return
  let message
  try { message = JSON.parse(await readBody(req)) } catch { return send(res, 400, { error: 'parse error' }) }
  logRequest('http', req, message)
  if (message.method == null) {
    deliverResponse(message)
    res.writeHead(202)
    return res.end()
  }
  let capabilities
  if (message.method === 'initialize') {
    const sid = b64url(randomBytes(12))
    sessions.set(sid, { capabilities: message.params?.capabilities ?? {} })
    log('capabilities.log', message.params?.capabilities ?? {})
    res.setHeader('Mcp-Session-Id', sid)
  } else {
    const sid = req.headers['mcp-session-id']
    if (!sid) return send(res, 400, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: 'Mcp-Session-Id required' } })
    if (!sessions.has(sid)) return send(res, 404, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32001, message: 'session not found' } })
    capabilities = sessions.get(sid).capabilities
  }
  if (message.id == null) {
    res.writeHead(202)
    return res.end()
  }
  const wantsStream = message.method === 'tools/call' && ['ask_name', 'open_link'].includes(message.params?.name)
  if (!wantsStream) {
    const reply = await handle(message, { headers: req.headers, capabilities, transport: 'http', emit: () => {}, request: async () => ({ error: { message: 'no stream' } }) })
    return send(res, 200, reply)
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  let seq = 0
  const emit = msg => res.write(`id: ev-${++seq}\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`)
  const reply = await handle(message, { headers: req.headers, capabilities, transport: 'http', emit, request: makeRequest(emit) })
  emit(reply)
  res.end()
}

async function legacySse(req, res, url) {
  if (url.pathname === '/sse' && req.method === 'GET') {
    if (!authorize(req, res)) return
    const sid = b64url(randomBytes(12))
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    legacy.set(sid, { res, capabilities: {} })
    log('requests.log', { transport: 'sse', http: 'GET', rpc: null, codshSession: req.headers['x-codsh-session'] ?? null })
    res.write(`event: endpoint\ndata: /messages?sessionId=${sid}\n\n`)
    req.on('close', () => legacy.delete(sid))
    return
  }
  if (url.pathname === '/messages' && req.method === 'POST') {
    if (!authorize(req, res)) return
    const entry = legacy.get(url.searchParams.get('sessionId') ?? '')
    if (!entry) return send(res, 404, 'unknown session')
    let message
    try { message = JSON.parse(await readBody(req)) } catch { return send(res, 400, 'parse error') }
    logRequest('sse', req, message)
    res.writeHead(202)
    res.end()
    if (message.method == null) return deliverResponse(message)
    if (message.method === 'initialize') {
      entry.capabilities = message.params?.capabilities ?? {}
      log('capabilities.log', entry.capabilities)
    }
    if (message.id == null) return
    const emit = msg => entry.res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`)
    const reply = await handle(message, { headers: req.headers, capabilities: entry.capabilities, transport: 'sse', emit, request: makeRequest(emit) })
    emit(reply)
    return
  }
  return false
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, base)
  try {
    if (url.pathname === '/moved' || url.pathname.startsWith('/moved/')) {
      res.writeHead(307, { Location: `${base}/mcp` })
      return res.end()
    }
    if (url.pathname.startsWith('/confirm/')) return send(res, 200, 'confirmed')
    if (OAUTH && await oauthRoute(req, res, url) !== false) return
    if (url.pathname === '/mcp') return await streamable(req, res)
    if (await legacySse(req, res, url) !== false) return
    send(res, 404, 'not found')
  } catch (error) {
    if (!res.headersSent) send(res, 500, String(error?.message ?? error))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`
  process.stdout.write(`LISTENING ${server.address().port}\n`)
})
process.on('SIGTERM', () => process.exit(0))
