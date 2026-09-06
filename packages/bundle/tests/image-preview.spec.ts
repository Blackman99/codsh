/**
 * Image preview overlay card and thumbnail rendering tests.
 */

import { describe, expect, it } from 'vitest'
import { formatByteSize, imagePreviewCard } from '../src/image-preview.ts'
import { createTheme, displayWidth } from '../src/theme.ts'
import type { PendingImage } from '../src/prompt.ts'

const theme = createTheme(false, {})
const colour = createTheme(true, {})

describe('formatByteSize', () => {
  it('formats bytes, kilobytes, and megabytes', () => {
    expect(formatByteSize(500)).toBe('500 B')
    expect(formatByteSize(2048)).toBe('2.0 KB')
    expect(formatByteSize(1024 * 1024 * 3.5)).toBe('3.5 MB')
  })
})

describe('imagePreviewCard', () => {
  const sample: PendingImage = {
    id: 1,
    image: {
      mediaType: 'image/png',
      data: 'fake-data',
      name: 'screenshot.png',
    },
    width: 1920,
    height: 1080,
    byteSize: 1024 * 42,
  }

  it('renders a framed card containing image title, dimensions, and size', () => {
    const card = imagePreviewCard(sample, theme, 60)
    expect(card[0]).toContain('Image #1')
    expect(card.some(row => row.includes('screenshot.png'))).toBe(true)
    expect(card.some(row => row.includes('1920×1080 png'))).toBe(true)
    expect(card.some(row => row.includes('42.0 KB'))).toBe(true)
    expect(card.at(-1)).toContain('╰')
  })

  it('renders a two-column thumbnail card when thumbnail is available', () => {
    const withThumb: PendingImage = {
      ...sample,
      thumbnail: [
        '▀'.repeat(12),
        '▀'.repeat(12),
        '▀'.repeat(12),
        '▀'.repeat(12),
      ],
    }
    const card = imagePreviewCard(withThumb, colour, 60)
    expect(card.length).toBe(6) // top + 4 content + bottom
    expect(card[0]).toContain('Image #1')
    expect(card.some(row => row.includes('screenshot.png'))).toBe(true)
    expect(card.some(row => row.includes('1920×1080 png'))).toBe(true)
  })

  it('fits within terminal column constraints without overflowing', () => {
    const card = imagePreviewCard(sample, theme, 35)
    for (const row of card) {
      expect(displayWidth(row)).toBeLessThanOrEqual(35)
    }
  })
})
