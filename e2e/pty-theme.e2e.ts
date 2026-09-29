/**
 * The theme on a real terminal: `/theme` switches the palette — the chrome at
 * once, the conversation above it repainted — keeps the choice across a
 * restart without disturbing the other preferences, and the picker previews a
 * theme and puts the original back on Esc.
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E2E_TEST_TIMEOUT_MS, makeHome } from './harness.ts'
import { drivePtySteps } from './pty-driver.ts'
import { ENTER, ESCAPE } from './pty-helpers.ts'

/** The DeepSeek blue accent on the pinned 256-colour terminal, as the input frame opens. */
const BRAND_FRAME = '\u001B[38;5;63m╭'

/**
 * The bytes of a capture between two step offsets. Offsets count bytes, and
 * the capture is a string of UTF-16 units, so the cut goes through a buffer.
 */
const cut = (output: string, from: number | undefined, to?: number): string =>
  Buffer.from(output).subarray(from ?? 0, to).toString()

/** The prefs file a home keeps, parsed; empty when there is none. */
async function prefsOf(home: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(home, 'code-cli-ui.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

describe.skipIf(process.platform === 'win32')('the theme (real PTY)', () => {
  it('switches to deepseek-light with /theme, repaints the history, and keeps it across a restart', async () => {
    const home = await makeHome()
    try {
      // A preference the theme must not erase.
      await writeFile(join(home, 'code-cli-ui.json'), '{"density":"comfortable"}\n')
      const first = await drivePtySteps('write', [
        ['Welcome to codsh', `note the work${ENTER}`, 500],
        ['Write note.txt', `/theme deepseek-light${ENTER}`, 600],
        ['theme · deepseek-light', `/exit${ENTER}`, 400],
      ], { env: { DSH_HOME: home } })

      const before = cut(first.output, 0, first.offsets[1])
      // Painted dark first: the navy band behind the person's message, and the brand frame.
      expect(before).toContain('\u001B[48;5;17m')
      expect(before).toContain(BRAND_FRAME)
      expect(before).toContain('\u001B]12;#4d6bfe\u0007')
      // The turn may still be painting when the command is typed, so the
      // switch is found by its first light band. From there the history is
      // repainted: no dark band is ever painted again, the secondary gray is
      // the light one, and the frame keeps the brand blue both themes share.
      const sent = cut(first.output, first.offsets[1])
      const switchedAt = sent.indexOf('\u001B[48;5;189m')
      expect(switchedAt).toBeGreaterThan(-1)
      const after = sent.slice(switchedAt)
      expect(after).not.toContain('\u001B[48;5;17m')
      expect(after).toContain('\u001B[38;5;242m')
      expect(after).toContain(BRAND_FRAME)
      expect(after).toContain('note the work')
      expect(await prefsOf(home)).toEqual({ density: 'comfortable', theme: 'deepseek-light' })

      const second = await drivePtySteps('write', [
        ['Welcome to codsh', `/theme terminal${ENTER}`, 600],
        ['theme · terminal', `/exit${ENTER}`, 400],
      ], { env: { DSH_HOME: home } })
      // The saved theme is in force from the first frame, with no background answer to go on.
      const booted = cut(second.output, 0, second.offsets[0])
      expect(booted).toContain('\u001B[38;5;242m')
      expect(booted).not.toContain('\u001B[38;5;245m')
      // The terminal theme frames the box in the terminal's own blue and gives the cursor its colour back.
      const switched = cut(second.output, second.offsets[0])
      expect(switched).toContain('\u001B[34m╭')
      expect(switched).toContain('\u001B]112\u0007')
      expect(await prefsOf(home)).toEqual({ density: 'comfortable', theme: 'terminal' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)

  it('previews a theme in the picker and puts the original back on Esc', async () => {
    const home = await makeHome()
    try {
      const run = await drivePtySteps('write', [
        ['Welcome to codsh', `/theme${ENTER}`, 600],
        // Three rows down is the terminal theme: the marker takes the terminal's own blue.
        ['Theme', `${ESCAPE}[B${ESCAPE}[B${ESCAPE}[B`, 600],
        ['\u001B[34m❯', ESCAPE, 600],
        ['theme · auto → deepseek', `/exit${ENTER}`, 400],
      ], { env: { DSH_HOME: home } })

      const previewed = cut(run.output, run.offsets[1], run.offsets[2])
      expect(previewed).toContain('\u001B[34m❯')
      const reverted = cut(run.output, run.offsets[2])
      expect(reverted).toContain(BRAND_FRAME)
      expect(reverted).not.toContain('\u001B[34m╭')
      // Dismissed, nothing was kept.
      expect((await prefsOf(home)).theme).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, E2E_TEST_TIMEOUT_MS)
})
