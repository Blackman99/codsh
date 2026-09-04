/**
 * Reading an image off the system clipboard.
 *
 * An image never arrives through the terminal: bracketed paste is text by
 * construction, and a screenshot sitting on the clipboard has no byte channel
 * into stdin at all. So — exactly as Claude Code does — Ctrl+V asks the
 * platform for the clipboard's image directly: `osascript` on macOS,
 * `wl-paste`/`xclip` on Linux, PowerShell on Windows. A machine without the
 * helper, or a clipboard holding text, reads as "no image" rather than an
 * error, the same silent tolerance the clipboard WRITE path has.
 * @module codsh-bundle/src/clipboard-image
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment/types'

/** An image read off the clipboard, plus what the flash line wants to say. */
export interface ClipboardImage {
  /** The raw bytes. */
  data: Buffer
  /** The type the bytes actually are, sniffed rather than trusted. */
  mediaType: ImageMediaType
  /** Pixel width, when the header could be read. */
  width?: number
  /** Pixel height, when the header could be read. */
  height?: number
}

/** The most a clipboard image may be; beyond this the read reports none. */
const MAX_CLIPBOARD_IMAGE_BYTES = 64 * 1024 * 1024

/**
 * Run one command, capturing binary stdout.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns stdout as bytes, or undefined on any failure or empty output.
 */
function run(command: string, args: readonly string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], {
      encoding: 'buffer',
      maxBuffer: MAX_CLIPBOARD_IMAGE_BYTES,
      timeout: 10_000,
    }, (error, stdout) => {
      if (error !== null || stdout.length === 0) resolve(undefined)
      else resolve(stdout)
    })
  })
}

/**
 * What image type these bytes are, from their magic numbers.
 *
 * Sniffed rather than taken from the reader's word: the store verifies the
 * declared type against the decoded bytes and refuses a mismatch, so lying
 * here would only defer the failure to a worse moment.
 * @param data - the bytes.
 * @returns the media type, or undefined for anything that is not an image.
 */
export function sniffImageType(data: Buffer): ImageMediaType | undefined {
  if (data.length < 12) return undefined
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'image/jpeg'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}

/** The clipboard's image on macOS: AppleScript writes the PNG to a file. */
async function readDarwin(): Promise<Buffer | undefined> {
  // A file, not stdout: osascript prints binary data as a «data …» hex
  // literal, and the reference (Claude Code) uses this same write-to-file
  // shape for the read. The AppleScript errors when no image is held, which
  // run() reads as "none".
  const dir = await mkdtemp(join(tmpdir(), 'codsh-clip-'))
  const file = join(dir, 'clipboard.png')
  try {
    const script = [
      '-e', 'set png_data to (the clipboard as «class PNGf»)',
      '-e', `set fp to open for access POSIX file "${file}" with write permission`,
      '-e', 'write png_data to fp',
      '-e', 'close access fp',
    ]
    const ran = await new Promise<boolean>((resolve) => {
      execFile('osascript', script, { timeout: 10_000 }, error => void resolve(error === null))
    })
    if (!ran) return undefined
    return await readFile(file).catch(() => undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The clipboard's image on Linux, Wayland first, X11 as the fallback. */
async function readLinux(env: Record<string, string | undefined>): Promise<Buffer | undefined> {
  // Probe the offered types first: asking xclip for image/png when the
  // clipboard holds text hangs or errors depending on the owner, and the
  // probe is how the reference distinguishes "no image" from "no helper".
  if (env.WAYLAND_DISPLAY !== undefined) {
    const types = await run('wl-paste', ['-l'])
    const offered = types?.toString('utf8').match(/image\/(?:png|jpeg|webp|gif)/u)?.[0]
    if (offered === undefined) return undefined
    return run('wl-paste', ['-t', offered])
  }
  const types = await run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])
  const offered = types?.toString('utf8').match(/image\/(?:png|jpeg|webp|gif)/u)?.[0]
  if (offered === undefined) return undefined
  return run('xclip', ['-selection', 'clipboard', '-t', offered, '-o'])
}

/** The clipboard's image on Windows: PowerShell saves it as a PNG file. */
async function readWin32(): Promise<Buffer | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'codsh-clip-'))
  const file = join(dir, 'clipboard.png')
  try {
    const script = `$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${file.replaceAll('\\', '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png) }`
    const ran = await new Promise<boolean>((resolve) => {
      execFile('powershell', ['-NoProfile', '-Command', script], { timeout: 10_000 }, error => void resolve(error === null))
    })
    if (!ran) return undefined
    return await readFile(file).catch(() => undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Pixel dimensions from the image header, best effort.
 *
 * sharp decodes properly, but it is a native module and the flash line does
 * not justify failing a paste over it — an unreadable header simply reports
 * no dimensions.
 * @param data - the image bytes.
 * @returns width and height, or undefined.
 */
async function probeDimensions(data: Buffer): Promise<{ width: number; height: number } | undefined> {
  try {
    const { default: sharp } = await import('sharp')
    const meta = await sharp(data).metadata()
    if (typeof meta.width === 'number' && typeof meta.height === 'number') {
      return { width: meta.width, height: meta.height }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * The image on the system clipboard, or undefined when it holds none.
 *
 * `CODSH_CLIPBOARD_IMAGE_CMD` overrides the platform reader with a shell
 * command whose stdout is the image bytes — the seam the tests use, exactly
 * as `CODSH_CLIPBOARD=osc52` keeps the write path off the real clipboard.
 * @param env - the environment, for the override and the display probes.
 * @returns the image with its sniffed type and dimensions, or undefined.
 */
export async function readClipboardImage(env: Record<string, string | undefined>): Promise<ClipboardImage | undefined> {
  const override = env.CODSH_CLIPBOARD_IMAGE_CMD
  const data = override !== undefined && override !== ''
    ? await run(env.SHELL ?? '/bin/sh', ['-c', override])
    : process.platform === 'darwin' ? await readDarwin()
      : process.platform === 'win32' ? await readWin32()
        : await readLinux(env)
  if (data === undefined) return undefined
  const mediaType = sniffImageType(data)
  if (mediaType === undefined) return undefined
  const size = await probeDimensions(data)
  return { data, mediaType, ...size }
}
