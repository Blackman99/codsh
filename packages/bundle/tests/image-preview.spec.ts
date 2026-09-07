/**
 * Image preview card, mosaic decoding, and the graphic handed to the terminal.
 */

import { describe, expect, it } from 'vitest'
import { formatByteSize, generateImageThumbnail, imagePreviewCard, nativePreviewProtocol } from '../src/image-preview.ts'
import { createTheme, displayWidth } from '../src/theme.ts'
import type { PendingImage } from '../src/prompt.ts'

const theme = createTheme(false, {})
const colour = createTheme(true, {})

/**
 * Every card test names the terminal it is drawing for.
 *
 * The card's shape depends on what the terminal can paint, and the process
 * running the suite is itself in some terminal — reading the ambient
 * environment would make these pass or fail by where they ran.
 */
const plain = { TERM: 'xterm-256color' }
const ghostty = { TERM_PROGRAM: 'ghostty' }
const iterm = { TERM_PROGRAM: 'iTerm.app' }

describe('formatByteSize', () => {
  it('formats bytes, kilobytes, and megabytes', () => {
    expect(formatByteSize(500)).toBe('500 B')
    expect(formatByteSize(2048)).toBe('2.0 KB')
    expect(formatByteSize(1024 * 1024 * 3.5)).toBe('3.5 MB')
  })
})

describe('generateImageThumbnail', () => {
  it('scales without cropping, so the whole picture survives the aspect ratio', async () => {
    const landscape = '<svg width="1600" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="1600" height="900" fill="red"/></svg>'
    const thumb = await generateImageThumbnail(Buffer.from(landscape), 48, 14)
    expect(thumb).toBeDefined()
    expect(thumb?.length).toBeLessThanOrEqual(14)
    // Two pixel rows to a cell, so 16:9 comes out wider in columns than rows.
    expect(displayWidth(thumb?.[0] ?? '')).toBeGreaterThan(thumb?.length ?? 0)
  })

  it('reports nothing rather than throwing when the bytes decode to no image', async () => {
    expect(await generateImageThumbnail(Buffer.from('not an image at all'), 20, 6)).toBeUndefined()
  })
})

describe('nativePreviewProtocol', () => {
  const png: PendingImage = { id: 1, image: { mediaType: 'image/png', data: 'QUJD' } }

  it('uses the protocol the terminal actually implements', () => {
    expect(nativePreviewProtocol(png, ghostty)).toBe('kitty')
    expect(nativePreviewProtocol(png, iterm)).toBe('iterm2')
    expect(nativePreviewProtocol(png, plain)).toBeUndefined()
  })

  it('declines kitty for a format it cannot take, and iTerm2 keeps it', () => {
    // Kitty graphics accepts PNG or raw pixels; a pasted JPEG has to fall
    // back to the mosaic rather than be sent as something it is not.
    const jpeg: PendingImage = { id: 2, image: { mediaType: 'image/jpeg', data: 'QUJD' } }
    expect(nativePreviewProtocol(jpeg, ghostty)).toBeUndefined()
    expect(nativePreviewProtocol(jpeg, iterm)).toBe('iterm2')
  })

  it('declines when there are no bytes to send', () => {
    expect(nativePreviewProtocol({ id: 3, image: { mediaType: 'image/png', data: '' } }, ghostty)).toBeUndefined()
  })
})

