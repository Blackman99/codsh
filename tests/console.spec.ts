/**
 * The terminal in its two shapes.
 *
 * Off a terminal it queues lines, because input can arrive before anything asks
 * for it and every line in a piped script is a separate instruction. On one it
 * owns the keyboard and a region of rows at the bottom, which the transcript has
 * to write around.
 */

import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { TerminalConsole, rewrappedHeight } from '../src/console.ts'
import type { Key } from '../src/keys.ts'

/** Collects everything the console writes. */
class Sink extends PassThrough {
  readonly chunks: string[] = []
  override write(chunk: never): boolean {
    this.chunks.push(String(chunk))
    return true
  }

  get text(): string {
    return this.chunks.join('')
  }
}

/** A PassThrough that claims to be a terminal and accepts raw mode. */
class TtyInput extends PassThrough {
  readonly isTTY = true
  rawMode = false
  setRawMode(mode: boolean): this {
    this.rawMode = mode
    return this
  }
}

/**
 * Build a console over in-memory streams.
 * @param tty - whether both streams should look like a terminal.
 * @param columns - reported terminal width.
 * @returns the console and its streams.
 */
function build(tty = false, columns?: number): { console: TerminalConsole; input: PassThrough; output: Sink } {
  const input = tty ? new TtyInput() : new PassThrough()
  const output = new Sink()
  if (tty) Object.defineProperty(output, 'isTTY', { value: true })
  if (columns !== undefined) Object.defineProperty(output, 'columns', { value: columns })
  return { console: new TerminalConsole(input, output as never), input, output }
}

/** Yield to the event loop so stream events land. */
const settle = (): Promise<void> => new Promise(resolve => void setImmediate(resolve))

describe('piped input', () => {
  it('serves lines that arrived before the first read', async () => {
    const { console: term, input } = build()
    input.write('first\nsecond\n')
    await settle()
    expect(await term.readLine()).toBe('first')
    expect(await term.readLine()).toBe('second')
  })

  it('waits for input that has not arrived yet', async () => {
    const { console: term, input } = build()
    const reading = term.readLine()
    await settle()
    input.write('later\n')
    expect(await reading).toBe('later')
  })

  it('keeps every line separate, because each is its own instruction', async () => {
    const { console: term, input } = build()
    input.write('one\ntwo\n')
    await settle()
    expect(await term.readLine()).toBe('one')
    expect(await term.readLine()).toBe('two')
  })

  it('answers undefined once input ends', async () => {
    const { console: term, input } = build()
    input.end()
    await settle()
    expect(await term.readLine()).toBeUndefined()
  })

  it('releases a waiting read when its signal aborts', async () => {
    const { console: term } = build()
    const controller = new AbortController()
    const reading = term.readLine(controller.signal)
    await settle()
    controller.abort()
    expect(await reading).toBeUndefined()
  })

  it('serves reads in the order they were requested', async () => {
    const { console: term, input } = build()
    const first = term.readLine()
    const second = term.readLine()
    await settle()
    input.write('a\nb\n')
    expect(await first).toBe('a')
    expect(await second).toBe('b')
  })

  it('draws no region, which would be permanent noise in a redirected transcript', () => {
    const { console: term, output } = build()
    term.setRegion(['a box'], { row: 0, column: 0 })
    term.write('a finished line')
    expect(output.text).toBe('a finished line\n')
  })

  it('owns no keyboard', () => {
    expect(build().console.readsKeys).toBe(false)
  })
})

describe('terminal input', () => {
  it('takes raw mode and asks the terminal to mark pastes', () => {
    const { console: term, input, output } = build(true)
    expect(term.readsKeys).toBe(true)
    expect((input as TtyInput).rawMode).toBe(true)
    expect(output.text).toContain('\u001B[?2004h')
  })

  it('dispatches decoded keys', async () => {
    const { console: term, input } = build(true)
    const keys: Key[] = []
    term.onKey(key => void keys.push(key))
    input.write('hi\r')
    await settle()
    expect(keys).toEqual([{ kind: 'text', text: 'hi' }, { kind: 'enter' }])
  })

  it('resolves a held Escape once nothing follows it', async () => {
    const { console: term, input } = build(true)
    const keys: Key[] = []
    term.onKey(key => void keys.push(key))
    input.write('\u001B')
    await settle()
    // Still ambiguous: it could be the start of an arrow key.
    expect(keys).toEqual([])
    await new Promise(resolve => void setTimeout(resolve, 60))
    expect(keys).toEqual([{ kind: 'escape' }])
  })

  it('restores the terminal on close', () => {
    const { console: term, input, output } = build(true)
    term.close()
    expect((input as TtyInput).rawMode).toBe(false)
    expect(output.text).toContain('\u001B[?2004l')
  })
})

