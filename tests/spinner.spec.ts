/**
 * The working indicator occupies the console's single live line, names the key
 * that stops it, and does nothing at all where there is no cursor to rewrite.
 */

import { describe, expect, it } from 'vitest'
import { Spinner, spinnerText } from '../src/spinner.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})
const label = { verb: 'working', interrupt: 'ESC' }

/** Records what the surface was asked to display. */
function surface(isTty: boolean) {
  const shown: (string | undefined)[] = []
  return { isTty, setLive: (text: string | undefined) => void shown.push(text), shown }
}

describe('spinnerText', () => {
  it('names the elapsed time and the interrupt key', () => {
    expect(spinnerText(0, 1500, label, theme)).toBe('⠋ working 1.5s · ESC to interrupt')
  })

  it('drops the decimal once the wait is long enough for it to be noise', () => {
    expect(spinnerText(0, 62_000, label, theme)).toContain('62s')
  })

  it('cycles frames without running off the end', () => {
    const first = spinnerText(0, 0, label, theme)
    const wrapped = spinnerText(10, 0, label, theme)
    expect(wrapped).toBe(first)
  })
})

describe('Spinner', () => {
  it('paints immediately, then clears on stop', () => {
    const view = surface(true)
    let now = 0
    const spinner = new Spinner(view, theme, label, () => now)
    spinner.start()
    expect(spinner.running).toBe(true)
    expect(view.shown[0]).toContain('working')
    now = 2000
    spinner.stop()
    expect(spinner.running).toBe(false)
    expect(view.shown.at(-1)).toBeUndefined()
  })

  it('does nothing off a terminal, where a rewritten line becomes noise', () => {
    const view = surface(false)
    const spinner = new Spinner(view, theme, label, () => 0)
    spinner.start()
    expect(spinner.running).toBe(false)
    expect(view.shown).toEqual([])
  })

  it('ignores a second start and a stop that was never started', () => {
    const view = surface(true)
    const spinner = new Spinner(view, theme, label, () => 0)
    spinner.start()
    spinner.start()
    expect(view.shown).toHaveLength(1)
    spinner.stop()
    spinner.stop()
    expect(view.shown).toHaveLength(2)
  })
})

describe('Spinner and the live region', () => {
  it('releases the region on stop, so what follows is not shadowed', () => {
    // An interrupt writes its report right after stopping; a spinner that had
    // kept the region would redraw itself beneath that report.
    const view = surface(true)
    const spinner = new Spinner(view, theme, label, () => 0)
    spinner.start()
    spinner.stop()
    expect(view.shown.at(-1)).toBeUndefined()
    expect(spinner.running).toBe(false)
  })
})
