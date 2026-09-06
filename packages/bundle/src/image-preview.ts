/**
 * Image preview overlay and half-block ANSI thumbnail generator.
 *
 * Automatically displays an image preview card floating above the prompt box
 * when the cursor is positioned directly next to an `[Image #N]` token.
 * @module codsh-bundle/src/image-preview
 */

import { displayWidth, truncate } from './theme.ts'
import type { Theme } from './theme.ts'
import type { PendingImage } from './prompt.ts'

/** Format byte size into a human-readable string. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Generate a half-block ANSI colored thumbnail using sharp.
 * @param buffer - raw image buffer.
 * @param width - character cell width of the thumbnail.
 * @param heightRows - character cell height (rows) of the thumbnail.
 * @returns an array of rows with 24-bit ANSI escapes, or undefined if sharp fails.
 */
export async function generateImageThumbnail(
  buffer: Buffer,
  width = 12,
  heightRows = 4,
): Promise<string[] | undefined> {
  try {
    const { default: sharp } = await import('sharp')
    const { data } = await sharp(buffer)
      .resize(width, heightRows * 2, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const rows: string[] = []
    for (let r = 0; r < heightRows; r++) {
      let line = ''
      for (let c = 0; c < width; c++) {
        const topIdx = ((r * 2) * width + c) * 3
        const botIdx = ((r * 2 + 1) * width + c) * 3
        const tr = data[topIdx] ?? 0
        const tg = data[topIdx + 1] ?? 0
        const tb = data[topIdx + 2] ?? 0
        const br = data[botIdx] ?? 0
        const bg = data[botIdx + 1] ?? 0
        const bb = data[botIdx + 2] ?? 0
        line += `\u001B[38;2;${tr};${tg};${tb}m\u001B[48;2;${br};${bg};${bb}m▀\u001B[0m`
      }
      rows.push(line)
    }
    return rows
  } catch {
    return undefined
  }
}

/**
 * Read dimensions and format of an image buffer using sharp.
 * @param buffer - raw image buffer.
 */
export async function readImageMetadata(
  buffer: Buffer,
): Promise<{ width?: number; height?: number; format?: string } | undefined> {
  try {
    const { default: sharp } = await import('sharp')
    const meta = await sharp(buffer).metadata()
    return { width: meta.width, height: meta.height, format: meta.format }
  } catch {
    return undefined
  }
}

/**
 * Build the floating preview card rows for a pending image.
 * @param image - the pending image record.
 * @param theme - theme styling.
 * @param columns - terminal content columns.
 */
export function imagePreviewCard(image: PendingImage, theme: Theme, columns: number): string[] {
  const cardWidth = Math.max(28, Math.min(columns - 2, 50))
  const innerWidth = cardWidth - 4
  const title = `🖼  Image #${image.id}`
  const titleWidth = displayWidth(title)
  const topRuleWidth = Math.max(0, cardWidth - 4 - titleWidth)

  const top = `${theme.muted('╭─ ')}${theme.accent(title)} ${theme.muted('─'.repeat(topRuleWidth) + '╮')}`
  const bottom = `${theme.muted('╰' + '─'.repeat(cardWidth - 2) + '╯')}`

  const fmt = (image.image.mediaType || 'image/png').replace(/^image\//u, '')
  const dims = image.width !== undefined && image.height !== undefined ? `${image.width}×${image.height} ${fmt}` : fmt
  const size = image.byteSize !== undefined ? formatByteSize(image.byteSize) : undefined
  const name = image.image.name || `Pasted image #${image.id}`

  const thumb = image.thumbnail
  const hasThumb = thumb !== undefined && thumb.length === 4 && innerWidth >= 34

  const infoLines: string[] = [
    truncate(name, hasThumb ? innerWidth - 14 : innerWidth),
    truncate(theme.dim(dims), hasThumb ? innerWidth - 14 : innerWidth),
    truncate(theme.dim(size !== undefined ? `${size}` : `[Image #${image.id}]`), hasThumb ? innerWidth - 14 : innerWidth),
    truncate(theme.muted(`[Image #${image.id}]`), hasThumb ? innerWidth - 14 : innerWidth),
  ]

  const rows: string[] = [top]

  if (hasThumb) {
    const thumbWidth = 12
    const infoWidth = innerWidth - thumbWidth - 2
    for (let i = 0; i < 4; i++) {
      const t = thumb[i] ?? ' '.repeat(thumbWidth)
      const info = infoLines[i] ?? ''
      const pad = ' '.repeat(Math.max(0, infoWidth - displayWidth(info)))
      rows.push(`${theme.muted('│ ')}${t}  ${info}${pad}${theme.muted(' │')}`)
    }
  } else {
    for (const info of infoLines.slice(0, 3)) {
      const pad = ' '.repeat(Math.max(0, innerWidth - displayWidth(info)))
      rows.push(`${theme.muted('│ ')}${info}${pad}${theme.muted(' │')}`)
    }
  }

  rows.push(bottom)
  return rows
}
