/**
 * Legacy dsh Home fixtures for the session-copy tests (ticket 62). Sessions
 * are written with the pinned dsh persistence and attachments with the real
 * dsh-attachment-local store, exactly as the old client lays them out.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

/** A valid 4x4 RGB PNG (dsh stores it verbatim: it already fits its policy). */
export function tinyPng() {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4)
    data.copy(out, 8)
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(4, 0)
  ihdr.writeUInt32BE(4, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(13 * 4)
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 12; x += 1) raw[y * 13 + 1 + x] = (x * 40 + y * 60) & 255
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

export async function openLegacyHome(dshBin, home, { compression = 'zstd' } = {}) {
  const requireFromDsh = createRequire(dshBin)
  const load = async name => import(pathToFileURL(requireFromDsh.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const Persistence = (await load('@deepseek-ai/dsh-session-persistence-jsonl')).default
  const Attachments = (await load('@deepseek-ai/dsh-attachment-local')).default
  const session = await load('@deepseek-ai/dsh-session')
  const ctx = new Context()
  await ctx.plugin(Persistence, { root: `${home}/sessions`, compression })
  await ctx.plugin(Attachments, { dshHome: home })
  const persistence = ctx.sessionPersistence
  const attachments = ctx.attachmentStore ?? ctx.attachments
  let clock = 1_790_000_000_000
  const tick = () => (clock += 7)
  return {
    session,
    saveImage: data => attachments.saveImage({ data: new Uint8Array(data), mediaType: 'image/png' }),
    saveFile: (name, text) => attachments.saveFile({ name, data: new TextEncoder().encode(text) }),
    /** One finished turn: a user prompt (optionally with attachments), an answer, a tool round. */
    turn(turn, prompt, { blocks = [], answer = `answer ${turn}`, tool = false, title } = {}) {
      const events = [
        { type: 'turn/start', data: { turn } },
        { type: 'step/start', data: { turn, step: 1 } },
        { type: 'user/message', data: { content: [{ type: 'text', text: prompt }, ...blocks], source: { kind: 'user' }, role: 'user', id: randomUUID() }, surfaceOp: 'append' },
      ]
      if (title) events.push({ type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'fallback' } } })
      if (tool) {
        events.push(
          { type: 'assistant/message', data: { turn, step: 1, stream: [], message: { role: 'assistant', content: [{ type: 'tool-call', id: `call-${turn}`, name: 'read', arguments: '{"file_path":"note.txt"}' }], source: { kind: 'model', provider: 'cli-mock', model: 'cli-mock' }, id: randomUUID() } }, surfaceOp: 'append' },
          { type: 'tool/call', data: { turn, step: 1, callId: `call-${turn}`, name: 'read', arguments: '{"file_path":"note.txt"}' } },
          { type: 'tool/result', data: { turn, step: 1, message: { source: { kind: 'tool', callId: `call-${turn}` }, content: [{ type: 'tool-result', toolCallId: `call-${turn}`, content: [{ type: 'text', text: 'alpha' }], isError: false }], role: 'user', id: randomUUID() } }, surfaceOp: 'append' },
        )
      }
      events.push(
        { type: 'assistant/message', data: { turn, step: 1, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: answer }], source: { kind: 'model', provider: 'cli-mock', model: 'cli-mock' }, id: randomUUID() } }, surfaceOp: 'append' },
        { type: 'step/end', data: { turn, step: 1 } },
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      )
      return events
    },
    /** Write one session log; `extraRows` are appended as raw events (unknown types). */
    async write(id, events, header = {}) {
      const full = { version: 3, id, createdAt: tick(), cwd: '/tmp/codsh-194-fixture-ws', isSeeded: false, delegationDepth: 0, agentPreset: 'code-cli', ...header }
      const numbered = events.map((event, seq) => ({ seq, time: tick(), ...event }))
      const writer = await persistence.create(full, { inheritedEventCount: 0 })
      try {
        if (numbered.length > 0) await writer.append(numbered)
        await writer.flush()
      } finally {
        await writer.close()
      }
      return numbered
    },
    /** The old client continuing a session: append after its last event. */
    async grow(id, events) {
      const handle = await persistence.open(id, 'write')
      try {
        const { events: stored } = await handle.read()
        const numbered = events.map((event, index) => ({ seq: stored.length + index, time: tick(), ...event }))
        await handle.append(numbered)
        await handle.flush()
      } finally {
        await handle.close()
      }
    },
    async close() {
      await ctx.fiber?.dispose?.().catch(() => undefined)
    },
  }
}
