#!/usr/bin/env node
/**
 * Read-only projection of a dsh JSONL session log for the isolated Rust UI.
 * Opens persistence as an observer (never write ownership) and never executes
 * tools. Corruption and unsupported formats fail closed.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function readLineage(home, sessionId) {
  try {
    const value = JSON.parse(readFileSync(join(home, 'session-lineage', `${sessionId}.json`), 'utf8'))
    if (value && typeof value === 'object') return value
  } catch {
    // Lineage is optional provenance beside the append-only dsh log.
  }
  return null
}

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

// A rejected editor edit is stored as a session event whose tool-result,
// isError, and call id sit inside the message rather than a top-level tool/result.
function nestedToolResults(event) {
  const data = event?.data ?? {}
  const message = data.message ?? {}
  const content = Array.isArray(message.content) ? message.content : []
  const source = message.source ?? data.source ?? {}
  const sourceId = String(source.callId ?? source.toolCallId ?? '')
  const fallbackId = sourceId || String(message.toolCallId ?? message.callId ?? data.callId ?? '')
  return content
    .filter(block => block && block.type === 'tool-result')
    .map(block => {
      const ownId = String(block.toolCallId ?? block.callId ?? '')
      const id = ownId || fallbackId
      // A denied editor edit stores the call id on message.source and omits
      // isError. An explicit false stays success. A block that names itself
      // without isError is not a denial.
      const deniedBySource = ownId === ''
        && sourceId !== ''
        && block.isError !== false
        && message.isError !== false
      return {
        id,
        content: textBlocks(Array.isArray(block.content) ? block.content : []),
        isError: block.isError === true || message.isError === true || deniedBySource,
      }
    })
    .filter(block => block.id !== '')
}

// A text-only model gets each pasted image as a `<pasted-image … path=…>`
// element appended after everything the user typed (the client escapes the
// path attribute), and dsh joins adjacent text blocks into one. The live row
// shows only the typed text with its `[Image #N]` placeholders, so the
// restored row drops that trailing run of elements and nothing earlier: an
// element the user typed mid-message stays.
const PASTED_IMAGE_FALLBACKS = /(?:\n<pasted-image id="\d+" media="image\/(?:png|jpeg|webp|gif)"(?: dimensions="\d+x\d+")? path="[^"\n]*">\n<\/pasted-image>\n)+$/u

function typedText(content) {
  return textBlocks(content).replace(PASTED_IMAGE_FALLBACKS, '')
}

function proposedDiff(name, args) {
  const path = String(args?.file_path ?? '')
  if (name === 'write') {
    const content = String(args?.content ?? '')
    const lines = [`write ${path}`, '--- /dev/null', `+++ b/${path}`]
    for (const line of content.split('\n')) lines.push(`+${line.replace(/\r$/u, '')}`)
    if (content === '') lines.push('+')
    return lines.join('\n')
  }
  if (name === 'edit') {
    const oldText = String(args?.old_string ?? '')
    const newText = String(args?.new_string ?? '')
    const lines = [`edit ${path}`, `--- a/${path}`, `+++ b/${path}`]
    for (const line of oldText.split('\n')) lines.push(`-${line.replace(/\r$/u, '')}`)
    for (const line of newText.split('\n')) lines.push(`+${line.replace(/\r$/u, '')}`)
    return lines.join('\n')
  }
  if (name === 'read') return `read ${path}`
  return path ? `${name} ${path}` : name
}

const SUMMARY_LIMIT = 60

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

/** The line a background completion notice shows as (ticket 175). */
export const JOB_NOTICE_PREFIX = '◎ Task completed'

/**
 * A dsh tool-jobs completion notice: the model read it as a user message
 * that nobody typed. The transcript shows it as its own marked turn, the way
 * the live client does, and never as a prompt.
 */
/** The line a goal round shows as (ticket 180). */
export const GOAL_ROUND_PREFIX = '◎ Goal round'

/**
 * A dsh goal round (`<goal_round>` from the round driver) is a turn nobody
 * typed either: it shows as `◎ Goal round N/M`, like the live client.
 */
function goalRound(event, source) {
  if (source?.kind !== 'goal' || !(source.round > 0)) return undefined
  const message = event.data?.message ?? event.data ?? {}
  const max = /Round: \d+\/(\d+)/.exec(textBlocks(message.content))?.[1]
  return `${GOAL_ROUND_PREFIX} ${source.round}${max ? `/${max}` : ''}`
}

function jobNotice(event) {
  if (event?.type !== 'user/message') return undefined
  const source = eventSource(event)
  const round = goalRound(event, source)
  if (round !== undefined) return round
  if (source?.kind !== 'plugin' || source?.plugin !== 'tool-jobs') return undefined
  const summary = typeof source.summary === 'string' ? source.summary.trim() : ''
  return summary === '' ? JOB_NOTICE_PREFIX : `${JOB_NOTICE_PREFIX} · ${summary}`
}

