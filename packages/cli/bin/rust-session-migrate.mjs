#!/usr/bin/env node
/**
 * Copy selected legacy codsh sessions into the isolated Rust client's dsh
 * Home (ticket 62).
 *
 * The legacy client is `dsh --profile code` over the host dsh Home
 * (`$DSH_HOME`, default `~/.dsh`); its sessions live in `<home>/sessions`
 * and its attachments in `<home>/attachments/v1`. This helper opens that
 * store with dsh's own persistence strictly as a reader (`open(id, 'read')`
 * never publishes a successor generation) and never writes, locks, or
 * migrates anything under the legacy Home, so the old client keeps reading
 * its original, byte-identical records.
 *
 * Each imported session becomes a NEW session id in the isolated store:
 * the legacy client and this client never write the same session. The copy
 * keeps every event dsh can read (messages, tool calls and results,
 * attachments by content address, subagent children, titles), rewrites only
 * the session ids that the copy renamed, and drops the legacy agent preset
 * from the header (that preset is not installed here). What cannot be copied
 * is reported, never hidden: events this build skips (unknown but marked
 * ignorable), content blocks the Rust client does not display, missing
 * attachments, and missing subagent logs. A log dsh refuses (damaged, an
 * unsupported newer format, an unknown required event) is not copied at all.
 *
 * Every copy is written, re-read, and compared before its provenance record
 * (`<isolated home>/session-migrations/<copy id>.json`) is completed; a
 * failure removes what this run created. The record names the legacy Home,
 * session id, log file, and a digest of the bytes read, so a repeated
 * import is recognised: unchanged means "already imported", a legacy
 * session that grew since means a conflict until `--again` asks for a new
 * copy. Returning to the old client needs nothing from the new format.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

export const RECORD_DIR = 'session-migrations'
const RECORD_SCHEMA = 1
const MAX_DEPTH = 16
/** The session log generation the pinned dsh reads and writes. */
const SUPPORTED_VERSION = 3
/** Content blocks the Rust client renders; others are kept but reported. */
const DISPLAYED_BLOCKS = new Set(['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-result'])
const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

class MigrationError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------- raw logs

/**
 * Split a Zstandard file into its independent frames (dsh writes one frame
 * per durable batch; Node's one-shot decoder stops after the first frame).
 */
export function splitFrames(buf) {
  const frames = []
  let at = 0
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('truncated zstd frame header')
    const magic = buf.readUInt32LE(at)
    if (((magic & 0xfffffff0) >>> 0) === 0x184d2a50) {
      at += 8 + buf.readUInt32LE(at + 4)
      continue
    }
    if (magic !== 0xfd2fb528) throw new Error(`not a zstd frame at byte ${at}`)
    const start = at
    const descriptor = buf[at + 4]
    const sizeFlag = descriptor >> 6
    const single = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionary = descriptor & 3
    let cursor = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictionary] + [single ? 1 : 0, 2, 4, 8][sizeFlag]
    for (;;) {
      if (cursor + 3 > buf.length) throw new Error('truncated zstd block')
      const header = buf[cursor] | (buf[cursor + 1] << 8) | (buf[cursor + 2] << 16)
      const last = header & 1
      const type = (header >> 1) & 3
      cursor += 3 + (type === 1 ? 1 : header >> 3)
      if (last) break
    }
    if (checksum) cursor += 4
    if (cursor > buf.length) throw new Error('truncated zstd frame')
    frames.push(buf.subarray(start, cursor))
    at = cursor
  }
  return frames
}

