/**
 * The prompt joins the two input shapes: an editor driven by keys on a terminal,
 * a line reader off one. It also owns what the bottom region is made of.
 */

import { describe, expect, it, vi } from 'vitest'
import { Prompt } from '../src/prompt.ts'
import { createTheme, displayWidth } from '../src/theme.ts'
import type { RegionCursor } from '../src/console.ts'
import type { Key } from '../src/keys.ts'
import type { QueueItem } from '../src/queue.ts'

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
    rows: 8,
    get contentColumns() { return Math.max(1, this.columns - 1 - 2) },
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
    /**
     * Where a pointer row falls below the transcript; the fake owns no
     * geometry, so a test says so directly when it wants a region row.
     */
    region: undefined as { region: 'chrome' | 'overlay'; index: number } | undefined,
    regionRowAt(): { region: 'chrome' | 'overlay'; index: number } | undefined { return this.region },
    /** What the viewport reports the pointer is resting on. */
    hover: undefined as { label: string; lines: number; expanded: boolean; enter?: boolean } | undefined,
    mouseMove(): { label: string; lines: number; expanded: boolean; enter?: boolean } | undefined { return this.hover },
    mouseLeave() { this.pointer.push('leave') },
    /** What was written to the clipboard, so a copy can be asserted. */
    copied: [] as string[],
    copyText(text: string): boolean { this.copied.push(text); return true },
    /** Viewport pointer calls, recorded so a region press can be shown not to reach them. */
    pointer: [] as string[],
    mouseDown(row: number) { this.pointer.push(`down ${String(row)}`) },
    mouseDrag(row: number) { this.pointer.push(`drag ${String(row)}`) },
    /** What the viewport hands back on release, when a drag selected something. */
    selected: undefined as string | undefined,
    mouseUp(): string | undefined { this.pointer.push('up'); return this.selected },
    write: (line: string) => void written.push(line),
    setRegion: (rows: readonly string[], cursor: RegionCursor) => void draws.push({ rows: [...rows], cursor }),
    /** The reserved top-bar rows this prompt painted. */
    topBars: [] as string[],
    setTopBar(row: string) { this.topBars.push(row) },
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
    overlays: [] as string[][],
    setOverlay(rows: readonly string[]) { this.overlays.push([...rows]) },
    coversOverlay: () => false,
    viewers: [] as (string[] | undefined)[],
    setViewer(rows: readonly string[] | undefined) { this.viewers.push(rows === undefined ? undefined : [...rows]) },
    timelineHidden: [] as boolean[],
    setTimelineHidden(hidden: boolean) { this.timelineHidden.push(hidden) },
    readLine: () => Promise.resolve(lines.shift()),
  }
}

const sources = {
  commands: () => [{ name: 'plan', description: 'plan mode' }, { name: 'permission', description: 'switch the preset' }],
  paths: (token: string) => [[], token] as [string[], string],
}

/**
 * Build a prompt over a fake console.
 * @param readsKeys - whether the console owns the keyboard.
 * @returns the prompt, its console, and the handler calls it made.
 */
function build(
  readsKeys = true,
  clipboard?: () => Promise<{ data: Buffer; mediaType: 'image/png'; width?: number; height?: number } | undefined>,
  steer?: (item: QueueItem) => Promise<'steered' | 'idle'>,
  painting = theme,
) {
  const console = fakeConsole(readsKeys)
  const calls: string[] = []
  const prompt = new Prompt(console as never, painting, sources, {
    interrupt: () => void calls.push('interrupt'),
    escape: () => void calls.push('escape'),
    eof: () => void calls.push('eof'),
    turn: direction => void calls.push(`turn:${direction}`),
    ...clipboard === undefined ? {} : { readClipboardImage: clipboard },
    ...steer === undefined ? {} : { steer },
  })
  return { prompt, console, calls }
}

/** A steer handler that records what it was handed and answers as told. */
function steerFixture(outcome: 'steered' | 'idle' = 'steered') {
  const items: QueueItem[] = []
  const steer = (item: QueueItem): Promise<'steered' | 'idle'> => {
    items.push(item)
    return Promise.resolve(outcome)
  }
  return { steer, items }
}

/** Type a line and press Enter. */
function submit(console: ReturnType<typeof fakeConsole>, text: string): void {
  console.press({ kind: 'text', text })
  console.press({ kind: 'enter' })
}

