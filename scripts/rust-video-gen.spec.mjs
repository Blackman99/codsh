/**
 * Ticket 188: image_to_video / reference_to_video for the Rust client. The
 * plugin runs in real dsh through the Rust overlay and the keyless mock
 * model; the native `video run` command is replaced at the process boundary
 * by a recording fake, so these tests cover registration, the capability
 * text in the descriptions, `[Image #N]` resolution in every image field,
 * the call id that names the job record, the permission card, the parallel
 * cap and cancellation. Validation, the async job, its record and the saved
 * file are covered by the Rust unit tests and the PTY test.
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
  IMAGE_TO_VIDEO,
  REFERENCE_TO_VIDEO,
  buildJob,
  createVideoTools,
  describe as describeTool,
  imageReferences,
  maxParallel,
  resultText,
  runVideoJob,
  videoTitle,
} from '../packages/cli/bin/rust-acp-video.mjs'
import { accessFromTool, evaluatePermission, imageReferenceDenied } from '../packages/cli/bin/rust-acp-file-approval.mjs'
import { imagineTyped } from '../packages/cli/bin/rust-acp-session-read.mjs'

const require = createRequire(import.meta.url)
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
const roots = []
const running = []
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
  const root = mkdtempSync(join('/tmp', 'codsh-video-'))
  roots.push(root)
  const box = { root, home: join(root, 'home'), grok: join(root, 'grok'), cwd: join(root, 'workspace') }
  for (const dir of [box.home, box.grok, box.cwd]) mkdirSync(dir)
  writeFileSync(join(root, 'overlay.yml'), rustAcpOverlay())
  // The native `video run` stand-in: records each job and its signals.
  const fake = join(root, 'fake-codsh-rust')
  writeFileSync(fake, `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs')
const log = ${JSON.stringify(join(root, 'jobs.jsonl'))}
const job = JSON.parse(readFileSync(0, 'utf8'))
appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), job }) + '\\n')
process.on('SIGTERM', () => {
  appendFileSync(log, JSON.stringify({ signal: 'SIGTERM', prompt: job.prompt }) + '\\n')
  process.stdout.write(JSON.stringify({ ok: false, cancelled: true, error: 'Video job cancelled: the service confirmed remote job job_1 is cancelled. Nothing was saved.' }) + '\\n')
  process.exit(130)
})
if (job.prompt.includes('HANG')) setInterval(() => {}, 1000)
else if (job.prompt.includes('SLOW')) setTimeout(() => done(), 1500)
else if (job.prompt.includes('TIMEOUT')) { process.stdout.write(JSON.stringify({ ok: false, error: 'Video generation did not complete within 300s (remote job r-9 on 127.0.0.1:9); it may still be running there. /videos status asks the service again and saves the video if it finished. Nothing was saved.' }) + '\\n'); process.exit(1) }
else done()
function done() {
  const text = 'Video saved to videos/1.mp4 (mp4, 1.0 KB).\\nAbsolute path: ' + job.sessionDir + '/videos/1.mp4\\nRequest: ' + job.tool + ' 6s 480p\\nService: 127.0.0.1:9 · remote job r-1 · 0.1s\\nCost: one video job on 127.0.0.1:9 (keyless); codsh does not know its price, so any charge is set by that service'
  process.stdout.write(JSON.stringify({ ok: true, tool: job.tool, path: job.sessionDir + '/videos/1.mp4', short: 'videos/1.mp4', text }) + '\\n')
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
      DSH_CODE_CLI_MOCK_TOOL: 'video',
      DSH_CODE_CLI_MOCK_IMAGE: '1',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: '',
      CODSH_PERMISSION_POLICY: permissionPath,
      CODSH_PLAN_ROOT: join(box.grok, 'sessions', encodeCwdDirname(box.cwd)),
      CODSH_RUST_BIN: box.fake,
      CODSH_VIDEO_I2V: '1',
      CODSH_VIDEO_R2V: '1',
      CODSH_VIDEO_HOST: '127.0.0.1:9',
      CODSH_VIDEO_CAPS: 'image_to_video duration 6 or 10 s; resolution_name 480p or 720p',
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
  await send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codsh-video-test', version: '0' } })
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

const IMAGINE_VIDEO = '# Imagine Video\n\nVideo starts from an image \u2014 there is no text-to-video tool.\n\nUser prompt: '

describe('video tools in dsh (ticket 188)', () => {
  it('are offered only when the Rust client publishes a configured service, with its capabilities', async () => {
    const box = makeBox()
    const on = await startDsh(box)
    const offered = await on.prompt(await newSession(on, box), 'VIDEO_TOOLS')
    expect(offered).toContain('RUST_ACP_VIDEO_TOOLS image_to_video[image_to_video duration 6 or 10 s; resolution_name 480p or 720p],reference_to_video[')
    await on.stop()
    running.splice(0)
    const off = await startDsh(box, { env: { CODSH_VIDEO_I2V: '0', CODSH_VIDEO_R2V: '0' } })
    expect(await off.prompt(await newSession(off, box), 'VIDEO_TOOLS')).toContain('RUST_ACP_VIDEO_TOOLS (none)')
    const i2vOnly = await startDsh(box, { env: { CODSH_VIDEO_R2V: '0' } })
    expect(await i2vOnly.prompt(await newSession(i2vOnly, box), 'VIDEO_TOOLS')).toMatch(/RUST_ACP_VIDEO_TOOLS image_to_video\[[^\]]*\]$/m)
    expect(box.jobs()).toEqual([])
  }, 90000)

  it('image_to_video runs the native command for this session folder, named by the call id', async () => {
    const box = makeBox()
    const picture = join(box.root, 'still.png')
    writeFileSync(picture, Buffer.from(PNG, 'base64'))
    const dsh = await startDsh(box)
    const session = await newSession(dsh, box)
    const answer = await dsh.prompt(session, `VIDEO_I2V ${JSON.stringify({ prompt: 'slow push-in', image: picture, duration: 10, resolution_name: '720p' })}`)
    expect(answer).toContain('RUST_ACP_VIDEO_DONE OK:Video saved to videos/1.mp4 (mp4, 1.0 KB).')
    expect(answer).toContain(`Absolute path: ${join(box.grok, 'sessions', encodeCwdDirname(box.cwd), session, 'videos', '1.mp4')}`)
    expect(answer).toContain('codsh does not know its price')
    const [record] = box.jobs()
    expect(record.argv).toEqual(['video', 'run', '--json'])
    expect(record.cwd).toBe(box.cwd)
    expect(record.job).toEqual({
      tool: 'image_to_video',
      sessionDir: join(box.grok, 'sessions', encodeCwdDirname(box.cwd), session),
      callId: 'rust-acp-video-1',
      prompt: 'slow push-in',
      image: picture,
      duration: 10,
      resolution_name: '720p',
    })
    expect(toolTitles(dsh)).toEqual(['image_to_video'])
  }, 60000)

  it('/imagine-video reaches image_to_video with the prompt and the attached image', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const answer = await dsh.prompt(await newSession(dsh, box), [
      { type: 'text', text: `${IMAGINE_VIDEO}[Image #1] the cat blinks — 眨眼` },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ])
    expect(answer).toContain('RUST_ACP_VIDEO_DONE')
    const [record] = box.jobs()
    expect(record.job.prompt).toBe('the cat blinks — 眨眼')
    expect(record.job.image).toMatch(/^\//)
    expect(readFileSync(record.job.image).subarray(1, 4).toString()).toBe('PNG')
  }, 60000)

  it('reference_to_video resolves [Image #N] in every image field; unknown tokens stay for the native error', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const args = {
      prompt: '<IMAGE_1> waves',
      images: ['[Image #1]', '[Image #9]'],
      first_frame: '[Image #1]',
      last_frame: '/abs/end.png',
      keyframes: [{ image: '[Image #1]', timestamp_s: 2.5 }],
      voices: ['ara'],
      aspect_ratio: '16:9',
      duration: '4',
    }
    const answer = await dsh.prompt(await newSession(dsh, box), [
      { type: 'text', text: `VIDEO_R2V ${JSON.stringify(args)}` },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ])
    expect(answer).toContain('RUST_ACP_VIDEO_DONE')
    const { job } = box.jobs()[0]
    expect(job.tool).toBe('reference_to_video')
    expect(job.images[0]).toMatch(/^\//)
    expect(job.images[1]).toBe('[Image #9]')
    expect(job.first_frame).toBe(job.images[0])
    expect(job.keyframes).toEqual([{ image: job.images[0], timestamp_s: 2.5 }])
    expect(job.last_frame).toBe('/abs/end.png')
    expect(job.voices).toEqual(['ara'])
    expect(job.duration).toBe('4')
  }, 60000)

  it('asks before starting a job and a rejection sends nothing', async () => {
    const box = makeBox()
    const dsh = await startDsh(box, { permission: { mode: 'ask' }, decline: true })
    const answer = await dsh.prompt(await newSession(dsh, box), `VIDEO_I2V ${JSON.stringify({ image: '/a.png', prompt: 'x' })}`)
    expect(dsh.permissions).toHaveLength(1)
    expect(answer).toContain('RUST_ACP_VIDEO_ERROR ERR:')
    expect(answer).toMatch(/rejected/)
    expect(box.jobs()).toEqual([])
  }, 60000)

  it('an approved card sends once; a Read deny rule on an image path refuses before asking', async () => {
    const box = makeBox()
    const secret = join(box.root, 'secret')
    mkdirSync(secret)
    writeFileSync(join(secret, 'face.png'), Buffer.from(PNG, 'base64'))
    const dsh = await startDsh(box, {
      permission: { mode: 'ask', rules: [{ action: 'deny', tool: 'read', pattern: `${secret}/**`, patternMode: 'glob', source: 'test' }] },
    })
    const session = await newSession(dsh, box)
    expect(await dsh.prompt(session, `VIDEO_I2V ${JSON.stringify({ image: join(box.root, 'open.png'), prompt: 'ok' })}`)).toContain('RUST_ACP_VIDEO_DONE')
    expect(dsh.permissions).toHaveLength(1)
    const denied = await dsh.prompt(session, `VIDEO_R2V ${JSON.stringify({ prompt: 'p', aspect_ratio: '1:1', keyframes: [{ image: join(secret, 'face.png'), timestamp_s: 1 }] })}`)
    expect(denied).toContain('RUST_ACP_VIDEO_ERROR ERR:')
    expect(denied).toContain('was not sent')
    expect(dsh.permissions).toHaveLength(1)
    expect(box.jobs()).toHaveLength(1)
  }, 60000)

  it('a local timeout is an error result that says the job may still finish', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const answer = await dsh.prompt(await newSession(dsh, box), `VIDEO_I2V ${JSON.stringify({ image: '/a.png', prompt: 'TIMEOUT' })}`)
    expect(answer).toContain('RUST_ACP_VIDEO_ERROR ERR:')
    expect(answer).toContain('/videos status asks the service again')
  }, 60000)

  it('cancel stops the native command process group', async () => {
    const box = makeBox()
    const dsh = await startDsh(box)
    const session = await newSession(dsh, box)
    const turn = dsh.prompt(session, `VIDEO_I2V ${JSON.stringify({ image: '/a.png', prompt: 'HANG forever' })}`)
    await waitFor(() => box.jobs().length === 1, 'the video job to start')
    dsh.notify('session/cancel', { sessionId: session })
    const result = await turn.catch(error => String(error))
    await waitFor(() => box.jobs().some(record => record.signal === 'SIGTERM'), 'SIGTERM to reach the video command')
    expect(String(result)).not.toContain('RUST_ACP_VIDEO_DONE')
  }, 60000)
})

describe('video plugin helpers', () => {
  it('dsh-side titles match the Rust card and name the host after the last " via "', () => {
    const env = { CODSH_VIDEO_HOST: 'vid.local:7860' }
    expect(videoTitle(IMAGE_TO_VIDEO, { prompt: 'a cat via the window', image: 'x', duration: 10 }, env))
      .toBe('Animate image (10s, default resolution) "a cat via the window" via vid.local:7860')
    expect(videoTitle(REFERENCE_TO_VIDEO, { prompt: 'duo', images: ['a', 'b'], first_frame: 'c', voices: ['ara'], aspect_ratio: '16:9', resolution_name: '720p' }, env))
      .toBe('Reference video (2 refs, first frame, 1 voice; default length, 720p, 16:9) "duo" via vid.local:7860')
    expect(videoTitle(IMAGE_TO_VIDEO, { prompt: 'y'.repeat(100) }, {})).toContain('…" via the configured video service')
  })

  it('descriptions carry what the configured service accepts', () => {
    expect(describeTool('Base.', { CODSH_VIDEO_HOST: 'h:1', CODSH_VIDEO_CAPS: 'image_to_video duration 1 or 2 s' }))
      .toBe('Base. The configured video service (h:1) accepts: image_to_video duration 1 or 2 s. Other values are refused before anything is sent.')
    expect(describeTool('Base.', {})).toBe('Base.')
    const [i2v, r2v] = createVideoTools({ env: { CODSH_VIDEO_I2V: '1', CODSH_VIDEO_R2V: '1', CODSH_VIDEO_CAPS: 'caps' } })
    expect([i2v.name, r2v.name]).toEqual([IMAGE_TO_VIDEO, REFERENCE_TO_VIDEO])
    expect(i2v.parameters.required).toEqual(['image'])
    expect(r2v.parameters.required).toEqual(['prompt', 'aspect_ratio'])
    expect(r2v.parameters.properties.voices.description).not.toMatch(/xAI|Grok/)
    expect(i2v.description).toContain('accepts: caps.')
    expect(createVideoTools({ env: {} })).toEqual([])
  })

  it('caps parallelism between 1 and 16, default 4, and refuses extra calls without sending', async () => {
    expect(maxParallel({})).toBe(4)
    expect(maxParallel({ CODSH_VIDEO_MAX_PARALLEL: '2' })).toBe(2)
    expect(maxParallel({ CODSH_VIDEO_MAX_PARALLEL: '0' })).toBe(4)
    let release
    const jobs = []
    const env = { CODSH_VIDEO_I2V: '1', CODSH_VIDEO_MAX_PARALLEL: '1', CODSH_PLAN_ROOT: '/r' }
    const [tool] = createVideoTools({ env, run: job => { jobs.push(job); return new Promise(resolve => { release = () => resolve({ ok: true, text: 'Video saved to videos/1.mp4.' }) }) } })
    const exec = { agent: { session: { id: 's' } }, callId: 'c1' }
    const first = tool.execute({ image: '/a.png' }, exec)
    await expect(tool.execute({ image: '/b.png' }, { ...exec, callId: 'c2' })).rejects.toThrow('at most 1 video requests run at once')
    release()
    expect(await first).toBe('Video saved to videos/1.mp4.')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ callId: 'c1', sessionDir: '/r/s', image: '/a.png' })
  })

  it('collects every image reference and builds the native job', () => {
    const args = { prompt: 'p', image: 'i', first_frame: 'f', last_frame: 'l', images: ['a'], keyframes: [{ image: 'k', timestamp_s: 1 }] }
    expect(imageReferences(args)).toEqual(['i', 'f', 'l', 'a', 'k'])
    const paths = new Map([[1, '/store/one.png']])
    expect(buildJob(IMAGE_TO_VIDEO, { image: '[Image #1]', prompt: 'x', aspect_ratio: '1:1' }, paths, '/s', 'c'))
      .toEqual({ tool: IMAGE_TO_VIDEO, sessionDir: '/s', callId: 'c', prompt: 'x', image: '/store/one.png' })
  })

  it('result text is the native text; a missing Rust client or an early abort sends nothing', async () => {
    expect(resultText({ text: 'Video saved to videos/2.webm (webm, 3 KB).' })).toBe('Video saved to videos/2.webm (webm, 3 KB).')
    expect(resultText({ short: 'videos/3.mp4', path: '/s/videos/3.mp4' })).toBe('Video saved to videos/3.mp4.\nAbsolute path: /s/videos/3.mp4')
    expect(await runVideoJob({ tool: IMAGE_TO_VIDEO }, { binary: '' })).toMatchObject({ ok: false, error: expect.stringContaining('no request was made') })
    const aborted = new AbortController()
    aborted.abort()
    expect(await runVideoJob({ tool: IMAGE_TO_VIDEO }, { binary: '/bin/false', signal: aborted.signal })).toMatchObject({ ok: false, cancelled: true })
  })

  it('an abort waits for the command to report what the service said about the cancel', async () => {
    const root = mkdtempSync(join('/tmp', 'codsh-video-abort-'))
    roots.push(root)
    const fake = join(root, 'fake')
    writeFileSync(fake, `#!${process.execPath}
process.stdin.resume()
process.on('SIGTERM', () => { process.stdout.write(JSON.stringify({ ok: false, cancelled: true, error: 'Video job cancelled: the service confirmed remote job j1 is cancelled. Nothing was saved.' }) + '\\n'); process.exit(130) })
setInterval(() => {}, 1000)
`)
    chmodSync(fake, 0o755)
    const controller = new AbortController()
    const pending = runVideoJob({ tool: IMAGE_TO_VIDEO }, { binary: fake, signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 300))
    controller.abort()
    expect(await pending).toEqual({ ok: false, cancelled: true, error: 'Video job cancelled: the service confirmed remote job j1 is cancelled. Nothing was saved.' })
  })
})

describe('video permission and resume', () => {
  const policy = extra => ({ mode: 'ask', rules: [], grants: {}, cwd: '/w', rememberToolApprovals: true, ...extra })

  it('video calls are tool accesses with every image input and always ask in ask mode', () => {
    const access = accessFromTool('reference_to_video', { prompt: 'p', images: ['[Image #1]'], first_frame: '/f.png', keyframes: [{ image: '/k.png', timestamp_s: 1 }] })
    expect(access).toEqual({ kind: 'tool', name: 'reference_to_video', prompt: 'p', references: ['/f.png', '[Image #1]', '/k.png'] })
    expect(evaluatePermission(policy(), access).kind).toBe('ask')
    expect(evaluatePermission(policy({ mode: 'dontAsk' }), access).kind).toBe('deny')
    expect(evaluatePermission(policy({ loadError: 'bad policy' }), access)).toEqual({ kind: 'deny', reason: 'bad policy' })
  })

  it('a Read deny rule covers file:// and absolute image inputs, not tokens or data URLs', () => {
    const rules = [{ action: 'deny', tool: 'read', pattern: '/secret/**', patternMode: 'glob', source: 't' }]
    const deny = args => imageReferenceDenied(policy({ rules }), accessFromTool('image_to_video', { prompt: 'p', ...args }))
    expect(deny({ image: '/secret/a.png' })?.kind).toBe('deny')
    expect(deny({ image: 'file:///secret/a.png' })?.kind).toBe('deny')
    expect(deny({ image: '[Image #1]' })).toBeNull()
    expect(deny({ image: 'data:image/png;base64,AA' })).toBeNull()
  })

  it('resume shows the typed /imagine-video line', () => {
    expect(imagineTyped(`${IMAGINE_VIDEO}a fox runs`)).toBe('/imagine-video a fox runs')
    expect(imagineTyped('# Imagine Video elsewhere')).toBe('# Imagine Video elsewhere')
  })

  it('both overlays load the video plugin and the launcher forwards its keys', () => {
    expect(rustAcpOverlay()).toContain('rust-acp-video')
    const launcher = readFileSync(new URL('../packages/cli/bin/rust.mjs', import.meta.url), 'utf8')
    expect(launcher).toContain("new URL('./rust-acp-video.mjs', import.meta.url)")
    for (const key of ['GROK_VIDEO_GEN', 'GROK_MAX_PARALLEL_VIDEO_GEN_CALLS', 'CODSH_VIDEO_I2V', 'CODSH_VIDEO_R2V', 'CODSH_VIDEO_HOST', 'CODSH_VIDEO_CAPS', 'CODSH_VIDEO_KEY_ENV', 'CODSH_VIDEO_OPENER']) {
      expect(launcher).toContain(`'${key}'`)
    }
  })
})
