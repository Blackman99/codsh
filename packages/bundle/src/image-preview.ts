/**
 * The image preview card: a centered overlay showing what a pasted
 * `[Image #N]` token actually holds.
 *
 * Two ways to show it, and the terminal picks. One that speaks an
 * inline-graphics protocol is handed the image itself, at the resolution it
 * was pasted at; every other terminal gets a half-block mosaic, decoded out
 * of process. Either way the image bytes stay out of the card's rows — the
 * card reserves blank cells and the screen paints the picture over them.
 * The transcript around the card is dimmed so the picture is what reads.
 * @module codsh-bundle/src/image-preview
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeImageDimensions } from './image-meta.ts'
import { resizeToRaw } from './image-resize.ts'
import { graphicsProtocol, iterm2Image, kittyDelete, kittyImage } from './terminal-graphics.ts'
import type { GraphicsProtocol, TerminalGraphic } from './terminal-graphics.ts'
import { displayWidth, truncate } from './theme.ts'
import type { Theme } from './theme.ts'
import type { PendingImage } from './prompt.ts'

/** Format byte size into a human-readable string. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The card, plus the image the terminal was asked to paint over it. */
export interface ImagePreview {
  /** Card rows, image-free and safe to measure, cut, and diff. */
  rows: string[]
  /** The picture itself, when the terminal can paint one. */
  graphic?: TerminalGraphic | undefined
}

/**
 * A terminal cell is about twice as tall as it is wide.
 *
 * The true ratio is the font's and no escape sequence reports it, so a preview
 * scaled by this is a shape within a few percent of the original rather than
 * an exact one. That is the trade the card takes: both cell dimensions are
 * given to the protocol, which fixes the geometry the layout reserved instead
 * of letting the terminal compute a height the card would have to guess.
 */
const CELL_ASPECT = 2

/**
 * An image id no other program is likely to be using.
 *
 * Kitty ids are terminal-wide, so a low number risks deleting a placement that
 * belongs to something else sharing the window.
 */
const KITTY_ID_BASE = 0x63_64_00

/**
 * Rows the card spends on itself: two borders, a divider, and two caption lines.
 *
 * The picture gets what is left. Sizing it against the terminal's height
 * instead of the overlay's is what pushed the caption and the bottom border
 * off the bottom of the screen — the chrome owns rows too.
 */
const CARD_OVERHEAD_ROWS = 5

/**
 * The protocol that can show this image as itself, if any.
 *
 * Format matters as much as the terminal: Kitty graphics takes PNG or raw
 * pixels and nothing else, so a pasted JPEG in Ghostty falls back to the
 * mosaic, while iTerm2 decodes whatever it is handed.
 * @param image - the pending image.
 * @param env - environment to read the terminal's identity from.
 * @returns the protocol to use, or undefined when the mosaic is the only option.
 */
export function nativePreviewProtocol(
  image: PendingImage,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): GraphicsProtocol | undefined {
  if (!image.image.data) return undefined
  const protocol = graphicsProtocol(env)
  if (protocol === undefined) return undefined
  if (protocol === 'kitty' && image.image.mediaType !== 'image/png') return undefined
  return protocol
}

/**
 * Cell rectangle an image should be drawn into.
 *
 * Widest first, then shortened to the aspect ratio, and only if that is taller
 * than the room available does the height become the constraint — so a wide
 * screenshot uses the full card and a tall one stays inside the viewport.
 * @param imageWidth - source pixel width.
 * @param imageHeight - source pixel height.
 * @param maxColumns - widest the rectangle may be, in cells.
 * @param maxRows - tallest the rectangle may be, in cells.
 */
function nativeGeometry(
  imageWidth: number,
  imageHeight: number,
  maxColumns: number,
  maxRows: number,
): { columns: number; rows: number } {
  let columns = Math.max(1, maxColumns)
  let rows = Math.max(1, Math.round((columns * imageHeight) / (imageWidth * CELL_ASPECT)))
  if (rows > maxRows) {
    rows = Math.max(1, maxRows)
    columns = Math.max(1, Math.min(maxColumns, Math.round((rows * CELL_ASPECT * imageWidth) / imageHeight)))
  }
  return { columns, rows }
}

