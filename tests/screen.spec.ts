/**
 * The session's own screen. Owning the viewport means the chrome sits at the
 * bottom by construction, scrolling is ours to implement, and a frame is
 * painted as a whole — the three things the old bottom-region drawing could not
 * guarantee.
 */

import { describe, expect, it } from 'vitest'
import { Screen } from '../src/screen.ts'
import type { ScreenHost } from '../src/screen.ts'

/** A host that records what would be written, at a fixed size. */
function host(rows = 10, columns = 20): ScreenHost & { out: string[]; size: { rows: number; columns: number } } {
  const size = { rows, columns }
  const out: string[] = []
  return {
    out,
    size,
    write: (data: string) => void out.push(data),
    columns: () => size.columns,
    rows: () => size.rows,
  }
}

/** The rows a frame painted, as `row => text`, from the emitted sequences. */
function painted(data: string): Map<number, string> {
  const rows = new Map<number, string>()
  for (const match of data.matchAll(/\u001B\[(\d+);1H\u001B\[K([^\u001B]*)/gu)) {
    rows.set(Number(match[1]), match[2] ?? '')
  }
  return rows
}

/** Everything written since the last checkpoint, joined. */
const flush = (sink: { out: string[] }): string => sink.out.splice(0).join('')

describe('entering and leaving', () => {
  it('takes the alternate screen with mouse reporting, and gives both back', () => {
    const sink = host()
    const screen = new Screen(sink)
    screen.enter()
    const entered = flush(sink)
    expect(entered).toContain('\u001B[?1049h')
    expect(entered).toContain('\u001B[?1002h')
    expect(entered).toContain('\u001B[?1006h')

    screen.leave()
    const left = flush(sink)
    // Mouse and cursor are restored before the buffer swaps back, so the
    // shell never inherits our modes.
    expect(left.indexOf('\u001B[?1006l')).toBeLessThan(left.indexOf('\u001B[?1049l'))
    expect(left).toContain('\u001B[?25h')
  })

  it('leaves once, however many exit paths call it', () => {
    const sink = host()
    const screen = new Screen(sink)
    screen.enter()
    flush(sink)
    screen.leave()
    const first = flush(sink)
    screen.leave()
    expect(first).toContain('\u001B[?1049l')
    expect(flush(sink)).toBe('')
  })

  it('draws nothing before it holds the screen', () => {
    const sink = host()
    const screen = new Screen(sink)
    screen.append(['ignored'])
    screen.setChrome(['box'], { row: 0, column: 0 }, true)
    expect(flush(sink)).toBe('')
  })
})

describe('layout', () => {
  it('puts the chrome on the last rows with an empty transcript', () => {
    const sink = host(6, 20)
    const screen = new Screen(sink)
    screen.enter()
    flush(sink)
    screen.setChrome(['box top', 'box body', 'status'], { row: 1, column: 2 }, true)
    const rows = painted(flush(sink))
    // Six rows, three of chrome: the chrome occupies 4, 5, 6.
    expect(rows.get(4)).toBe('box top')
    expect(rows.get(5)).toBe('box body')
    expect(rows.get(6)).toBe('status')
  })

  it('shows the tail of the transcript above the chrome', () => {
    const sink = host(5, 20)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    flush(sink)
    screen.append(['one', 'two', 'three', 'four', 'five', 'six'])
    const rows = painted(flush(sink))
    // Four viewport rows show the last four lines. The chrome's row is absent
    // from this frame precisely because it did not change — which is the diff
    // doing its job; its placement is pinned by the layout test above.
    expect([rows.get(1), rows.get(2), rows.get(3), rows.get(4)]).toEqual(['three', 'four', 'five', 'six'])
    expect(rows.has(5)).toBe(false)
  })

  it('wraps a line too wide for the viewport instead of overwriting a row', () => {
    const sink = host(4, 10)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    flush(sink)
    // Nine content columns (one is kept clear), so 20 characters take 3 rows.
    screen.append(['x'.repeat(20)])
    const rows = painted(flush(sink))
    expect(rows.get(1)).toBe('x'.repeat(9))
    expect(rows.get(2)).toBe('x'.repeat(9))
    expect(rows.get(3)).toBe('xx')
  })

  it('places the cursor absolutely inside the chrome, or hides it', () => {
    const sink = host(6, 20)
    const screen = new Screen(sink)
    screen.enter()
    flush(sink)
    screen.setChrome(['a', 'b', 'c'], { row: 1, column: 4 }, true)
    // Chrome starts at row 4, so its second row is row 5, column 4 is 5.
    expect(flush(sink)).toContain('\u001B[5;5H\u001B[?25h')

    screen.setChrome(['a', 'b', 'd'], { row: 1, column: 4 }, false)
    const unfocused = flush(sink)
    expect(unfocused).not.toContain('\u001B[?25h')
  })
})

describe('painting', () => {
  it('wraps every frame in a synchronized update', () => {
    const sink = host()
    const screen = new Screen(sink)
    screen.enter()
    flush(sink)
    screen.append(['line'])
    const frame = flush(sink)
    expect(frame.startsWith('\u001B[?2026h')).toBe(true)
    expect(frame.endsWith('\u001B[?2026l')).toBe(true)
  })

  it('repaints only the rows that changed', () => {
    const sink = host(5, 20)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status one'], { row: 0, column: 0 }, false)
    screen.append(['kept', 'kept too'])
    flush(sink)
    screen.setChrome(['status two'], { row: 0, column: 0 }, false)
    const rows = painted(flush(sink))
    // Only the chrome row differs, so the transcript rows are left alone.
    expect([...rows.keys()]).toEqual([5])
    expect(rows.get(5)).toBe('status two')
  })

  it('clears rows a shrunken frame no longer fills', () => {
    const sink = host(5, 20)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['a', 'b', 'c'], { row: 0, column: 0 }, false)
    flush(sink)
    // A shorter chrome leaves the bottom row painted with the old content.
    screen.setChrome(['a'], { row: 0, column: 0 }, false)
    const frame = flush(sink)
    expect(frame).toContain('\u001B[5;1H\u001B[K')
  })
})

describe('scrolling', () => {
  it('detaches from the tail and comes back', () => {
    const sink = host(4, 20)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['one', 'two', 'three', 'four', 'five'])
    flush(sink)

    screen.scrollBy(-2)
    expect(screen.scrolledBy).toBe(2)
    const back = painted(flush(sink))
    expect([back.get(1), back.get(2), back.get(3)]).toEqual(['one', 'two', 'three'])

    screen.scrollToBottom()
    expect(screen.scrolledBy).toBe(0)
    const tail = painted(flush(sink))
    expect([tail.get(1), tail.get(2), tail.get(3)]).toEqual(['three', 'four', 'five'])
  })

  it('cannot scroll past either end', () => {
    const sink = host(4, 20)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['one', 'two', 'three', 'four', 'five'])
    screen.scrollBy(-100)
    // Five lines in a three-row viewport: two rows can be hidden, no more.
    expect(screen.scrolledBy).toBe(2)
    screen.scrollBy(100)
    expect(screen.scrolledBy).toBe(0)
  })

  it('keeps a scrolled reader in place as new lines arrive', () => {
    const sink = host(4, 20)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['one', 'two', 'three', 'four', 'five'])
    screen.scrollBy(-2)
    flush(sink)
    screen.append(['six'])
    // Still two rows from the tail — reading is not yanked forward.
    expect(screen.scrolledBy).toBe(2)
    const rows = painted(flush(sink))
    expect([rows.get(1), rows.get(2), rows.get(3)]).toEqual(['two', 'three', 'four'])
  })
})