function summarizePrompt(event) {
  const message = event?.data?.message ?? event?.data ?? {}
  const line = textBlocks(message.content)
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '' && !part.startsWith('<pasted-image ')) ?? ''
  if (line === '') return '(empty)'
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line
}

export function rewindPoints(events) {
  const points = []
  let openTurn = false
  let compaction = 0
  let tools = 0
  for (const event of events ?? []) {
    const type = event?.type
    if (type === 'compaction/start') compaction += 1
    else if (type === 'compaction/end' && compaction > 0) compaction -= 1
    else if (type === 'tool/call') tools += 1
    else if (type === 'tool/result' && tools > 0) tools -= 1
    if (type === 'turn/start') openTurn = true
    else if (type === 'user/message' && isDirectUser(event)) {
      points.push({
        turn: points.length + 1,
        summary: summarizePrompt(event),
        boundary: undefined,
      })
    } else if (type === 'turn/end') {
      const last = points.at(-1)
      if (last !== undefined && last.boundary === undefined && compaction === 0 && tools === 0) {
        last.boundary = event.seq
      }
      openTurn = false
    }
  }
  const last = points.at(-1)
  const tail = events?.at(-1)
  if (
    last !== undefined
    && last.boundary === undefined
    && !openTurn
    && compaction === 0
    && tools === 0
    && tail?.seq !== undefined
  ) {
    last.boundary = tail.seq
  }
  return points.filter(point => point.boundary !== undefined)
}

