/**
 * What a pasted image becomes when the model cannot see.
 *
 * DeepSeek Vision routes receive first-class image blocks before this module
 * is involved. For text-only routes such as Flash and Pro, codsh gives an
 * image two honest lives: it is always saved to a stable file the agent's
 * tools can touch — inspect, commit, embed. An explicit `CODSH_VISION_*`
 * sidecar, or DeepSeek's built-in Vision Exp bridge when no sidecar is set,
 * can also describe it into text the model can actually read: everything in
 * it transcribed, structure narrated. Both ride the same message the person
 * sent, so they persist in durable history and survive `--resume`.
 * @module codsh-bundle/src/vision
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { EncodedImageAttachment, ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { GenerateOptions, LlmCallConfig, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A vision sidecar: an OpenAI-compatible endpoint that can see. */
export interface VisionConfig {
  /** The API base, e.g. `https://open.bigmodel.cn/api/paas/v4`. */
  baseUrl: string
  /** Bearer token; absent for endpoints that need none (local ollama). */
  apiKey?: string
  /** The multimodal model to ask. */
  model: string
}

/** How long one description may take before the paste falls back to file-only. */
const VISION_TIMEOUT_MS = 30_000

/** The sibling route that lends sight to DeepSeek's text-only models. */
export const DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** The provider-owned preparation seam needed for one auxiliary vision call. */
export interface VisionLlm {
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<{
    readonly config: LlmCallConfig
    readonly inputModalities?: readonly ModelModality[]
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }>
}

/**
 * The one instruction the sidecar gets.
 *
 * It is the eyes for a model that has none, so completeness beats brevity and
 * verbatim beats summary: a truncated error message or a paraphrased line of
 * code is exactly the part the coding agent needed.
 */
const VISION_PROMPT
  = 'You are the eyes for a text-only coding agent. Describe this image precisely and completely. '
    + 'Transcribe ALL visible text, code, commands, error messages, numbers and labels verbatim. '
    + 'When it shows a UI, terminal, diagram or chart, describe its structure and layout so the agent '
    + 'can reason about it. Do not speculate beyond what is visible.'

/** How the conversation model should consume a successful visual handoff. */
const DESCRIPTION_HANDLING
  = 'A vision model has already inspected this image. Treat the description as the image content available to you '
    + 'and answer the user directly. Do not say that you cannot see, read, access, or directly inspect the image, '
    + 'and do not mention the description, metadata, or vision handoff unless the user asks how image handling works.'

/**
 * The sidecar from the environment, or undefined when none is configured.
 * @param env - the process environment.
 * @returns the config when both the base URL and the model are set.
 */
export function visionConfigFromEnv(env: Record<string, string | undefined>): VisionConfig | undefined {
  const baseUrl = env.CODSH_VISION_BASE_URL
  const model = env.CODSH_VISION_MODEL
  if (baseUrl === undefined || baseUrl === '' || model === undefined || model === '') return undefined
  const config: VisionConfig = { baseUrl: baseUrl.replace(/\/$/u, ''), model }
  const key = env.CODSH_VISION_API_KEY
  if (key !== undefined && key !== '') config.apiKey = key
  return config
}

/**
 * Ask the sidecar what an image shows.
 * @param image - the encoded image.
 * @param config - which endpoint and model to ask.
 * @param signal - cancels the request, on top of the built-in timeout.
 * @returns the description.
 * @throws on timeout, a non-2xx answer, or an answer with no text.
 */
