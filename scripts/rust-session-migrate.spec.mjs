import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { openLegacyHome, tinyPng } from './rust-session-migrate-fixture.mjs'
import { locateLog, rawRows, splitFrames } from '../packages/cli/bin/rust-session-migrate.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HELPER = join(ROOT, 'packages/cli/bin/rust-session-migrate.mjs')
const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const DSH_BIN = (() => {
  const bin = JSON.parse(readFileSync(dshManifest, 'utf8')).bin
  return join(dirname(dshManifest), typeof bin === 'string' ? bin : bin.dsh)
})()

const temps = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function homes() {
  const base = mkdtempSync('/tmp/codsh-194-spec-')
  temps.push(base)
  const legacy = join(base, 'legacy-dsh')
  const isolated = join(base, 'rust-home', '.codsh-rust', 'dsh')
  mkdirSync(legacy, { recursive: true })
  mkdirSync(isolated, { recursive: true })
  return { base, legacy, isolated }
}

function migrate(h, args, env = {}) {
  const result = spawnSync(process.execPath, [HELPER, ...args], {
    env: { ...process.env, DSH_HOME: h.isolated, CODSH_HOST_DSH_HOME: h.legacy, DSH_BIN, CODSH_TEST_MIGRATION_FAIL: '', ...env },
    encoding: 'utf8',
  })
  let json
  if (args.includes('--json')) json = JSON.parse(result.stdout)
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

/** Every file under a tree with its sha256 and mtime: the "untouched" proof. */
function snapshot(dir) {
  const out = {}
  const walk = at => {
    for (const name of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, name.name)
      if (name.isDirectory()) walk(path)
      else out[relative(dir, path)] = `${createHash('sha256').update(readFileSync(path)).digest('hex')}:${statSync(path).mtimeMs}`
    }
  }
  walk(dir)
  return out
}

function treeFiles(dir) {
  return existsSync(dir) ? Object.keys(snapshot(dir)).sort() : []
}

async function readCopy(h, id) {
  const fx = await openLegacyHome(DSH_BIN, h.isolated)
  try {
    const requireFromDsh = createRequire(DSH_BIN)
    const { pathToFileURL } = await import('node:url')
    const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
    const Persistence = (await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)).default
    const ctx = new Context()
    await ctx.plugin(Persistence, { root: join(h.isolated, 'sessions'), compression: 'zstd' })
    const handle = await ctx.sessionPersistence.open(id, 'read')
    const { events } = await handle.read()
    const header = JSON.parse(JSON.stringify(handle.header ?? (await ctx.sessionPersistence.stat(id)).header))
    await handle.close()
    await ctx.fiber?.dispose?.().catch(() => undefined)
    return { header, events: JSON.parse(JSON.stringify(events)) }
  } finally {
    await fx.close()
  }
}