/** Raw JSONL rows of one log file, header first; a torn final row is dropped. */
export function rawRows(path) {
  const bytes = readFileSync(path)
  const text = path.endsWith('.zstd')
    ? splitFrames(bytes).map(frame => zstdDecompressSync(frame).toString('utf8')).join('')
    : bytes.toString('utf8')
  const rows = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // A torn tail row is storage recovery's business; dsh drops it too.
    }
  }
  return { rows, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

/** The encoding one session root uses, from its generation file names. */
export function rootEncoding(root) {
  let zstd = 0
  let raw = 0
  for (const project of safeDir(root)) {
    for (const session of safeDir(join(root, project))) {
      for (const name of safeDir(join(root, project, session))) {
        const match = LOG_NAME.exec(name)
        if (match === null) continue
        if (match[2]) zstd += 1
        else raw += 1
      }
    }
  }
  if (zstd > 0 && raw > 0) return 'mixed'
  if (raw > 0) return 'none'
  return 'zstd'
}

function safeDir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** Directory and highest generation file of one session, found by name. */
export function locateLog(root, sessionId) {
  for (const project of safeDir(root)) {
    const dir = join(root, project, sessionId)
    let best
    for (const name of safeDir(dir)) {
      const match = LOG_NAME.exec(name)
      if (match === null) continue
      const version = match[1] === undefined ? 0 : Number(match[1])
      if (best === undefined || version > best.version) best = { version, path: join(dir, name) }
    }
    if (best !== undefined) return { dir, ...best }
  }
  return undefined
}

// ---------------------------------------------------------------- dsh store

async function loadDsh(dshBin) {
  const requireFromDsh = createRequire(dshBin)
  const load = async name => import(pathToFileURL(requireFromDsh.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const Persistence = (await load('@deepseek-ai/dsh-session-persistence-jsonl')).default
  const session = await load('@deepseek-ai/dsh-session')
  return { Context, Persistence, session }
}

async function openStore(dsh, root, compression) {
  const ctx = new dsh.Context()
  await ctx.plugin(dsh.Persistence, { root, compression })
  const persistence = ctx.sessionPersistence
  if (persistence === undefined) throw new MigrationError('dsh session persistence is not mounted')
  return {
    persistence,
    close: async () => { await ctx.fiber?.dispose?.().catch(() => undefined) },
  }
}

function classify(error) {
  const name = error?.name ?? ''
  const message = String(error?.message ?? error)
  if (name === 'SessionPersistenceNotFoundError' || /not found/i.test(message)) return { kind: 'missing', message }
  if (name === 'SessionFormatUnsupportedError' || /upgrade the harness|unsupported|unknown .*event|unrecogni/i.test(message)) {
    return { kind: 'unsupported', message }
  }
  if (name === 'SessionPersistenceCorruptionError' || /corrupt|checksum|malformed|invalid/i.test(message)) return { kind: 'damaged', message }
  return { kind: 'unreadable', message }
}

// ---------------------------------------------------------------- analysis

function titleOf(events) {
  let title = ''
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  return title
}

function openTurn(events) {
  let open = null
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data?.turn ?? null
    if (event.type === 'turn/end') open = null
  }
  return open
}

function walkBlocks(content, visit) {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    visit(block)
    if (Array.isArray(block.content)) walkBlocks(block.content, visit)
  }
}

/** Counts, attachments, children, and unsupported content of one event list. */
export function inventory(events) {
  const counts = { turns: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, images: 0, files: 0 }
  const attachments = new Map()
  const children = []
  const hidden = new Map()
  for (const event of events) {
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start': counts.turns += 1; break
      case 'user/message': if (data.source?.kind === 'user') counts.userMessages += 1; break
      case 'assistant/message': counts.assistantMessages += 1; break
      case 'tool/call': counts.toolCalls += 1; break
      case 'tool/result': counts.toolResults += 1; break
      case 'subagent/catalog':
        if (typeof data.childId === 'string' && data.childId !== '' && !children.includes(data.childId)) children.push(data.childId)
        break
      default: break
    }
    const message = data.message ?? (Array.isArray(data.content) ? data : undefined)
    walkBlocks(message?.content, block => {
      const kind = String(block.type ?? '')
      if (!DISPLAYED_BLOCKS.has(kind)) hidden.set(kind, (hidden.get(kind) ?? 0) + 1)
      const id = block.attachment?.attachmentId
      if ((kind === 'image' || kind === 'file') && typeof id === 'string' && !attachments.has(id)) {
        attachments.set(id, { id, kind, name: block.attachment?.name ?? null, bytes: block.attachment?.bytes ?? null })
        if (kind === 'image') counts.images += 1
        else counts.files += 1
      }
    })
  }
  return { counts, attachments: [...attachments.values()], children, hiddenBlocks: Object.fromEntries(hidden) }
}

/** Where one attachment's bytes live under a dsh Home (dsh-attachment-local layout). */
export function attachmentPaths(home, attachment) {
  const match = ATTACHMENT_ID.exec(attachment.id)
  if (match === null) return undefined
  const hex = match[1]
  const root = join(home, 'attachments', 'v1')
  if (attachment.kind === 'image') return { hex, object: join(root, 'objects', hex.slice(0, 2), hex) }
  const name = typeof attachment.name === 'string' ? attachment.name : ''
  return {
    hex,
    object: join(root, 'file-objects', hex.slice(0, 2), hex),
    reference: name !== '' && !name.includes('/') && !name.includes('\\') && name !== '..' && name !== '.'
      ? join(root, 'files', hex.slice(0, 2), hex, name)
      : undefined,
  }
}

