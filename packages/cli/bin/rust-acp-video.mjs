/**
 * Video generation for the Rust client (ticket 56 / #188).
 *
 * `image_to_video` and `reference_to_video` are registered only when the
 * Rust client publishes CODSH_VIDEO_I2V=1 / CODSH_VIDEO_R2V=1, which it does
 * only for an explicitly configured `[model.<id>]` video service. The native
 * `video run` command owns validation against that service's capabilities,
 * the async job (start, poll, download), its record in
 * `<session folder>/video-jobs/`, and the saved file in
 * `<session folder>/videos/<n>.<ext>`. This plugin resolves `[Image #N]`
 * placeholders to the host path of the user's attachment, caps parallel
 * calls, names the job after the tool call (so the row can show its live
 * state), and forwards cancellation (Ctrl+C / Esc) as SIGTERM to the
 * command's process group; the command then asks the service to cancel.
 */
export const name = 'rust-acp-video'
export const inject = ['tools']

import { spawn } from 'node:child_process'
import { rustBinary, enabled } from './rust-acp-web.mjs'
import { attachmentPaths, lastUserMessage, resolveReferences, sessionDirFor, stopChild } from './rust-acp-image.mjs'

export const IMAGE_TO_VIDEO = 'image_to_video'
export const REFERENCE_TO_VIDEO = 'reference_to_video'
const OUTPUT_CAP = 1024 * 1024
const IMAGE_SOURCES = 'Absolute filesystem path, HTTPS URL, or `data:image/...;base64,...` URL.'

export const IMAGE_TO_VIDEO_DESCRIPTION = 'Generate a video from a single source image; returns the saved video\'s absolute path. When telling the user where it was saved, refer to it by its short session-relative path (e.g. `videos/1.mp4`) rather than the absolute path, so it renders as a clickable link that opens the video. Provide `image` for the image to animate and optionally a `prompt` to guide the animation. Use this tool when the user provides an image and wants it animated, turned into a video, or used as the first frame. Example: image_to_video(image="/Users/me/photo.jpg", prompt="gentle camera push-in with wind moving the hair", duration=6, resolution_name="480p")'

export const REFERENCE_TO_VIDEO_DESCRIPTION = 'Generate a video from reference images, preset voices, and/or pinned keyframes, guided by a required text prompt; returns the saved video\'s absolute path. When telling the user where it was saved, refer to it by its short session-relative path (e.g. `videos/1.mp4`) rather than the absolute path, so it renders as a clickable link that opens the video. Provide up to 14 `images` (style/content references: people, objects, clothing, settings \u2014 they appear re-rendered, not as literal frames) and/or up to 3 `voices` (preset voice identifiers the subjects speak in). To pin EXACT frames instead, set `first_frame` and/or `last_frame` (those images appear literally as the video\'s first/last frame; set both to interpolate, or the same image for a perfect loop) and/or `keyframes` (up to 4 `{image, timestamp_s}` anchors strictly inside the clip, snapped to a 1/3-second grid). At least one of `images`, `voices`, `first_frame`, `last_frame`, or `keyframes` is required. Tag references in the prompt as `<IMAGE_i>` and voices as `<AUDIO_0>`, ...; the index space follows the upload order `first_frame`, `images`, `keyframes`, `last_frame` \u2014 so with `first_frame` set, the first `images` entry is `<IMAGE_1>`, not `<IMAGE_0>`. Pinned frames never need prompt tags (their timing is explicit). Example: reference_to_video(prompt="The person from <IMAGE_1> walks toward the camera, speaking with the voice from <AUDIO_0>", first_frame="/Users/me/wide_shot.jpg", images=["/Users/me/person.jpg"], keyframes=[{"image": "/Users/me/closeup.jpg", "timestamp_s": 3.0}], last_frame="/Users/me/closeup.jpg", voices=["eve"], aspect_ratio="16:9", duration=6, resolution_name="480p")'

const DURATION = { type: 'integer', minimum: 0 }