/**
 * A half-block mosaic of an image, for a terminal that cannot paint one.
 *
 * Two pixel rows share a cell: the upper half-block glyph takes the top pixel
 * as its foreground and the bottom as its background, which buys twice the
 * vertical resolution a row of text would have. The scaling is uncropped, so
 * the mosaic shows the whole picture and its aspect ratio survives.
 * @param buffer - the encoded image.
 * @param maxWidth - max cell width of the mosaic.
 * @param maxHeightRows - max cell height, in rows, of the mosaic.
 * @returns rows carrying 24-bit colour, or undefined when the decode failed.
 */
export async function generateImageThumbnail(
  buffer: Buffer,
  maxWidth = 96,
  maxHeightRows = 28,
): Promise<string[] | undefined> {
  try {
    const raw = await resizeToRaw(buffer, maxWidth, maxHeightRows * 2)
    if (raw === undefined) return undefined
    const { data } = raw
    const imgWidth = raw.width
    const imgHeight = raw.height
    const heightRows = Math.ceil(imgHeight / 2)

    const rows: string[] = []
    for (let r = 0; r < heightRows; r++) {
      let line = ''
      for (let c = 0; c < imgWidth; c++) {
        const topRow = r * 2
        const botRow = r * 2 + 1
        const topIdx = (topRow * imgWidth + c) * 3
        const tr = data[topIdx] ?? 0
        const tg = data[topIdx + 1] ?? 0
        const tb = data[topIdx + 2] ?? 0
        if (botRow < imgHeight) {
          const botIdx = (botRow * imgWidth + c) * 3
          const br = data[botIdx] ?? 0
          const bg = data[botIdx + 1] ?? 0
          const bb = data[botIdx + 2] ?? 0
          line += `\u001B[38;2;${tr};${tg};${tb}m\u001B[48;2;${br};${bg};${bb}m▀\u001B[0m`
        } else {
          line += `\u001B[38;2;${tr};${tg};${tb}m\u001B[49m▀\u001B[0m`
        }
      }
      rows.push(line)
    }
    return rows
  } catch {
    return undefined
  }
}

/**
 * Read dimensions and format of an image buffer via pure-JS header parser.
 * @param buffer - raw image buffer.
 */
export function readImageMetadata(
  buffer: Buffer,
): { width?: number; height?: number; format?: string } | undefined {
  return probeImageDimensions(buffer)
}

/**
 * Open the original image in the platform default native viewer (Preview.app, xdg-open, start).
 * @param image - the pending image record.
 * @returns true if opened successfully.
 */
