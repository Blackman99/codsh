/**
 * Ticket 187: image_gen / image_edit for the Rust client. The plugin runs in
 * real dsh through the Rust overlay and the keyless mock model; the native
 * `image run` command is replaced at the process boundary by a recording
 * fake, so these tests cover registration, `[Image #N]` resolution, the
 * permission card, the parallel cap and cancellation. The request, reply
 * checks and saved file are covered by the Rust unit tests and the PTY test.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { rustAcpOverlay } from './rust-acp-overlay.mjs'
import { encodeCwdDirname } from '../packages/cli/bin/rust-acp-plan.mjs'
import {
  IMAGE_EDIT,
  IMAGE_GEN,
  attachmentPaths,
  createImageTools,
  imageTitle,
  maxParallel,
  resolveReferences,
  resultText,
  runImageJob,
  sessionDirFor,
} from '../packages/cli/bin/rust-acp-image.mjs'
import { accessFromTool, evaluatePermission, imageReferenceDenied } from '../packages/cli/bin/rust-acp-file-approval.mjs'
import { imagineTyped } from '../packages/cli/bin/rust-acp-session-read.mjs'

const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const roots = []
const running = []
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const IMAGINE = "Call the image_gen tool immediately, passing the user's prompt below verbatim — do not rewrite, embellish, or expand it. After the tool completes, briefly acknowledge and mention where the image was saved.\n\nPrompt: "

afterEach(async () => {
  for (const item of running.splice(0)) await item.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dshPath() {
  const manifest = JSON.parse(readFileSync(dshManifest, 'utf8'))
  return join(dirname(dshManifest), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh)
}

async function waitFor(predicate, detail, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for ${detail}`)
}

function makeBox() {
  const root = mkdtempSync(join('/tmp', 'codsh-image-'))
  roots.push(root)
  const box = { root, home: join(root, 'home'), grok: join(root, 'grok'), cwd: join(root, 'workspace') }
  for (const dir of [box.home, box.grok, box.cwd]) mkdirSync(dir)
  writeFileSync(join(root, 'overlay.yml'), rustAcpOverlay())
  // The native `image run` stand-in: records each job and its signals.
  const fake = join(root, 'fake-codsh-rust')
  writeFileSync(fake, `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs')
const log = ${JSON.stringify(join(root, 'jobs.jsonl'))}
const job = JSON.parse(readFileSync(0, 'utf8'))
appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), job }) + '\\n')
process.on('SIGTERM', () => { appendFileSync(log, JSON.stringify({ signal: 'SIGTERM', prompt: job.prompt }) + '\\n'); process.exit(130) })
if (job.prompt.includes('HANG')) setInterval(() => {}, 1000)
else if (job.prompt.includes('SLOW')) setTimeout(() => done(), 1500)
else if (job.prompt.includes('REFUSE')) { process.stdout.write(JSON.stringify({ ok: false, error: 'The image service refused the request: blocked by policy. Nothing was saved.' }) + '\\n'); process.exit(1) }
else done()
function done() {
  process.stdout.write(JSON.stringify({ ok: true, tool: job.tool, path: job.sessionDir + '/images/1.png', short: 'images/1.png', width: 64, height: 32, service: '127.0.0.1:9', model: 'fake', elapsedMs: 5 }) + '\\n')
}
`)
  chmodSync(fake, 0o755)
  box.fake = fake
  box.jobs = () => existsSync(join(root, 'jobs.jsonl'))
    ? readFileSync(join(root, 'jobs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  return box
}

async function startDsh(box, { env = {}, permission = { mode: 'always-approve' }, decline = false } = {}) {
  const permissionPath = join(box.root, 'permission-policy.json')
  writeFileSync(permissionPath, JSON.stringify({ cwd: box.cwd, ...permission }))
  const child = spawn(process.execPath, [dshPath(), '--profile', 'acp', '--patch', join(box.root, 'overlay.yml')], {
    cwd: box.cwd,
    env: {
      PATH: process.env.PATH,
      HOME: box.home,
      DSH_HOME: box.home,
      GROK_HOME: box.grok,
      DSH_CODE_CLI_MOCK_TOOL: 'image',
      DSH_CODE_CLI_MOCK_IMAGE: '1',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      CODSH_PLAN_ROOT: join(box.grok, 'sessions', encodeCwdDirname(box.cwd)),
      CODSH_RUST_BIN: box.fake,
      CODSH_IMAGE_GEN: '1',
      CODSH_IMAGE_EDIT: '1',
      CODSH_IMAGE_GEN_HOST: '127.0.0.1:9',
      CODSH_IMAGE_EDIT_HOST: '127.0.0.1:9',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  const stderr = []
  const permissions = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session/update') updates.push(msg.params)
    if (msg.method === 'session/request_permission') {
      permissions.push(msg.params)
      const allow = decline ? undefined : msg.params.options.find(option => option.kind === 'allow_once')
      const reject = msg.params.options.find(option => option.kind === 'reject_once')
      const chosen = allow ?? reject
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' } } })}\n`)
    }
    if (msg.id != null && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')} ${stderr.slice(-15).join('\n')}`))
      else waiter.resolve(msg.result)
    }
  })
  createInterface({ input: child.stderr }).on('line', line => stderr.push(line))
  let nextId = 1
  const send = (method, params, timeout = 60000) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${stderr.slice(-20).join('\n')}`)), timeout)
    })
  }
  const exited = new Promise(resolve => child.on('exit', resolve))
  const dsh = {
    send,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    updates,
    permissions,
    async stop() {
      child.stdin.end()
      child.kill('SIGTERM')
      await exited
    },
    answerSince(from) {
      return updates.slice(from)
        .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
        .map(update => update.update.content.text)
        .join('')
    },
    async prompt(sessionId, prompt) {
      const from = updates.length
      await send('session/prompt', { sessionId, prompt: typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt })
      return dsh.answerSince(from)
    },
  }
  running.push(dsh)
  await send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-image-test', version: '0' } })
  return dsh
}

async function newSession(dsh, box) {
  return (await dsh.send('session/new', { cwd: box.cwd, mcpServers: [] })).sessionId
}

function toolTitles(dsh) {
  return dsh.updates
    .filter(update => update.update.sessionUpdate === 'tool_call')
    .map(update => update.update.title)
}

describe('image tools in dsh (ticket 187)', () => {
  it('are offered only when the Rust client publishes a configured service', async () => {
    const box = makeBox()
    const on = await startDsh(box)
    expect(await on.prompt(await newSession(on, box), 'IMAGE_TOOLS')).toContain('RUST_ACP_IMAGE_TOOLS image_edit,image_gen')
    await on.stop()
    running.splice(0)
    const off = await startDsh(box, { env: { CODSH_IMAGE_GEN: '0', CODSH_IMAGE_EDIT: '0' } })
    expect(await off.prompt(await newSession(off, box), 'IMAGE_TOOLS')).toContain('RUST_ACP_IMAGE_TOOLS (none)')
    const genOnly = await startDsh(box, { env: { CODSH_IMAGE_EDIT: '0' } })
    expect(await genOnly.prompt(await newSession(genOnly, box), 'IMAGE_TOOLS')).toContain('RUST_ACP_IMAGE_TOOLS image_gen')
    expect(box.jobs()).toEqual([])
  }, 90000)

  it('image_gen runs the native command for this session folder and returns the short path', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const session = await newSession(dsh, box)
    const answer = await dsh.prompt(session, 'IMAGE_GEN ratio=16:9 a red fox in snow')
    expect(answer).toContain('RUST_ACP_IMAGE_DONE OK:Image saved to images/1.png (64x32).')
    expect(answer).toContain(`Absolute path: ${join(box.grok, 'sessions', encodeCwdDirname(box.cwd), session, 'images', '1.png')}`)
    const [record] = box.jobs()
    expect(record.argv).toEqual(['image', 'run', '--json'])
    expect(record.cwd).toBe(box.cwd)
    expect(record.job).toEqual({
      tool: 'image_gen',
      prompt: 'a red fox in snow',
      aspect_ratio: '16:9',
      image: [],
      sessionDir: join(box.grok, 'sessions', encodeCwdDirname(box.cwd), session),
    })
    // dsh's ACP titles a call with its tool name; the Rust client builds the card title.
    expect(toolTitles(dsh)).toEqual(['image_gen'])
  }, 60000)

  it('/imagine reaches image_gen with the prompt verbatim', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const typed = 'a cat,  watercolor — 水彩, no text'
    const answer = await dsh.prompt(await newSession(dsh, box), `${IMAGINE}${typed}`)
    expect(answer).toContain('RUST_ACP_IMAGE_DONE')
    expect(box.jobs()[0].job.prompt).toBe(typed)
  }, 60000)

  it('image_edit resolves [Image #1] to the stored attachment; unknown tokens stay for the native error', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const session = await newSession(dsh, box)
    const answer = await dsh.prompt(session, [
      { type: 'text', text: 'IMAGE_EDIT [Image #1]|[Image #7] :: make it blue [Image #1]' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ])
    expect(answer).toContain('RUST_ACP_IMAGE_DONE')
    const [record] = box.jobs()
    expect(record.job.tool).toBe('image_edit')
    expect(record.job.image[1]).toBe('[Image #7]')
    expect(record.job.image[0]).toMatch(/^\//)
    expect(readFileSync(record.job.image[0]).subarray(1, 4).toString()).toBe('PNG')
    expect(toolTitles(dsh)).toEqual(['image_edit'])
  }, 60000)

  it('a text-only model turn resolves the <pasted-image> path the Rust client sent', async () => {
    const box = makeBox()
    const picture = join(box.root, 'pasted.png')
    writeFileSync(picture, Buffer.from(PNG, 'base64'))
    const dsh = await startDsh(box)
    await dsh.prompt(await newSession(dsh, box), [
      { type: 'text', text: 'IMAGE_EDIT [Image #2] :: sketch [Image #2]' },
      { type: 'text', text: `\n<pasted-image id="2" media="image/png" dimensions="1x1" path="${picture}">\n</pasted-image>\n` },
    ])
    expect(box.jobs()[0].job.image).toEqual([picture])
  }, 60000)

  it('asks before sending and a rejection sends nothing', async () => {
    const box = makeBox()
    const dsh = await startDsh(box, { permission: { mode: 'ask' }, decline: true })
    const answer = await dsh.prompt(await newSession(dsh, box), 'IMAGE_GEN a lighthouse')
    expect(dsh.permissions).toHaveLength(1)
    expect(answer).toContain('RUST_ACP_IMAGE_ERROR ERR:')
    expect(answer).toMatch(/rejected/)
    expect(box.jobs()).toEqual([])
  }, 60000)

  it('an approved card sends once; a Read deny rule on a reference path refuses before asking', async () => {
    const box = makeBox()
    const secret = join(box.root, 'secret')
    mkdirSync(secret)
    writeFileSync(join(secret, 'face.png'), Buffer.from(PNG, 'base64'))
    const dsh = await startDsh(box, {
      permission: { mode: 'ask', rules: [{ action: 'deny', tool: 'read', pattern: `${secret}/**`, patternMode: 'glob', source: 'test' }] },
    })
    const session = await newSession(dsh, box)
    expect(await dsh.prompt(session, 'IMAGE_GEN a lighthouse')).toContain('RUST_ACP_IMAGE_DONE')
    expect(dsh.permissions).toHaveLength(1)
    const denied = await dsh.prompt(session, `IMAGE_EDIT ${join(secret, 'face.png')} :: older`)
    expect(denied).toContain('RUST_ACP_IMAGE_ERROR ERR:')
    expect(denied).toContain('was not sent')
    expect(dsh.permissions).toHaveLength(1)
    expect(box.jobs()).toHaveLength(1)
  }, 60000)

  it('a refusal is an error result with the service message', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const answer = await dsh.prompt(await newSession(dsh, box), 'IMAGE_GEN REFUSE this')
    expect(answer).toContain('RUST_ACP_IMAGE_ERROR ERR:')
    expect(answer).toContain('The image service refused the request: blocked by policy. Nothing was saved.')
  }, 60000)

  it('cancel stops the native command process group', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const session = await newSession(dsh, box)
    const turn = dsh.prompt(session, 'IMAGE_GEN HANG forever')
    await waitFor(() => box.jobs().length === 1, 'the image job to start')
    dsh.notify('session/cancel', { sessionId: session })
    const result = await turn.catch(error => String(error))
    await waitFor(() => box.jobs().some(record => record.signal === 'SIGTERM'), 'SIGTERM to reach the image command')
    expect(String(result)).not.toContain('RUST_ACP_IMAGE_DONE')
  }, 60000)

  it('parallel calls beyond the cap fail explicitly and are not sent', async () => {
    const box = makeBox()
    const dsh = await startDsh(box, { env: { CODSH_IMAGE_MAX_PARALLEL: '1' } })
    const answer = await dsh.prompt(await newSession(dsh, box), 'IMAGE_PAIR SLOW one THEN SLOW two')
    expect(answer).toContain('RUST_ACP_IMAGE_ERROR')
    expect(answer).toContain('at most 1 image requests run at once')
    expect(box.jobs().filter(record => record.job)).toHaveLength(1)
  }, 60000)
})

describe('image plugin helpers', () => {
  it('dsh-side titles name the host after the last " via "', () => {
    const env = { CODSH_IMAGE_GEN_HOST: 'gen.local:8080', CODSH_IMAGE_EDIT_HOST: 'edit.local' }
    expect(imageTitle(IMAGE_GEN, { prompt: 'a cat via the window' }, env)).toBe('Generate image "a cat via the window" via gen.local:8080')
    expect(imageTitle(IMAGE_EDIT, { prompt: 'x', image: ['a'] }, env)).toBe('Edit image (1 ref) "x" via edit.local')
    expect(imageTitle(IMAGE_GEN, { prompt: 'y'.repeat(100) }, env)).toContain('…')
  })

  it('caps parallelism between 1 and 16, default 4', () => {
    expect(maxParallel({})).toBe(4)
    expect(maxParallel({ CODSH_IMAGE_MAX_PARALLEL: '2' })).toBe(2)
    expect(maxParallel({ CODSH_IMAGE_MAX_PARALLEL: '99' })).toBe(4)
  })

  it('maps image blocks to placeholders in number order and keeps data URLs as a fallback', () => {
    const content = [
      { type: 'text', text: 'see [Image #3] and [Image #1]' },
      { type: 'image', attachment: { id: 'a' } },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]
    const paths = attachmentPaths(content, ref => (ref.id === 'a' ? '/store/a' : undefined))
    expect(paths.get(1)).toBe('/store/a')
    expect(paths.get(3)).toBe('data:image/png;base64,QUJD')
    expect(resolveReferences(['[Image #1]', ' [Image #3] ', '[Image #2]', '/abs.png'], paths))
      .toEqual(['/store/a', 'data:image/png;base64,QUJD', '[Image #2]', '/abs.png'])
  })

  it('unescapes <pasted-image> paths and skips unsaved ones', () => {
    const paths = attachmentPaths([{ type: 'text', text: '<pasted-image id="1" media="image/png" path="/a &amp; b/&quot;x&quot;.png">\n<pasted-image id="2" media="image/png" path="unsaved:abc">' }])
    expect(paths.get(1)).toBe('/a & b/"x".png')
    expect(paths.has(2)).toBe(false)
  })

  it('the session folder is the plan folder of the calling session', () => {
    expect(sessionDirFor({ session: { id: 's-1', header: { cwd: '/w' } } }, { CODSH_PLAN_ROOT: '/r' })).toBe('/r/s-1')
    expect(sessionDirFor({ session: { header: { id: 's-2', cwd: '/w' } } }, { GROK_HOME: '/g' })).toBe(`/g/sessions/${encodeCwdDirname('/w')}/s-2`)
    expect(sessionDirFor({}, {})).toBe('')
  })

  it('result text names the short path and the absolute path', () => {
    expect(resultText({ short: 'images/2.jpg', path: '/s/images/2.jpg', width: 10, height: 20, service: 'h', model: 'm', elapsedMs: 1500 }))
      .toBe('Image saved to images/2.jpg (10x20).\nAbsolute path: /s/images/2.jpg\nService: h (m) in 1.5s.')
  })

  it('a missing Rust client fails without a request', async () => {
    expect(await runImageJob({ tool: 'image_gen' }, { binary: '' })).toMatchObject({ ok: false, error: expect.stringContaining('no request was made') })
    const aborted = new AbortController()
    aborted.abort()
    expect(await runImageJob({ tool: 'image_gen' }, { binary: '/bin/false', signal: aborted.signal })).toMatchObject({ ok: false, cancelled: true })
  })

  it('execute throws on a failed job and on a missing session folder', async () => {
    const env = { CODSH_IMAGE_GEN: '1', CODSH_PLAN_ROOT: '/r' }
    const [tool] = createImageTools({ env, run: async () => ({ ok: false, error: 'HTTP 402: payment required' }) })
    await expect(tool.execute({ prompt: 'x' }, { agent: { session: { id: 's' } } })).rejects.toThrow('HTTP 402: payment required')
    await expect(tool.execute({ prompt: 'x' }, { agent: {} })).rejects.toThrow('no session folder')
    expect(createImageTools({ env: {} })).toEqual([])
  })
})

describe('image permission and resume', () => {
  const policy = extra => ({ mode: 'ask', rules: [], grants: {}, cwd: '/w', rememberToolApprovals: true, ...extra })

  it('image calls are their own access kind and always ask in ask mode', () => {
    const access = accessFromTool('image_edit', { prompt: 'p', image: ['[Image #1]', '/a.png'] })
    expect(access).toEqual({ kind: 'tool', name: 'image_edit', prompt: 'p', references: ['[Image #1]', '/a.png'] })
    expect(evaluatePermission(policy(), access).kind).toBe('ask')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), access).kind).toBe('deny')
    expect(evaluatePermission(policy({ loadError: 'bad policy' }), access)).toEqual({ kind: 'deny', reason: 'bad policy' })
  })

  it('a Read deny rule covers file:// and absolute references, not tokens or data URLs', () => {
    const rules = [{ action: 'deny', tool: 'read', pattern: '/secret/**', patternMode: 'glob', source: 't' }]
    const deny = refs => imageReferenceDenied(policy({ rules }), accessFromTool('image_edit', { prompt: 'p', image: refs }))
    expect(deny(['/secret/a.png'])?.kind).toBe('deny')
    expect(deny(['file:///secret/a.png'])?.kind).toBe('deny')
    expect(deny(['[Image #1]', 'data:image/png;base64,AA', '/open/a.png'])).toBeNull()
    expect(imageReferenceDenied(policy({ rules }), accessFromTool('image_gen', { prompt: '/secret/a.png' }))).toBeNull()
  })

  it('resume shows the typed /imagine line', () => {
    expect(imagineTyped(`${IMAGINE}a cat`)).toBe('/imagine a cat')
    expect(imagineTyped('plain text')).toBe('plain text')
  })

  it('both overlays load the image plugin and the launcher forwards its keys', () => {
    expect(rustAcpOverlay()).toContain('rust-acp-image')
    const launcher = readFileSync(new URL('../packages/cli/bin/rust.mjs', import.meta.url), 'utf8')
    expect(launcher).toContain("new URL('./rust-acp-image.mjs', import.meta.url)")
    for (const key of ['GROK_IMAGE_GEN', 'GROK_IMAGE_EDIT', 'GROK_MAX_PARALLEL_IMAGE_GEN_CALLS', 'CODSH_IMAGE_GEN', 'CODSH_IMAGE_EDIT', 'CODSH_IMAGE_KEY_ENV', 'CODSH_IMAGE_OPENER']) {
      expect(launcher).toContain(`'${key}'`)
    }
  })
})