export const IMAGE_TO_VIDEO_PARAMETERS = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  required: ['image'],
  type: 'object',
  properties: {
    prompt: { description: 'Optional prompt to guide the video generation model. If omitted, a natural animation applies automatically.', type: 'string' },
    image: { description: `Source image to animate. Provide an absolute filesystem path, HTTPS URL, or \`data:image/...;base64,...\` URL.`, type: 'string' },
    duration: { ...DURATION, description: 'Duration of the video generation, either 6 or 10 seconds. Default to 6 unless the user requests longer.' },
    resolution_name: {
      description: 'Resolution name of the video generation, only specify it when user asks for a specific resolution, either 480p or 720p. Defaults to 480p unless the user specifically requests for higher quality.',
      type: 'string',
    },
  },
}

export const REFERENCE_TO_VIDEO_PARAMETERS = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  required: ['prompt', 'aspect_ratio'],
  type: 'object',
  properties: {
    prompt: { description: 'Prompt to guide the video generation model. Describe the desired video.', type: 'string' },
    images: {
      description: 'Reference images, up to 14 entries; the images are used as style/content references for the generated video (people, objects, clothing, settings). Each entry may be an absolute filesystem path, HTTPS URL, or `data:image/...;base64,...` URL. Reference them in the prompt as `<IMAGE_0>`, `<IMAGE_1>`, ... May be empty when `voices`, `first_frame`, `last_frame`, or `keyframes` is provided.',
      type: 'array',
      items: { type: 'string' },
    },
    first_frame: {
      description: 'Optional image pinned as the video\'s exact FIRST frame \u2014 it appears literally at the start (unlike `images`, which condition the video and appear re-rendered). Absolute filesystem path, HTTPS URL, or `data:image/...;base64,...` URL. Combine with `last_frame` to interpolate between two exact frames.',
      type: 'string',
    },
    last_frame: {
      description: 'Optional image pinned as the video\'s exact LAST frame \u2014 the clip ends arriving on it. Same formats as `first_frame`. Set `first_frame` and `last_frame` to the same image for a perfect loop.',
      type: 'string',
    },
    keyframes: {
      description: 'Mid-video keyframe anchors, up to 4 entries; each pins an image to appear literally at a timestamp strictly inside the clip (use `first_frame` / `last_frame` for the endpoints). Timestamps snap to the engine\'s 1/3-second grid, so anchors closer than 1/3 s to each other are rejected.',
      type: 'array',
      items: {
        type: 'object',
        required: ['image', 'timestamp_s'],
        properties: {
          image: { description: `Image that appears literally at \`timestamp_s\`. ${IMAGE_SOURCES}`, type: 'string' },
          timestamp_s: { description: 'Time in seconds at which the image appears, strictly inside the clip (0 < t < duration). Snapped server-side to the engine\'s 1/3-second keyframe grid; two anchors closer than 1/3 s are rejected.', type: 'number' },
        },
      },
    },
    voices: {
      description: 'Optional preset voices the subject(s) speak in, up to 3 entries, each a voice identifier from the configured video service\'s built-in roster (e.g. "ara", "eve", "leo", "rex"; an unknown identifier fails with the list of available voices). Reference them in the prompt as `<AUDIO_0>`, `<AUDIO_1>`, `<AUDIO_2>`. Usable alongside `images` or on their own.',
      type: 'array',
      items: { type: 'string' },
    },
    aspect_ratio: {
      description: 'Aspect ratio of the generated video, decide it based on the user\'s request. 1:1 for square (icons, profiles), 16:9 for wide (landscapes, cinematic), 9:16 for tall (phone wallpapers, stories), 4:3 or 3:2 for horizontal photos, 3:4 or 2:3 for vertical (portraits, posters).',
      type: 'string',
      enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    },
    duration: { ...DURATION, description: 'Duration of the video in seconds, between 1 and 15. Defaults to 6.' },
    resolution_name: {
      description: 'Resolution name of the video generation, only specify it when user asks for a specific resolution, either 480p or 720p. Defaults to 480p.',
      type: 'string',
    },
  },
}

/** The host a video tool sends to, as published by the Rust client. */
export function videoHost(env = process.env) {
  const raw = env.CODSH_VIDEO_HOST
  return raw ? String(raw) : 'the configured video service'
}

export function maxParallel(env = process.env) {
  const value = Number.parseInt(String(env.CODSH_VIDEO_MAX_PARALLEL ?? ''), 10)
  return Number.isInteger(value) && value >= 1 && value <= 16 ? value : 4
}

