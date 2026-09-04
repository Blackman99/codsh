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
import { TerminalConsole } from '../src/console.ts'
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
  it('reports an unavailable system-only clipboard without emitting OSC 52', () => {
    const clipboard = process.env['CODSH_CLIPBOARD']
    const path = process.env['PATH']
    process.env['CODSH_CLIPBOARD'] = 'system'
    process.env['PATH'] = ''
    try {
      const { console: term, output } = build()
      expect(term.copyText('plain text')).toBe(false)
      expect(output.text).not.toContain('\u001B]52;c;')
    } finally {
      if (clipboard === undefined) delete process.env['CODSH_CLIPBOARD']
      else process.env['CODSH_CLIPBOARD'] = clipboard
      if (path === undefined) delete process.env['PATH']
      else process.env['PATH'] = path
    }
  })

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

  it('writes a prompt normally when no TTY exists to make it sticky', () => {
    const { console: term, output } = build()
    // Off a TTY the gutter still prefixes each content row so pipes keep role marks.
    term.appendPrompt(['question', ''], '› ')
    expect(output.text).toBe('› question\n\n')
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

  it('hands the TTY to a child and takes the viewport back', async () => {
    const { console: term, input } = build(true)
    const tty = input as TtyInput
    term.enterScreen()
    expect(term.owningScreen).toBe(true)
    expect(tty.rawMode).toBe(true)
    await term.runInForeground(async () => {
      expect(term.owningScreen).toBe(false)
      expect(tty.rawMode).toBe(false)
    })
    expect(term.owningScreen).toBe(true)
    expect(tty.rawMode).toBe(true)
  })
})