export function openOriginalImage(image: PendingImage): boolean {
  try {
    if (!image.image.data) return false
    const fmt = (image.image.mediaType || 'image/png').replace(/^image\//u, '') || 'png'
    const filePath = join(tmpdir(), `codsh-preview-${image.id}.${fmt}`)
    writeFileSync(filePath, Buffer.from(image.image.data, 'base64'))
    if (process.platform === 'darwin') {
      spawn('open', [filePath], { stdio: 'ignore', detached: true }).unref()
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', filePath], { stdio: 'ignore', detached: true }).unref()
    } else {
      spawn('xdg-open', [filePath], { stdio: 'ignore', detached: true }).unref()
    }
    return true
  } catch {
    return false
  }
}

/**
 * Build the centered preview card, and the graphic that belongs over it.
 *
 * The card takes most of the terminal, because the point of it is to be looked
 * at: nearly the full width, nearly the full viewport height, centered in both.
 * Its picture is either the image itself, drawn by the terminal at the
 * resolution it was pasted at, or a half-block mosaic of it — and in the first
 * case the rows the image will cover are left blank on purpose. Painting a
 * base64 payload as row text is what breaks: the row is measured, cut to the
 * terminal width mid-sequence, and the terminal then swallows everything after
 * the wound as string data.
 * @param image - the pending image record.
 * @param theme - theme styling.
 * @param columns - terminal content columns.
 * @param viewportRows - rows the overlay may occupy, chrome already deducted.
 * @param env - environment to read the terminal's identity from.
 * @returns rows to float, and the image to paint over the cells they reserved.
 */
export function imagePreviewCard(
  image: PendingImage,
  theme: Theme,
  columns: number,
  viewportRows = 20,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): ImagePreview {
  const maxAllowedWidth = Math.max(20, columns - 4)
  // A card taller than the overlay it floats in loses its bottom rows, which
  // are the ones that say what the image is.
  const maxContentRows = Math.max(1, viewportRows - CARD_OVERHEAD_ROWS)

  const protocol = nativePreviewProtocol(image, env)
  const thumb = (image.thumbnail ?? []).slice(0, maxContentRows)
  const thumbWidth = thumb.length > 0 ? displayWidth(thumb[0] ?? '') : 0

  const geometry = protocol === undefined
    ? undefined
    : nativeGeometry(image.width ?? 800, image.height ?? 600, maxAllowedWidth - 4, maxContentRows)

  const cardWidth = geometry !== undefined
    ? Math.min(maxAllowedWidth, Math.max(geometry.columns + 4, 42))
    : thumbWidth > 0
      ? Math.min(maxAllowedWidth, Math.max(thumbWidth + 4, 42))
      : Math.min(maxAllowedWidth, 50)
  const innerWidth = Math.max(1, cardWidth - 4)
  const leftMargin = Math.max(0, Math.floor((columns - cardWidth) / 2))
  const margin = ' '.repeat(leftMargin)

  const titleRaw = `🖼  Image #${image.id}`
  const displayTitle = truncate(titleRaw, Math.max(4, cardWidth - 6))
  const topRuleWidth = Math.max(0, cardWidth - 5 - displayWidth(displayTitle))

  const top = `${margin}${theme.muted('╭─ ')}${theme.accent(displayTitle)} ${theme.muted('─'.repeat(topRuleWidth) + '╮')}`
  const mid = `${margin}${theme.muted('├' + '─'.repeat(cardWidth - 2) + '┤')}`
  const bottom = `${margin}${theme.muted('╰' + '─'.repeat(cardWidth - 2) + '╯')}`
  /** One card row: the frame, and `body` centered in what it encloses. */
  const contentRow = (body: string): string => {
    const bodyWidth = displayWidth(body)
    const left = Math.max(0, Math.floor((innerWidth - bodyWidth) / 2))
    const right = Math.max(0, innerWidth - bodyWidth - left)
    return `${margin}${theme.muted('│ ')}${' '.repeat(left)}${body}${' '.repeat(right)}${theme.muted(' │')}`
  }

  const cardRows: string[] = [top]
  let graphic: TerminalGraphic | undefined

  if (geometry !== undefined) {
    // Blank cells, not the picture: the terminal draws it over these rows once
    // the frame that reserved them has been painted.
    for (let row = 0; row < geometry.rows; row += 1) cardRows.push(contentRow(''))
    cardRows.push(mid)
    const id = KITTY_ID_BASE + image.id
    const data = image.image.data
    const canvasPad = Math.max(0, Math.floor((innerWidth - geometry.columns) / 2))
    graphic = {
      key: `${image.id}:${protocol}:${geometry.columns}x${geometry.rows}`,
      payload: protocol === 'kitty'
        ? kittyImage(data, id, geometry.columns, geometry.rows)
        : iterm2Image(data, geometry.columns, geometry.rows),
      // An iTerm2 image is cell content and goes when its rows are cleared; a
      // Kitty placement outlives them and has to be deleted by id.
      clear: protocol === 'kitty' ? kittyDelete(id) : '',
      // Directly under the top border, where the reserved rows begin.
      row: 1,
      column: leftMargin + 2 + canvasPad,
      columns: geometry.columns,
      rows: geometry.rows,
    }
  } else if (thumb.length > 0) {
    for (const row of thumb) cardRows.push(contentRow(row))
    cardRows.push(mid)
  }

  const name = image.image.name || `Pasted image #${image.id}`
  const nameShown = truncate(name, innerWidth)
  cardRows.push(`${margin}${theme.muted('│ ')}${nameShown}${' '.repeat(Math.max(0, innerWidth - displayWidth(nameShown)))}${theme.muted(' │')}`)

  const fmt = (image.image.mediaType || 'image/png').replace(/^image\//u, '')
  const dims = image.width !== undefined && image.height !== undefined ? `${image.width}×${image.height}` : undefined
  const size = image.byteSize !== undefined ? formatByteSize(image.byteSize) : undefined
  const hint = 'Ctrl+O: 打开系统原图'
  const meta = [dims, size, fmt].filter(Boolean).join(' · ')
  const metaShown = truncate(meta !== '' ? `${meta}  ${hint}` : hint, innerWidth)
  cardRows.push(`${margin}${theme.muted('│ ')}${theme.dim(metaShown)}${' '.repeat(Math.max(0, innerWidth - displayWidth(metaShown)))}${theme.muted(' │')}`)

  cardRows.push(bottom)
  return { rows: cardRows, graphic }
}
