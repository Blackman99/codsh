/**
 * The prompt joins the two input shapes: an editor driven by keys on a terminal,
 * a line reader off one. It also owns what the bottom region is made of.
 */

import { describe, expect, it, vi } from 'vitest'
import { Prompt } from '../src/prompt.ts'
import { createTheme } from '../src/theme.ts'
import type { RegionCursor } from '../src/console.ts'
import type { Key } from '../src/keys.ts'

const theme = createTheme(false, {})

/** One recorded region draw. */
interface Drawn {
  rows: string[]
  cursor: RegionCursor
}

/** A console stand-in that records regions and replays keys. */
function fakeConsole(readsKeys: boolean) {
  let handler: ((key: Key) => void) | undefined
  const draws: Drawn[] = []
  const written: string[] = []
  const lines: string[] = []
  return {
    readsKeys,
    finished: false,
    columns: 60,
    draws,
    written,
    /** Queue a line for the piped read path. */
    queue: (line: string) => void lines.push(line),
    press: (key: Key) => { handler?.(key) },
    onKey: (next: (key: Key) => void) => { handler = next; return () => { handler = undefined } },
    onResize: () => () => {},
    clearScreen: () => {},
    write: (line: string) => void written.push(line),
    setRegion: (rows: readonly string[], cursor: RegionCursor) => void draws.push({ rows: [...rows], cursor }),
    clearRegion: () => void draws.push({ rows: [], cursor: { row: 0, column: 0 } }),
    readLine: () => Promise.resolve(lines.shift()),
  }
}

const sources = {
  commands: () => [{ name: 'plan', description: 'plan mode' }],
  paths: (token: string) => [[], token] as [string[], string],
}

/**
 * Build a prompt over a fake console.
 * @param readsKeys - whether the console owns the keyboard.
 * @returns the prompt, its console, and the handler calls it made.
 */
function build(readsKeys = true) {
  const console = fakeConsole(readsKeys)
  const calls: string[] = []
  const prompt = new Prompt(console as never, theme, sources, {
    interrupt: () => void calls.push('interrupt'),
    escape: () => void calls.push('escape'),
    eof: () => void calls.push('eof'),
  })
  return { prompt, console, calls }
}

describe('reading on a terminal', () => {
  it('resolves with the submitted text', async () => {
    const { prompt, console } = build()
    const reading = prompt.read()
    console.press({ kind: 'text', text: 'do it' })
    console.press({ kind: 'enter' })
    expect(await reading).toBe('do it')
  })

  it('keeps a submission made before anything asked for it', async () => {
    const { prompt, console } = build()
    // Typed while the agent worked: the line reader used to queue this for free,
    // and losing it would lose the keystrokes.
    console.press({ kind: 'text', text: 'early' })
    console.press({ kind: 'enter' })
    expect(await prompt.read()).toBe('early')
  })

  it('serves queued submissions in order', async () => {
    const { prompt, console } = build()
    for (const text of ['one', 'two']) {
      console.press({ kind: 'text', text })
      console.press({ kind: 'enter' })
    }
    expect(await prompt.read()).toBe('one')
    expect(await prompt.read()).toBe('two')
  })

  it('abandons a read when its signal aborts', async () => {
    const { prompt } = build()
    const controller = new AbortController()
    const reading = prompt.read(controller.signal)
    controller.abort()
    expect(await reading).toBeUndefined()
  })

  it('reports control keys to its owner', () => {
    const { prompt, console, calls } = build()
    void prompt.read()
    console.press({ kind: 'interrupt' })
    console.press({ kind: 'escape' })
    expect(calls).toEqual(['interrupt', 'escape'])
  })

  it('answers an outstanding read with nothing on end-of-file', async () => {
    const { prompt, console, calls } = build()
    const reading = prompt.read()
    console.press({ kind: 'eof' })
    expect(await reading).toBeUndefined()
    expect(calls).toEqual(['eof'])
  })
})

describe('reading off a terminal', () => {
  it('delegates to the line reader', async () => {
    const { prompt, console } = build(false)
    console.queue('from a pipe')
    expect(await prompt.read()).toBe('from a pipe')
  })

  it('draws nothing at all', () => {
    const { prompt, console } = build(false)
    prompt.setHint('working')
    prompt.setStreaming('partial')
    void prompt.read()
    expect(console.draws).toEqual([])
  })
})

