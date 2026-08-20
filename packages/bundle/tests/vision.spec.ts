/**
 * The vision sidecar and the text-only fallback pieces: the request shape an
 * OpenAI-compatible endpoint receives, the failure modes that must degrade
 * rather than lose a turn, and the context block the model reads in place of
 * sight.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeImage, pastedImageBlock, visionConfigFromEnv } from '../src/vision.ts'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment/types'

const IMAGE: EncodedImageAttachment = { mediaType: 'image/png', data: 'cG5nLWJ5dGVz', name: 'Pasted image #1' }

afterEach(() => {
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