function checkAttachment(home, attachment) {
  const paths = attachmentPaths(home, attachment)
  if (paths === undefined) return { ...attachment, status: 'unsupported', detail: 'not a content-addressed attachment id' }
  try {
    const bytes = readFileSync(paths.object)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== paths.hex) return { ...attachment, status: 'damaged', detail: 'stored bytes do not match their digest' }
    return { ...attachment, status: 'ok', size: bytes.length }
  } catch {
    return { ...attachment, status: 'missing', detail: 'not found in the legacy attachment store' }
  }
}

/**
 * Read one legacy session (and, recursively, its subagent children) without
 * writing anything. The result lists what a copy would contain and lose.
 */
async function analyze(store, legacyRoot, legacyHome, sessionId, depth = 0, seen = new Set(), parentPreset = undefined) {
  seen.add(sessionId)
  const located = locateLog(legacyRoot, sessionId)
  const node = { sessionId, depth, log: located?.path ?? null, children: [], gaps: [], skipped: {}, notes: [] }
  if (located === undefined) {
    node.status = 'missing'
    node.error = 'no session log in the legacy store'
    return node
  }
  let raw
  try {
    raw = rawRows(located.path)
  } catch (error) {
    raw = undefined
    node.rawError = String(error?.message ?? error)
  }
  let handle
  try {
    handle = await store.persistence.open(sessionId, 'read')
  } catch (error) {
    const classified = classify(error)
    if (classified.kind === 'missing' && located.version > SUPPORTED_VERSION) {
      classified.kind = 'unsupported'
      classified.message = `session log format v${located.version} is newer than this build reads (v${SUPPORTED_VERSION})`
    }
    node.status = classified.kind
    node.error = classified.message
    if (raw !== undefined) node.digest = raw.digest
    node.formatVersion = raw?.rows[0]?.version ?? located.version
    return node
  }
  try {
    const header = JSON.parse(JSON.stringify(handle.header ?? (await store.persistence.stat(sessionId))?.header ?? {}))
    const { events } = await handle.read()
    const copied = JSON.parse(JSON.stringify(events))
    node.header = header
    node.events = copied
    node.inheritedEventCount = Number(handle.inheritedEventCount ?? 0)
    node.formatVersion = raw?.rows[0]?.version ?? header.version ?? located.version
    node.digest = raw?.digest ?? null
    node.title = titleOf(copied)
    node.openTurn = openTurn(copied)
    node.cwd = header.cwd ?? ''
    node.createdAt = header.createdAt ?? 0
    node.updatedAt = copied.at(-1)?.time ?? header.createdAt ?? 0
    const found = inventory(copied)
    node.counts = found.counts
    node.hiddenBlocks = found.hiddenBlocks
    node.attachments = found.attachments.map(item => checkAttachment(legacyHome, item))
    for (const item of node.attachments) {
      if (item.status !== 'ok') node.gaps.push(`${item.kind} attachment ${item.id} is ${item.status}${item.detail ? ` (${item.detail})` : ''}`)
    }
    if (raw !== undefined) {
      const known = store.knownTypes
      for (const row of raw.rows.slice(1)) {
        if (typeof row?.type === 'string' && !known.has(row.type) && row.ignorable === true) {
          node.skipped[row.type] = (node.skipped[row.type] ?? 0) + 1
        }
      }
    }
    if (typeof header.agentPreset === 'string' && header.agentPreset !== '' && header.agentPreset !== parentPreset) {
      node.notes.push(`legacy agent preset '${header.agentPreset}' is not installed here; the copy continues with this client's agent and tools`)
    }
    if (node.openTurn !== null) {
      node.notes.push(`turn ${node.openTurn} never finished (it may still be running in the old client); the copy ends at the last saved event and resumes as interrupted`)
    }
    try {
      // The exact seed check a copy (and every later resume) goes through.
      const { Session, SessionId, SessionLogOffset } = store.session
      Session.create(SessionId(sessionId), copied, header, SessionLogOffset(header.isSeeded === true ? node.inheritedEventCount : 0))
    } catch (error) {
      node.status = 'unsupported'
      node.error = `this build cannot resume the log: ${error?.message ?? error}`
      return node
    }
    node.status = 'ok'
    for (const childId of found.children) {
      if (seen.has(childId)) continue
      if (depth + 1 > MAX_DEPTH) {
        node.gaps.push(`subagent ${childId} is nested too deeply to copy`)
        continue
      }
      const child = await analyze(store, legacyRoot, legacyHome, childId, depth + 1, seen, header.agentPreset)
      if (child.status !== 'ok') node.gaps.push(`subagent ${childId} log is ${child.status}${child.error ? `: ${child.error}` : ''}`)
      node.children.push(child)
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  return node
}

function flatten(node, out = []) {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

/** complete, partial (copyable with gaps), or a refusal kind. */
function verdict(node) {
  if (node.status !== 'ok') return node.status
  const all = flatten(node).filter(item => item.status === 'ok')
  const gaps = all.flatMap(item => item.gaps)
  const skipped = all.some(item => Object.keys(item.skipped).length > 0)
  return gaps.length > 0 || skipped ? 'partial' : 'complete'
}

function blocking(node) {
  return flatten(node).filter(item => item.status === 'ok').flatMap(item => item.gaps)
}

// ---------------------------------------------------------------- records

export function readRecords(home) {
  const dir = join(home, RECORD_DIR)
  const records = []
  for (const name of safeDir(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (value && typeof value === 'object' && typeof value.copyId === 'string') records.push({ ...value, file: join(dir, name) })
    } catch {
      // A torn record is reported by the stale-record sweep below.
    }
  }
  return records
}

function writeRecord(home, record) {
  const dir = join(home, RECORD_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, `${record.copyId}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, target)
  return target
}

function sameHome(a, b) {
  return resolve(a) === resolve(b)
}

function copiesOf(records, legacyHome, sessionId) {
  return records
    .filter(record => record.status !== 'pending' && record.source?.sessionId === sessionId && sameHome(record.source?.home ?? '', legacyHome))
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function removeSessionDirs(root, ids) {
  for (const id of ids) {
    for (const project of safeDir(root)) {
      const dir = join(root, project, id)
      if (existsSync(dir) && lstatSync(dir).isDirectory() && resolve(dir).startsWith(resolve(root) + sep)) rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A pending record whose writer is gone is an interrupted import: undo it. */
function sweepStale(home, root) {
  const cleaned = []
  for (const record of readRecords(home)) {
    if (record.status !== 'pending' || alive(record.pid)) continue
    removeSessionDirs(root, record.createdSessions ?? [])
    for (const path of record.createdFiles ?? []) rmSync(path, { force: true })
    rmSync(record.file, { force: true })
    cleaned.push(record.source?.sessionId ?? record.copyId)
  }
  return cleaned
}

// ---------------------------------------------------------------- copying

function remapIds(value, map) {
  if (typeof value === 'string') {
    if (map.has(value)) return map.get(value)
    // Transcript text names subagents too ("started subagent <id>"); ids are
    // UUIDs, so a substring match cannot hit anything else.
    let out = value
    for (const [from, to] of map) if (from.length >= 32 && out.includes(from)) out = out.replaceAll(from, to)
    return out
  }
  if (Array.isArray(value)) return value.map(item => remapIds(item, map))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = remapIds(item, map)
    return out
  }
  return value
}

function canonicalDigest(events) {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex')
}

function copyAttachment(legacyHome, home, attachment, created) {
  const from = attachmentPaths(legacyHome, attachment)
  const to = attachmentPaths(home, attachment)
  const place = (source, target) => {
    if (existsSync(target)) {
      const digest = createHash('sha256').update(readFileSync(target)).digest('hex')
      if (digest === from.hex) return
      throw new MigrationError(`attachment ${attachment.id} already exists in the isolated store with different bytes`)
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    copyFileSync(source, target)
    created.push(target)
  }
  place(from.object, to.object)
  if (from.reference !== undefined && to.reference !== undefined) {
    if (!existsSync(to.reference)) {
      mkdirSync(dirname(to.reference), { recursive: true, mode: 0o700 })
      try {
        linkSync(to.object, to.reference)
      } catch {
        copyFileSync(to.object, to.reference)
      }
      created.push(to.reference)
    }
  }
}

function failpoint(stage) {
  if (process.env.CODSH_TEST_MIGRATION_FAIL === stage) throw new MigrationError(`injected failure after ${stage} (CODSH_TEST_MIGRATION_FAIL)`)
}

async function writeCopy(dsh, store, node, copyId, idMap, isRoot) {
  const header = { ...node.header, id: copyId }
  delete header.agentPreset
  if (isRoot) {
    // ACP session/list refuses a root whose header names a parent; the
    // legacy fork parent stays in the provenance record.
    delete header.parentSession
  } else if (typeof header.parentSession === 'string') {
    header.parentSession = idMap.get(header.parentSession) ?? header.parentSession
  }
  const events = remapIds(node.events, idMap)
  const inherited = header.isSeeded === true ? node.inheritedEventCount : 0
  const { Session, SessionId, SessionLogOffset } = dsh.session
  const session = Session.create(SessionId(copyId), events, header, SessionLogOffset(inherited))
  const snapshot = JSON.parse(JSON.stringify(session.snapshotEvents()))
  // dsh closes a constructor seed with its own `session/end-seed` marker (as
  // on every resume); anything else added or changed is a failed copy.
  const added = snapshot.slice(events.length)
  if (canonicalDigest(snapshot.slice(0, events.length)) !== canonicalDigest(events) || added.some(event => event.type !== 'session/end-seed')) {
    throw new MigrationError(`dsh changed the events of ${node.sessionId} while preparing the copy`)
  }
  const writer = await store.persistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
  try {
    if (snapshot.length > 0) await writer.append(session.snapshotEvents())
    await writer.flush()
  } finally {
    await writer.close().catch(() => undefined)
  }
  return { events: snapshot, header: session.header }
}

async function verifyCopy(store, copyId, expected) {
  const handle = await store.persistence.open(copyId, 'read')
  try {
    const { events } = await handle.read()
    const got = JSON.parse(JSON.stringify(events))
    if (got.length !== expected.length) {
      throw new MigrationError(`copy ${copyId} re-read ${got.length} events, expected ${expected.length}`)
    }
    if (canonicalDigest(got) !== canonicalDigest(expected)) throw new MigrationError(`copy ${copyId} does not match what was written`)
    return canonicalDigest(got)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------- summary

function summary(node) {
  const all = flatten(node).filter(item => item.status === 'ok')
  const add = key => all.reduce((sum, item) => sum + (item.counts?.[key] ?? 0), 0)
  const skipped = {}
  const hidden = {}
  for (const item of all) {
    for (const [type, count] of Object.entries(item.skipped)) skipped[type] = (skipped[type] ?? 0) + count
    for (const [type, count] of Object.entries(item.hiddenBlocks ?? {})) hidden[type] = (hidden[type] ?? 0) + count
  }
  return {
    sessionId: node.sessionId,
    status: node.status,
    verdict: verdict(node),
    error: node.error ?? null,
    formatVersion: node.formatVersion ?? null,
    title: node.title ?? '',
    cwd: node.cwd ?? '',
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    log: node.log,
    digest: node.digest ?? null,
    events: node.events?.length ?? 0,
    turns: node.counts?.turns ?? 0,
    userMessages: add('userMessages'),
    assistantMessages: add('assistantMessages'),
    toolCalls: add('toolCalls'),
    toolResults: add('toolResults'),
    attachments: all.flatMap(item => item.attachments ?? []).map(({ id, kind, name, status }) => ({ id, kind, name, status })),
    subagents: flatten(node).length - 1,
    subagentsCopyable: all.length - 1,
    openTurn: node.openTurn ?? null,
    skippedEvents: skipped,
    hiddenBlocks: hidden,
    gaps: blocking(node),
    notes: all.flatMap(item => item.notes.map(note => (item === node ? note : `subagent ${item.sessionId}: ${note}`))),
    parentSession: node.header?.parentSession ?? null,
  }
}

// ---------------------------------------------------------------- commands

export async function listLegacy({ dshBin, home, legacyHome }) {
  const legacyRoot = join(legacyHome, 'sessions')
  const result = { ok: true, mode: 'list', legacyHome, sessions: [], warnings: [] }
  if (!existsSync(legacyRoot)) {
    result.missingStore = true
    return result
  }
  const encoding = rootEncoding(legacyRoot)
  if (encoding === 'mixed') throw new MigrationError(`the legacy session store mixes compressed and plain logs (${legacyRoot}); nothing was read`)
  const dsh = await loadDsh(dshBin)
  const store = await openStore(dsh, legacyRoot, encoding)
  store.knownTypes = dsh.session.KNOWN_SESSION_EVENT_TYPES
  store.session = dsh.session
  const records = readRecords(home)
  try {
    let listed = []
    try {
      listed = await store.persistence.list()
    } catch (error) {
      throw new MigrationError(`cannot list legacy sessions in ${legacyRoot}: ${error.message}`)
    }
    const ids = new Set()
    for (const snapshot of listed) {
      const header = snapshot.header ?? {}
      if (typeof header.id !== 'string' || header.origin === 'subagent') continue
      ids.add(header.id)
    }
    // A log whose header dsh refuses is absent from list(); report it too.
    for (const project of safeDir(legacyRoot)) {
      for (const name of safeDir(join(legacyRoot, project))) {
        if (!ids.has(name) && locateLog(legacyRoot, name) !== undefined) {
          const rows = (() => { try { return rawRows(locateLog(legacyRoot, name).path).rows } catch { return [] } })()
          if (rows[0]?.origin !== 'subagent') ids.add(name)
        }
      }
    }
    for (const id of ids) {
      const node = await analyze(store, legacyRoot, legacyHome, id)
      const row = summary(node)
      row.copies = copiesOf(records, legacyHome, id).map(record => ({
        copyId: record.copyId, status: record.status, digest: record.source?.digest ?? null, completedAt: record.completedAt ?? null,
      }))
      const last = row.copies.at(-1)
      row.importState = last === undefined ? 'not imported' : last.digest === row.digest ? 'imported' : 'changed since import'
      result.sessions.push(row)
    }
  } finally {
    await store.close()
  }
  result.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return result
}

export async function importSessions(options) {
  const { dshBin, home, legacyHome, ids = [], all = false, apply = false, again = false, allowPartial = false } = options
  const legacyRoot = join(legacyHome, 'sessions')
  const root = join(home, 'sessions')
  if (sameHome(legacyHome, home) || resolve(home).startsWith(resolve(legacyHome) + sep) || resolve(legacyHome).startsWith(resolve(home) + sep)) {
    throw new MigrationError('the legacy dsh Home and the isolated Home overlap; refusing to import', 2)
  }
  const result = { ok: true, mode: apply ? 'apply' : 'preview', legacyHome, results: [], warnings: [] }
  const release = apply ? acquireLock(home) : () => undefined
  try {
    if (apply) {
      for (const id of sweepStale(home, root)) result.warnings.push(`removed an interrupted earlier import of ${id}`)
    }
    return await importSelected({ dshBin, home, legacyHome, legacyRoot, root, ids, all, apply, again, allowPartial, result })
  } finally {
    release()
  }
}

/** One importer at a time per isolated Home; a lock left by a dead process is taken over. */
function acquireLock(home) {
  const dir = join(home, RECORD_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, '.import.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      return () => rmSync(path, { force: true })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = Number.parseInt(readFileSync(path, 'utf8'), 10)
      if (alive(owner) && owner !== process.pid) {
        throw new MigrationError(`another session import (pid ${owner}) is running for this Home; try again when it finishes`)
      }
      rmSync(path, { force: true })
    }
  }
  throw new MigrationError('could not take the session import lock')
}

async function importSelected({ dshBin, home, legacyHome, legacyRoot, root, ids, all, apply, again, allowPartial, result }) {
  if (!existsSync(legacyRoot)) throw new MigrationError(`no legacy session store at ${legacyRoot}`, 3)
  let selected = [...ids]
  if (all) {
    const listed = await listLegacy({ dshBin, home, legacyHome })
    selected = listed.sessions.filter(row => row.importState !== 'imported').map(row => row.sessionId)
  }
  if (selected.length === 0) {
    result.warnings.push(all ? 'every legacy session is already imported' : 'no legacy session selected')
    return result
  }
  const encoding = rootEncoding(legacyRoot)
  if (encoding === 'mixed') throw new MigrationError(`the legacy session store mixes compressed and plain logs (${legacyRoot}); nothing was read`)
  const dsh = await loadDsh(dshBin)
  const legacy = await openStore(dsh, legacyRoot, encoding)
  legacy.knownTypes = dsh.session.KNOWN_SESSION_EVENT_TYPES
  legacy.session = dsh.session
  const isolated = apply ? await openStore(dsh, root, 'zstd') : undefined
  try {
    for (const sessionId of [...new Set(selected)]) {
      const node = await analyze(legacy, legacyRoot, legacyHome, sessionId)
      const row = summary(node)
      const existing = copiesOf(readRecords(home), legacyHome, sessionId)
      const last = existing.at(-1)
      row.copies = existing.map(record => record.copyId)
      if (node.status !== 'ok') {
        row.outcome = 'refused'
        row.reason = refusal(node)
        result.results.push(row)
        continue
      }
      if (last !== undefined && !again) {
        if (last.source?.digest === row.digest) {
          row.outcome = 'already-imported'
          row.copyId = last.copyId
          row.reason = `already imported as ${last.copyId}; the legacy session has not changed since (pass --again for another copy)`
        } else {
          row.outcome = 'conflict'
          row.copyId = last.copyId
          row.reason = `the legacy session changed since it was imported as ${last.copyId}; pass --again to import a new copy (the earlier copy is kept)`
        }
        result.results.push(row)
        continue
      }
      if (row.gaps.length > 0 && !allowPartial) {
        row.outcome = 'refused'
        row.reason = 'referenced data is missing (listed under gaps); pass --allow-partial to copy the rest'
        result.results.push(row)
        continue
      }
      if (!apply) {
        row.outcome = 'would-import'
        result.results.push(row)
        continue
      }
      try {
        const done = await copyTree(dsh, isolated, node, { home, legacyHome, root, row })
        Object.assign(row, done)
        row.outcome = 'imported'
      } catch (error) {
        row.outcome = 'failed'
        row.reason = `${error.message}. Nothing from this attempt was kept; the legacy session is unchanged.`
      }
      result.results.push(row)
    }
  } finally {
    await legacy.close()
    await isolated?.close()
  }
  result.ok = result.results.every(row => ['imported', 'already-imported', 'would-import'].includes(row.outcome))
  return result
}

function refusal(node) {
  switch (node.status) {
    case 'missing': return `no legacy session '${node.sessionId}' (${node.error})`
    case 'unsupported': return `the legacy log uses a format or event this build cannot read (${node.error}); nothing was copied`
    case 'damaged': return `the legacy log is damaged (${node.error}); nothing was copied`
    default: return `the legacy log could not be read (${node.error}); nothing was copied`
  }
}

async function copyTree(dsh, store, node, { home, legacyHome, root, row }) {
  const nodes = flatten(node).filter(item => item.status === 'ok')
  const idMap = new Map(nodes.map(item => [item.sessionId, randomUUID()]))
  const copyId = idMap.get(node.sessionId)
  const record = {
    schema: RECORD_SCHEMA,
    copyId,
    status: 'pending',
    pid: process.pid,
    startedAt: Date.now(),
    source: {
      kind: 'legacy-dsh',
      home: resolve(legacyHome),
      sessionId: node.sessionId,
      log: node.log,
      formatVersion: node.formatVersion,
      digest: node.digest,
      events: node.events.length,
      parentSession: node.header?.parentSession ?? null,
    },
    children: nodes.slice(1).map(item => ({ sessionId: item.sessionId, copyId: idMap.get(item.sessionId), log: item.log, digest: item.digest })),
    createdSessions: [],
    createdFiles: [],
  }
  writeRecord(home, record)
  try {
    const written = []
    // Children first: a parent never points at a copy that is not there yet.
    for (const item of [...nodes].reverse()) {
      const id = idMap.get(item.sessionId)
      record.createdSessions.push(id)
      writeRecord(home, record)
      const out = await writeCopy(dsh, store, item, id, idMap, item === node)
      written.push({ id, events: out.events })
      if (item === node) failpoint('root')
    }
    for (const item of nodes) {
      for (const attachment of item.attachments ?? []) {
        if (attachment.status === 'ok') copyAttachment(legacyHome, home, attachment, record.createdFiles)
      }
    }
    writeRecord(home, record)
    failpoint('attachments')
    const digests = {}
    for (const entry of written) digests[entry.id] = await verifyCopy(store, entry.id, entry.events)
    for (const item of nodes) {
      for (const attachment of item.attachments ?? []) {
        if (attachment.status !== 'ok') continue
        const check = checkAttachment(home, attachment)
        if (check.status !== 'ok') throw new MigrationError(`copied attachment ${attachment.id} failed verification (${check.status})`)
      }
    }
    const status = row.verdict === 'complete' ? 'complete' : 'partial'
    const final = {
      ...record,
      status,
      completedAt: Date.now(),
      verified: digests,
      report: {
        turns: row.turns, userMessages: row.userMessages, assistantMessages: row.assistantMessages,
        toolCalls: row.toolCalls, toolResults: row.toolResults, attachments: row.attachments,
        subagents: row.subagents, skippedEvents: row.skippedEvents, hiddenBlocks: row.hiddenBlocks,
        gaps: row.gaps, notes: row.notes,
      },
    }
    delete final.pid
    writeRecord(home, final)
    return { copyId, status, children: record.children }
  } catch (error) {
    removeSessionDirs(root, record.createdSessions)
    for (const path of record.createdFiles) rmSync(path, { force: true })
    rmSync(join(home, RECORD_DIR, `${copyId}.json`), { force: true })
    throw error
  }
}

// ---------------------------------------------------------------- rendering

function when(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown time'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function contentLine(row) {
  const parts = [
    `${row.turns} turn(s)`,
    `${row.userMessages} prompt(s)`,
    `${row.assistantMessages} answer(s)`,
    `${row.toolCalls} tool call(s)`,
    `${row.attachments.length} attachment(s)`,
    `${row.subagents} subagent(s)`,
  ]
  return parts.join(' · ')
}

function detailLines(row) {
  const lines = []
  for (const gap of row.gaps) lines.push(`    missing: ${gap}`)
  for (const [type, count] of Object.entries(row.skippedEvents)) lines.push(`    not copied: ${count} '${type}' event(s) this build does not read (marked skippable by the old client)`)
  for (const [type, count] of Object.entries(row.hiddenBlocks)) lines.push(`    kept, not displayed: ${count} '${type}' content block(s)`)
  for (const note of row.notes) lines.push(`    note: ${note}`)
  return lines
}

export function renderText(result) {
  const lines = []
  if (result.mode === 'list') {
    if (result.missingStore) {
      lines.push(`No legacy session store at ${join(result.legacyHome, 'sessions')}; nothing to import.`)
      lines.push('Point DSH_HOME at the old client\'s dsh Home if it is not ~/.dsh.')
    } else lines.push(`Legacy sessions in ${join(result.legacyHome, 'sessions')}:`)
    if (result.sessions.length === 0 && !result.missingStore) lines.push('  (none)')
    for (const row of result.sessions) {
      const title = row.title === '' ? '(untitled)' : row.title
      if (row.status !== 'ok') {
        lines.push(`  ${row.sessionId}  ${row.status}: ${row.error}`)
        continue
      }
      lines.push(`  ${row.sessionId}  ${title} · ${when(row.updatedAt)} · ${row.cwd}`)
      lines.push(`    ${contentLine(row)} · ${row.verdict} · ${row.importState}${row.copies.length > 0 ? ` (copy ${row.copies.at(-1).copyId})` : ''}`)
      lines.push(...detailLines(row))
    }
    if (result.sessions.length > 0) lines.push('Nothing was written. Import with: codsh --rust import sessions <id>... --apply (or --all --apply).')
  } else {
    for (const row of result.results) {
      const head = {
        imported: `Imported ${row.sessionId} as ${row.copyId} (${row.status})`,
        'would-import': `Would import ${row.sessionId} (${row.verdict})`,
        'already-imported': `Skipped ${row.sessionId}: ${row.reason}`,
        conflict: `Conflict ${row.sessionId}: ${row.reason}`,
        refused: `Refused ${row.sessionId}: ${row.reason}`,
        failed: `Failed ${row.sessionId}: ${row.reason}`,
      }[row.outcome]
      lines.push(head)
      if (row.status === 'ok') {
        lines.push(`    ${contentLine(row)}${row.title ? ` · "${row.title}"` : ''}`)
        lines.push(...detailLines(row))
      }
      if (row.outcome === 'imported') lines.push(`    resume with: codsh --rust --resume ${row.copyId}`)
    }
    if (result.mode === 'preview') lines.push('Nothing was written. Pass --apply to copy.')
    else lines.push('The legacy Home was only read; the old client still opens its original sessions.')
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`)
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const options = { ids: [], all: false, apply: false, preview: false, again: false, allowPartial: false, json: false, list: false }
  for (const arg of argv) {
    switch (arg) {
      case '--all': options.all = true; break
      case '--apply': options.apply = true; break
      case '--preview': options.preview = true; break
      case '--again': options.again = true; break
      case '--allow-partial': options.allowPartial = true; break
      case '--json': options.json = true; break
      case '--list': options.list = true; break
      default:
        if (arg.startsWith('-')) throw new MigrationError(`unsupported import sessions option ${arg}; use codsh --rust import sessions --help`, 2)
        options.ids.push(arg)
    }
  }
  if (options.apply && options.preview) throw new MigrationError('use only one of --preview or --apply; --preview never writes', 2)
  if (options.all && options.ids.length > 0) throw new MigrationError('use either --all or session ids, not both', 2)
  return options
}

async function main() {
  const home = process.env.DSH_HOME
  const legacyHome = process.env.CODSH_HOST_DSH_HOME
  const dshBin = process.env.DSH_BIN
  let options
  try {
    options = parseArgs(process.argv.slice(2))
    if (!home) throw new MigrationError('missing DSH_HOME (run through the codsh launcher)', 2)
    if (!legacyHome) throw new MigrationError('missing the legacy dsh Home (run through `codsh --rust import sessions`)', 2)
    if (!dshBin) throw new MigrationError('missing DSH_BIN (run through the codsh launcher)', 2)
    const listing = options.list || (!options.all && options.ids.length === 0)
    const result = listing
      ? await listLegacy({ dshBin, home, legacyHome })
      : await importSessions({ dshBin, home, legacyHome, ...options, apply: options.apply && !options.preview })
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : renderText(result))
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    const code = error instanceof MigrationError ? error.code : 1
    if (options?.json) process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    else process.stderr.write(`${error.message}\n`)
    process.exitCode = code
  }
}

if (process.argv[1] && process.argv[1].includes('rust-session-migrate')) {
  main()
}
