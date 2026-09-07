/**
 * Resizing an image without loading a native decoder into this process.
 *
 * sharp is the only thing here that can resample a photograph properly, and it
 * is also a native module: loading it pulls libvips into the process, and the
 * moment a second copy of libvips is reachable — a checkout and an installed
 * profile resolving their own, which is the normal development shape — the
 * macOS Objective-C runtime prints a duplicate-class warning straight to file
 * descriptor 2. There is no JavaScript hook on that write. It lands on the
 * terminal, over a frame this surface believes it owns, and the frame diff has
 * no idea the screen changed under it.
 *
 * So the decode happens in a child process whose stderr goes nowhere: the
 * warning is written where no one is looking, and the surface stays the only
 * writer of its own screen. The cost is one process launch per preview, paid
 * off the render path.
 * @module codsh-bundle/src/image-resize
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Decoded pixels, three bytes per pixel, row after row. */
export interface RawImage {
  /** RGB bytes, `width * height * 3` of them. */
  data: Buffer
  /** Pixel width after the resize. */
  width: number
  /** Pixel height after the resize. */
  height: number
}

/** How long the child gets before the preview is given up on. */
const RESIZE_TIMEOUT_MS = 10_000

/**
 * Where this installation's sharp lives, without loading it.
 *
 * Resolution is not execution: the path is looked up from this module so the
 * child imports the same copy the bundle depends on, wherever the bundle was
 * installed, and nothing native enters this process to find it.
 * @returns a file URL for the child to import, or undefined when sharp is absent.
 */
function sharpUrl(): string | undefined {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('sharp')).href
  } catch {
    return undefined
  }
}

/**
 * Scale an image to fit a pixel box, returning raw RGB.
 *
 * `fit: 'inside'` is what makes the result uncropped: the image is scaled until
 * it fits inside the box, so the preview shows the whole picture rather than a
 * centre cut of it, and one of the two dimensions comes back smaller than asked.
 * @param buffer - the encoded image.
 * @param maxWidth - widest the result may be, in pixels.
 * @param maxHeight - tallest the result may be, in pixels.
 * @returns the decoded pixels, or undefined when nothing could decode them.
 */
export function resizeToRaw(
  buffer: Buffer,
  maxWidth: number,
  maxHeight: number,
): Promise<RawImage | undefined> {
  const url = sharpUrl()
  if (url === undefined) return Promise.resolve(undefined)
  const width = Math.max(1, Math.floor(maxWidth))
  const height = Math.max(1, Math.floor(maxHeight))
  // The dimensions are integers computed here, never text from elsewhere, and
  // the module path is a resolver's answer — so the script is a literal.
  const script = [
    `const { default: sharp } = await import(${JSON.stringify(url)})`,
    'const chunks = []',
    'for await (const chunk of process.stdin) chunks.push(chunk)',
    'const { data, info } = await sharp(Buffer.concat(chunks))',
    `  .resize(${width}, ${height}, { fit: 'inside', kernel: 'lanczos3' })`,
    '  .sharpen()',
    '  .removeAlpha()',
    '  .raw()',
    '  .toBuffer({ resolveWithObject: true })',
    'process.stdout.write(`${info.width} ${info.height}\\n`)',
    'process.stdout.write(data)',
  ].join('\n')

  return new Promise<RawImage | undefined>((resolve) => {
    let child
    try {
      child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        // Nothing is read from this process's stdin and nothing may reach its
        // stderr: the first would steal keys from the surface, the second is
        // the whole reason the work is out here.
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      resolve(undefined)
      return
    }
    const out: Buffer[] = []
    let settled = false
    /** Answer once, and never leave the child running behind the answer. */
    const finish = (image: RawImage | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.exitCode === null) child.kill('SIGKILL')
      resolve(image)
    }
    const timer = setTimeout(() => { finish(undefined) }, RESIZE_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', () => { finish(undefined) })
    child.stdout?.on('data', (chunk: Buffer) => void out.push(chunk))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(undefined)
        return
      }
      finish(decode(Buffer.concat(out)))
    })
    child.stdin?.on('error', () => { finish(undefined) })
    child.stdin?.end(buffer)
  })
}

/**
 * Read the child's answer: a `width height` line, then the pixels.
 *
 * A short or unparsable buffer is a failed decode rather than a partial
 * picture — half a row of pixels drawn as colour is worse than no preview.
 * @param out - everything the child wrote.
 * @returns the image, or undefined when the bytes do not describe one.
 */
function decode(out: Buffer): RawImage | undefined {
  const newline = out.indexOf(0x0a)
  if (newline < 0) return undefined
  const [width, height] = out.subarray(0, newline).toString('latin1').split(' ').map(Number)
  if (width === undefined || height === undefined) return undefined
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return undefined
  const data = out.subarray(newline + 1)
  if (data.length < width * height * 3) return undefined
  return { data, width, height }
}
