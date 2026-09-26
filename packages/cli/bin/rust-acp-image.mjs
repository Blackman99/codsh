/**
 * Image generation and editing for the Rust client (ticket 55 / #187).
 *
 * `image_gen` and `image_edit` are registered only when the Rust client
 * publishes CODSH_IMAGE_GEN=1 / CODSH_IMAGE_EDIT=1, which it does only for
 * an explicitly configured `[model.<id>]` image service. The native
 * `image run` command owns the service request, the reply checks and the
 * saved file: this plugin resolves `[Image #N]` placeholders to the host
 * path of the user's attachment, caps parallel calls, and forwards
 * cancellation (Ctrl+C / Esc) as SIGTERM to the command's process group.
 * Saved images live in `<session folder>/images/<n>.<ext>` next to plan.md.
 */
export const name = 'rust-acp-image'
export const inject = ['tools']

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { planFilePath } from './rust-acp-plan.mjs'
import { rustBinary, enabled } from './rust-acp-web.mjs'

export const IMAGE_GEN = 'image_gen'
export const IMAGE_EDIT = 'image_edit'
const OUTPUT_CAP = 1024 * 1024

export const IMAGE_GEN_DESCRIPTION = "Generate a new image from a text description using the configured image service; returns the saved image's absolute path. When telling the user where it was saved, refer to it by its short session-relative path (e.g. `images/1.jpg`) rather than the absolute path, so it renders as a clickable link that opens the image. To produce multiple images, emit multiple tool calls with distinct prompts."

export const IMAGE_EDIT_DESCRIPTION = "Edit or transform existing image(s) via the configured image service; use instead of image_gen for image-to-image work (preserve likeness, transfer style, remix). Returns the saved image's absolute path. When telling the user where it was saved, refer to it by its short session-relative path (e.g. `images/1.jpg`) rather than the absolute path, so it renders as a clickable link that opens the image. Each required `image` is one reference \u2014 a user-attachment token (e.g. \"[Image #1]\"), an absolute filesystem path, or a `data:image/...;base64,...` URL (see the `image` parameter for the resolution order and details)."

export const IMAGE_GEN_PARAMETERS = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  required: ['prompt'],
  type: 'object',
  properties: {
    prompt: { description: 'Text description of the image to generate.', type: 'string' },
    aspect_ratio: {
      description: "Aspect ratio of the generated image, decide it based on the user's request. Defaults to 'auto'. 1:1 for square (icons, profiles), 16:9 for wide (landscapes, cinematic), 9:16 for tall (phone wallpapers, stories), 3:2 for horizontal photos, 2:3 for vertical (portraits, posters).",
      type: 'string',
      default: 'auto',
    },
  },
}

export const IMAGE_EDIT_PARAMETERS = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  required: ['prompt', 'image'],
  type: 'object',
  properties: {
    prompt: {
      description: 'A text description of the desired edit or transformation. Describe what the output image should look like, referencing the input image(s).',
      type: 'string',
    },
    image: {
      description: 'Reference image(s) to condition the edit on. Each is one reference, in priority order: (1) a user attachment \u2014 its placeholder token, e.g. "[Image #1]" (attachments have no path you can see, so never invent one); (2) an absolute filesystem path the user gave you; (3) a `data:image/...;base64,...` URL.',
      type: 'array',
      items: { type: 'string' },
    },
    aspect_ratio: {
      description: "The aspect ratio of the output image. For single-image edits this is ignored \u2014 the output matches the input image's aspect ratio. For multi-image edits, defaults to 'auto'. Supported values: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9, 9:19.5, 20:9, 9:20, auto.",
      type: 'string',
      default: 'auto',
    },
  },
}

/** The host a tool sends to, as published by the Rust client. */
export function imageHost(tool, env = process.env) {
  const raw = tool === IMAGE_EDIT ? env.CODSH_IMAGE_EDIT_HOST : env.CODSH_IMAGE_GEN_HOST
  return raw ? String(raw) : 'the configured image service'
}

