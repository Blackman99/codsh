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
import { drivePty, drivePtySteps, finalScreen, heldOutput, screenOf } from './pty-driver.ts'

/** Submit what the box holds. */
const ENTER = '\r'

/** The preview card's title, and the anchor for the frame that drew it. */
const CARD_TITLE = 'Image #1'

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
    expect(rows.some(row => row.includes('›   [Image #1]'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('lets Vision Exp describe an image before DeepSeek Pro continues the turn', async () => {
    const output = await drivePty('auto-vision', [
      ['Welcome to codsh', `/model deepseek-official/deepseek-v4-pro${ENTER}`, 400],
      ['model deepseek-official/deepseek-v4-pro', CTRL_V, 400],
      ['image #1 attached', `what is this?${ENTER}`, 400],
      ['CODE_CLI_AUTO_VISION', `/status${ENTER}`, 500],
      ['model        deepseek-v4-pro', `/exit${ENTER}`, 500],
    ], { env: { CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard() } })
    const rows = finalScreen(output).alternate
    const text = rows.join(' ')
    expect(text).toContain('CODE_CLI_AUTO_VISION model=deepseek-v4-pro described=yes')
    expect(text).toContain('model        deepseek-v4-pro')
    expect(rows.some(row => row.includes('[image #1 · 1×1 png · described]'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('cancels the pending turn when the user interrupts Vision Exp', async () => {
    const output = await drivePty('auto-vision-slow', [
      ['Welcome to codsh', `/model deepseek-official/deepseek-v4-pro${ENTER}`, 400],
      ['model deepseek-official/deepseek-v4-pro', CTRL_V, 400],
      ['image #1 attached', `what is this?${ENTER}`, 400],
      ['describing image #1 with deepseek-v4-flash-vision-exp', '\u001B', 400],
      ['', `/exit${ENTER}`, 2_500],
    ], { env: { CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard() } })
    const text = finalScreen(output).alternate.join(' ')
    expect(text).toContain('interrupted')
    expect(text).not.toContain('CODE_CLI_AUTO_VISION')
  }, E2E_TEST_TIMEOUT_MS)

  it('continues DeepSeek Pro with the saved file when Vision Exp fails', async () => {
    const output = await drivePty('auto-vision-fail', [
      ['Welcome to codsh', `/model deepseek-official/deepseek-v4-pro${ENTER}`, 400],
      ['model deepseek-official/deepseek-v4-pro', CTRL_V, 400],
      ['image #1 attached', `what is this?${ENTER}`, 400],
      ['CODE_CLI_AUTO_VISION', `/exit${ENTER}`, 500],
    ], { env: { CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard() } })
    const rows = finalScreen(output).alternate
    const text = rows.join(' ')
    expect(text).toContain('CODE_CLI_AUTO_VISION model=deepseek-v4-pro described=no bridge=none file=yes')
    expect(rows.some(row => row.includes('[image #1 · 1×1 png · saved to file]'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)

  it('keeps an explicitly configured sidecar ahead of automatic Vision Exp', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        choices: [{ message: { content: 'E2E_SIDECAR_DESCRIPTION: a blue square' } }],
      }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const output = await drivePty('auto-vision', [
        ['Welcome to codsh', `/model deepseek-official/deepseek-v4-pro${ENTER}`, 400],
        ['model deepseek-official/deepseek-v4-pro', CTRL_V, 400],
        ['image #1 attached', `${ENTER}`, 400],
        ['CODE_CLI_AUTO_VISION', `/exit${ENTER}`, 500],
      ], {
        env: {
          CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard(),
          CODSH_VISION_BASE_URL: `http://127.0.0.1:${port}`,
          CODSH_VISION_MODEL: 'e2e-eyes',
        },
      })
      expect(finalScreen(output).alternate.join(' '))
        .toContain('CODE_CLI_AUTO_VISION model=deepseek-v4-pro described=yes bridge=sidecar file=yes')
    } finally {
      await new Promise<void>(resolve => void server.close(() => { resolve() }))
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('describes multiple pasted images independently and preserves their order for Pro', async () => {
    const output = await drivePty('auto-vision', [
      ['Welcome to codsh', `/model deepseek-official/deepseek-v4-pro${ENTER}`, 400],
      ['model deepseek-official/deepseek-v4-pro', CTRL_V, 400],
      ['image #1 attached', CTRL_V, 400],
      ['image #2 attached', `${ENTER}`, 400],
      ['CODE_CLI_AUTO_VISION', `/exit${ENTER}`, 500],
    ], { env: { CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard() } })
    const rows = finalScreen(output).alternate
    expect(rows.join(' ')).toContain('model=deepseek-v4-pro described=yes bridge=auto file=yes order=1,2')
    expect(rows.filter(row => row.includes('· 1×1 png · described]'))).toHaveLength(2)
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

describe.skipIf(process.platform === 'win32')('previewing a pasted image (real PTY)', () => {
  it('hands a kitty-graphics terminal the image, and no row carries its bytes', async () => {
    // The card is up as soon as the paste lands: the token goes in at the
    // cursor, and the cursor is left resting against it.
    // One backspace takes the token back out — dropping the image and closing
    // the card — so the line is a command by the time `/exit` is typed.
    const driven = await drivePtySteps('echo', [
      ['Welcome to codsh', CTRL_V, 800],
      ['image #1 attached', `\u007F/exit${ENTER}`, 800],
    ], {
      env: {
        CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard(),
        TERM_PROGRAM: 'ghostty',
      },
    })
    const held = heldOutput(driven.output)
    // One complete transmission: the keys Ghostty implements, the payload, and
    // the string terminator. A payload cut short of that terminator is what
    // leaves a terminal eating the rest of the frame as string data.
    const transmit = /\u001B_Ga=T,f=100,t=d,i=\d+,c=\d+,r=\d+,C=1,q=2;[A-Za-z0-9+/=]+\u001B\\/u
    expect(transmit.test(held)).toBe(true)
    // Positioned by the frame, at a cell inside the card rather than wherever
    // the last row write happened to leave the cursor.
    expect(/\u001B\[\d+;\d+H\u001B_Ga=T/u.test(held)).toBe(true)
    // Taking the token back out closes the card, and a kitty placement has to
    // be deleted by id or it stays on screen over whatever comes next.
    expect(/\u001B_Ga=d,d=I,i=\d+,q=2\u001B\\/u.test(held)).toBe(true)
    // The frame that drew the card, not the last one: the card is up only
    // while the cursor rests against the token, and step 2 takes it away.
    const rows = screenOf(held, held.indexOf(CARD_TITLE)).alternate
    expect(rows.some(row => row.includes('Pasted image #1'))).toBe(true)
    expect(rows.some(row => row.includes('1×1'))).toBe(true)
    // The whole card, caption and bottom border included: sized against the
    // terminal rather than the overlay, the rows that name the image are the
    // ones that fall off the bottom while the picture keeps the space.
    expect(rows.some(row => row.includes('╰'))).toBe(true)
    // The bytes stayed out of the rows, so nothing was measured, cut, or
    // ellipsised on the way to the screen.
    for (const row of rows) {
      expect(row).not.toContain('a=T,f=100')
      expect(row).not.toContain('1337')
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('sends no graphics escape to a terminal that cannot paint one', async () => {
    // The harness pins TERM_PROGRAM to its own name, which speaks neither
    // protocol — the card falls back to text and a mosaic.
    const driven = await drivePtySteps('echo', [
      ['Welcome to codsh', CTRL_V, 800],
      ['image #1 attached', `\u007F/exit${ENTER}`, 800],
    ], { env: { CODSH_CLIPBOARD_IMAGE_CMD: await fixtureClipboard() } })
    const held = heldOutput(driven.output)
    expect(held).not.toContain('\u001B_Ga=T')
    expect(held).not.toContain('1337;File=inline')
    const rows = screenOf(held, held.indexOf(CARD_TITLE)).alternate
    expect(rows.some(row => row.includes('Pasted image #1'))).toBe(true)
    expect(rows.some(row => row.includes('╰'))).toBe(true)
  }, E2E_TEST_TIMEOUT_MS)
})
