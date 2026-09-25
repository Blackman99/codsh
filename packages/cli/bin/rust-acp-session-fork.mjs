#!/usr/bin/env node
/**
 * dsh-backed conversation fork for the isolated Rust client.
 * Reads the source session as an observer, seeds a new append-only child with
 * parentSession lineage, and never mutates the source or workspace files.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { forkPrefix, projectTurns, readLineage, rewindPoints } from './rust-acp-session-read.mjs'

function fail(code, message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exit(code)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hasFlag(name) {
  return process.argv.includes(name)
}

async function openPersistence(dshBin, home) {
  const requireFromDsh = createRequire(dshBin)
  const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
  const JsonlSessionPersistence = (await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)).default
  const sessionMod = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session')).href)
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
  const persistence = ctx.sessionPersistence
  if (persistence === undefined) throw new Error('dsh session persistence is not mounted')
  return { ctx, persistence, sessionMod }
}

function classifyOpenError(error, sessionId) {
  const name = error?.name ?? ''
  const message = error?.message ?? String(error)
  if (name === 'SessionPersistenceNotFoundError' || /not found/i.test(message)) {
    return { code: 3, message: `session is not resumable: ${sessionId}` }
  }
  if (name === 'SessionPersistenceCorruptionError' || /corrupt/i.test(message)) {
    return { code: 2, message: `source data is damaged: ${message}` }
  }
  if (name === 'SessionFormatUnsupportedError' || /upgrade the harness|unsupported/i.test(message)) {
    return { code: 2, message: `source data is damaged: ${message}` }
  }
  return { code: 1, message }
}

export async function forkConversation(options) {
  const {
    home,
    dshBin,
    sessionId,
    boundary,
    childId,
    restoreCode = false,
    listOnly = false,
    cwd,
  } = options
  if (restoreCode) {
    throw Object.assign(new Error('Conversation fork does not restore files; --restore-code is unavailable on the dsh execution core (no repository snapshot).'), { code: 4 })
  }
  const { ctx, persistence, sessionMod } = await openPersistence(dshBin, home)
  let reader
  try {
    reader = await persistence.open(sessionId, 'read')
  } catch (error) {
    await ctx.fiber?.dispose?.().catch(() => undefined)
    const classified = classifyOpenError(error, sessionId)
    throw Object.assign(new Error(classified.message), { code: classified.code })
  }
  try {
    const snapshot = await persistence.stat(sessionId)
    const header = snapshot?.header ?? reader.header ?? {}
    const { events } = await reader.read()
    const points = rewindPoints(events)
    if (listOnly) {
      const lineage = readLineage(home, sessionId)
      return {
        ok: true,
        sessionId,
        parentSession: header.parentSession ?? lineage?.parentSession ?? null,
        isSeeded: header.isSeeded === true || lineage?.isSeeded === true,
        rewindPoints: points,
        turns: projectTurns(events),
      }
    }
    let seed
    try {
      seed = forkPrefix(events, boundary)
    } catch (error) {
      throw Object.assign(new Error(error.message), { code: 5 })
    }
    const { Session, SessionId, SESSION_FORMAT_VERSION, SessionLogOffset } = sessionMod
    const nextId = childId ?? randomUUID()
    if (nextId === sessionId) {
      throw Object.assign(new Error('fork child id must differ from the source session'), { code: 5 })
    }
    const meta = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(nextId),
      createdAt: Date.now(),
      isSeeded: true,
    }
    // `--cwd` (ticket 174: `-w -r`) moves the fork into a worktree; the
    // source session keeps its own directory.
    if (typeof cwd === 'string' && cwd !== '') meta.cwd = cwd
    else if (typeof header.cwd === 'string' && header.cwd !== '') meta.cwd = header.cwd
    const cloned = JSON.parse(JSON.stringify(seed))
    const child = Session.create(SessionId(nextId), cloned, meta, SessionLogOffset(cloned.length))
    const writer = await persistence.create(child.header, {
      inheritedEventCount: child.inheritedEventCount,
    })
    try {
      await writer.append(child.snapshotEvents())
      await writer.flush()
    } finally {
      await writer.close().catch(() => undefined)
    }
    // ACP session/list and session/resume refuse header.parentSession as a
    // non-root child. Lineage stays on disk beside the append-only log so the
    // forked session remains resumable while the source relationship is kept.
    const lineageDir = join(home, 'session-lineage')
    mkdirSync(lineageDir, { mode: 0o700, recursive: true })
    writeFileSync(join(lineageDir, `${nextId}.json`), `${JSON.stringify({
      sessionId: nextId,
      parentSession: sessionId,
      isSeeded: true,
      inheritedEventCount: child.inheritedEventCount,
      boundary: cloned.at(-1)?.seq ?? null,
      filesRestored: false,
    })}\n`, { mode: 0o600 })
    return {
      ok: true,
      sessionId: nextId,
      parentSession: sessionId,
      isSeeded: true,
      inheritedEventCount: child.inheritedEventCount,
      boundary: cloned.at(-1)?.seq,
      rewindPoints: rewindPoints(child.snapshotEvents()),
      turns: projectTurns(child.snapshotEvents()),
      filesRestored: false,
    }
  } finally {
    await reader.close().catch(() => undefined)
    await ctx.fiber?.dispose?.().catch(() => undefined)
  }
}

async function main() {
  const sessionId = argValue('--session-id') ?? process.env.CODSH_SESSION_ID
  const home = process.env.DSH_HOME
  const dshBin = process.env.DSH_BIN
  if (typeof sessionId !== 'string' || sessionId === '') fail(1, 'missing --session-id')
  if (typeof home !== 'string' || home === '') fail(1, 'missing DSH_HOME')
  if (typeof dshBin !== 'string' || dshBin === '') fail(1, 'missing DSH_BIN')
  const rawBoundary = argValue('--boundary')
  const boundary = rawBoundary === undefined ? undefined : Number(rawBoundary)
  if (rawBoundary !== undefined && !Number.isSafeInteger(boundary)) fail(5, 'invalid boundary')
  try {
    const result = await forkConversation({
      home,
      dshBin,
      sessionId,
      boundary,
      childId: argValue('--child-id'),
      restoreCode: hasFlag('--restore-code'),
      listOnly: hasFlag('--list'),
      cwd: argValue('--cwd'),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    fail(error.code ?? 1, error.message)
  }
}

const entry = process.argv[1] && process.argv[1].includes('rust-acp-session-fork')
if (entry) {
  main().catch(error => fail(error.code ?? 1, error.message))
}
