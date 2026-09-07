/**
 * Pure TypeScript image format sniffers and dimension extractors.
 *
 * Avoids loading native libraries (like sharp/libvips) in the interactive TUI
 * process, completely preventing macOS duplicate Objective-C class conflicts.
 * @module codsh-bundle/src/image-meta
 */

export interface ImageDimensions {
  width: number
  height: number
  format: 'png' | 'jpeg' | 'webp' | 'gif'
}

/**
 * Extract pixel dimensions and format directly from image header bytes.
 * Supports PNG, JPEG, WebP (VP8, VP8L, VP8X), and GIF.
 * @param buf - raw image bytes.
 * @returns extracted width, height, and format, or undefined if unrecognized.
 */
export function probeImageDimensions(buf: Buffer): ImageDimensions | undefined {
  if (buf.length < 10) return undefined

  // PNG
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      format: 'png',
    }
  }

  // JPEG
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset < buf.length) {
      if (buf[offset] !== 0xff) break
      const marker = buf[offset + 1]
      // SOF0, SOF1, SOF2 markers
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
          format: 'jpeg',
        }
      }
      const len = buf.readUInt16BE(offset + 2)
      offset += 2 + len
    }
  }

  // WebP
  if (buf.length >= 30 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    const chunkHeader = buf.slice(12, 16).toString()
    if (chunkHeader === 'VP8X' && buf.length >= 30) {
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
        format: 'webp',
      }
    }
    if (chunkHeader === 'VP8 ' && buf.length >= 30) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
        format: 'webp',
      }
    }
    if (chunkHeader === 'VP8L' && buf.length >= 25) {
      const b0 = buf[21] ?? 0
      const b1 = buf[22] ?? 0
      const b2 = buf[23] ?? 0
      const b3 = buf[24] ?? 0
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        format: 'webp',
      }
    }
  }

  // GIF
  if (buf.slice(0, 6).toString().startsWith('GIF8')) {
    return {
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
      format: 'gif',
    }
  }

  return undefined
}