describe('imagePreviewCard', () => {
  const sample: PendingImage = {
    id: 1,
    image: {
      mediaType: 'image/png',
      data: 'QUJDRA',
      name: 'screenshot.png',
    },
    width: 1920,
    height: 1080,
    byteSize: 1024 * 42,
  }

  it('renders a framed card containing image title, dimensions, and size', () => {
    const { rows } = imagePreviewCard(sample, theme, 60, 24, plain)
    expect(rows[0]).toContain('Image #1')
    expect(rows.some(row => row.includes('screenshot.png'))).toBe(true)
    expect(rows.some(row => row.includes('1920×1080'))).toBe(true)
    expect(rows.some(row => row.includes('42.0 KB'))).toBe(true)
    expect(rows.at(-1)).toContain('╰')
  })

  it('renders a centered mosaic card with divider and metadata', () => {
    const withThumb: PendingImage = { ...sample, thumbnail: Array.from({ length: 4 }, () => '▀'.repeat(24)) }
    const { rows, graphic } = imagePreviewCard(withThumb, colour, 60, 24, plain)
    // top + 4 mosaic rows + divider + name + meta + bottom
    expect(rows.length).toBe(9)
    expect(rows.some(row => row.includes('├'))).toBe(true)
    expect(graphic).toBeUndefined()
  })

  it('reserves blank rows and hands the image to the terminal beside them', () => {
    const { rows, graphic } = imagePreviewCard(sample, colour, 80, 30, ghostty)
    expect(graphic?.payload).toContain('\u001B_Ga=T,f=100,t=d')
    expect(graphic?.payload).toContain('QUJDRA')
    // The picture starts directly under the top border, and the card reserves
    // exactly the rows it will cover.
    expect(graphic?.row).toBe(1)
    const reserved = rows.slice(1, 1 + (graphic?.rows ?? 0))
    expect(reserved.length).toBe(graphic?.rows)
    for (const row of reserved) expect(row.replaceAll(/\u001B\[[0-9;]*m/gu, '')).toMatch(/^ *│ +│$/u)
  })

  it('keeps image bytes out of every row, whichever protocol is used', () => {
    // This is the failure the card is shaped around: a base64 payload inside a
    // row measures as thousands of columns, gets cut mid-sequence by the width
    // fitting, and the terminal then eats the rest of the frame as string data.
    for (const env of [ghostty, iterm]) {
      const { rows } = imagePreviewCard(sample, colour, 80, 30, env)
      for (const row of rows) {
        expect(row).not.toContain('QUJDRA')
        expect(row).not.toContain('\u001B_G')
        expect(row).not.toContain('1337')
      }
    }
  })

  it('sends iTerm2 its own protocol, not kitty escapes', () => {
    const { graphic } = imagePreviewCard(sample, colour, 80, 30, iterm)
    expect(graphic?.payload).toContain('\u001B]1337;File=inline=1')
    expect(graphic?.payload).not.toContain('\u001B_G')
    // iTerm2 images are cell content: clearing the rows removes them, so
    // there is nothing to delete by id.
    expect(graphic?.clear).toBe('')
  })

  it('deletes a kitty placement by id, since clearing its rows will not', () => {
    const { graphic } = imagePreviewCard(sample, colour, 80, 30, ghostty)
    expect(graphic?.clear).toContain('a=d,d=I,i=')
  })

  it('keeps the reserved picture inside the viewport for a tall image', () => {
    const tall: PendingImage = { ...sample, width: 600, height: 4000 }
    const { rows, graphic } = imagePreviewCard(tall, colour, 80, 24, ghostty)
    expect(graphic?.rows).toBeLessThanOrEqual(24 - 5)
    expect(rows.length).toBeLessThanOrEqual(24)
  })

  it('never grows past the rows it was given, whatever the viewport', () => {
    // The overlay is what the chrome leaves of the screen. A card measured
    // against the terminal instead loses its last rows — the caption and the
    // bottom border, which are the ones that say what the image is.
    for (const viewport of [8, 12, 20, 36]) {
      for (const env of [plain, ghostty]) {
        const { rows } = imagePreviewCard(sample, colour, 120, viewport, env)
        expect(rows.length).toBeLessThanOrEqual(viewport)
        expect(rows.some(row => row.includes('screenshot.png'))).toBe(true)
        expect(rows.at(-1)).toContain('╰')
      }
    }
  })

  it('centers the card horizontally and never overflows the columns given', () => {
    for (const columns of [35, 60, 80, 120]) {
      for (const env of [plain, ghostty]) {
        const { rows } = imagePreviewCard(sample, theme, columns, 24, env)
        for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(columns)
      }
    }
    const { rows } = imagePreviewCard(sample, theme, 80, 24, plain)
    for (const row of rows) expect(row.startsWith(' ')).toBe(true)
  })
})
