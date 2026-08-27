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
  let resized: (() => void) | undefined
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
    onResize: (next: () => void) => { resized = next; return () => { resized = undefined } },
    resize() { resized?.() },
    clearScreen: () => {},
    /** Viewport scrolling, recorded so the key routing can be asserted. */
    scrolls: [] as (number | 'bottom' | -1 | 1)[],
    scrolledBy: 0,
    /** What the viewport reports the pointer is resting on. */
    hover: undefined as { label: string; lines: number; expanded: boolean } | undefined,
    mouseMove(): { label: string; lines: number; expanded: boolean } | undefined { return this.hover },
    write: (line: string) => void written.push(line),
    setRegion: (rows: readonly string[], cursor: RegionCursor) => void draws.push({ rows: [...rows], cursor }),
    clearRegion: () => void draws.push({ rows: [], cursor: { row: 0, column: 0 } }),
    scrollBy(delta: number) { this.scrolls.push(delta) },
    scrollPage(direction: -1 | 1) { this.scrolls.push(direction) },
    scrollToBottom() { this.scrolls.push('bottom') },
    transcriptSearch: undefined as { query: string; hits: number; index: number } | undefined,
    searchTranscript(query: string) {
      this.transcriptSearch = { query, hits: query === '' ? 0 : 1, index: 0 }
      return this.transcriptSearch
    },
    nextTranscriptHit(direction: 1 | -1) {
      if (this.transcriptSearch === undefined) return undefined
      this.transcriptSearch = { ...this.transcriptSearch, index: this.transcriptSearch.index + direction }
      return this.transcriptSearch
    },
    clearTranscriptSearch() { this.transcriptSearch = undefined },
    setScrollNotice() {},
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
function build(readsKeys = true, clipboard?: () => Promise<{ data: Buffer; mediaType: 'image/png'; width?: number; height?: number } | undefined>) {
  const console = fakeConsole(readsKeys)
  const calls: string[] = []
  const prompt = new Prompt(console as never, theme, sources, {
    interrupt: () => void calls.push('interrupt'),
    escape: () => void calls.push('escape'),
    eof: () => void calls.push('eof'),
    ...clipboard === undefined ? {} : { readClipboardImage: clipboard },
  })
  return { prompt, console, calls }
}

