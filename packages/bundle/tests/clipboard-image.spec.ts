/**
 * The clipboard-image reader, driven through its test seam: a command whose
 * stdout is the image bytes stands in for the platform clipboard, exactly as
 * `CODSH_CLIPBOARD=osc52` stands in for the platform clipboard on writes.
 */

import { describe, expect, it } from 'vitest'
import { readClipboardImage, sniffImageType } from '../src/clipboard-image.ts'

/** A 1×1 PNG, the smallest real image the fixtures need. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A shell command printing `data` to stdout, via node so it runs anywhere. */
const emit = (data: Buffer): string =>
  `node -e "process.stdout.write(Buffer.from('${data.toString('base64')}','base64'))"`

describe('sniffing what the bytes are', () => {
  it('recognises the four types the store admits', () => {
    expect(sniffImageType(TINY_PNG)).toBe('image/png')
    expect(sniffImageType(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg')
    expect(sniffImageType(Buffer.from('GIF89a______'))).toBe('image/gif')
    expect(sniffImageType(Buffer.from('RIFF____WEBP'))).toBe('image/webp')
  })

  it('refuses text and anything too short to say', () => {
    expect(sniffImageType(Buffer.from('just some text on the clipboard'))).toBeUndefined()
    expect(sniffImageType(Buffer.from('x'))).toBeUndefined()
  })
})

describe('reading through the override command', () => {
  it('returns the bytes with their sniffed type and probed dimensions', async () => {
    const image = await readClipboardImage({ CODSH_CLIPBOARD_IMAGE_CMD: emit(TINY_PNG) })
    expect(image?.mediaType).toBe('image/png')
    expect(image?.data.equals(TINY_PNG)).toBe(true)
    expect(image?.width).toBe(1)
    expect(image?.height).toBe(1)
  })

  it('reads empty output as no image', async () => {
    expect(await readClipboardImage({ CODSH_CLIPBOARD_IMAGE_CMD: 'true' })).toBeUndefined()
  })

  it('reads a failing command as no image, never as an error', async () => {
    expect(await readClipboardImage({ CODSH_CLIPBOARD_IMAGE_CMD: 'exit 3' })).toBeUndefined()
  })

  it('reads non-image bytes as no image', async () => {
    expect(await readClipboardImage({ CODSH_CLIPBOARD_IMAGE_CMD: 'echo clipboard holds text' })).toBeUndefined()
  })
})
