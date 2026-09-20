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

function isDirectUser(event) {
  const payload = event.data ?? {}
  const source = payload.source ?? payload.message?.source
  const kind = typeof source === 'string' ? source : source?.kind ?? source?.type ?? ''
  if (kind === 'inject' || kind === 'tool' || kind === 'system') return false
  const message = payload.message ?? payload
  const text = textBlocks(message.content)
  if (text.startsWith('<')) return false
  if (/Current runtime context|This snapshot supersedes/i.test(text)) return false
  return true
}

export function projectTurns(events) {
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
    }
    turns.push(current)
  }

  for (const event of events) {
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'turn/start' || (type === 'user/message' && current === null)) {
      openTurn()
    }
    if (current === null) continue
    if (type === 'user/message' && isDirectUser(event)) {
      const message = data.message ?? data
      const text = textBlocks(message.content).trim()
      if (text !== '' && current.user === '') {
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
      current = null
    }
  }
  return turns.filter(turn => turn.user !== '' || turn.answer !== '' || turn.tools.length > 0)
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
    process.stdout.write(`${JSON.stringify({
      ok: true,
      sessionId,
      cwd: snapshot?.header?.cwd ?? handle.header?.cwd ?? null,
      turns: projectTurns(events),
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