/** Wait out the async hop a clipboard read takes. */
const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** A fixture clipboard holding one tiny PNG. */
const pngClipboard = () => Promise.resolve({
  data: Buffer.from('fake-png-bytes'),
  mediaType: 'image/png' as const,
  width: 12,
  height: 8,
})

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

  it('shows the completion menu above the box', () => {
    const { prompt, console } = build()
    void prompt.read()
    console.press({ kind: 'text', text: '/p' })
    const rows = console.draws.at(-1)?.rows ?? []
    const plan = rows.findIndex(row => row.includes('/plan'))
    const frame = rows.findIndex(row => row.includes('╭'))
    expect(plan).toBeGreaterThanOrEqual(0)
    expect(plan).toBeLessThan(frame)
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
  it('dequeues the tail back into the box on Escape', () => {
    const { prompt, console, calls } = build()
    console.press({ kind: 'text', text: 'later work' })
    console.press({ kind: 'enter' })
    console.press({ kind: 'escape' })
    expect(calls).not.toContain('escape')
    expect((console.draws.at(-1)?.rows ?? []).some(row => row.includes('queued:'))).toBe(false)
    void prompt.read()
    expect((console.draws.at(-1)?.rows ?? []).join('\n')).toContain('later work')
  })

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

  it('re-fits the status row when the terminal changes width', () => {
    const { prompt, console } = build()
    const long = 'model · code-cli · workspace-write · 12k tokens · ~/very/long/workspace/path (main)'
    prompt.setStatus(long)
    void prompt.read()
    console.columns = 24
    console.resize()
    const narrow = console.draws.at(-1)?.rows.at(-1) ?? ''
    expect(narrow.endsWith('…')).toBe(true)
    expect(narrow.length).toBeLessThan(long.length)
    console.columns = 120
    console.resize()
    expect(console.draws.at(-1)?.rows.at(-1)).toBe(long)
  })

  it('pins the todo readout over the hint and status rows', () => {
    const { prompt, console } = build()
    prompt.setStatus('model · 12k tokens')
    prompt.setHint('working')
    prompt.setTodos([
      { content: 'read the code', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
    ])
    const rows = console.draws.at(-1)?.rows ?? []
    // The list is context for the work in flight, so it sits above the rows
    // that describe right now — and it survives the card scrolling away.
    expect(rows.at(-3)).toContain('▶ write the fix')
    expect(rows.at(-2)).toBe('working')
    expect(rows.at(-1)).toBe('model · 12k tokens')
  })

  it('pastes an image as a token, and hands it over with the submission', async () => {
    const { prompt, console } = build(true, pngClipboard)
    const reading = prompt.read()
    console.press({ kind: 'paste-image' })
    await settled()
    // The token in the box, and the flash saying what attached.
    expect(console.draws.at(-1)?.rows.join('\n')).toContain('[Image #1]')
    expect(console.draws.at(-1)?.rows.join('\n')).toContain('✓ image #1 attached (12×8 png)')
    console.press({ kind: 'text', text: ' what is this?' })
    console.press({ kind: 'enter' })
    expect(await reading).toBe('[Image #1] what is this?')
    const images = prompt.takeAttachments()
    expect(images).toHaveLength(1)
    expect(images[0]?.id).toBe(1)
    expect(images[0]?.image.mediaType).toBe('image/png')
    expect(images[0]?.image.data).toBe(Buffer.from('fake-png-bytes').toString('base64'))
    // Drained exactly once.
    expect(prompt.takeAttachments()).toHaveLength(0)
  })

  it('drops the image whose token was deleted before submitting', async () => {
    const { prompt, console } = build(true, pngClipboard)
    const reading = prompt.read()
    console.press({ kind: 'paste-image' })
    await settled()
    // Backspace eats the whole token; its image must not ride along unseen.
    console.press({ kind: 'backspace' })
    console.press({ kind: 'text', text: 'plain after all' })
    console.press({ kind: 'enter' })
    expect(await reading).toBe('plain after all')
    expect(prompt.takeAttachments()).toHaveLength(0)
  })

  it('keeps a queued line paired with its own images', async () => {
    const { prompt, console } = build(true, pngClipboard)
    // Nothing is reading yet: paste, submit, then paste again for the next line.
    console.press({ kind: 'paste-image' })
    await settled()
    console.press({ kind: 'enter' })
    console.press({ kind: 'text', text: 'no image here' })
    console.press({ kind: 'enter' })
    expect(await prompt.read()).toBe('[Image #1]')
    expect(prompt.takeAttachments()).toHaveLength(1)
    expect(await prompt.read()).toBe('no image here')
    // The second line pasted nothing; a later paste must not bleed backwards.
    expect(prompt.takeAttachments()).toHaveLength(0)
  })

  it('flashes when the clipboard holds no image', async () => {
    const { prompt, console } = build(true, () => Promise.resolve(undefined))
    prompt.read()
    console.press({ kind: 'paste-image' })
    await settled()
    expect(console.draws.at(-1)?.rows.join('\n')).toContain('no image in the clipboard')
    expect(prompt.takeAttachments()).toHaveLength(0)
  })

  it('names the block under the pointer, and gives the hint row back after', () => {
    const { prompt, console } = build()
    prompt.setHint('working')
    console.hover = { label: 'Bash(pnpm test)', lines: 120, expanded: false }
    console.press({ kind: 'mouse-move', row: 3, column: 5 })
    // The readout outranks the working indicator: it answers where the pointer
    // is right now, and it lasts exactly as long as the pointer rests there.
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('  Bash(pnpm test) · 120 lines · click to expand')

    // An open block says the click would shut it, not open it again.
    console.hover = { label: 'thinking', lines: 42, expanded: true }
    console.press({ kind: 'mouse-move', row: 4, column: 5 })
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('  thinking · 42 lines · click to fold')

    // Off every block, the indicator has its row back.
    console.hover = undefined
    console.press({ kind: 'mouse-move', row: 9, column: 5 })
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('working')
  })

  it('does not grow the chrome when the hover readout appears', () => {
    const { prompt, console } = build()
    prompt.setStatus('model · 12k tokens')
    void prompt.read()
    const idle = console.draws.at(-1)?.rows.length ?? 0
    console.hover = { label: 'thinking', lines: 8, expanded: false }
    console.press({ kind: 'mouse-move', row: 3, column: 5 })
    const hovering = console.draws.at(-1)?.rows ?? []
    expect(hovering.length).toBe(idle)
    expect(hovering.at(-1)).toBe('  thinking · 8 lines · click to expand')
    console.hover = undefined
    console.press({ kind: 'mouse-move', row: 9, column: 5 })
    expect(console.draws.at(-1)?.rows.length).toBe(idle)
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('model · 12k tokens')
  })

  it('repaints nothing while the pointer stays on one block', () => {
    const { prompt, console } = build()
    prompt.setHint('working')
    console.hover = { label: 'thinking', lines: 42, expanded: false }
    console.press({ kind: 'mouse-move', row: 3, column: 5 })
    const drawn = console.draws.length
    // Motion arrives a report per cell crossed; a frame per report would be a
    // repaint for every pixel of pointer travel.
    console.press({ kind: 'mouse-move', row: 3, column: 6 })
    console.press({ kind: 'mouse-move', row: 3, column: 7 })
    expect(console.draws.length).toBe(drawn)
  })

  it('opens the whole list on Ctrl-T and closes it again', () => {
    const { prompt, console } = build()
    prompt.setTodos([
      { content: 'read the code', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
    ])
    console.press({ kind: 'toggle-todos' })
    const opened = console.draws.at(-1)?.rows ?? []
    expect(opened.some(row => row.includes('read the code'))).toBe(true)
    expect(opened.some(row => row.includes('Ctrl+T closes'))).toBe(true)
    console.press({ kind: 'toggle-todos' })
    const closed = console.draws.at(-1)?.rows ?? []
    expect(closed.some(row => row.includes('read the code'))).toBe(false)
    expect(closed.some(row => row.includes('▶ write the fix'))).toBe(true)
  })

  it('shows no readout before the first todo write', () => {
    const { prompt, console } = build()
    prompt.setStatus('model')
    prompt.setTodos([])
    expect((console.draws.at(-1)?.rows ?? []).some(row => row.includes('todos'))).toBe(false)
  })

  it('redraws only when the list actually changed', () => {
    const { prompt, console } = build()
    prompt.setTodos([{ content: 'write the fix', status: 'in_progress' }])
    const drawn = console.draws.length
    // Pushed on every session event: repainting an unchanged list would flicker
    // the chrome for the length of a turn.
    prompt.setTodos([{ content: 'write the fix', status: 'in_progress' }])
    expect(console.draws.length).toBe(drawn)
    prompt.setTodos([{ content: 'write the fix', status: 'completed' }])
    expect(console.draws.length).toBeGreaterThan(drawn)
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

  it('switches the box to shell mode as ! is typed', () => {
    const { prompt, console } = build()
    void prompt.read()
    console.press({ kind: 'text', text: '!' })
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('! command'))).toBe(true)
    console.press({ kind: 'text', text: 'l' })
    const typed = console.draws.at(-1)?.rows ?? []
    expect(typed.some(row => row.includes('! command'))).toBe(false)
    expect(typed.some(row => row.includes('! l') || row.includes('l'))).toBe(true)
  })

  it('opens the shortcuts overlay on ? and closes it on Escape', () => {
    const { prompt, console } = build()
    void prompt.read()
    console.press({ kind: 'text', text: '?' })
    const opened = console.draws.at(-1)?.rows ?? []
    expect(opened.some(row => row.includes('Ctrl+R history'))).toBe(true)
    console.press({ kind: 'escape' })
    const closed = console.draws.at(-1)?.rows ?? []
    expect(closed.some(row => row.includes('Ctrl+R history'))).toBe(false)
  })

  it('does not steal ? once the box has text', () => {
    const { prompt, console } = build()
    void prompt.read()
    console.press({ kind: 'text', text: 'a' })
    console.press({ kind: 'text', text: '?' })
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('Ctrl+R history'))).toBe(false)
    expect(rows.join('\n')).toContain('a?')
  })

  it('opens transcript find on Ctrl-F and gives the row back on Escape', () => {
    const { prompt, console } = build()
    void prompt.read()
    console.press({ kind: 'transcript-search' })
    expect((console.draws.at(-1)?.rows ?? []).some(row => row.includes('find:'))).toBe(true)
    console.press({ kind: 'text', text: 'alpha' })
    expect(console.transcriptSearch?.query).toBe('alpha')
    console.press({ kind: 'escape' })
    expect(console.transcriptSearch).toBeUndefined()
    expect((console.draws.at(-1)?.rows ?? []).some(row => row.includes('find:'))).toBe(false)
  })

  it('does not type the find query into the box', () => {
    const { prompt, console } = build()
    void prompt.read()
    console.press({ kind: 'transcript-search' })
    console.press({ kind: 'text', text: 'needle' })
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('› needle'))).toBe(false)
    expect(rows.some(row => row.includes('find: needle'))).toBe(true)
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