/** Append one raw JSONL row to a legacy log as its own zstd frame. */
function appendRawRow(home, id, row) {
  const log = locateLog(join(home, 'sessions'), id).path
  appendFileSync(log, zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`)))
}

async function richLegacy(h) {
  const fx = await openLegacyHome(DSH_BIN, h.legacy)
  try {
    const image = await fx.saveImage(tinyPng())
    const file = await fx.saveFile('notes.txt', 'legacy file body\n')
    const childId = '0b4a1f6e-1111-4c2d-9e8f-000000000001'
    await fx.write(childId, [
      { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'CHILD_BRIEF' } },
      ...fx.turn(1, 'child prompt', { answer: 'CHILD_ANSWER' }),
    ], { origin: 'subagent', parentSession: 'session-rich', delegationDepth: 1 })
    await fx.write('session-rich', [
      ...fx.turn(1, 'RICH_PROMPT', { blocks: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }], title: 'Rich legacy session', tool: true, answer: 'RICH_ANSWER' }),
      { type: 'subagent/catalog', data: { version: 0, childId, childCreatedAt: 1, mode: 'continuable', label: 'CHILD_BRIEF' } },
      ...fx.turn(2, `started subagent ${childId}`, { answer: 'SECOND_ANSWER' }),
    ])
    await fx.write('session-plain', fx.turn(1, 'PLAIN_PROMPT', { title: 'Plain legacy session' }))
    return { image, file, childId }
  } finally {
    await fx.close()
  }
}

describe('codsh --rust import sessions helper (ticket 62)', () => {
  it('lists and previews without writing anything, then copies a session tree with attachments and provenance', async () => {
    const h = homes()
    const { image, file, childId } = await richLegacy(h)
    const before = snapshot(h.legacy)

    const listed = migrate(h, ['--json'])
    expect(listed.code).toBe(0)
    const rich = listed.json.sessions.find(row => row.sessionId === 'session-rich')
    expect(listed.json.sessions.map(row => row.sessionId).sort()).toEqual(['session-plain', 'session-rich'])
    expect(rich).toMatchObject({ verdict: 'complete', importState: 'not imported', subagents: 1, toolCalls: 1, turns: 2 })
    expect(rich.attachments.map(item => [item.kind, item.status])).toEqual([['image', 'ok'], ['file', 'ok']])
    expect(migrate(h, []).stdout).toContain('Nothing was written')

    const preview = migrate(h, ['session-rich', '--json'])
    expect(preview.code).toBe(0)
    expect(preview.json.results[0].outcome).toBe('would-import')
    expect(treeFiles(h.isolated)).toEqual([])

    const applied = migrate(h, ['session-rich', '--apply', '--json'])
    expect(applied.code, applied.stdout + applied.stderr).toBe(0)
    const row = applied.json.results[0]
    expect(row).toMatchObject({ outcome: 'imported', status: 'complete' })
    expect(row.copyId).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.copyId).not.toBe('session-rich')
    expect(snapshot(h.legacy)).toEqual(before)

    const copy = await readCopy(h, row.copyId)
    expect(copy.header.id).toBe(row.copyId)
    expect(copy.header.agentPreset).toBeUndefined()
    expect(copy.header.parentSession).toBeUndefined()
    const text = JSON.stringify(copy.events)
    for (const token of ['RICH_PROMPT', 'RICH_ANSWER', 'SECOND_ANSWER', image.attachmentId, file.attachmentId]) expect(text).toContain(token)
    expect(text).not.toContain(childId)
    const childCopy = row.children[0].copyId
    expect(copy.events.find(event => event.type === 'subagent/catalog').data.childId).toBe(childCopy)
    expect(text).toContain(`started subagent ${childCopy}`)
    expect(copy.events.at(-1).type).toBe('session/end-seed')
    const legacyEvents = rawRows(locateLog(join(h.legacy, 'sessions'), 'session-rich').path).rows.slice(1)
    expect(copy.events.length).toBe(legacyEvents.length + 1)

    const child = await readCopy(h, childCopy)
    expect(child.header).toMatchObject({ origin: 'subagent', parentSession: row.copyId, delegationDepth: 1 })
    expect(JSON.stringify(child.events)).toContain('CHILD_ANSWER')

    const imageHex = image.attachmentId.slice(7)
    const fileHex = file.attachmentId.slice(7)
    expect(readFileSync(join(h.isolated, 'attachments/v1/objects', imageHex.slice(0, 2), imageHex))).toEqual(tinyPng())
    expect(readFileSync(join(h.isolated, 'attachments/v1/files', fileHex.slice(0, 2), fileHex, 'notes.txt'), 'utf8')).toBe('legacy file body\n')

    const record = JSON.parse(readFileSync(join(h.isolated, 'session-migrations', `${row.copyId}.json`), 'utf8'))
    expect(record).toMatchObject({
      status: 'complete', copyId: row.copyId,
      source: { kind: 'legacy-dsh', home: h.legacy, sessionId: 'session-rich', formatVersion: 3, digest: rich.digest },
      children: [{ sessionId: childId, copyId: childCopy }],
    })
    expect(record.pid).toBeUndefined()
    expect(Object.keys(record.verified).sort()).toEqual([row.copyId, childCopy].sort())

    const again = migrate(h, ['--json'])
    expect(again.json.sessions.find(item => item.sessionId === 'session-rich').importState).toBe('imported')
    expect(existsSync(join(h.isolated, 'session-migrations', '.import.lock'))).toBe(false)
  }, 60_000)

  it('recognises a repeated import, reports a legacy session that grew as a conflict, and copies again only on --again', async () => {
    const h = homes()
    await richLegacy(h)
    const first = migrate(h, ['session-plain', '--apply', '--json']).json.results[0]
    expect(first.outcome).toBe('imported')

    const repeat = migrate(h, ['session-plain', '--apply', '--json'])
    expect(repeat.code).toBe(0)
    expect(repeat.json.results[0]).toMatchObject({ outcome: 'already-imported', copyId: first.copyId })

    const all = migrate(h, ['--all', '--apply', '--json'])
    expect(all.json.results.map(item => item.sessionId)).toEqual(['session-rich'])

    const fx = await openLegacyHome(DSH_BIN, h.legacy)
    await fx.grow('session-plain', fx.turn(2, 'LEGACY_KEPT_GOING'))
    await fx.close()

    const conflict = migrate(h, ['session-plain', '--apply', '--json'])
    expect(conflict.code).toBe(1)
    expect(conflict.json.results[0]).toMatchObject({ outcome: 'conflict', copyId: first.copyId })
    expect(migrate(h, ['--json']).json.sessions.find(item => item.sessionId === 'session-plain').importState).toBe('changed since import')

    const second = migrate(h, ['session-plain', '--apply', '--again', '--json'])
    expect(second.code).toBe(0)
    const secondCopy = second.json.results[0].copyId
    expect(secondCopy).not.toBe(first.copyId)
    expect(JSON.stringify((await readCopy(h, secondCopy)).events)).toContain('LEGACY_KEPT_GOING')
    expect(JSON.stringify((await readCopy(h, first.copyId)).events)).not.toContain('LEGACY_KEPT_GOING')
  }, 60_000)

  it('refuses a missing attachment unless --allow-partial, and records the gap', async () => {
    const h = homes()
    const { image } = await richLegacy(h)
    const hex = image.attachmentId.slice(7)
    rmSync(join(h.legacy, 'attachments/v1/objects', hex.slice(0, 2), hex))
    const before = snapshot(h.legacy)

    const refused = migrate(h, ['session-rich', '--apply', '--json'])
    expect(refused.code).toBe(1)
    expect(refused.json.results[0]).toMatchObject({ outcome: 'refused', verdict: 'partial' })
    expect(refused.json.results[0].gaps.join('\n')).toContain(`image attachment ${image.attachmentId} is missing`)
    expect(treeFiles(join(h.isolated, 'sessions'))).toEqual([])
    expect(migrate(h, ['session-rich']).stdout).toContain('missing: image attachment')

    const partial = migrate(h, ['session-rich', '--apply', '--allow-partial', '--json'])
    expect(partial.code).toBe(0)
    const row = partial.json.results[0]
    expect(row).toMatchObject({ outcome: 'imported', status: 'partial' })
    const record = JSON.parse(readFileSync(join(h.isolated, 'session-migrations', `${row.copyId}.json`), 'utf8'))
    expect(record.status).toBe('partial')
    expect(record.report.gaps.join('\n')).toContain(image.attachmentId)
    expect(existsSync(join(h.isolated, 'attachments/v1/objects', hex.slice(0, 2), hex))).toBe(false)
    expect(snapshot(h.legacy)).toEqual(before)
  }, 60_000)

  it('reports skipped ignorable events and refuses unknown required events, damaged logs, and newer formats', async () => {
    const h = homes()
    const fx = await openLegacyHome(DSH_BIN, h.legacy)
    await fx.write('session-skip', [...fx.turn(1, 'SKIP_PROMPT'), { type: 'future/hint', ignorable: true, data: { note: 'x' } }])
    await fx.write('session-required', fx.turn(1, 'REQUIRED_PROMPT'))
    await fx.write('session-damaged', fx.turn(1, 'DAMAGED_PROMPT'))
    await fx.close()
    appendRawRow(h.legacy, 'session-required', { type: 'future/required', seq: 6, time: 1, data: {} })
    const damaged = locateLog(join(h.legacy, 'sessions'), 'session-damaged').path
    const bytes = readFileSync(damaged)
    const frames = splitFrames(bytes)
    const middle = frames[0].length + Math.floor(frames[1].length / 2)
    bytes[middle] ^= 0xff
    bytes[middle + 1] ^= 0xff
    writeFileSync(damaged, bytes)
    const futureDir = join(h.legacy, 'sessions', '--tmp-codsh-194-fixture-ws--', 'session-future')
    mkdirSync(futureDir, { recursive: true })
    writeFileSync(join(futureDir, 'session.v9.jsonl.zstd'), zstdCompressSync(Buffer.from(`${JSON.stringify({ version: 9, id: 'session-future', createdAt: 1, cwd: '/tmp' })}\n`)))
    const before = snapshot(h.legacy)

    const listed = migrate(h, ['--json'])
    expect(listed.code).toBe(0)
    const by = Object.fromEntries(listed.json.sessions.map(row => [row.sessionId, row]))
    expect(by['session-skip']).toMatchObject({ status: 'ok', verdict: 'partial', skippedEvents: { 'future/hint': 1 } })
    expect(by['session-required'].status).toBe('unsupported')
    expect(by['session-future'].status).toBe('unsupported')
    expect(by['session-future'].error).toContain('v9')
    expect(['damaged', 'unreadable']).toContain(by['session-damaged'].status)

    const applied = migrate(h, ['session-skip', 'session-required', 'session-damaged', 'session-future', 'session-nope', '--apply', '--json'])
    expect(applied.code).toBe(1)
    const outcomes = Object.fromEntries(applied.json.results.map(row => [row.sessionId, row.outcome]))
    expect(outcomes).toEqual({
      'session-skip': 'imported', 'session-required': 'refused', 'session-damaged': 'refused', 'session-future': 'refused', 'session-nope': 'refused',
    })
    const skip = applied.json.results.find(row => row.sessionId === 'session-skip')
    expect(skip.status).toBe('partial')
    const text = migrate(h, ['session-skip', '--again']).stdout
    expect(text).toContain("not copied: 1 'future/hint' event(s)")
    expect(snapshot(h.legacy)).toEqual(before)
    expect(readdirSync(join(h.isolated, 'session-migrations')).filter(name => name.endsWith('.json'))).toEqual([`${skip.copyId}.json`])
  }, 60_000)

  it('removes everything a failed copy created and sweeps an interrupted import left by a dead process', async () => {
    const h = homes()
    await richLegacy(h)
    const before = snapshot(h.legacy)
    for (const stage of ['root', 'attachments']) {
      const failed = migrate(h, ['session-rich', '--apply', '--json'], { CODSH_TEST_MIGRATION_FAIL: stage })
      expect(failed.code).toBe(1)
      expect(failed.json.results[0].outcome).toBe('failed')
      expect(failed.json.results[0].reason).toContain('Nothing from this attempt was kept')
      expect(treeFiles(join(h.isolated, 'sessions')).filter(name => !name.endsWith('session.lock'))).toEqual([])
      expect(treeFiles(join(h.isolated, 'attachments'))).toEqual([])
      expect(treeFiles(join(h.isolated, 'session-migrations'))).toEqual([])
    }

    // A crash between writing the copy and completing its record.
    const staleId = '5ea1e000-0000-4000-8000-000000000001'
    const staleDir = join(h.isolated, 'sessions', '--tmp-codsh-194-fixture-ws--', staleId)
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'session.v3.jsonl.zstd'), 'partial')
    const staleFile = join(h.isolated, 'attachments/v1/objects/aa/stale')
    mkdirSync(dirname(staleFile), { recursive: true })
    writeFileSync(staleFile, 'x')
    mkdirSync(join(h.isolated, 'session-migrations'), { recursive: true })
    writeFileSync(join(h.isolated, 'session-migrations', `${staleId}.json`), JSON.stringify({
      schema: 1, copyId: staleId, status: 'pending', pid: 2 ** 22 + 12345, source: { sessionId: 'session-rich', home: h.legacy },
      createdSessions: [staleId], createdFiles: [staleFile],
    }))
    const preview = migrate(h, ['session-rich', '--json'])
    expect(preview.json.results[0].outcome).toBe('would-import')
    expect(existsSync(staleDir)).toBe(true)

    const applied = migrate(h, ['session-rich', '--apply', '--json'])
    expect(applied.code).toBe(0)
    expect(applied.json.warnings).toEqual(['removed an interrupted earlier import of session-rich'])
    expect(existsSync(staleDir)).toBe(false)
    expect(existsSync(staleFile)).toBe(false)
    expect(existsSync(join(h.isolated, 'session-migrations', `${staleId}.json`))).toBe(false)
    expect(snapshot(h.legacy)).toEqual(before)
  }, 60_000)

  it('explains a missing legacy store, bad usage, and overlapping Homes with distinct exit codes', async () => {
    const h = homes()
    const none = migrate(h, [])
    expect(none.code).toBe(0)
    expect(none.stdout).toContain('No legacy session store')
    expect(migrate(h, ['session-x', '--apply']).code).toBe(3)
    expect(migrate(h, ['--bogus']).code).toBe(2)
    expect(migrate(h, ['--apply', '--preview', 'x']).code).toBe(2)
    expect(migrate(h, ['--all', 'x']).code).toBe(2)
    const overlap = migrate(h, ['x', '--apply'], { CODSH_HOST_DSH_HOME: h.isolated })
    expect(overlap.code).toBe(2)
    expect(overlap.stderr).toContain('overlap')
    const unset = migrate(h, [], { CODSH_HOST_DSH_HOME: '' })
    expect(unset.code).toBe(2)
  })
})