export async function describeImage(image: EncodedImageAttachment, config: VisionConfig, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(VISION_TIMEOUT_MS)
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` },
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    }),
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  if (!response.ok) throw new Error(`vision endpoint answered ${response.status}`)
  const body = await response.json() as { choices?: { message?: { content?: string } }[] }
  const text = body.choices?.[0]?.message?.content?.trim()
  if (text === undefined || text === '') throw new Error('vision endpoint answered without text')
  return text
}

/**
 * Ask DeepSeek's native vision sibling to describe one durable image.
 *
 * This is deliberately a one-shot auxiliary call: it receives no conversation
 * history, system prompt, or tools, and its answer is returned as plain text
 * for the selected text model's ordinary user turn.
 * @param image - the image reference already admitted to the durable store.
 * @param llm - the provider-neutral runtime serving the DeepSeek route.
 * @param options - optional caller cancellation and request attribution.
 * @returns the visible text emitted by the vision model.
 * @throws when the route cannot see, the provider fails, the call is aborted,
 *   or the response contains no visible text.
 */
export async function describeImageWithLlm(
  image: ImageAttachmentRef,
  llm: VisionLlm,
  options: { signal?: AbortSignal; sessionId?: SessionId } = {},
): Promise<string> {
  const timeout = AbortSignal.timeout(VISION_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const prepared = await llm.prepareCall({
    provider: 'deepseek-official',
    model: DEEPSEEK_VISION_MODEL,
    reasoningEffort: ReasoningEffortId('off'),
  }, signal)
  if (prepared.inputModalities?.includes('image') !== true) {
    throw new Error(`${DEEPSEEK_VISION_MODEL} does not accept image input`)
  }
  const assembler = new BlockAssembler()
  const message = createUserMessage({
    content: [
      { type: 'image', attachment: image },
      { type: 'text', text: VISION_PROMPT },
    ],
    source: { kind: 'plugin', plugin: 'coding-cli' },
  })
  for await (const chunk of prepared.stream({
    ...prepared.config,
    messages: [message],
    signal,
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
  })) assembler.push(chunk)

  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`vision model ${finish.kind}: ${finish.failure.message}`)
  }
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text === '') throw new Error('vision model answered without text')
  return text
}

/**
 * The upstream store's default admission limits, for use when no store is
 * mounted: the sidecar payload is bounded by the same line either way.
 */
export const DEFAULT_IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 3.5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** File extension per media type, for the saved copy's name. */
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const

/**
 * Save a pasted image where the agent's tools can reach it.
 *
 * The original bytes, never a downscaled copy — the person may want the asset
 * itself committed. Content-addressed under the dsh home so a repeated paste
 * dedupes, nothing lands in the workspace uninvited, and the path stays valid
 * for `--resume`.
 * @param image - the encoded image.
 * @returns the absolute path of the saved file.
 */
export async function savePastedImage(image: EncodedImageAttachment): Promise<string> {
  const data = Buffer.from(image.data, 'base64')
  const digest = createHash('sha256').update(data).digest('hex').slice(0, 12)
  const dir = dshHomePath('attachments', 'pasted')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${digest}.${EXTENSIONS[image.mediaType]}`)
  // Content-addressed: same bytes, same path — overwriting is a no-op rewrite.
  await writeFile(path, data)
  return path
}

/**
 * The context block a pasted image contributes on a text-only route.
 *
 * The same XMLish convention the `!` passthrough uses: the model reads the
 * path (its tools can open the file), the dimensions, and — when the sidecar
 * ran — the description standing in for sight.
 * @param id - the `[Image #N]` number the person's text references.
 * @param image - the encoded image.
 * @param at - where the file was saved and what is known about it.
 * @returns the block text.
 */
export function pastedImageBlock(
  id: number,
  image: EncodedImageAttachment,
  at: { path: string; width?: number; height?: number; description?: string },
): string {
  const size = at.width !== undefined && at.height !== undefined ? ` dimensions="${at.width}x${at.height}"` : ''
  const body = at.description === undefined
    ? ''
    : `\n<description>\n${at.description}\n</description>\n<handling>\n${DESCRIPTION_HANDLING}\n</handling>`
  return `<pasted-image id="${id}" media="${image.mediaType}"${size} path="${at.path}">${body}\n</pasted-image>`
}

/**
 * Shrink an image until the attachment store will admit it.
 *
 * Retina screenshots exceed the deployed routes' 2000-pixel side limit as a
 * matter of course, and refusing them would make the feature useless on the
 * machines most likely to use it. The downscale re-encodes as PNG; a copy
 * still over the byte limit falls back to JPEG, which is what a photograph
 * that big actually is.
 * @param image - the encoded image.
 * @param limits - the store's admission limits.
 * @returns the image, downscaled only when it had to be.
 */
export async function fitWithinLimits(image: EncodedImageAttachment, limits: ImageAttachmentLimits): Promise<EncodedImageAttachment> {
  const data = Buffer.from(image.data, 'base64')
  const { default: sharp } = await import('sharp')
  const meta = await sharp(data).metadata()
  const side = Math.max(meta.width ?? 0, meta.height ?? 0)
  const oversized = side > limits.maxImageDimension
    || data.length > limits.maxImageBytes
    || (meta.width ?? 0) * (meta.height ?? 0) > limits.maxImagePixels
  if (!oversized) return image
  const bounded = sharp(data).resize({
    width: limits.maxImageDimension,
    height: limits.maxImageDimension,
    fit: 'inside',
    withoutEnlargement: true,
  })
  const png = await bounded.png().toBuffer()
  if (png.length <= limits.maxImageBytes) {
    return { ...image, mediaType: 'image/png', data: png.toString('base64') }
  }
  const jpeg = await sharp(png).jpeg({ quality: 80 }).toBuffer()
  return { ...image, mediaType: 'image/jpeg', data: jpeg.toString('base64') }
}
