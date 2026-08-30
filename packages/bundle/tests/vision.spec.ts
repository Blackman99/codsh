/**
 * The vision sidecar and the text-only fallback pieces: the request shape an
 * OpenAI-compatible endpoint receives, the failure modes that must degrade
 * rather than lose a turn, and the context block the model reads in place of
 * sight.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DEEPSEEK_VISION_MODEL,
  describeImage,
  describeImageWithLlm,
  pastedImageBlock,
  visionConfigFromEnv,
} from '../src/vision.ts'
import type { EncodedImageAttachment, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'

const IMAGE: EncodedImageAttachment = { mediaType: 'image/png', data: 'cG5nLWJ5dGVz', name: 'Pasted image #1' }
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:fixture'),
  mediaType: 'image/png',
  bytes: 9,
  width: 12,
  height: 8,
  name: 'Pasted image #1',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the sidecar config', () => {
  it('needs both the base URL and the model', () => {
    expect(visionConfigFromEnv({})).toBeUndefined()
    expect(visionConfigFromEnv({ CODSH_VISION_BASE_URL: 'https://v.example/v1' })).toBeUndefined()
    expect(visionConfigFromEnv({ CODSH_VISION_MODEL: 'glm-4v' })).toBeUndefined()
  })

  it('reads the endpoint, trims a trailing slash, and keeps the key optional', () => {
    expect(visionConfigFromEnv({
      CODSH_VISION_BASE_URL: 'https://v.example/v1/',
      CODSH_VISION_MODEL: 'glm-4v',
    })).toEqual({ baseUrl: 'https://v.example/v1', model: 'glm-4v' })
    expect(visionConfigFromEnv({
      CODSH_VISION_BASE_URL: 'https://v.example/v1',
      CODSH_VISION_MODEL: 'glm-4v',
      CODSH_VISION_API_KEY: 'sk-x',
    })?.apiKey).toBe('sk-x')
  })
})

describe('asking the sidecar', () => {
  it('sends the OpenAI-compatible shape and returns the text', async () => {
    const fetched = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '  a login form with one error banner  ' } }],
    })))
    vi.stubGlobal('fetch', fetched)
    const text = await describeImage(IMAGE, { baseUrl: 'https://v.example/v1', apiKey: 'sk-x', model: 'glm-4v' })
    expect(text).toBe('a login form with one error banner')
    const [url, init] = fetched.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://v.example/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-x')
    const body = JSON.parse(init.body as string) as { model: string; messages: { content: { type: string; image_url?: { url: string } }[] }[] }
    expect(body.model).toBe('glm-4v')
    // The image travels as a data URL, the instruction beside it.
    expect(body.messages[0]?.content[0]?.image_url?.url).toBe('data:image/png;base64,cG5nLWJ5dGVz')
    expect(body.messages[0]?.content[1]?.type).toBe('text')
  })

  it('sends no authorization header when no key is configured', async () => {
    const fetched = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'described' } }],
    })))
    vi.stubGlobal('fetch', fetched)
    await describeImage(IMAGE, { baseUrl: 'https://v.example/v1', model: 'llava' })
    const [, init] = fetched.mock.calls[0] as [string, RequestInit]
    expect('authorization' in (init.headers as Record<string, string>)).toBe(false)
  })

  it('throws on a refusing endpoint, and on an answer with no text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))
    await expect(describeImage(IMAGE, { baseUrl: 'https://v.example/v1', model: 'glm-4v' }))
      .rejects.toThrow('vision endpoint answered 401')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }))))
    await expect(describeImage(IMAGE, { baseUrl: 'https://v.example/v1', model: 'glm-4v' }))
      .rejects.toThrow('vision endpoint answered without text')
  })
})

describe('asking the built-in DeepSeek vision route', () => {
  it('sends only the image instruction and returns visible text without changing the caller model', async () => {
    let request: GenerateOptions | undefined
    const llm = {
      prepareCall: vi.fn(async (config: LlmCallConfig) => ({
        config,
        inputModalities: ['text', 'image'] as const,
        stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
          request = options
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'a settings panel with the label Save' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'a settings panel with the label Save' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      })),
    }

    const text = await describeImageWithLlm(IMAGE_REF, llm, { sessionId: SessionId('session-1') })

    expect(text).toBe('a settings panel with the label Save')
    expect(llm.prepareCall).toHaveBeenCalledWith({
      provider: 'deepseek-official',
      model: DEEPSEEK_VISION_MODEL,
      reasoningEffort: 'off',
    }, expect.any(AbortSignal))
    expect(request?.provider).toBe('deepseek-official')
    expect(request?.model).toBe(DEEPSEEK_VISION_MODEL)
    expect(request?.sessionId).toBe('session-1')
    expect(request?.tools).toBeUndefined()
    expect(request?.system).toBeUndefined()
    expect(request?.messages).toHaveLength(1)
    expect(request?.messages[0]?.content[0]).toEqual({ type: 'image', attachment: IMAGE_REF })
    expect(request?.messages[0]?.content[1]).toMatchObject({ type: 'text' })
  })

  it('refuses a route that does not explicitly accept images', async () => {
    const llm = {
      prepareCall: vi.fn(async (config: LlmCallConfig) => ({
        config,
        inputModalities: ['text'] as const,
        stream: async function* (): AsyncIterable<StreamChunk> {
          throw new Error('stream must not start')
        },
      })),
    }
    await expect(describeImageWithLlm(IMAGE_REF, llm))
      .rejects.toThrow('deepseek-v4-flash-vision-exp does not accept image input')
  })

  it('reports provider failures and answers with no visible text', async () => {
    const failing = {
      prepareCall: vi.fn(async (config: LlmCallConfig) => ({
        config,
        inputModalities: ['text', 'image'] as const,
        stream: async function* (): AsyncIterable<StreamChunk> {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'credential refused' } } }
        },
      })),
    }
    await expect(describeImageWithLlm(IMAGE_REF, failing))
      .rejects.toThrow('vision model error: credential refused')

    const empty = {
      prepareCall: vi.fn(async (config: LlmCallConfig) => ({
        config,
        inputModalities: ['text', 'image'] as const,
        stream: async function* (): AsyncIterable<StreamChunk> {
          yield { type: 'block-start', index: 0, blockType: 'reasoning' }
          yield { type: 'reasoning-delta', index: 0, text: 'private reasoning only' }
          yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private reasoning only' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      })),
    }
    await expect(describeImageWithLlm(IMAGE_REF, empty))
      .rejects.toThrow('vision model answered without text')
  })

  it('propagates an aborted provider call', async () => {
    const llm = {
      prepareCall: vi.fn(async (config: LlmCallConfig) => ({
        config,
        inputModalities: ['text', 'image'] as const,
        stream: async function* (): AsyncIterable<StreamChunk> {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'caller stopped' } } }
        },
      })),
    }
    await expect(describeImageWithLlm(IMAGE_REF, llm))
      .rejects.toThrow('vision model aborted: caller stopped')
  })

  it('propagates cancellation from the caller signal into the vision stream', async () => {
    const caller = new AbortController()
    const waiting = Promise.withResolvers<void>()
    const llm = {
      prepareCall: vi.fn(async (config: LlmCallConfig) => ({
        config,
        inputModalities: ['text', 'image'] as const,
        stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
          waiting.resolve()
          await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'caller stopped' } } }
        },
      })),
    }

    const result = describeImageWithLlm(IMAGE_REF, llm, { signal: caller.signal })
    await waiting.promise
    caller.abort()

    await expect(result).rejects.toThrow('vision model aborted: caller stopped')
  })

  it('bounds the auxiliary call with the 30-second vision deadline', async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const waiting = Promise.withResolvers<void>()
    const llm = {
      prepareCall: vi.fn(async (config: LlmCallConfig) => ({
        config,
        inputModalities: ['text', 'image'] as const,
        stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
          waiting.resolve()
          await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'deadline elapsed' } } }
        },
      })),
    }

    const result = describeImageWithLlm(IMAGE_REF, llm)
    await waiting.promise
    deadline.abort()

    await expect(result).rejects.toThrow('vision model aborted: deadline elapsed')
    expect(timeout).toHaveBeenCalledWith(30_000)
  })
})

describe('the context block a text-only route reads', () => {
  it('names the token, the file, the size, and carries the description', () => {
    const block = pastedImageBlock(2, IMAGE, {
      path: '/home/u/.dsh/attachments/pasted/ab12cd34ef56.png',
      width: 2880,
      height: 1800,
      description: 'a stack trace ending in TypeError',
    })
    expect(block).toBe([
      '<pasted-image id="2" media="image/png" dimensions="2880x1800" path="/home/u/.dsh/attachments/pasted/ab12cd34ef56.png">',
      '<description>',
      'a stack trace ending in TypeError',
      '</description>',
      '</pasted-image>',
    ].join('\n'))
  })

  it('stands without a description or dimensions, saying only what it knows', () => {
    const block = pastedImageBlock(1, IMAGE, { path: '/tmp/x.png' })
    expect(block).toBe('<pasted-image id="1" media="image/png" path="/tmp/x.png">\n</pasted-image>')
  })
})