export function maxParallel(env = process.env) {
  const value = Number.parseInt(String(env.CODSH_IMAGE_MAX_PARALLEL ?? ''), 10)
  return Number.isInteger(value) && value >= 1 && value <= 16 ? value : 4
}

function excerpt(text, limit = 60) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** The card title. The Rust client reads the host after the last " via ". */
export function imageTitle(tool, args = {}, env = process.env) {
  const host = imageHost(tool, env)
  const prompt = excerpt(args?.prompt)
  if (tool === IMAGE_EDIT) {
    const count = Array.isArray(args?.image) ? args.image.length : 0
    const refs = `${count} ref${count === 1 ? '' : 's'}`
    return `Edit image (${refs}) "${prompt}" via ${host}`
  }
  return `Generate image "${prompt}" via ${host}`
}

function unescapeXml(value) {
  return String(value)
    .replaceAll('&#10;', '\n')
    .replaceAll('&#13;', '\r')
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

export function lastUserMessage(agent) {
  let messages = []
  try {
    messages = agent?.session?.deriveMessages?.() ?? []
  } catch {
    messages = []
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const content = Array.isArray(message.content) ? message.content : []
    // dsh appends runtime-context and hook notes as later user messages; the
    // attachment turn is the latest one carrying an image or a placeholder.
    if (content.some(block => block?.type === 'image'
      || (block?.type === 'text' && /\[Image #\d+\]|<pasted-image /u.test(String(block.text ?? ''))))) return content
  }
  return []
}

/**
 * `[Image #N]` → the host path of that attachment in the latest user turn.
 * A text-only model got `<pasted-image id="N" … path="…">`; an image model
 * got image blocks in placeholder order, stored by dsh's attachment store.
 */
export function attachmentPaths(content, hostPath = () => undefined) {
  const paths = new Map()
  const placeholders = []
  const blocks = []
  for (const block of content) {
    if (block?.type === 'text') {
      const text = String(block.text ?? '')
      for (const match of text.matchAll(/<pasted-image id="(\d+)"[^>\n]*? path="([^"\n]*)">/gu)) {
        const path = unescapeXml(match[2])
        if (!path.startsWith('unsaved:')) paths.set(Number(match[1]), path)
      }
      for (const match of text.matchAll(/\[Image #(\d+)\]/gu)) {
        const id = Number(match[1])
        if (!placeholders.includes(id)) placeholders.push(id)
      }
    } else if (block?.type === 'image') {
      blocks.push(block)
    }
  }
  if (blocks.length > 0) {
    const ids = [...placeholders].sort((a, b) => a - b)
    const byOrder = ids.length === blocks.length
    blocks.forEach((block, index) => {
      const id = byOrder ? ids[index] : index + 1
      if (paths.has(id)) return
      let path
      try {
        path = block.attachment === undefined ? undefined : hostPath(block.attachment)
      } catch {
        path = undefined
      }
      if (!path && typeof block.data === 'string' && typeof (block.mimeType ?? block.mediaType) === 'string') {
        path = `data:${block.mimeType ?? block.mediaType};base64,${block.data}`
      }
      if (path) paths.set(id, path)
    })
  }
  return paths
}

/** Replace resolvable `[Image #N]` references; unresolved ones reach the native check and fail there. */
export function resolveReferences(references, paths) {
  return references.map(reference => {
    const match = /^\s*\[Image #(\d+)\]\s*$/u.exec(String(reference))
    if (!match) return String(reference)
    return paths.get(Number(match[1])) ?? String(reference)
  })
}

export function sessionDirFor(agent, env = process.env) {
  const session = agent?.session
  const sessionId = session?.id ?? session?.header?.id
  if (sessionId === undefined || sessionId === null || sessionId === '') return ''
  const cwd = session?.header?.cwd ?? process.cwd()
  return dirname(planFilePath(sessionId, env, cwd))
}

export function stopChild(child) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

const CANCELLED = { ok: false, cancelled: true, error: 'image request cancelled; no file was saved' }

/** Run `<rust> image run --json` with the job on stdin. */
export function runImageJob(job, { signal, cwd, env = process.env, binary = rustBinary() } = {}) {
  if (!binary) {
    return Promise.resolve({ ok: false, error: 'image tools are not connected to the Rust client; no request was made' })
  }
  if (signal?.aborted) return Promise.resolve(CANCELLED)
  return new Promise(resolve => {
    let child
    try {
      child = spawn(binary, ['image', 'run', '--json'], {
        cwd: cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      resolve({ ok: false, error: `could not start the image command: ${error.message}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => {
      stopChild(child)
      finish(CANCELLED)
    }
    child.stdout?.on('data', chunk => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8')
    })
    child.stdin?.on('error', () => { /* the command exited before reading */ })
    child.on('error', error => finish({ ok: false, error: `could not start the image command: ${error.message}` }))
    child.on('close', () => {
      if (signal?.aborted) {
        finish(CANCELLED)
        return
      }
      const line = stdout.trim().split('\n').findLast(item => item.startsWith('{'))
      if (!line) {
        finish({ ok: false, error: (stderr || 'image command produced no result').trim() })
        return
      }
      try {
        finish(JSON.parse(line))
      } catch (error) {
        finish({ ok: false, error: `image command returned invalid JSON: ${error.message}` })
      }
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdin?.end(JSON.stringify(job))
  })
}

/** The model-facing text of a saved image. */
export function resultText(result) {
  const short = String(result.short ?? '')
  const path = String(result.path ?? '')
  const size = result.width && result.height ? ` (${result.width}x${result.height})` : ''
  const lines = [`Image saved to ${short || path}${size}.`, `Absolute path: ${path}`]
  if (result.service) {
    const seconds = Number.isFinite(result.elapsedMs) ? ` in ${(result.elapsedMs / 1000).toFixed(1)}s` : ''
    lines.push(`Service: ${result.service}${result.model ? ` (${result.model})` : ''}${seconds}.`)
  }
  return lines.join('\n')
}

export function createImageTools(options = {}) {
  const env = options.env ?? process.env
  const run = options.run ?? runImageJob
  const hostPathOf = options.hostPath ?? (() => undefined)
  let active = 0
  const tool = (name, description, parameters) => ({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: imageTitle(name, args, env), kind: 'other' }),
    async execute(args, exec) {
      const limit = maxParallel(env)
      if (active >= limit) {
        throw new Error(`${name}: at most ${limit} image requests run at once (tools.media_gen.max_parallel_image_gen_calls); this call was not sent. Retry after the running ones finish.`)
      }
      const agent = exec?.agent
      const sessionDir = sessionDirFor(agent, env)
      if (!sessionDir) throw new Error(`${name}: no session folder is known; no request was made`)
      const references = Array.isArray(args?.image) ? args.image.map(String) : []
      const paths = references.length > 0 ? attachmentPaths(lastUserMessage(agent), hostPathOf) : new Map()
      const job = {
        tool: name,
        prompt: String(args?.prompt ?? ''),
        aspect_ratio: typeof args?.aspect_ratio === 'string' ? args.aspect_ratio : 'auto',
        image: resolveReferences(references, paths),
        sessionDir,
      }
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
  if (enabled('CODSH_IMAGE_GEN', env)) tools.push(tool(IMAGE_GEN, IMAGE_GEN_DESCRIPTION, IMAGE_GEN_PARAMETERS))
  if (enabled('CODSH_IMAGE_EDIT', env)) tools.push(tool(IMAGE_EDIT, IMAGE_EDIT_DESCRIPTION, IMAGE_EDIT_PARAMETERS))
  return tools
}

export function apply(ctx) {
  const hostPath = ref => ctx.get?.('attachments')?.imageHostPath?.(ref)
  for (const tool of createImageTools({ hostPath })) ctx.tools.register(tool)
}