/** The reference description plus what the configured service accepts. */
export function describe(description, env = process.env) {
  const caps = String(env.CODSH_VIDEO_CAPS ?? '').trim()
  const host = videoHost(env)
  const accepts = caps ? ` The configured video service (${host}) accepts: ${caps}. Other values are refused before anything is sent.` : ''
  return `${description}${accepts}`
}

function excerpt(text, limit = 60) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}\u2026` : flat
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** The card title; the Rust client reads the host after the last " via ". */
export function videoTitle(tool, args = {}, env = process.env) {
  const host = videoHost(env)
  const prompt = excerpt(args?.prompt)
  const rawDuration = args?.duration
  const duration = rawDuration === undefined || rawDuration === null || String(rawDuration).trim() === ''
    ? 'default length'
    : `${String(rawDuration).trim()}s`
  const resolution = typeof args?.resolution_name === 'string' ? args.resolution_name : 'default resolution'
  if (tool === REFERENCE_TO_VIDEO) {
    const parts = []
    const count = key => (Array.isArray(args?.[key]) ? args[key].length : 0)
    if (count('images') > 0) parts.push(plural(count('images'), 'ref'))
    if (typeof args?.first_frame === 'string') parts.push('first frame')
    if (typeof args?.last_frame === 'string') parts.push('last frame')
    if (count('keyframes') > 0) parts.push(plural(count('keyframes'), 'keyframe'))
    if (count('voices') > 0) parts.push(plural(count('voices'), 'voice'))
    const inputs = parts.length > 0 ? parts.join(', ') : 'no inputs'
    const ratio = typeof args?.aspect_ratio === 'string' ? args.aspect_ratio : 'no ratio'
    return `Reference video (${inputs}; ${duration}, ${resolution}, ${ratio}) "${prompt}" via ${host}`
  }
  return `Animate image (${duration}, ${resolution}) "${prompt}" via ${host}`
}

/** Every image reference of a call, for attachment resolution and Read checks. */
export function imageReferences(args = {}) {
  const references = []
  for (const key of ['image', 'first_frame', 'last_frame']) {
    if (typeof args?.[key] === 'string') references.push(args[key])
  }
  if (Array.isArray(args?.images)) references.push(...args.images.map(String))
  if (Array.isArray(args?.keyframes)) {
    for (const keyframe of args.keyframes) {
      if (typeof keyframe?.image === 'string') references.push(keyframe.image)
    }
  }
  return references
}

/** The native job: tool arguments with `[Image #N]` resolved. */
export function buildJob(tool, args = {}, paths = new Map(), sessionDir = '', callId = '') {
  const one = value => (typeof value === 'string' ? resolveReferences([value], paths)[0] : undefined)
  const job = { tool, sessionDir, callId: callId ? String(callId) : '', prompt: String(args?.prompt ?? '') }
  if (tool === IMAGE_TO_VIDEO) {
    if (typeof args?.image === 'string') job.image = one(args.image)
  } else {
    if (Array.isArray(args?.images)) job.images = resolveReferences(args.images.map(String), paths)
    if (typeof args?.first_frame === 'string') job.first_frame = one(args.first_frame)
    if (typeof args?.last_frame === 'string') job.last_frame = one(args.last_frame)
    if (Array.isArray(args?.keyframes)) {
      job.keyframes = args.keyframes.map(keyframe => ({
        image: typeof keyframe?.image === 'string' ? one(keyframe.image) : keyframe?.image,
        timestamp_s: keyframe?.timestamp_s,
      }))
    }
    if (Array.isArray(args?.voices)) job.voices = args.voices
    if (args?.aspect_ratio !== undefined) job.aspect_ratio = args.aspect_ratio
  }
  if (args?.duration !== undefined && args?.duration !== null) job.duration = args.duration
  if (args?.resolution_name !== undefined && args?.resolution_name !== null) job.resolution_name = args.resolution_name
  return job
}

const CANCELLED = { ok: false, cancelled: true, error: 'video request cancelled; codsh asked the service to stop it where it can, and no file was saved' }
const CANCEL_GRACE_MS = 12_000

function parseResult(stdout, stderr) {
  const line = stdout.trim().split('\n').findLast(item => item.startsWith('{'))
  if (!line) return { ok: false, error: (stderr || 'video command produced no result').trim() }
  try {
    return JSON.parse(line)
  } catch (error) {
    return { ok: false, error: `video command returned invalid JSON: ${error.message}` }
  }
}

/**
 * Run `<rust> video run --json` with the job on stdin. On abort the command
 * gets SIGTERM, asks the service to cancel, records the answer, and exits;
 * its own cancel message is returned when it arrives within the grace time.
 */
export function runVideoJob(job, { signal, cwd, env = process.env, binary = rustBinary(), graceMs = CANCEL_GRACE_MS } = {}) {
  if (!binary) {
    return Promise.resolve({ ok: false, error: 'video tools are not connected to the Rust client; no request was made' })
  }
  if (signal?.aborted) return Promise.resolve(CANCELLED)
  return new Promise(resolve => {
    let child
    try {
      child = spawn(binary, ['video', 'run', '--json'], {
        cwd: cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      resolve({ ok: false, error: `could not start the video command: ${error.message}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let grace
    const finish = value => {
      if (settled) return
      settled = true
      if (grace) clearTimeout(grace)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => {
      stopChild(child)
      grace = setTimeout(() => finish(CANCELLED), graceMs)
      grace.unref?.()
    }
    child.stdout?.on('data', chunk => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8')
    })
    child.stdin?.on('error', () => { /* the command exited before reading */ })
    child.on('error', error => finish({ ok: false, error: `could not start the video command: ${error.message}` }))
    child.on('close', () => {
      const result = parseResult(stdout, stderr)
      if (signal?.aborted && result.ok !== true) {
        finish({ ...CANCELLED, ...(result.cancelled && result.error ? { error: String(result.error) } : {}) })
        return
      }
      finish(result)
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdin?.end(JSON.stringify(job))
  })
}

/** The model-facing text of a saved video (the command already wrote it). */
export function resultText(result) {
  if (typeof result.text === 'string' && result.text.trim() !== '') return result.text
  const short = String(result.short ?? '')
  const path = String(result.path ?? '')
  return [`Video saved to ${short || path}.`, `Absolute path: ${path}`].join('\n')
}

export function createVideoTools(options = {}) {
  const env = options.env ?? process.env
  const run = options.run ?? runVideoJob
  const hostPathOf = options.hostPath ?? (() => undefined)
  let active = 0
  const tool = (name, description, parameters) => ({
    name,
    description: describe(description, env),
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: videoTitle(name, args, env), kind: 'other' }),
    async execute(args, exec) {
      const limit = maxParallel(env)
      if (active >= limit) {
        throw new Error(`${name}: at most ${limit} video requests run at once (tools.media_gen.max_parallel_video_gen_calls); this call was not sent. Retry after the running ones finish.`)
      }
      const agent = exec?.agent
      const sessionDir = sessionDirFor(agent, env)
      if (!sessionDir) throw new Error(`${name}: no session folder is known; no request was made`)
      const references = imageReferences(args)
      const needsPaths = references.some(reference => /\[Image #\d+\]/u.test(reference))
      const paths = needsPaths ? attachmentPaths(lastUserMessage(agent), hostPathOf) : new Map()
      const job = buildJob(name, args, paths, sessionDir, exec?.callId)
      active += 1
      let result
      try {
        result = await run(job, { signal: exec?.signal, cwd: agent?.session?.header?.cwd, env })
      } finally {
        active -= 1
      }
      if (!result || result.ok !== true) {
        throw new Error(String(result?.error || `${name} failed; no file was saved`))
      }
      return resultText(result)
    },
  })
  const tools = []
  if (enabled('CODSH_VIDEO_I2V', env)) tools.push(tool(IMAGE_TO_VIDEO, IMAGE_TO_VIDEO_DESCRIPTION, IMAGE_TO_VIDEO_PARAMETERS))
  if (enabled('CODSH_VIDEO_R2V', env)) tools.push(tool(REFERENCE_TO_VIDEO, REFERENCE_TO_VIDEO_DESCRIPTION, REFERENCE_TO_VIDEO_PARAMETERS))
  return tools
}

export function apply(ctx) {
  const hostPath = ref => ctx.get?.('attachments')?.imageHostPath?.(ref)
  for (const tool of createVideoTools({ hostPath })) ctx.tools.register(tool)
}
