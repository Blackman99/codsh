#!/usr/bin/env node
/**
 * Read-only projection of a dsh JSONL session log for the isolated Rust UI.
 * Opens persistence as an observer (never write ownership) and never executes
 * tools. Corruption and unsupported formats fail closed.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function fail(code, message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exit(code)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function textBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && (block.type === 'text' || block.type === 'reasoning'))
    .map(block => String(block.text ?? ''))
    .join('')
}

function eventSource(event) {
  const payload = event.data ?? {}
  return payload.source ?? payload.message?.source
}

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

function isCompactCheckpoint(event) {
  const source = eventSource(event)
  return source?.kind === 'plugin' && source?.plugin === 'compact'
}

function eventSurfaceOp(event) {
  return event?.surfaceOp ?? event?.data?.surfaceOp ?? event?.data?.message?.surfaceOp
}

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4

function estimateContent(blocks) {
  if (!Array.isArray(blocks)) return 0
  let tokens = 0
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' || block.type === 'reasoning') {
      tokens += Math.ceil(String(block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    } else if (block.type === 'tool-call') {
      tokens += Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN)
        + Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN)
        + BLOCK_OVERHEAD
    } else if (block.type === 'tool-result') {
      tokens += estimateContent(block.content) + BLOCK_OVERHEAD
    } else {
      tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

function estimateSystemContent(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0
  let characters = 0
  for (const block of blocks) {
    if (block?.type === 'text') characters += String(block.text ?? '').length
    else if (block) characters += JSON.stringify(block).length
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + 4
}

export function projectBreakdown(events) {
  if (!Array.isArray(events) || events.length === 0) return null
  const live = liveSurfaceSeqs(events)
  const bySeq = new Map(events.filter(event => typeof event?.seq === 'number').map(event => [event.seq, event]))
  let toolsTokens
  for (const event of events) {
    if (event?.type !== 'request/header') continue
    const tools = event.data?.header?.tools
    toolsTokens = Array.isArray(tools) && tools.length > 0
      ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
      : 0
  }
  let systemTokens = 0
  let totalSurface = 0
  for (const seq of live) {
    const event = bySeq.get(seq)
    if (!event) continue
    const message = event.data?.message ?? event.data ?? {}
    const content = message.content
    const tokens = event.type === 'system/message'
      ? estimateSystemContent(content)
      : estimateContent(content) + 4
    totalSurface += tokens
    if (event.type === 'system/message' && tokens > 0) systemTokens = tokens
  }
  return {
    system: systemTokens,
    tools: toolsTokens,
    messages: Math.max(0, totalSurface - systemTokens),
  }
}

export function liveSurfaceSeqs(events) {
  const nodes = []
  for (const event of events ?? []) {
    if (!SURFACE_TYPES.has(event?.type) || typeof event.seq !== 'number') continue
    const op = eventSurfaceOp(event)
    if (op && op !== 'append' && op.op === 'replace') {
      const startIdx = nodes.indexOf(op.startSeq)
      const endIdx = nodes.indexOf(op.endSeq)
      if (startIdx >= 0 && endIdx >= 0 && startIdx <= endIdx) {
        nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
        continue
      }
    }
    nodes.push(event.seq)
  }
  return new Set(nodes)
}

function liveToolResultIds(events, live) {
  const ids = new Set()
  for (const event of events ?? []) {
    if (event?.type !== 'tool/result' || typeof event.seq !== 'number' || !live.has(event.seq)) continue
    const message = event.data?.message ?? {}
    ids.add(String(message.toolCallId ?? message.callId ?? event.data?.callId ?? ''))
  }
  return ids
}

function isDirectUser(event) {
  if (isCompactCheckpoint(event)) return true
  const source = eventSource(event)
  const kind = typeof source === 'string' ? source : source?.kind ?? source?.type ?? ''
  if (kind === 'inject' || kind === 'tool' || kind === 'system' || kind === 'plugin') return false
  const message = event.data?.message ?? event.data ?? {}
  const text = textBlocks(message.content)
  if (text.startsWith('<') && !text.includes('<compacted-summary>')) return false
  if (/Current runtime context|This snapshot supersedes/i.test(text)) return false
  return true
}

export function shadowedSeqs(events) {
  const shadowed = new Set()
  const live = liveSurfaceSeqs(events)
  for (const event of events ?? []) {
    const data = event?.data ?? {}
    if (event?.type === 'compaction/summary' && Array.isArray(data.shadowedSeqs)) {
      for (const seq of data.shadowedSeqs) shadowed.add(seq)
    }
    const op = eventSurfaceOp(event)
    if (op?.op === 'replace') {
      const start = op.startSeq
      const end = op.endSeq
      for (const item of events) {
        if (typeof item?.seq === 'number' && item.seq >= start && item.seq <= end && item !== event) {
          shadowed.add(item.seq)
        }
      }
    }
    if (SURFACE_TYPES.has(event?.type) && typeof event.seq === 'number' && !live.has(event.seq)) {
      shadowed.add(event.seq)
    }
  }
  return shadowed
}

export function projectCompaction(events) {
  const records = []
  let current = null
  for (const event of events ?? []) {
    const data = event?.data ?? {}
    if (event?.type === 'compaction/start') {
      current = {
        id: data.compactionId ?? null,
        items: null,
        tokens: null,
        provider: '',
        model: '',
        summary: '',
        purpose: 'compaction',
        usage: null,
        error: null,
        shadowedSeqs: [],
      }
    } else if (event?.type === 'compaction/summary') {
      current = {
        ...(current ?? {}),
        id: data.compactionId ?? current?.id ?? null,
        items: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null,
        tokens: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : null,
        provider: data.provider ?? '',
        model: data.model ?? '',
        summary: textBlocks(data.summary),
        purpose: 'compaction',
        usage: data.usage ?? null,
        error: null,
        shadowedSeqs: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [],
      }
    } else if (event?.type === 'compaction/end') {
      if (current) {
        current.error = data.error ?? null
        records.push(current)
        current = null
      } else {
        records.push({
          id: data.compactionId ?? null,
          items: null,
          tokens: null,
          provider: '',
          model: '',
          summary: '',
          purpose: 'compaction',
          usage: null,
          error: data.error ?? null,
          shadowedSeqs: [],
        })
      }
    }
  }
  return records
}

export function projectTurns(events, options = {}) {
  const skipShadowed = options.skipShadowed !== false
  const live = skipShadowed ? liveSurfaceSeqs(events) : null
  const shadowed = skipShadowed ? shadowedSeqs(events) : new Set()
  const liveTools = live ? liveToolResultIds(events, live) : null
  const compaction = projectCompaction(events)
  const latest = compaction.at(-1)
  const turns = []
  let current = null
  const tools = new Map()

  function openTurn() {
    current = {
      user: '',
      thought: '',
      answer: '',
      tools: [],
      error: null,
      cancelled: false,
      interrupted: false,
      compacted: false,
      compaction: null,
    }
    turns.push(current)
  }

  for (const event of events ?? []) {
    const type = event?.type
    const data = event?.data ?? {}
    if (skipShadowed && SURFACE_TYPES.has(type) && typeof event.seq === 'number' && (!live.has(event.seq) || shadowed.has(event.seq))) {
      continue
    }
    if (skipShadowed && type === 'tool/call' && live.size > 0) {
      const id = String(data.callId ?? data.toolCallId ?? '')
      if (!liveTools.has(id)) continue
    }
    if (type === 'turn/start' || (type === 'user/message' && current === null && isDirectUser(event))) {
      openTurn()
    }
    if (current === null) continue
    if (type === 'user/message' && isDirectUser(event)) {
      const message = data.message ?? data
      const text = textBlocks(message.content).trim()
      if (isCompactCheckpoint(event) || text.includes('<compacted-summary>')) {
        current.compacted = true
        current.user = current.user || 'compaction summary'
        current.answer = text
        if (latest) {
          current.compaction = {
            items: latest.items,
            tokens: latest.tokens,
            provider: latest.provider,
            model: latest.model,
            purpose: 'compaction',
            error: latest.error,
          }
        }
      } else if (text !== '' && current.user === '') {
        current.user = text
      }
    } else if (type === 'assistant/message') {
      const message = data.message ?? {}
      const content = Array.isArray(message.content) ? message.content : []
      for (const block of content) {
        if (block?.type === 'reasoning' || block?.type === 'thought') {
          current.thought += String(block.text ?? '')
        } else if (block?.type === 'text') {
          current.answer += String(block.text ?? '')
        }
      }
      if (data.interrupted === true) current.interrupted = true
    } else if (type === 'tool/call') {
      const id = String(data.callId ?? data.toolCallId ?? '')
      const name = String(data.name ?? 'tool')
      let args = {}
      try { args = JSON.parse(String(data.arguments ?? '{}')) } catch { args = {} }
      const tool = {
        id,
        title: name,
        status: 'pending',
        diff: name === 'edit' || name === 'write' || name === 'read'
          ? `${name} ${args.file_path ?? ''}`
          : name,
        result: '',
      }
      tools.set(id, tool)
      current.tools.push(tool)
    } else if (type === 'tool/result') {
      const message = data.message ?? {}
      const id = String(message.toolCallId ?? message.callId ?? data.callId ?? '')
      const content = textBlocks(message.content)
      const code = String(data.error?.code ?? '')
      const unknown = code === 'TOOL_OUTCOME_UNKNOWN' || code === 'TOOL_NOT_STARTED'
        || /outcome is unknown|interrupted before/i.test(content)
      let tool = tools.get(id)
      if (tool === undefined) {
        tool = { id, title: 'tool', status: 'pending', diff: '', result: '' }
        current.tools.push(tool)
        tools.set(id, tool)
      }
      tool.result = content
      if (unknown) {
        tool.status = 'unknown'
        current.interrupted = true
      } else if (message.isError === true || data.error) {
        tool.status = 'failed'
        current.error ??= `tool ${id} failed`
      } else {
        tool.status = 'completed'
      }
    } else if (type === 'turn/end') {
      const reason = data.reason ?? {}
      if (reason.kind === 'interrupted') current.interrupted = true
      if (reason.kind === 'aborted') current.cancelled = true
      if (reason.kind === 'error') {
        current.error ??= reason.error?.message ?? 'turn failed'
      }
      if (current.interrupted || current.cancelled) markUnknownOpenTools(current)
      current = null
    }
  }
  if (current) {
    if (!current.compacted) {
      current.interrupted = true
      markUnknownOpenTools(current)
    }
  }
  for (const turn of turns) {
    if (turn.interrupted || turn.cancelled) markUnknownOpenTools(turn)
  }
  const keep = skipShadowed
    ? turn => turn.compacted || turn.tools.length > 0 || turn.user !== ''
    : turn => turn.user !== '' || turn.answer !== '' || turn.tools.length > 0 || turn.compacted
  return turns.filter(keep)
}

export function projectSession(events) {
  const live = projectTurns(events, { skipShadowed: true })
  const original = projectTurns(events, { skipShadowed: false })
  const compaction = projectCompaction(events)
  const retainedTools = live.flatMap(turn => turn.tools)
  const retainedTodos = retainedTools.filter(tool =>
    /todo/i.test(`${tool.title} ${tool.diff} ${tool.result}`))
  return {
    turns: live,
    originalTurnCount: original.length,
    originalToolCount: original.flatMap(turn => turn.tools).length,
    compaction,
    retainedTools,
    retainedTodos,
    breakdown: projectBreakdown(events),
  }
}

function markUnknownOpenTools(turn) {
  for (const tool of turn.tools) {
    if (tool.status === 'pending' || tool.status === 'in_progress') {
      tool.status = 'unknown'
      turn.interrupted = true
    }
  }
}

async function main() {
  const sessionId = argValue('--session-id') ?? process.env.CODSH_SESSION_ID
  const home = process.env.DSH_HOME
  const dshBin = process.env.DSH_BIN
  if (typeof sessionId !== 'string' || sessionId === '') fail(1, 'missing --session-id')
  if (typeof home !== 'string' || home === '') fail(1, 'missing DSH_HOME')
  if (typeof dshBin !== 'string' || dshBin === '') fail(1, 'missing DSH_BIN')
  const requireFromDsh = createRequire(dshBin)
  let Context
  let JsonlSessionPersistence
  try {
    Context = (await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)).Context
    JsonlSessionPersistence = (await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)).default
  } catch (error) {
    fail(1, `cannot load dsh persistence: ${error.message}`)
  }
  const root = join(home, 'sessions')
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root })
  } catch (error) {
    fail(1, `cannot open dsh session store: ${error.message}`)
  }
  const persistence = ctx.sessionPersistence
  if (persistence === undefined) fail(1, 'dsh session persistence is not mounted')
  let handle
  try {
    handle = await persistence.open(sessionId, 'read')
  } catch (error) {
    const name = error?.name ?? ''
    const message = error?.message ?? String(error)
    if (name === 'SessionPersistenceNotFoundError' || /not found/i.test(message)) {
      fail(3, `session is not resumable: ${sessionId}`)
    }
    if (name === 'SessionPersistenceCorruptionError' || /corrupt/i.test(message)) {
      fail(2, `source data is damaged: ${message}`)
    }
    if (name === 'SessionFormatUnsupportedError' || /upgrade the harness|unsupported/i.test(message)) {
      fail(2, `source data is damaged: ${message}`)
    }
    fail(1, message)
  }
  try {
    const snapshot = await persistence.stat(sessionId)
    const { events } = await handle.read()
    const projected = projectSession(events)
    process.stdout.write(`${JSON.stringify({
      ok: true,
      sessionId,
      cwd: snapshot?.header?.cwd ?? handle.header?.cwd ?? null,
      ...projected,
    })}\n`)
  } catch (error) {
    const message = error?.message ?? String(error)
    if (/corrupt/i.test(message) || error?.name === 'SessionPersistenceCorruptionError') {
      fail(2, `source data is damaged: ${message}`)
    }
    fail(1, message)
  } finally {
    await handle.close().catch(() => undefined)
    await ctx.fiber?.dispose?.().catch(() => undefined)
  }
}

const entry = process.argv[1] && process.argv[1].includes('rust-acp-session-read')
if (entry) {
  main().catch(error => fail(1, error.message))
}