describe('resize', () => {
  it('re-wraps at the new width and repaints in full', () => {
    const sink = host(5, 12)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['abcdefghijklmnop'])
    flush(sink)

    sink.size.columns = 6
    screen.resize()
    const rows = painted(flush(sink))
    // Five content columns now: the sixteen characters take four rows, which is
    // exactly the viewport, and a resize repaints every row including the chrome.
    expect([rows.get(1), rows.get(2), rows.get(3), rows.get(4)]).toEqual(['abcde', 'fghij', 'klmno', 'p'])
    expect(rows.get(5)).toBe('status')
  })

  it('clamps a scrolled position that a taller screen makes impossible', () => {
    const sink = host(4, 20)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['one', 'two', 'three', 'four', 'five'])
    screen.scrollBy(-2)
    sink.size.rows = 20
    screen.resize()
    expect(screen.scrolledBy).toBe(0)
  })
})

describe('folds', () => {
  it('shows the summary, swaps to the full form, and back', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['before'])
    screen.appendFold(['summary (Ctrl+O expands)'], ['line 1', 'line 2', 'line 3'])
    screen.append(['after'])
    flush(sink)

    expect(screen.hasFolds).toBe(true)
    expect(screen.toggleFolds()).toBe(true)
    let rows = painted(flush(sink))
    const shown = [...rows.values()].join('\n')
    expect(shown).toContain('line 3')
    expect(shown).not.toContain('summary')

    screen.collapseFolds()
    rows = painted(flush(sink))
    const collapsed = [...rows.values()].join('\n')
    expect(collapsed).toContain('summary (Ctrl+O expands)')
    expect(collapsed).not.toContain('line 2')
  })

  it('toggles every fold, and later content keeps its place', () => {
    const sink = host(12, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.appendFold(['first summary'], ['first full a', 'first full b'])
    screen.append(['between'])
    screen.appendFold(['second summary'], ['second full'])
    flush(sink)
    screen.toggleFolds()
    const text = [...painted(flush(sink)).values()].join('\n')
    // Both folds expanded; the plain line between them stays between them.
    expect(text.indexOf('first full b')).toBeLessThan(text.indexOf('between'))
    expect(text.indexOf('between')).toBeLessThan(text.indexOf('second full'))
    // Toggling back restores both summaries.
    screen.toggleFolds()
    const back = [...painted(flush(sink)).values()].join('\n')
    expect(back).toContain('first summary')
    expect(back).toContain('second summary')
  })

  it('folds back a finished block: expanded now, summary once moved on', () => {
    const sink = host(10, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['answer 1', 'answer 2', 'answer 3', 'answer 4', ''])
    const fresh = [...painted(flush(sink)).values()].join('\n')
    screen.foldBack(5, ['answer 1', '(more)', ''])

    // Nothing changed visually: the block streamed in the open and stays.
    expect(screen.hasFolds).toBe(true)
    expect(fresh).toContain('answer 4')
    expect(flush(sink)).toBe('')

    // Moving on collapses it even though the global state was never expanded.
    screen.collapseFolds()
    const collapsed = [...painted(flush(sink)).values()].join('\n')
    expect(collapsed).toContain('(more)')
    expect(collapsed).not.toContain('answer 4')

    // Ctrl+O brings the full text back, and again away.
    expect(screen.toggleFolds()).toBe(true)
    expect([...painted(flush(sink)).values()].join('\n')).toContain('answer 4')
    screen.toggleFolds()
    expect([...painted(flush(sink)).values()].join('\n')).toContain('(more)')
  })

  it('keeps positions right with folds in mixed states', () => {
    const sink = host(14, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    // A collapsed fold (thinking), a plain line, then a fresh expanded block.
    screen.appendFold(['thought summary'], ['thought a', 'thought b', 'thought c'])
    screen.append(['between'])
    screen.append(['long a', 'long b', 'long c'])
    screen.foldBack(3, ['long head', '(rest)'])
    flush(sink)

    // One Ctrl+O expands the collapsed one; the fresh one already shows full.
    screen.toggleFolds()
    const text = [...painted(flush(sink)).values()].join('\n')
    expect(text.indexOf('thought c')).toBeLessThan(text.indexOf('between'))
    expect(text.indexOf('between')).toBeLessThan(text.indexOf('long a'))
    expect(text).toContain('long c')

    // Collapse both; order still holds and both summaries show.
    screen.collapseFolds()
    const back = [...painted(flush(sink)).values()].join('\n')
    expect(back.indexOf('thought summary')).toBeLessThan(back.indexOf('between'))
    expect(back.indexOf('between')).toBeLessThan(back.indexOf('long head'))
    expect(back).toContain('(rest)')
    expect(back).not.toContain('long c')
  })

  it('refuses a fold back that would overlap an existing fold', () => {
    const sink = host(10, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.appendFold(['s'], ['f1', 'f2'])
    screen.append(['tail'])
    // Claims two lines but the first belongs to the fold above: refused.
    screen.foldBack(2, ['bad'])
    screen.collapseFolds()
    flush(sink)
    expect(screen.toggleFolds()).toBe(true)
    // Only the original fold toggles; 'bad' never entered the transcript.
    const text = [...painted(flush(sink)).values()].join('\n')
    expect(text).toContain('f2')
    expect(text).not.toContain('bad')
  })

  it('has nothing to toggle without folds, and clearing forgets them', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    expect(screen.toggleFolds()).toBe(false)
    screen.appendFold(['s'], ['f'])
    screen.clearTranscript()
    expect(screen.hasFolds).toBe(false)
  })
})