describe('the bottom region', () => {
  it('draws its rows and leaves the cursor among them', () => {
    const { console: term, output } = build(true, 40)
    term.setRegion(['top', 'middle', 'bottom'], { row: 1, column: 3 })
    const drawn = output.text
    expect(drawn).toContain('top')
    expect(drawn).toContain('bottom')
    // One row back up from the last, then three columns across.
    expect(drawn).toContain('\u001B[1A')
    expect(drawn).toContain('\u001B[3C')
  })

  it('erases the previous rows before drawing again', () => {
    const { console: term, output } = build(true, 40)
    term.setRegion(['one', 'two'], { row: 1, column: 0 })
    output.chunks.length = 0
    term.setRegion(['three'], { row: 0, column: 0 })
    // Back to the region's first row, then clear everything below it.
    expect(output.text).toContain('\u001B[1A')
    expect(output.text).toContain('\u001B[0J')
    expect(output.text).toContain('three')
  })

  it('writes a transcript line above the region and puts it back', () => {
    const { console: term, output } = build(true, 40)
    term.setRegion(['the box'], { row: 0, column: 0 })
    output.chunks.length = 0
    term.write('a finished line')
    const written = output.text
    expect(written).toContain('a finished line\n')
    // The region reappears beneath what was just kept.
    expect(written.lastIndexOf('the box')).toBeGreaterThan(written.indexOf('a finished line'))
  })

  it('cuts a row to keep it off the wrap, which would break the erase', () => {
    const { console: term, output } = build(true, 20)
    term.setRegion(['x'.repeat(60)], { row: 0, column: 0 })
    // Escapes and the carriage return occupy no column.
    const visible = output.text.replaceAll(/\u001B\[[0-9;?]*[A-Za-z]/gu, '').replaceAll('\r', '')
    for (const line of visible.split('\n')) expect(line.length).toBeLessThanOrEqual(19)
  })

  it('leaves nothing behind when cleared', () => {
    const { console: term, output } = build(true, 40)
    term.setRegion(['the box'], { row: 0, column: 0 })
    output.chunks.length = 0
    term.clearRegion()
    expect(output.text).toContain('\u001B[0J')
    // With the region gone, a write is a plain append again.
    output.chunks.length = 0
    term.write('plain')
    expect(output.text).toBe('plain\n')
  })

  it('lays out to a floor when the terminal reports no width', () => {
    const { console: term } = build(true, 0)
    expect(term.columns).toBe(20)
  })
})

describe('bottom anchoring and resize recovery', () => {
  it('anchors a fresh region to the last screen row', () => {
    const { console: term, output } = build(true, 40)
    term.setRegion(['the box'], { row: 0, column: 0 })
    expect(output.text).toContain('\u001B[9999;1H')
    // A redraw of a live region moves relatively; it must not re-anchor.
    output.chunks.length = 0
    term.setRegion(['the box', 'status'], { row: 0, column: 0 })
    expect(output.text).not.toContain('\u001B[9999;1H')
  })

  it('re-anchors after a clear, which is how Ctrl-L keeps the box at the bottom', () => {
    const { console: term, output } = build(true, 40)
    term.setRegion(['the box'], { row: 0, column: 0 })
    term.clearScreen()
    output.chunks.length = 0
    term.setRegion(['the box'], { row: 0, column: 0 })
    expect(output.text).toContain('\u001B[9999;1H')
  })

  it('recovers from a resize with an absolute erase, never a relative one', async () => {
    const { console: term, output } = build(true, 40)
    Object.defineProperty(output, 'rows', { value: 30 })
    term.setRegion(['x'.repeat(35), 'status'], { row: 1, column: 0 })
    output.chunks.length = 0
    output.emit('resize')
    await settle()
    // Two rows of width ≤39 at the (unchanged) fake width of 40 → estimate 2,
    // plus 2 slack rows: clear from row 27 of 30 downwards, absolutely.
    expect(output.text).toContain('\u001B[27;1H\u001B[0J')
    // The next draw is fresh and anchors to the bottom again.
    output.chunks.length = 0
    term.setRegion(['the box'], { row: 0, column: 0 })
    expect(output.text).toContain('\u001B[9999;1H')
  })
})

describe('rewrappedHeight', () => {
  it('counts the lines rows refold into at a narrower width', () => {
    // 70 wide at 30 columns → 3 lines; 10 wide → 1; an empty row is still 1.
    expect(rewrappedHeight([70, 10, 0], 30)).toBe(5)
  })

  it('never divides by a zero-width terminal', () => {
    expect(rewrappedHeight([5], 0)).toBe(5)
  })
})