/** The chrome rows last drawn, joined for a substring check. */
const drawn = (console: ReturnType<typeof fakeConsole>): string => (console.draws.at(-1)?.rows ?? []).join('\n')

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

  it('merges adjacent queued prompts into one submission, a blank line between', async () => {
    const { prompt, console } = build()
    // Two thoughts typed while the agent worked were meant as one turn.
    submit(console, 'one')
    submit(console, 'two')
    expect(await prompt.read()).toBe('one\n\ntwo')
  })

  it('runs a queued ! line singly, in its turn, between prompts', async () => {
    const { prompt, console } = build()
    for (const text of ['one', '!ls', 'two', 'three']) submit(console, text)
    expect(await prompt.read()).toBe('one')
    expect(await prompt.read()).toBe('!ls')
    expect(await prompt.read()).toBe('two\n\nthree')
  })

  it('answers a question from the keyboard, never from the queue', async () => {
    const { prompt, console } = build()
    // Typed for the next turn, before any question existed.
    submit(console, 'later')
    const answer = prompt.readAnswer()
    submit(console, 'yes')
    expect(await answer).toBe('yes')
    expect(prompt.queued.map(item => item.text)).toEqual(['later'])
    expect(await prompt.read()).toBe('later')
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
    console.press({ kind: 'turn', direction: -1 })
    expect(calls).toEqual(['interrupt', 'escape', 'turn:-1'])
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
    expect(last?.rows[0]?.startsWith('─')).toBe(true)
    // Row 0 is the divider, so the cursor belongs on the row below it.
    expect(last?.cursor.row).toBe(1)
  })

  it('lays the box out to contentColumns so the gutter cannot ellipsize its right edge', () => {
    const { prompt, console } = build()
    void prompt.read()
    const top = console.draws.at(-1)?.rows[0] ?? ''
    expect(top).toMatch(/^─+$/u)
    expect(top).not.toContain('…')
    expect(displayWidth(top)).toBe(console.contentColumns)
  })

  it('leaves the divider uncoloured, so decoration carries no meaning', () => {
    const painted = createTheme(true, {})
    const { prompt, console } = build(true, undefined, undefined, painted)
    void prompt.read()
    const divider = console.draws.at(-1)?.rows[0] ?? ''
    // The divider is the region's edge, not a mode: a mode announces itself
    // through the accent the caller passes, and the default carries no hue.
    expect(divider).toBe(painted.dim('─'.repeat(console.contentColumns)))
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

  it('floats the completion menu over the transcript', () => {
    const { prompt, console } = build()
    void prompt.read()
    console.press({ kind: 'text', text: '/p' })
    const rows = console.draws.at(-1)?.rows ?? []
    const overlay = console.overlays.at(-1) ?? []
    expect(rows.some(row => row.includes('─'))).toBe(true)
    expect(rows.some(row => row.includes('/plan'))).toBe(false)
    expect(overlay.some(row => row.includes('/plan'))).toBe(true)
    expect(overlay.some(row => row.includes('plan mode'))).toBe(true)
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
    expect(console.timelineHidden.at(-1)).toBe(true)
    console.press({ kind: 'down' })
    console.press({ kind: 'enter' })
    expect(await deciding).toEqual({ kind: 'chosen', indices: [1] })
    expect(console.timelineHidden.at(-1)).toBe(false)
  })

  it('reports selector highlight changes for reversible previews', async () => {
    const { prompt, console } = build()
    const highlighted: number[] = []
    const deciding = prompt.select({
      title: 'Jump',
      options: [{ label: 'first' }, { label: 'second' }],
      filterable: true,
    }, undefined, index => highlighted.push(index))

    console.press({ kind: 'down' })
    console.press({ kind: 'escape' })

    expect(await deciding).toEqual({ kind: 'cancelled' })
    expect(highlighted).toEqual([0, 1])
  })

  it('settles on a row pressed and released in the same place', async () => {
    const { prompt, console } = build()
    const deciding = prompt.select({ title: 'Allow?', options: [{ label: 'Yes' }, { label: 'No' }] })
    // Row 0 is the title; the options follow it.
    console.region = { region: 'chrome', index: 2 }
    console.press({ kind: 'mouse-down', row: 9, column: 4 })
    console.press({ kind: 'mouse-up', row: 9, column: 4 })
    expect(await deciding).toEqual({ kind: 'chosen', indices: [1] })
  })

  it('takes the press back when it is released somewhere else', async () => {
    const { prompt, console } = build()
    const deciding = prompt.select({ title: 'Allow?', options: [{ label: 'Yes' }, { label: 'No' }] })
    console.region = { region: 'chrome', index: 1 }
    console.press({ kind: 'mouse-down', row: 8, column: 4 })
    // Released one row down: the button was slid off before it was let go.
    console.region = { region: 'chrome', index: 2 }
    console.press({ kind: 'mouse-up', row: 9, column: 4 })
    console.press({ kind: 'escape' })
    expect(await deciding).toEqual({ kind: 'cancelled' })
  })

  it('does nothing on a row that offers nothing, and never reaches the viewport', async () => {
    const { prompt, console } = build()
    const deciding = prompt.select({ title: 'Allow?', options: [{ label: 'Yes' }] })
    // The title row: not an option, and not a place to start a selection.
    console.region = { region: 'chrome', index: 0 }
    console.press({ kind: 'mouse-down', row: 7, column: 4 })
    console.press({ kind: 'mouse-up', row: 7, column: 4 })
    expect(console.pointer).toEqual([])
    console.press({ kind: 'escape' })
    expect(await deciding).toEqual({ kind: 'cancelled' })
  })

  it('keeps a drag the viewport anchored when it is released below the transcript', () => {
    const { console } = build()
    // Pressed on the transcript: no region owns that row.
    console.press({ kind: 'mouse-down', row: 3, column: 4 })
    // Swept down out of the transcript and let go over the input box, which is
    // how selecting through to the last line ends.
    console.region = { region: 'chrome', index: 1 }
    console.press({ kind: 'mouse-drag', row: 9, column: 40 })
    console.selected = 'answer'
    console.press({ kind: 'mouse-up', row: 9, column: 40 })
    // The gesture belonged to the viewport through release, so it copied.
    expect(console.pointer).toEqual(['down 3', 'drag 9', 'up'])
    expect(console.copied).toEqual(['answer'])
  })

  it('gives a region the gesture back once nothing is held any more', async () => {
    const { prompt, console } = build()
    const deciding = prompt.select({ title: 'Allow?', options: [{ label: 'Yes' }, { label: 'No' }] })
    // A press the viewport anchored whose release happened off the window and
    // never arrived.
    console.press({ kind: 'mouse-down', row: 3, column: 4 })
    console.region = { region: 'chrome', index: 2 }
    // A button-less move says the button is up: the option is the region's
    // again, rather than feeding a selection that ended long ago.
    console.press({ kind: 'mouse-move', row: 9, column: 4 })
    console.press({ kind: 'mouse-down', row: 9, column: 4 })
    console.press({ kind: 'mouse-up', row: 9, column: 4 })
    expect(await deciding).toEqual({ kind: 'chosen', indices: [1] })
  })

  it('marks the row under the pointer without moving what Enter would take', async () => {
    const { prompt, console } = build()
    const deciding = prompt.select({ title: 'Allow?', options: [{ label: 'Yes' }, { label: 'No' }] })
    console.region = { region: 'chrome', index: 2 }
    console.press({ kind: 'mouse-move', row: 9, column: 4 })
    // The pointer moved nothing: Enter still takes the row the mark is on.
    console.press({ kind: 'enter' })
    expect(await deciding).toEqual({ kind: 'chosen', indices: [0] })
  })

  it('takes a completion the pointer chose, not the one the mark is on', async () => {
    const { prompt, console } = build()
    const reading = prompt.read()
    console.press({ kind: 'text', text: '/' })
    // Two candidates are offered and the mark sits on the first.
    expect(console.overlays.at(-1)?.length).toBeGreaterThan(1)

    // The menu is drawn over the transcript, so it answers in the overlay.
    console.region = { region: 'overlay', index: 1 }
    console.press({ kind: 'mouse-down', row: 5, column: 4 })
    console.press({ kind: 'mouse-up', row: 5, column: 4 })

    console.press({ kind: 'enter' })
    // The second candidate, not the first, which is where the mark was.
    expect(await reading).toBe('/permission')
  })

  it('puts the cursor where the box was clicked', async () => {
    const { prompt, console } = build()
    const reading = prompt.read()
    console.press({ kind: 'text', text: 'hello world' })

    // Row 0 of the chrome is the divider; row 1 is its first line, and the
    // text starts two cells into it, after the screen's own gutter.
    console.region = { region: 'chrome', index: 1 }
    console.press({ kind: 'mouse-down', row: 9, column: 3 + 2 + 5 })
    console.press({ kind: 'mouse-up', row: 9, column: 3 + 2 + 5 })
    console.press({ kind: 'text', text: 'X' })

    console.press({ kind: 'enter' })
    expect(await reading).toBe('helloX world')
  })

  it('puts the cursor on the wrapped row where the box was clicked', async () => {
    const { prompt, console } = build()
    const reading = prompt.read()
    const line = 'x'.repeat(60)
    console.press({ kind: 'text', text: line })

    // 57 content columns leaves 55 for text, so the line takes two region rows
    // and the 56th character opens the second. Terminal column 5 is that row's
    // first character: two cells of screen gutter plus the region's two.
    console.region = { region: 'chrome', index: 2 }
    console.press({ kind: 'mouse-down', row: 9, column: 5 })
    console.press({ kind: 'mouse-up', row: 9, column: 5 })
    console.press({ kind: 'text', text: 'X' })

    console.press({ kind: 'enter' })
    expect(await reading).toBe(`${'x'.repeat(55)}X${'x'.repeat(5)}`)
  })

  it('selects in the box on a drag and copies on release', async () => {
    const { prompt, console } = build()
    const reading = prompt.read()
    console.press({ kind: 'text', text: 'hello world' })

    // Column 5 is the first character; column 10 is the space after "hello".
    console.region = { region: 'chrome', index: 1 }
    console.press({ kind: 'mouse-down', row: 9, column: 5 })
    console.press({ kind: 'mouse-drag', row: 9, column: 10 })
    console.press({ kind: 'mouse-up', row: 9, column: 10 })

    expect(console.copied).toEqual(['hello'])
    const drawn = console.draws.at(-1)?.rows.join('\n') ?? ''
    expect(drawn).toContain('\u001B[7mhello\u001B[27m')

    console.press({ kind: 'text', text: 'X' })
    console.press({ kind: 'enter' })
    expect(await reading).toBe('X world')
  })

  it('still places the cursor when the press never moved', async () => {
    const { prompt, console } = build()
    const reading = prompt.read()
    console.press({ kind: 'text', text: 'hello world' })
    console.region = { region: 'chrome', index: 1 }
    console.press({ kind: 'mouse-down', row: 9, column: 5 })
    console.press({ kind: 'mouse-up', row: 9, column: 5 })
    console.press({ kind: 'text', text: 'X' })
    console.press({ kind: 'enter' })
    expect(await reading).toBe('Xhello world')
    expect(console.copied).toEqual([])
  })

  it('turns the wheel on the list the pointer is over', async () => {
    const { prompt, console } = build()
    const deciding = prompt.select({
      title: 'Pick',
      options: Array.from({ length: 30 }, (_, index) => ({ label: `option ${index}` })),
    })
    console.region = { region: 'chrome', index: 3 }
    console.press({ kind: 'scroll', lines: 6, at: { row: 9, column: 4 } })

    const shown = (console.draws.at(-1)?.rows ?? []).join('\n')
    expect(shown).not.toContain('option 0 ')
    // The mark never moved, so Enter still takes the first option.
    console.press({ kind: 'enter' })
    expect(await deciding).toEqual({ kind: 'chosen', indices: [0] })
  })

  it('leaves a keyboard scroll to the transcript, wherever the pointer rests', async () => {
    const { prompt, console } = build()
    const deciding = prompt.select({
      title: 'Pick',
      options: Array.from({ length: 30 }, (_, index) => ({ label: `option ${index}` })),
    })
    console.region = { region: 'chrome', index: 3 }
    // No place on it: this came from Shift+Down, not the wheel.
    console.press({ kind: 'scroll', lines: 6 })
    // The transcript's scroll coalesces a burst into one repaint, so it lands
    // on the next microtask rather than inside the key.
    await Promise.resolve()
    expect(console.scrolls).toEqual([6])

    console.press({ kind: 'escape' })
    expect(await deciding).toEqual({ kind: 'cancelled' })
  })

  it('refuses the pointer on a decision only the keyboard may make', async () => {
    // An approval: granting a tool for the session cannot be taken back, so a
    // click must not be able to do it, and nothing may suggest it can.
    const { prompt, console } = build()
    const deciding = prompt.select({
      title: 'Allow bash?',
      options: [{ label: 'Yes, this time' }, { label: 'Yes, always' }, { label: 'No' }],
      keyboardOnly: true,
    })
    console.region = { region: 'chrome', index: 2 }
    console.press({ kind: 'mouse-move', row: 9, column: 4 })
    console.press({ kind: 'mouse-down', row: 9, column: 4 })
    console.press({ kind: 'mouse-up', row: 9, column: 4 })
    // Nothing settled, and no row wears the pointer's mark. The dot also
    // appears inside the hints line, so the test looks for it where a marker
    // lives: at the very start of a row.
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.startsWith('\u00B7'))).toBe(false)

    // The wheel is refused too: the pointer does nothing here at all.
    console.press({ kind: 'scroll', lines: 3, at: { row: 9, column: 4 } })
    await Promise.resolve()
    expect(console.scrolls).toEqual([3])

    console.press({ kind: 'enter' })
    expect(await deciding).toEqual({ kind: 'chosen', indices: [0] })
  })

  it('copies what the reader is showing, on c', async () => {
    const { prompt, console } = build()
    const reading = prompt.view({ title: 'Changes', kind: 'diff', text: '-was\n+is' })
    console.press({ kind: 'text', text: 'c' })
    expect(console.copied).toEqual(['-was\n+is'])
    // The reader says so itself: it owns the screen, so the flash row is not
    // on it.
    expect((console.viewers.at(-1) ?? []).join('\n')).toContain('copied')

    console.press({ kind: 'escape' })
    await reading
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

describe('fullscreen viewing', () => {
  it('owns navigation keys until Escape restores the prompt', async () => {
    const { prompt, console, calls } = build()
    void prompt.read()
    const viewing = prompt.view({
      title: 'Code 1:1',
      kind: 'code',
      text: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'),
    })
    expect(console.viewers.at(-1)?.[0]).toContain('Code 1:1')
    expect(console.viewers.at(-1)?.join('\n')).toContain('line 1')

    console.press({ kind: 'scroll', lines: 1 })
    expect(console.viewers.at(-1)?.join('\n')).not.toContain('line 1\n')
    console.press({ kind: 'turn', direction: 1 })
    console.press({ kind: 'page', direction: 1 })
    expect(console.scrolls).toEqual([])
    expect(calls).toEqual([])

    console.press({ kind: 'home' })
    expect(console.viewers.at(-1)?.join('\n')).toContain('line 1')
    console.press({ kind: 'end' })
    expect(console.viewers.at(-1)?.join('\n')).toContain('line 12')
    console.press({ kind: 'escape' })
    await viewing
    expect(console.viewers.at(-1)).toBeUndefined()
    expect(calls).toEqual([])
    expect(console.draws.at(-1)?.rows.some(row => row.includes('─'))).toBe(true)
  })

  it('reflows on resize and closes when its signal aborts', async () => {
    const { prompt, console } = build()
    const controller = new AbortController()
    const viewing = prompt.view({ title: 'Answer 1', kind: 'answer', text: '界'.repeat(30) }, controller.signal)
    const before = console.viewers.at(-1)?.join('\n') ?? ''
    console.columns = 20
    console.resize()
    expect(console.viewers.at(-1)?.join('\n')).not.toBe(before)
    controller.abort()
    await viewing
    expect(console.viewers.at(-1)).toBeUndefined()
  })
})

describe('the surrounding rows', () => {
  it('leaves the queue alone on Escape and lets the owner interrupt', () => {
    const { prompt, console, calls } = build()
    submit(console, 'later work')
    console.press({ kind: 'escape' })
    // Escape means stop; taking a line back is the panel's job.
    expect(calls).toContain('escape')
    expect(prompt.queued.map(item => item.text)).toEqual(['later work'])
    expect(drawn(console)).toContain('queued: later work')
  })

  it('previews queued submissions so type-ahead is visibly held, not lost', () => {
    const { prompt, console } = build()
    submit(console, 'later work')
    prompt.setHint('working')
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('queued: later work') && row.includes('Ctrl+Q'))).toBe(true)
  })

  it('counts several queued lines and previews each', () => {
    const { console } = build()
    submit(console, 'first')
    submit(console, 'second')
    expect(drawn(console)).toContain('2 queued: first · second')
  })

  it('opens the queue panel on Ctrl-Q and closes it again', () => {
    const { prompt, console } = build()
    submit(console, 'first')
    submit(console, 'second')
    console.press({ kind: 'toggle-queue' })
    const opened = drawn(console)
    expect(opened).toContain('queue 2 · Ctrl+Q closes')
    expect(opened).toContain('1. first')
    expect(opened).toContain('2. second')
    expect(opened).toContain('[enter] edit')
    console.press({ kind: 'toggle-queue' })
    expect(drawn(console)).not.toContain('Ctrl+Q closes')
    expect(drawn(console)).toContain('2 queued: first · second')
    expect(prompt.queued).toHaveLength(2)
  })

  it('flashes when there is nothing to open', () => {
    const { console } = build()
    console.press({ kind: 'toggle-queue' })
    expect(drawn(console)).toContain('queue is empty')
    expect(drawn(console)).not.toContain('Ctrl+Q closes')
  })

  it('opens the panel on a click on the readout', () => {
    const { console } = build()
    submit(console, 'later work')
    const rows = console.draws.at(-1)?.rows ?? []
    const readout = rows.findIndex(row => row.includes('queued: later work'))
    expect(readout).toBeGreaterThanOrEqual(0)
    console.region = { region: 'chrome', index: readout }
    console.press({ kind: 'mouse-down', row: 9, column: 4 })
    console.press({ kind: 'mouse-up', row: 9, column: 4 })
    expect(drawn(console)).toContain('queue 1 · Ctrl+Q closes')
  })

  it('closes on Escape without interrupting or dropping anything', () => {
    const { prompt, console, calls } = build()
    submit(console, 'first')
    submit(console, 'second')
    console.press({ kind: 'toggle-queue' })
    console.press({ kind: 'escape' })
    expect(calls).not.toContain('escape')
    expect(drawn(console)).not.toContain('Ctrl+Q closes')
    expect(prompt.queued).toHaveLength(2)
  })

  it('keeps typing out of the box while the panel is open', () => {
    const { prompt, console } = build()
    submit(console, 'first')
    console.press({ kind: 'toggle-queue' })
    console.press({ kind: 'text', text: 'x' })
    expect(prompt.empty).toBe(true)
    expect(drawn(console)).toContain('Ctrl+Q closes')
  })

  it('edits a queued line back into the box, its images with it', async () => {
    const { prompt, console } = build(true, pngClipboard)
    console.press({ kind: 'paste-image' })
    await settled()
    console.press({ kind: 'enter' })
    console.press({ kind: 'toggle-queue' })
    console.press({ kind: 'enter' })
    expect(prompt.queued).toHaveLength(0)
    expect(drawn(console)).not.toContain('Ctrl+Q closes')
    const reading = prompt.read()
    expect(drawn(console)).toContain('[Image #1]')
    console.press({ kind: 'enter' })
    expect(await reading).toBe('[Image #1]')
    expect(prompt.takeAttachments()).toHaveLength(1)
  })

  it('refuses to edit into a box that holds text', () => {
    const { prompt, console } = build()
    submit(console, 'first')
    console.press({ kind: 'text', text: 'draft' })
    console.press({ kind: 'toggle-queue' })
    console.press({ kind: 'text', text: 'e' })
    expect(drawn(console)).toContain('clear the box first')
    expect(prompt.queued).toHaveLength(1)
  })

  it('deletes the marked item on d and closes when the queue empties', () => {
    const { prompt, console } = build()
    submit(console, 'only')
    console.press({ kind: 'toggle-queue' })
    console.press({ kind: 'text', text: 'd' })
    expect(prompt.queued).toHaveLength(0)
    expect(drawn(console)).not.toContain('Ctrl+Q closes')
    expect(drawn(console)).not.toContain('queued:')
  })

  it('reorders with Shift-Up and drains in the new order', async () => {
    const { prompt, console } = build()
    submit(console, '!first')
    submit(console, '!second')
    console.press({ kind: 'toggle-queue' })
    console.press({ kind: 'down' })
    console.press({ kind: 'scroll', lines: -1 })
    expect(prompt.queued.map(item => item.text)).toEqual(['!second', '!first'])
    expect(await prompt.read()).toBe('!second')
    expect(await prompt.read()).toBe('!first')
  })

  it('steers the marked prompt on s while a turn runs', async () => {
    const fixture = steerFixture()
    const { prompt, console } = build(true, undefined, fixture.steer)
    submit(console, 'also check X')
    console.press({ kind: 'toggle-queue' })
    console.press({ kind: 'text', text: 's' })
    await settled()
    expect(fixture.items.map(item => item.text)).toEqual(['also check X'])
    expect(prompt.queued).toHaveLength(0)
    expect(prompt.steering.map(item => item.text)).toEqual(['also check X'])
    expect(drawn(console)).toContain('steering: also check X')
    prompt.steerClaimed(fixture.items[0]?.id ?? -1)
    expect(prompt.steering).toHaveLength(0)
    expect(drawn(console)).not.toContain('steering:')
  })

  it('refuses to steer a ! line', async () => {
    const fixture = steerFixture()
    const { prompt, console } = build(true, undefined, fixture.steer)
    submit(console, '!ls')
    console.press({ kind: 'toggle-queue' })
    console.press({ kind: 'text', text: 's' })
    await settled()
    expect(fixture.items).toHaveLength(0)
    expect(prompt.queued).toHaveLength(1)
    expect(drawn(console)).toContain('only a message can steer')
  })

  it('steers straight from the box on Ctrl-Enter', async () => {
    const fixture = steerFixture()
    const { prompt, console } = build(true, undefined, fixture.steer)
    console.press({ kind: 'text', text: 'also' })
    console.press({ kind: 'steer' })
    await settled()
    expect(fixture.items.map(item => item.text)).toEqual(['also'])
    expect(prompt.queued).toHaveLength(0)
    expect(drawn(console)).toContain('steering: also')
  })

  it('queues a ! line on Ctrl-Enter instead of steering it', async () => {
    const fixture = steerFixture()
    const { prompt, console } = build(true, undefined, fixture.steer)
    console.press({ kind: 'text', text: '!ls' })
    console.press({ kind: 'steer' })
    await settled()
    expect(fixture.items).toHaveLength(0)
    expect(prompt.queued.map(item => item.text)).toEqual(['!ls'])
    expect(drawn(console)).toContain('only a message can steer')
  })

  it('sends like Enter on Ctrl-Enter when the loop is already asking', async () => {
    const fixture = steerFixture()
    const { prompt, console } = build(true, undefined, fixture.steer)
    const reading = prompt.read()
    console.press({ kind: 'text', text: 'now' })
    console.press({ kind: 'steer' })
    expect(await reading).toBe('now')
    expect(fixture.items).toHaveLength(0)
  })

  it('falls back to the queue when nothing was running after all', async () => {
    const fixture = steerFixture('idle')
    const { prompt, console } = build(true, undefined, fixture.steer)
    console.press({ kind: 'text', text: 'x' })
    console.press({ kind: 'steer' })
    await settled()
    expect(prompt.steering).toHaveLength(0)
    expect(prompt.queued.map(item => item.text)).toEqual(['x'])
    expect(drawn(console)).toContain('nothing is running')
  })

  it('returns an unclaimed steer to the head of the queue', async () => {
    const fixture = steerFixture()
    const { prompt, console } = build(true, undefined, fixture.steer)
    console.press({ kind: 'text', text: 'x' })
    console.press({ kind: 'steer' })
    await settled()
    submit(console, 'later')
    prompt.steerReturned(fixture.items[0]?.id ?? -1)
    expect(prompt.queued.map(item => item.text)).toEqual(['x', 'later'])
    expect(await prompt.read()).toBe('x\n\nlater')
  })

  it('holds one open panel: Ctrl-T closes the queue', () => {
    const { console } = build()
    submit(console, 'a')
    console.press({ kind: 'toggle-queue' })
    console.press({ kind: 'toggle-todos' })
    expect(drawn(console)).not.toContain('Ctrl+Q closes')
    console.press({ kind: 'toggle-queue' })
    expect(drawn(console)).toContain('Ctrl+Q closes')
  })

  it('closes by itself when a read drains the queue', async () => {
    const { prompt, console } = build()
    submit(console, 'a')
    console.press({ kind: 'toggle-queue' })
    expect(await prompt.read()).toBe('a')
    expect(drawn(console)).not.toContain('Ctrl+Q closes')
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

  it('paints the environment top bar above the region, column-aware', () => {
    const { prompt, console } = build()
    prompt.setTopBar(columns => `bar:${columns}`)
    void prompt.read()
    expect(console.topBars.at(-1)).toBe(`bar:${console.contentColumns}`)
    console.columns = 30
    console.resize()
    expect(console.topBars.at(-1)).toBe(`bar:${console.contentColumns}`)
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

  it('calls column-aware status formatter on paint and resize', () => {
    const { prompt, console } = build()
    prompt.setStatus(columns => `width:${columns}`)
    void prompt.read()
    expect(console.draws.at(-1)?.rows.at(-1)).toBe(`width:${console.contentColumns}`)
    console.columns = 30
    console.resize()
    expect(console.draws.at(-1)?.rows.at(-1)).toBe(`width:${console.contentColumns}`)
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

  it('shows image preview overlay when cursor is next to an image token and hides when moved away', async () => {
    const { prompt, console } = build(true, pngClipboard)
    void prompt.read()
    console.press({ kind: 'paste-image' })
    await settled()

    // Immediately after pasting, cursor is at the right edge of [Image #1]
    const overlay = console.overlays.at(-1) ?? []
    expect(overlay.some(row => row.includes('Image #1'))).toBe(true)

    // Moving away from the image token hides the preview overlay
    console.press({ kind: 'text', text: ' ' })
    console.press({ kind: 'text', text: 'a' })
    expect(console.overlays.at(-1)).toEqual([])

    // Moving back to the right edge of [Image #1] restores the preview overlay
    console.press({ kind: 'left' })
    expect(console.overlays.at(-1)).toEqual([])
    console.press({ kind: 'left' }) // now at column 10 (right edge of [Image #1])
    expect((console.overlays.at(-1) ?? []).some(row => row.includes('Image #1'))).toBe(true)

    // Moving left jumps over the token to the left edge of [Image #1] (column 0)
    console.press({ kind: 'left' })
    expect((console.overlays.at(-1) ?? []).some(row => row.includes('Image #1'))).toBe(true)
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

  it('keeps a queued line paired with its own images through the merge', async () => {
    const { prompt, console } = build(true, pngClipboard)
    // Nothing is reading yet: paste, submit, then a plain line for the same turn.
    console.press({ kind: 'paste-image' })
    await settled()
    console.press({ kind: 'enter' })
    submit(console, 'no image here')
    expect(await prompt.read()).toBe('[Image #1]\n\nno image here')
    expect(prompt.takeAttachments().map(image => image.id)).toEqual([1])
    // A ! line between two prompts keeps its own (no) images and its place.
    console.press({ kind: 'paste-image' })
    await settled()
    console.press({ kind: 'enter' })
    submit(console, '!ls')
    console.press({ kind: 'paste-image' })
    await settled()
    console.press({ kind: 'enter' })
    expect(await prompt.read()).toBe('[Image #2]')
    expect(prompt.takeAttachments().map(image => image.id)).toEqual([2])
    expect(await prompt.read()).toBe('!ls')
    expect(prompt.takeAttachments()).toHaveLength(0)
    expect(await prompt.read()).toBe('[Image #3]')
    expect(prompt.takeAttachments().map(image => image.id)).toEqual([3])
  })

  it('carries every merged line\'s images, in order', async () => {
    const { prompt, console } = build(true, pngClipboard)
    console.press({ kind: 'paste-image' })
    await settled()
    console.press({ kind: 'text', text: ' first' })
    console.press({ kind: 'enter' })
    console.press({ kind: 'paste-image' })
    await settled()
    console.press({ kind: 'text', text: ' second' })
    console.press({ kind: 'enter' })
    expect(await prompt.read()).toBe('[Image #1] first\n\n[Image #2] second')
    expect(prompt.takeAttachments().map(image => image.id)).toEqual([1, 2])
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

    // A subagent card is a view: the click opens that session, not the fold.
    console.hover = { label: 'subagent', lines: 3, expanded: false, enter: true }
    console.press({ kind: 'mouse-move', row: 5, column: 5 })
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('  subagent · 3 lines · click to enter')

    // Off every block, the indicator has its row back.
    console.hover = undefined
    console.press({ kind: 'mouse-move', row: 9, column: 5 })
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('working')
  })

  it('gives the status row back when the pointer leaves the transcript for the chrome', () => {
    const { prompt, console } = build()
    prompt.setStatus('model · 12k tokens')
    void prompt.read()
    console.hover = { label: 'thinking', lines: 8, expanded: false }
    console.press({ kind: 'mouse-move', row: 3, column: 5 })
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('  thinking · 8 lines · click to expand')
    console.hover = undefined
    console.region = { region: 'chrome', index: 0 }
    console.press({ kind: 'mouse-move', row: 7, column: 5 })
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('model · 12k tokens')
    expect(console.pointer.at(-1)).toBe('leave')
  })

  it('gives the status row back when the pointer leaves the window', () => {
    const { prompt, console } = build()
    prompt.setStatus('model · 12k tokens')
    void prompt.read()
    console.hover = { label: 'thinking', lines: 8, expanded: false }
    console.press({ kind: 'mouse-move', row: 3, column: 5 })
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('  thinking · 8 lines · click to expand')
    console.hover = undefined
    // Some terminals report 0,0 when the pointer exits; others a cell past the
    // last row. Either is "not on this surface".
    console.press({ kind: 'mouse-move', row: 0, column: 0 })
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('model · 12k tokens')
    console.hover = { label: 'thinking', lines: 8, expanded: false }
    console.press({ kind: 'mouse-move', row: 3, column: 5 })
    console.hover = undefined
    console.press({ kind: 'focus', focused: false })
    expect(console.draws.at(-1)?.rows.at(-1)).toBe('model · 12k tokens')
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
    const pinned = console.draws.at(-1)?.rows ?? []
    expect(pinned.some(row => row.includes('todos 1/2 · ▶ write the fix · Ctrl+T'))).toBe(true)
    expect(pinned.some(row => row.includes('read the code'))).toBe(false)
    console.press({ kind: 'toggle-todos' })
    const opened = console.draws.at(-1)?.rows ?? []
    expect(opened.some(row => row.includes('read the code'))).toBe(true)
    expect(opened.some(row => row.includes('todos 1/2 · Ctrl+T closes'))).toBe(true)
    console.press({ kind: 'toggle-todos' })
    const closed = console.draws.at(-1)?.rows ?? []
    expect(closed.some(row => row.includes('read the code'))).toBe(false)
    expect(closed.some(row => row.includes('todos 1/2 · ▶ write the fix · Ctrl+T'))).toBe(true)
  })

  it('collapses the list on Escape without aborting the session', () => {
    const { prompt, console, calls } = build()
    prompt.setTodos([
      { content: 'read the code', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
    ])
    console.press({ kind: 'toggle-todos' })
    expect((console.draws.at(-1)?.rows ?? []).some(row => row.includes('read the code'))).toBe(true)
    console.press({ kind: 'escape' })
    const closed = console.draws.at(-1)?.rows ?? []
    expect(closed.some(row => row.includes('read the code'))).toBe(false)
    expect(closed.some(row => row.includes('todos 1/2 · ▶ write the fix · Ctrl+T'))).toBe(true)
    expect(calls).not.toContain('escape')
  })

  it('keeps the same collapsed row in comfortable density', () => {
    const { prompt, console } = build()
    prompt.setTodos([
      { content: 'read the code', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
    ])
    const compact = (console.draws.at(-1)?.rows ?? []).find(row => row.includes('todos 1/2'))
    prompt.setDensity('comfortable')
    const comfortable = (console.draws.at(-1)?.rows ?? []).find(row => row.includes('todos 1/2'))
    expect(compact).toBe('todos 1/2 · ▶ write the fix · Ctrl+T')
    expect(comfortable).toBe(compact)
  })

  it('gives the plan rows back when the plan is withdrawn', () => {
    const { prompt, console } = build()
    prompt.setPlan({
      tickets: [{ title: 'landed', done: true }, { title: 'also landed', done: true }],
      done: 2,
      current: undefined,
    })
    expect(drawn(console)).toContain('plan 2/2')
    // A shipped spec has no work left to pin: the chrome shrinks back.
    prompt.setPlan(undefined)
    expect(drawn(console)).not.toContain('plan 2/2')
    expect(drawn(console)).not.toContain('every ticket landed')
  })

  it('does not redraw when the plan has not changed', () => {
    const { prompt, console } = build()
    const plan = {
      tickets: [{ title: 'landed', done: true }, { title: 'in flight', done: false }],
      done: 1,
      current: { title: 'in flight', done: false },
    }
    prompt.setPlan(plan)
    const n = console.draws.length
    prompt.setPlan({
      tickets: plan.tickets.map(ticket => ({ ...ticket })),
      done: 1,
      current: { title: 'in flight', done: false },
    })
    expect(console.draws.length).toBe(n)
  })

  it('opens the ship plan on a click, and folds it back from inside the list', () => {
    const { prompt, console } = build()
    prompt.setPlan({
      tickets: [
        { title: 'landed', done: true },
        { title: 'in flight', done: false },
        { title: 'waiting', done: false },
      ],
      done: 1,
      current: { title: 'in flight', done: false },
    })
    const closed = console.draws.at(-1)?.rows ?? []
    const teaser = closed.findIndex(row => row.includes('Ctrl+T opens the list'))
    expect(teaser).toBeGreaterThanOrEqual(0)
    expect(closed.some(row => row.includes('waiting'))).toBe(false)

    console.region = { region: 'chrome', index: teaser }
    console.press({ kind: 'mouse-down', row: 9, column: 4 })
    console.press({ kind: 'mouse-up', row: 9, column: 4 })
    const opened = console.draws.at(-1)?.rows ?? []
    expect(opened.some(row => row.includes('waiting'))).toBe(true)

    // A click anywhere in the open panel — not just the teaser — folds it back.
    const inside = opened.findIndex(row => row.includes('waiting'))
    expect(inside).toBeGreaterThanOrEqual(0)
    console.region = { region: 'chrome', index: inside }
    console.press({ kind: 'mouse-down', row: 10, column: 4 })
    console.press({ kind: 'mouse-up', row: 10, column: 4 })
    const shut = console.draws.at(-1)?.rows ?? []
    expect(shut.some(row => row.includes('Ctrl+T opens the list'))).toBe(true)
    expect(shut.some(row => row.includes('waiting'))).toBe(false)
  })

  it('takes a plan click back when it is released off the readout', () => {
    const { prompt, console } = build()
    prompt.setStatus('model')
    prompt.setPlan({
      tickets: [{ title: 'one ticket', done: false }],
      done: 0,
      current: { title: 'one ticket', done: false },
    })
    const teaser = (console.draws.at(-1)?.rows ?? []).findIndex(row => row.includes('plan 0/1'))
    expect(teaser).toBeGreaterThanOrEqual(0)
    console.region = { region: 'chrome', index: teaser }
    console.press({ kind: 'mouse-down', row: 9, column: 4 })
    // Released on the status row: the button was slid off before it was let go.
    const status = (console.draws.at(-1)?.rows ?? []).findIndex(row => row.includes('model'))
    expect(status).toBeGreaterThanOrEqual(0)
    expect(status).not.toBe(teaser)
    console.region = { region: 'chrome', index: status }
    console.press({ kind: 'mouse-up', row: 10, column: 4 })
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('plan 0/1'))).toBe(true)
    expect(rows.filter(row => row.includes('one ticket'))).toHaveLength(1)
  })

  it('omits redundant todos when a plan has matching tickets', () => {
    const { prompt, console } = build()
    prompt.setPlan({
      tickets: [
        { title: 'Ticket 1: Data Model', done: true },
        { title: 'Ticket 2: Application Integration', done: false },
      ],
      done: 1,
      current: { title: 'Ticket 2: Application Integration', done: false },
    })
    prompt.setTodos([
      { content: 'Ticket 1: Data Model', status: 'completed' },
      { content: 'Ticket 2: Application Integration', status: 'in_progress' },
    ])
    console.press({ kind: 'toggle-todos' })
    const opened = console.draws.at(-1)?.rows ?? []
    // The plan tickets are rendered
    expect(opened.some(row => row.includes('◇ plan'))).toBe(true)
    // Redundant todos header should not be rendered
    expect(opened.some(row => row.includes('todos 1/2'))).toBe(false)
  })

  it('keeps the collapsed chrome on the plan, not a second todo teaser', () => {
    const { prompt, console } = build()
    prompt.setPlan({
      tickets: [
        { title: 'Ticket 1: Data Model', done: true },
        { title: 'Ticket 2: Application Integration', done: false },
      ],
      done: 1,
      current: { title: 'Ticket 2: Application Integration', done: false },
    })
    prompt.setTodos([
      { content: 'Ticket 1: Data Model', status: 'completed' },
      { content: 'Ticket 2: Application Integration', status: 'in_progress' },
    ])
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('plan 1/2'))).toBe(true)
    expect(rows.some(row => row.includes('todos'))).toBe(false)
  })

  it('drops todos that repeat plan tickets and keeps genuine sub-steps', () => {
    const { prompt, console } = build()
    prompt.setPlan({
      tickets: [
        { title: 'Ticket 1: Data Model', done: true },
        { title: 'Ticket 2: Application Integration', done: false },
      ],
      done: 1,
      current: { title: 'Ticket 2: Application Integration', done: false },
    })
    prompt.setTodos([
      { content: 'Ticket 2: Application Integration', status: 'in_progress' },
      { content: 'write the failing test for the public seam', status: 'pending' },
    ])
    console.press({ kind: 'toggle-todos' })
    const opened = console.draws.at(-1)?.rows ?? []
    expect(opened.some(row => row.includes('◇ plan'))).toBe(true)
    expect(opened.some(row => row.includes('write the failing test for the public seam'))).toBe(true)
    expect(opened.filter(row => row.includes('Ticket 2: Application Integration'))).toHaveLength(1)
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

  it('reports Ctrl+O to its owner so the fold still opens', () => {
    const console = fakeConsole(true)
    const folds: string[] = []
    void new Prompt(console as never, theme, sources, {
      interrupt: () => {},
      escape: () => {},
      eof: () => {},
      expandOutput: () => void folds.push('expanded'),
    })
    console.press({ kind: 'expand-output' })
    expect(folds).toEqual(['expanded'])
  })

  it('accents the box frame when a mode asks it to', () => {
    const { prompt, console } = build()
    prompt.setAccent(text => `<${text}>`)
    void prompt.read()
    const rows = console.draws.at(-1)?.rows ?? []
    // The divider carries the mode so the next submission's rules are visible
    // from the region itself.
    expect(rows.some(row => row.startsWith('<─'))).toBe(true)
    prompt.setAccent(undefined)
    const plain = console.draws.at(-1)?.rows ?? []
    expect(plain.some(row => row.startsWith('<─'))).toBe(false)
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
    expect(opened.some(row => row.includes('Ctrl+Q queue'))).toBe(true)
    expect(opened.some(row => row.includes('/status'))).toBe(true)
    expect(opened.some(row => row.includes('model · permissions · tokens · context'))).toBe(true)
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

describe('the key legend', () => {
  const build = () => {
    const console = fakeConsole(true)
    const prompt = new Prompt(console as never, theme, sources,
      { interrupt: () => {}, escape: () => {}, eof: () => {} }, 'Ask anything')
    prompt.setStatus('status')
    prompt.setLegend('  ? shortcuts · ⇧Tab plan')
    void prompt.read()
    const rows = (): string[] => console.draws.at(-1)?.rows ?? []
    return { prompt, console, rows }
  }

  it('sits on the hint row under the box, empty or being typed in', () => {
    const { console, rows } = build()
    expect(rows().some(row => row.includes('? shortcuts'))).toBe(true)
    const height = rows().length
    for (const character of 'abc') console.press({ kind: 'text', text: character })
    expect(rows().some(row => row.includes('› abc'))).toBe(true)
    expect(rows().some(row => row.includes('? shortcuts'))).toBe(true)
    expect(rows().length).toBe(height)
  })

  it('gives the row to a hint or a flash and takes it back, without moving the box', () => {
    const { prompt, rows } = build()
    const height = rows().length
    prompt.setHint('  ESC again to edit your previous message')
    expect(rows().some(row => row.includes('ESC again'))).toBe(true)
    expect(rows().some(row => row.includes('? shortcuts'))).toBe(false)
    expect(rows().length).toBe(height)
    prompt.setHint(undefined)
    expect(rows().some(row => row.includes('? shortcuts'))).toBe(true)
    prompt.setFlash('  ✓ copied')
    expect(rows().some(row => row.includes('✓ copied'))).toBe(true)
    expect(rows().some(row => row.includes('? shortcuts'))).toBe(false)
    expect(rows().length).toBe(height)
    // The status row stays under whichever of them holds the hint row.
    expect(rows().at(-1)).toContain('status')
  })

  it('steps aside for a selector, whose keys are its own', async () => {
    const { prompt, console, rows } = build()
    const choosing = prompt.select({ title: 'Allow bash?', options: [{ label: 'Yes' }, { label: 'No' }] })
    expect(rows().some(row => row.includes('Allow bash?'))).toBe(true)
    expect(rows().some(row => row.includes('? shortcuts'))).toBe(false)
    console.press({ kind: 'enter' })
    await choosing
    expect(rows().some(row => row.includes('? shortcuts'))).toBe(true)
  })
})

describe('ship gate modal', () => {
  it('paints via setViewer, settles y/e/n/Esc, and clears shipGate + viewer', async () => {
    const gates: Array<1 | 2 | undefined> = []
    const { console, prompt } = (() => {
      const console = fakeConsole(true)
      const prompt = new Prompt(console as never, createTheme(false, {}), sources, {
        interrupt: () => {},
        escape: () => {},
        eof: () => {},
        shipGate: (gate) => { gates.push(gate) },
      })
      return { console, prompt }
    })()
    const pending = prompt.gate({
      kind: 'spec',
      title: 'ship · gate 1/2 — confirm spec',
      bodyLines: ['body'],
      recommended: 'confirm',
    })
    expect(prompt.shipGate).toBe(1)
    expect(gates.at(-1)).toBe(1)
    expect(console.viewers.at(-1)?.join('\n')).toContain('gate 1/2')
    console.press({ kind: 'text', text: 'y' })
    await expect(pending).resolves.toBe('confirm')
    expect(prompt.shipGate).toBeUndefined()
    expect(gates.at(-1)).toBeUndefined()
    expect(console.viewers.at(-1)).toBeUndefined()

    for (const [key, action] of [
      [{ kind: 'text', text: 'n' }, 'abort'],
      [{ kind: 'escape' }, 'abort'],
    ] as const) {
      const next = prompt.gate({
        kind: 'tickets',
        title: 'ship · gate 2/2 — approve tickets',
        bodyLines: ['t'],
        recommended: 'confirm',
      })
      expect(prompt.shipGate).toBe(2)
      console.press(key as never)
      await expect(next).resolves.toBe(action)
      expect(prompt.shipGate).toBeUndefined()
      expect(console.viewers.at(-1)).toBeUndefined()
    }
  })

  it('keeps the tickets gate open on e until the revision is typed and taken', async () => {
    const { console, prompt } = (() => {
      const console = fakeConsole(true)
      const prompt = new Prompt(console as never, createTheme(false, {}), sources, {
        interrupt: () => {},
        escape: () => {},
        eof: () => {},
      })
      return { console, prompt }
    })()
    const pending = prompt.gate({
      kind: 'tickets',
      title: 'ship · gate 2/2 — approve tickets',
      bodyLines: ['Ticket 1'],
      recommended: 'confirm',
    })
    console.press({ kind: 'text', text: 'e' })
    expect(prompt.shipGate).toBe(2)
    expect(console.viewers.at(-1)?.join('\n')).toMatch(/[▌_]/u)
    console.press({ kind: 'text', text: 'split ticket 1' })
    console.press({ kind: 'enter' })
    await expect(pending).resolves.toEqual({ kind: 'edit', note: 'split ticket 1' })
    expect(prompt.shipGate).toBeUndefined()
  })
})

describe('ship frontier card', () => {
  const grill = {
    question: 'Which storage?',
    options: [
      { label: 'SQLite', recommended: true as const },
      { label: 'Postgres' },
    ],
  }

  it('paints above the input without setViewer or hiding the timeline', async () => {
    const { prompt, console, calls } = build()
    prompt.setEngaged(true)
    const pending = prompt.frontier(grill)
    const rows = console.draws.at(-1)?.rows ?? []
    expect(rows.some(row => row.includes('Which storage?'))).toBe(true)
    expect(rows.some(row => row.includes('[rec]'))).toBe(true)
    expect(rows.some(row => row.includes('─'))).toBe(true)
    expect(console.viewers).toEqual([])
    expect(console.timelineHidden.at(-1)).toBe(false)
    expect(prompt.shipGate).toBeUndefined()
    console.press({ kind: 'escape' })
    await expect(pending).resolves.toEqual({ kind: 'dismiss' })
    expect(calls).toEqual([])
  })

  it('puts the cursor on a focused write-in field', async () => {
    const { prompt, console } = build()
    const pending = prompt.frontier({
      question: 'Where?',
      options: [
        { label: 'docs/specs/', recommended: true },
        { label: 'Type a path', writeIn: true },
      ],
    })
    console.press({ kind: 'down' })
    const last = console.draws.at(-1)
    expect(last?.cursor.row).toBeGreaterThan(0)
    expect((last?.rows[last.cursor.row] ?? '')).toMatch(/[▌_]/u)
    console.press({ kind: 'escape' })
    await pending
  })

  it('accepts y as the recommended label, and e stays on an inline custom field', async () => {
    const { prompt, console } = build()
    const taking = prompt.frontier(grill)
    console.press({ kind: 'text', text: 'y' })
    await expect(taking).resolves.toEqual({ kind: 'accept', value: 'SQLite' })

    const editing = prompt.frontier(grill)
    console.press({ kind: 'text', text: 'e' })
    const last = console.draws.at(-1)
    expect((last?.rows[last.cursor.row] ?? '')).toMatch(/[▌_]/u)
    console.press({ kind: 'text', text: 'neither' })
    console.press({ kind: 'enter' })
    await expect(editing).resolves.toEqual({ kind: 'accept', value: 'neither', custom: true })
  })
})

describe('comfortable density chrome', () => {
  it('does not add extra idle tip rows or cause status line wrapping on startup or typing', () => {
    const console = fakeConsole(true)
    console.columns = 120
    const prompt = new Prompt(console as never, theme, sources, {
      interrupt: () => {},
      escape: () => {},
      eof: () => {},
    }, 'Ask anything · / for commands · ⇧Tab plan mode')
    prompt.setDensity('comfortable')
    prompt.setStatus('gemini-3.8-flash-high (medium) · ~/my-projects/codsh (main) · ? shortcuts')
    void prompt.read()

    const draws = () => console.draws.at(-1)?.rows ?? []
    // The last row is the status line
    expect(draws().at(-1)).toBe('gemini-3.8-flash-high (medium) · ~/my-projects/codsh (main) · ? shortcuts')
    // No redundant idle tip row above status line
    expect(draws().some(row => row.includes('⇧Tab plan · Ctrl+T todos'))).toBe(false)
    expect(draws().some(row => row.includes('Ctrl+T todos'))).toBe(false)

    const initialRowCount = draws().length

    // Typing in the box does not change row count or drop any wrapping row
    console.press({ kind: 'text', text: 'hello' })
    expect(draws().length).toBe(initialRowCount)
    expect(draws().at(-1)).toBe('gemini-3.8-flash-high (medium) · ~/my-projects/codsh (main) · ? shortcuts')
  })
})
