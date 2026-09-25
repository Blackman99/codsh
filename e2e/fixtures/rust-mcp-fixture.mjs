#!/usr/bin/env node
// Keyless local MCP server for Rust client tests. Speaks newline-delimited
// JSON-RPC 2.0 over stdio (the MCP stdio transport). Tools have real side
// effects in the directory named by MCP_FIXTURE_DIR (default: cwd) so a test
// can observe that a call ran exactly once.
//   argv --exit-on-start   exit 3 before answering initialize (startup crash)
//   argv --bad-init        answer initialize with a JSON-RPC error
//   argv --tools=a,b       only list these tools
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const dir = process.env.MCP_FIXTURE_DIR || process.cwd()
const label = process.env.MCP_FIXTURE_LABEL || 'fixture'
const log = (line) => appendFileSync(join(dir, `${label}.calls.log`), `${line}\n`)
if (args.includes('--exit-on-start')) {
  process.stderr.write('fixture: exiting before initialize\n')
  process.exit(3)
}
const only = args.find(arg => arg.startsWith('--tools='))?.slice(8).split(',')

const TOOLS = [
  {
    name: 'write_note',
    description: 'Write text to a note file in the fixture directory.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'file name without directories' },
        text: { type: 'string' },
      },
      required: ['name', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'echo',
    description: 'Return the given value and a structured copy.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' }, count: { type: 'integer' } },
      required: ['value'],
    },
  },
  {
    name: 'big_output',
    description: 'Return a large text block.',
    inputSchema: { type: 'object', properties: { bytes: { type: 'integer' } } },
  },
  {
    name: 'fail',
    description: 'Report a tool error.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'crash',
    description: 'Exit the server process in the middle of a call.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Wait until cancelled or ms elapse, then write slow.done.',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } },
  },
].filter(tool => !only || only.includes(tool.name))

const pending = new Map()
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function text(value) {
  return { content: [{ type: 'text', text: value }] }
}

function call(id, name, input = {}) {
  log(`${name} ${JSON.stringify(input)}`)
  switch (name) {
    case 'write_note': {
      if (typeof input.name !== 'string' || /[\\/]/.test(input.name)) {
        return reply(id, { ...text('invalid name'), isError: true })
      }
      writeFileSync(join(dir, input.name), String(input.text ?? ''))
      return reply(id, text(`wrote ${input.name} (${String(input.text ?? '').length} chars)`))
    }
    case 'echo':
      return reply(id, {
        content: [{ type: 'text', text: `echo:${input.value}` }],
        structuredContent: { value: input.value, count: input.count ?? null },
      })
    case 'big_output': {
      const bytes = Number.isInteger(input.bytes) ? input.bytes : 200000
      return reply(id, text(`BIG-START ${'x'.repeat(Math.max(0, bytes - 18))} BIG-END`))
    }
    case 'fail':
      return reply(id, { ...text('fixture failure: the tool reported an error'), isError: true })
    case 'crash':
      process.stderr.write('fixture: crashing during tools/call\n')
      process.exit(7)
      return
    case 'slow': {
      const timer = setTimeout(() => {
        pending.delete(id)
        writeFileSync(join(dir, 'slow.done'), 'done')
        reply(id, text('slow finished'))
      }, Number.isInteger(input.ms) ? input.ms : 30000)
      pending.set(id, timer)
      return
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const { id, method, params } = message
  if (method === 'initialize') {
    if (args.includes('--bad-init')) {
      return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'fixture refuses to initialize' } })
    }
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `codsh-mcp-fixture-${label}`, version: '1.0.0' },
    })
  }
  if (method === 'notifications/cancelled') {
    const timer = pending.get(params?.requestId)
    if (timer) {
      clearTimeout(timer)
      pending.delete(params.requestId)
      log(`cancelled ${params.requestId}`)
    }
    return
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') return call(id, params?.name, params?.arguments)
  if (method === 'ping') return reply(id, {})
  if (id !== undefined && method) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
})
process.stdin.on('end', () => process.exit(0))