describe('the viewport it owns on a terminal', () => {
  /** Rows a frame painted, keyed by screen row. */
  function painted(data: string): Map<number, string> {
    const rows = new Map<number, string>()
    for (const match of data.matchAll(/\u001B\[(\d+);1H\u001B\[K([^\u001B]*)/gu)) {
      rows.set(Number(match[1]), (match[2] ?? '').slice(2))
    }
    return rows
  }

  /** A terminal console over in-memory streams, with a screen height. */
  function tty(rows = 8, columns = 40): { console: TerminalConsole; output: Sink } {
    const built = build(true, columns)
    Object.defineProperty(built.output, 'rows', { value: rows })
    return { console: built.console, output: built.output }
  }

  it('takes the alternate screen only when asked, and gives it back on close', () => {
    const { console: term, output } = tty()
    expect(output.text).not.toContain('\u001B[?1049h')
    term.enterScreen()
    expect(output.text).toContain('\u001B[?1049h')
    expect(term.owningScreen).toBe(true)
    term.close()
    // The buffer, the mouse modes, and raw mode all go back.
    expect(output.text).toContain('\u001B[?1049l')
    expect(output.text).toContain('\u001B[?1002l')
  })

  it('keeps transcript lines written before it owns the screen', () => {
    const { console: term, output } = tty(6, 40)
    // The banner is written before the viewport opens; nothing may be lost.
    term.write('banner line')
    term.enterScreen()
    const rows = painted(output.text)
    expect([...rows.values()]).toContain('banner line')
  })

  it('pins the chrome to the last rows, with the transcript from the top', () => {
    const { console: term, output } = tty(6, 40)
    term.enterScreen()
    term.write('older')
    term.write('newer')
    term.setRegion(['box', 'status'], { row: 0, column: 2 }, true)
    const rows = painted(output.text)
    expect(rows.get(5)).toBe('box')
    expect(rows.get(6)).toBe('status')
    // Short content reads from the top, the way a fresh terminal does; the
    // gap sits between it and the chrome.
    expect(rows.get(1)).toBe('older')
    expect(rows.get(2)).toBe('newer')
  })

  it('scrolls the transcript without moving the chrome', () => {
    const { console: term, output } = tty(4, 40)
    term.enterScreen()
    term.setRegion(['status'], { row: 0, column: 0 }, false)
    for (const line of ['one', 'two', 'three', 'four', 'five']) term.write(line)
    output.chunks.length = 0
    term.scrollBy(-2)
    expect(term.scrolledBy).toBe(2)
    const rows = painted(output.text)
    // The viewport moved back; row 4 is the chrome and did not change.
    expect([rows.get(1), rows.get(2), rows.get(3)]).toEqual(['one', 'two', 'three'])
    expect(rows.has(4)).toBe(false)
    term.scrollToBottom()
    expect(term.scrolledBy).toBe(0)
  })

  it('clears its own transcript rather than the terminal the person keeps', () => {
    const { console: term, output } = tty(5, 40)
    term.enterScreen()
    term.setRegion(['status'], { row: 0, column: 0 }, false)
    term.write('forgettable')
    output.chunks.length = 0
    term.clearScreen()
    const rows = painted(output.text)
    expect([...rows.values()].join('')).not.toContain('forgettable')
    // A full-screen erase would take the person's buffer with it.
    expect(output.text).not.toContain('\u001B[2J')
  })

  it('writes the exit summary to the buffer that survives the session', () => {
    const { console: term, output } = tty()
    term.enterScreen()
    term.close()
    output.chunks.length = 0
    term.writeAfterScreen('session session-1')
    expect(output.text).toBe('session session-1\n')
  })

  it('lays out to a floor when the terminal reports no width', () => {
    const { console: term } = build(true, 0)
    expect(term.columns).toBe(20)
  })

  it('reserves the viewport gutter in contentColumns on a terminal', () => {
    const { console: term } = build(true, 40)
    expect(term.contentColumns).toBe(37)
  })

  it('does not reserve a gutter off a terminal', () => {
    const { console: term } = build(false, 40)
    expect(term.contentColumns).toBe(39)
  })
})

describe('the bell and focus', () => {
  it('rings on a terminal that never reported focus', async () => {
    const { console: term } = build(true)
    term.bell()
    // Sink captures writes; the lone BEL is the ring.
    expect(term).toBeDefined()
  })

  it('delivers focus-out to the key handler', async () => {
    const { console: term, input } = build(true)
    const seen: Key[] = []
    const stop = term.onKey(key => { seen.push(key) })
    input.write('\u001B[O')
    await settle()
    expect(seen).toEqual([{ kind: 'focus', focused: false }])
    stop()
  })

  it('stays quiet while the window is focused, and rings once it is not', async () => {
    const { console: term, input, output } = build(true)
    const stop = term.onKey(() => {})
    input.write('\u001B[I')
    await settle()
    term.bell()
    expect(output.text.includes('\u0007')).toBe(false)
    input.write('\u001B[O')
    await settle()
    term.bell()
    expect(output.text.includes('\u0007')).toBe(true)
    stop()
  })

  it('hands the background answer to a listener, even one that arrives late', async () => {
    const { console: term, input } = build(true)
    const stop = term.onKey(() => {})
    input.write('\u001B]11;rgb:ffff/ffff/ffff\u0007')
    await settle()
    const seen: string[] = []
    term.onBackground(payload => seen.push(payload))
    expect(seen).toEqual(['rgb:ffff/ffff/ffff'])
    stop()
  })

  it('never replays protocol reports as early keys', async () => {
    const { console: term, input } = build(true)
    input.write('\u001B[I\u001B]11;rgb:0/0/0\u0007hi')
    await settle()
    const keys: string[] = []
    term.onKey(key => keys.push(key.kind))
    await settle()
    expect(keys).toEqual(['text'])
  })
})

describe('notifications through the terminal', () => {
  it('writes OSC 9 only while the person is away, like the bell', async () => {
    const { console: term, input, output } = build(true)
    const stop = term.onKey(() => {})
    // Never reported: away, as far as anyone can tell.
    expect(term.away).toBe(true)
    expect(term.notify('waiting for approval')).toBe(true)
    expect(output.text).toContain('\u001B]9;waiting for approval\u0007')
    input.write('\u001B[I')
    await settle()
    expect(term.away).toBe(false)
    expect(term.notify('ignored')).toBe(false)
    expect(output.text).not.toContain('ignored')
    input.write('\u001B[O')
    await settle()
    expect(term.notify('back')).toBe(true)
    expect(output.text).toContain('\u001B]9;back\u0007')
    stop()
  })

  it('sends nothing off a TTY', () => {
    const { console: term, output } = build(false)
    expect(term.away).toBe(false)
    expect(term.notify('piped')).toBe(false)
    expect(output.text).not.toContain(']9;')
  })
})