describe('the region it composes', () => {
  it('shows the box with the cursor inside it while reading', () => {
    const { prompt, console } = build()
    void prompt.read()
    const last = console.draws.at(-1)
    expect(last?.rows[0]?.startsWith('╭')).toBe(true)
    // Row 0 is the frame's top, so the cursor belongs on the row below it.
    expect(last?.cursor.row).toBe(1)
  })

  it('puts the streaming line above the box and shifts the cursor down', () => {
    const { prompt, console } = build()
    void prompt.read()
    prompt.setStreaming('half a sentence')
    const last = console.draws.at(-1)
    expect(last?.rows[0]).toBe('half a sentence')
    expect(last?.cursor.row).toBe(2)
  })

  it('shows only the indicator when nothing is being asked for', () => {
    const { prompt, console } = build()
    prompt.setHint('working 1.0s')
    const last = console.draws.at(-1)
    // No box: a box nobody can type into is furniture.
    expect(last?.rows).toEqual(['working 1.0s'])
  })

  it('redraws as the buffer changes', () => {
    const { prompt, console } = build()
    void prompt.read()
    const before = console.draws.length
    console.press({ kind: 'text', text: 'x' })
    expect(console.draws.length).toBeGreaterThan(before)
    expect(console.draws.at(-1)?.rows.some(row => row.includes('› x'))).toBe(true)
  })

  it('shows the completion menu under the box', () => {
    const { prompt, console } = build()
    void prompt.read()
    console.press({ kind: 'text', text: '/p' })
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('/plan'))).toBe(true)
    expect(rows.some(row => row.includes('plan mode'))).toBe(true)
  })

  it('takes the region down when cleared', () => {
    const { prompt, console } = build()
    void prompt.read()
    prompt.clear()
    expect(console.draws.at(-1)?.rows).toEqual([])
  })

  it('writes transcript lines through the console', () => {
    const { prompt, console } = build()
    prompt.write('a kept line')
    expect(console.written).toEqual(['a kept line'])
  })
})

describe('selection', () => {
  it('routes keys to the selector and resolves the choice', async () => {
    const { prompt, console } = build()
    const deciding = prompt.select({ title: 'Allow?', options: [{ label: 'Yes' }, { label: 'No' }] })
    // The widget replaced the box in the region.
    expect(console.draws.at(-1)?.rows[0]).toBe('Allow?')
    console.press({ kind: 'down' })
    console.press({ kind: 'enter' })
    expect(await deciding).toEqual({ kind: 'chosen', indices: [1] })
  })

  it('cancels the selection when its signal aborts', async () => {
    const { prompt } = build()
    const controller = new AbortController()
    const deciding = prompt.select({ title: 'Allow?', options: [{ label: 'Yes' }] }, controller.signal)
    controller.abort()
    expect(await deciding).toEqual({ kind: 'cancelled' })
  })

  it('keeps Ctrl-C above the selection, because stopping must always land', async () => {
    const { prompt, console, calls } = build()
    const deciding = prompt.select({ title: 'Allow?', options: [{ label: 'Yes' }] })
    console.press({ kind: 'interrupt' })
    expect(calls).toEqual(['interrupt'])
    console.press({ kind: 'escape' })
    expect(await deciding).toEqual({ kind: 'cancelled' })
  })
})

describe('the surrounding rows', () => {
  it('previews queued submissions so type-ahead is visibly held, not lost', () => {
    const { prompt, console } = build()
    console.press({ kind: 'text', text: 'later work' })
    console.press({ kind: 'enter' })
    prompt.setHint('working')
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('queued: later work'))).toBe(true)
  })

  it('keeps the status row last, under everything else', () => {
    const { prompt, console } = build()
    prompt.setStatus('model · 12k tokens')
    prompt.setHint('working')
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.at(-1)).toBe('model · 12k tokens')
    expect(rows.at(-2)).toBe('working')
  })

  it('redraws only when the status actually changed', () => {
    const { prompt, console } = build()
    prompt.setStatus('same')
    const drawn = console.draws.length
    prompt.setStatus('same')
    expect(console.draws.length).toBe(drawn)
  })

  it('reports Shift-Tab to its owner as a mode change', () => {
    const console = fakeConsole(true)
    const modes: string[] = []
    void new Prompt(console as never, theme, sources, {
      interrupt: () => {},
      escape: () => {},
      eof: () => {},
      shiftTab: () => void modes.push('cycled'),
    })
    console.press({ kind: 'shift-tab' })
    expect(modes).toEqual(['cycled'])
  })

  it('accents the box frame when a mode asks it to', () => {
    const { prompt, console } = build()
    prompt.setAccent(text => `<${text}>`)
    void prompt.read()
    const rows = console.draws.at(-1)?.rows ?? []
    // The frame carries the mode so the next submission's rules are visible
    // from the box itself.
    expect(rows.some(row => row.startsWith('<╭'))).toBe(true)
    prompt.setAccent(undefined)
    const plain = console.draws.at(-1)?.rows ?? []
    expect(plain.some(row => row.startsWith('<╭'))).toBe(false)
  })

  it('shows the placeholder inside an empty box', () => {
    const console = fakeConsole(true)
    const prompt = new Prompt(console as never, theme, sources,
      { interrupt: () => {}, escape: () => {}, eof: () => {} }, 'Ask anything')
    void prompt.read()
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('Ask anything'))).toBe(true)
  })
})

describe('sources', () => {
  it('reads the command list on each keystroke, because scope changes it', () => {
    const commands = vi.fn(() => [{ name: 'plan', description: 'plan mode' }])
    const console = fakeConsole(true)
    const prompt = new Prompt(console as never, theme, {
      commands,
      paths: (token: string) => [[], token],
    }, { interrupt: () => {}, escape: () => {}, eof: () => {} })
    void prompt.read()
    console.press({ kind: 'text', text: '/' })
    console.press({ kind: 'text', text: 'p' })
    expect(commands.mock.calls.length).toBeGreaterThan(1)
  })
})