export function forkPrefix(events, requestedBoundary) {
  const list = Array.isArray(events) ? events : []
  if (list.length === 0) {
    if (requestedBoundary === undefined) return []
    throw new Error('invalid boundary')
  }
  const boundary = requestedBoundary === undefined ? list.at(-1).seq : requestedBoundary
  if (!Number.isSafeInteger(boundary) || boundary < 0) {
    throw new Error('invalid boundary')
  }
  const prefix = list.filter(event => event.seq <= boundary)
  if (prefix.length === 0 || prefix.at(-1)?.seq !== boundary) {
    throw new Error(`invalid boundary ${boundary}`)
  }
  const lastTurn = [...prefix].reverse().find(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (lastTurn?.type === 'turn/start') {
    throw new Error(`open turn at fork boundary ${boundary}`)
  }
  let compaction = 0
  let tools = 0
  for (const event of prefix) {
    if (event.type === 'compaction/start') compaction += 1
    else if (event.type === 'compaction/end' && compaction > 0) compaction -= 1
    else if (event.type === 'tool/call') tools += 1
    else if (event.type === 'tool/result' && tools > 0) tools -= 1
  }
  if (compaction > 0 || tools > 0) {
    throw new Error(`fork boundary ${boundary} splits compaction or tool pairing`)
  }
  return prefix
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
    const notice = jobNotice(event)
    if (notice !== undefined) {
      // A wake turn starts with its notice; a notice taken mid-turn opens a
      // new transcript turn for the answer that follows it.
      const empty = current !== null && current.user === '' && current.answer === ''
        && current.thought === '' && current.tools.length === 0
      if (!empty) openTurn()
      current.user = notice
      continue
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
        current.user = typedText(message.content).trim() || text
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
        diff: proposedDiff(name, args),
        result: '',
      }
      tools.set(id, tool)
      current.tools.push(tool)
    } else if (type === 'tool/result') {
      const message = data.message ?? {}
      const nested = nestedToolResults(event)
      const nestedError = nested.some(block => block.isError)
      const id = String(
        message.toolCallId
        ?? message.callId
        ?? data.callId
        ?? nested.find(block => block.id)?.id
        ?? '',
      )
      const content = textBlocks(message.content) || nested.map(block => block.content).join('')
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
      } else if (message.isError === true || data.error || nestedError) {
        tool.status = 'failed'
        current.error ??= `tool ${id} failed`
      } else {
        tool.status = 'completed'
      }
    } else if (nestedToolResults(event).length > 0) {
      for (const nested of nestedToolResults(event)) {
        let tool = tools.get(nested.id)
        if (tool === undefined) {
          tool = { id: nested.id, title: 'tool', status: 'pending', diff: '', result: '' }
          current.tools.push(tool)
          tools.set(nested.id, tool)
        }
        tool.result = nested.content
        const unknown = /outcome is unknown|interrupted before/i.test(nested.content)
        if (unknown) {
          tool.status = 'unknown'
          current.interrupted = true
        } else if (nested.isError) {
          tool.status = 'failed'
          current.error ??= `tool ${nested.id} failed`
        } else if (tool.status !== 'failed' && tool.status !== 'unknown') {
          // A tool/result already recorded this id. A later nested scan of
          // the same event must not turn a denial back into completed.
          tool.status = 'completed'
        }
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

function titleOf(events) {
  let title = null
  for (const event of events ?? []) {
    if (event?.type !== 'session/title') continue
    const data = event.data ?? {}
    const source = data.source?.kind ?? ''
    title = {
      title: String(data.title ?? ''),
      manual: source === 'user',
      source,
      provider: String(data.source?.provider ?? ''),
      model: String(data.source?.model?.model ?? data.source?.model ?? ''),
    }
  }
  return title
}

function openTurnOf(events) {
  let open = false
  for (const event of events ?? []) {
    if (event?.type === 'turn/start') open = true
    else if (event?.type === 'turn/end') open = false
  }
  return open
}

function promptLines(events) {
  const lines = []
  for (const event of events ?? []) {
    if (event?.type !== 'user/message') continue
    // A completion notice and the runtime snapshot a wake turn records were
    // never typed; the picker lists prompts only.
    if (jobNotice(event) !== undefined) continue
    // dsh's goal wrap-up context (`<goal_complete>`) is not a prompt either.
    const source = eventSource(event)
    if (source?.kind === 'plugin' && source?.plugin === 'tool-goal') continue
    const message = event.data?.message ?? event.data ?? {}
    const content = Array.isArray(message.content) ? message.content : Array.isArray(event.data?.content) ? event.data.content : []
    const text = content.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n')
    const line = text.split('\n').map(part => part.trim()).find(part => part !== '' && !part.startsWith('<pasted-image '))
    if (line && /^Current runtime context\b/.test(line)) continue
    if (line) lines.push(line.slice(0, 160))
  }
  return lines
}

async function listCatalog(home, dshBin) {
  const requireFromDsh = createRequire(dshBin)
  const Context = (await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)).Context
  const JsonlSessionPersistence = (await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)).default
  const root = join(home, 'sessions')
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root })
  const persistence = ctx.sessionPersistence
  if (persistence === undefined) fail(1, 'dsh session persistence is not mounted')
  const warnings = []
  const sessions = []
  let listed
  try {
    listed = await persistence.list()
  } catch (error) {
    fail(1, `cannot list dsh sessions: ${error.message}`)
  }
  for (const snapshot of listed ?? []) {
    const header = snapshot.header ?? {}
    const sessionId = header.id
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (header.origin === 'subagent') continue
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
    } catch (error) {
      warnings.push(`unreadable session ${sessionId}: ${error.message}`)
      continue
    }
    try {
      const { events } = await handle.read()
      const folded = titleOf(events)
      sessions.push({
        id: sessionId,
        cwd: header.cwd ?? '',
        createdAt: header.createdAt ?? 0,
        updatedAt: header.updatedAt ?? header.createdAt ?? 0,
        prompts: promptLines(events),
        title: folded?.title ?? '',
        manual: folded?.manual === true,
        source: folded?.source ?? '',
        provider: folded?.provider ?? '',
        model: folded?.model ?? '',
        damaged: false,
        openTurn: openTurnOf(events),
      })
    } catch (error) {
      warnings.push(`malformed session ${sessionId}: ${error.message}`)
      sessions.push({
        id: sessionId,
        cwd: header.cwd ?? '',
        createdAt: header.createdAt ?? 0,
        updatedAt: header.createdAt ?? 0,
        prompts: [],
        title: '',
        manual: false,
        source: '',
        provider: '',
        model: '',
        damaged: true,
      })
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
  await ctx.fiber?.dispose?.().catch(() => undefined)
  process.stdout.write(`${JSON.stringify({ ok: true, sessions, warnings })}\n`)
}

async function main() {
  if (process.argv.includes('--list')) {
    const home = process.env.DSH_HOME
    const dshBin = process.env.DSH_BIN
    if (typeof home !== 'string' || home === '') fail(1, 'missing DSH_HOME')
    if (typeof dshBin !== 'string' || dshBin === '') fail(1, 'missing DSH_BIN')
    try {
      await listCatalog(home, dshBin)
    } catch (error) {
      fail(1, error.message)
    }
    return
  }
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
    const header = snapshot?.header ?? handle.header ?? {}
    const lineage = readLineage(home, sessionId)
    const { events } = await handle.read()
    const projected = projectSession(events)
    process.stdout.write(`${JSON.stringify({
      ok: true,
      sessionId,
      cwd: header.cwd ?? null,
      parentSession: header.parentSession ?? lineage?.parentSession ?? null,
      isSeeded: header.isSeeded === true || lineage?.isSeeded === true,
      inheritedEventCount: handle.inheritedEventCount ?? lineage?.inheritedEventCount ?? 0,
      rewindPoints: rewindPoints(events),
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
