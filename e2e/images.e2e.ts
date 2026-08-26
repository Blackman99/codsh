/**
 * Image paste, end to end against the installed binary.
 *
 * Three exits, three tests. On an image-capable route (the mock's `vision`
 * mode declares image input) the pasted bytes ride the message as first-class
 * blocks through the durable store. On the text-only route (`echo`, declaring
 * `['text']` like DeepSeek Flash and Pro) the image becomes a
 * saved file the model is told about — and, when the vision sidecar is
 * configured, a description stands in for sight. The clipboard is a fixture
 * command (`CODSH_CLIPBOARD_IMAGE_CMD`), so no run touches the real one.
 */

import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS } from './harness.ts'
import { drivePty, finalScreen } from './pty-driver.ts'

/** Submit what the box holds. */
const ENTER = '\r'

/** Ctrl+V, the paste-image binding. */
const CTRL_V = ''

/** A 1×1 PNG: a real image, as small as one gets. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A fixture PNG on disk, and the command that prints it as the clipboard. */
let fixtureDir: string
let clipboardCmd: string

async function fixtureClipboard(): Promise<string> {
  if (clipboardCmd !== undefined && clipboardCmd !== '') return clipboardCmd
  fixtureDir = await mkdtemp(join(tmpdir(), 'codsh-img-'))
  const png = join(fixtureDir, 'clipboard.png')
  await writeFile(png, TINY_PNG)
  clipboardCmd = `cat "${png}"`
  return clipboardCmd
}

afterAll(async () => {
  if (fixtureDir !== undefined) await rm(fixtureDir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('pasting an image (real PTY)', () => {
  it('rides an image-capable route as first-class blocks', async () => {
    const output = await drivePty('vision', [
      ['Welcome to codsh', CTRL_V, 400],
      // The token in the box and the flash naming what attached.
      ['image #1 attached', `${ENTER}`, 400],
      ['CODE_CLI_VISION', `/exit${ENTER}`, 500],
    ], { env: { CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard() } })
    const rows = finalScreen(output).alternate
    // The mock reports the image block the request carried: admitted through
    // the durable store, dimensions verified from the stored bytes.
    expect(rows.some(row => row.includes('CODE_CLI_VISION img=1 1x1:image/png'))).toBe(true)
    // The person's message shows the token and the meta line, not the bytes.
    expect(rows.some(row => row.includes('› [Image #1]'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('falls back to a saved file the model is told about on a text-only route', async () => {
    const output = await drivePty('echo', [
      ['Welcome to codsh', CTRL_V, 400],
      ['image #1 attached', `what is this?${ENTER}`, 400],
      ['CODE_CLI_CTX', `/exit${ENTER}`, 500],
    ], { env: { CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard() } })
    const rows = finalScreen(output).alternate
    // The reply wraps at the window edge, so the report is read across rows.
    const text = rows.join(' ')
    // The mock read the <pasted-image> context block and reports the path the
    // file was saved at; no sidecar is configured, so nothing described it.
    expect(text).toContain('image=/')
    expect(text).toContain('described=no')
    // The mock checked the file itself, inside the app's lifetime — the
    // per-test home is gone before this test could look, and a screen row
    // wraps a long path mid-token, so the path is asserted there, not here.
    expect(text).toContain('file=yes')
    // The transcript says what became of it, in place of pixels.
    expect(rows.some(row => row.includes('[image #1 · 1×1 png · saved to file]'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('describes the image through the vision sidecar when one is configured', async () => {
    // An in-test OpenAI-compatible endpoint: whatever arrives, one description.
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const carried = JSON.stringify(body).includes('data:image/png;base64,') ? 'with-image' : 'without-image'
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          choices: [{ message: { content: `E2E_DESCRIPTION ${carried}: a single red pixel` } }],
        }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const output = await drivePty('echo', [
        ['Welcome to codsh', CTRL_V, 400],
        ['image #1 attached', `${ENTER}`, 400],
        ['CODE_CLI_CTX', `/exit${ENTER}`, 500],
      ], {
        env: {
          CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard(),
          CODSH_VISION_BASE_URL: `http://127.0.0.1:${port}`,
          CODSH_VISION_MODEL: 'e2e-eyes',
        },
      })
      const rows = finalScreen(output).alternate
      const text = rows.join(' ')
      // The sidecar was asked (with the image as a data URL) and its answer
      // rode the same message the person sent.
      expect(text).toContain('image=/')
      expect(text).toContain('described=yes')
      expect(rows.some(row => row.includes('[image #1 · 1×1 png · described]'))).toBe(true)
    } finally {
      await new Promise<void>(resolve => void server.close(() => { resolve() }))
    }
  }, E2E_TEST_TIMEOUT_MS)
})
