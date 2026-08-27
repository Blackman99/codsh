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
  it('pushes the kitty keyboard flag on entry and pops it before leaving', () => {
    const sink = host()
    const screen = new Screen(sink)
    screen.enter()
    const entered = flush(sink)
    expect(entered).toContain('\u001B[>1u')
    expect(entered.indexOf('\u001B[?1049h')).toBeLessThan(entered.indexOf('\u001B[>1u'))
    // Focus reporting and the background question ride the same entry.
    expect(entered).toContain('\u001B[?1004h')
    expect(entered).toContain('\u001B]11;?\u0007')
    screen.leave()
    const left = flush(sink)
    expect(left).toContain('\u001B[<u')
    expect(left).toContain('\u001B[?1004l')
    expect(left.indexOf('\u001B[<u')).toBeLessThan(left.indexOf('\u001B[?1049l'))
  })

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

  it('opens the block a click lands on, and leaves its neighbours folded', () => {
    const sink = host(12, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.appendFold(['first summary', ''], ['first full a', 'first full b', ''])
    screen.appendFold(['second summary', ''], ['second full a', 'second full b', ''])
    flush(sink)

    // Row 1 holds the first summary; pressing and releasing without moving is
    // a click, and a click works that one block.
    screen.mouseDown(1, 3)
    expect(screen.mouseUp()).toBeUndefined()
    const text = [...painted(flush(sink)).values()].join('\n')
    expect(text).toContain('first full b')
    expect(text).not.toContain('first summary')
    // The block below it was not asked for and did not open.
    expect(text).toContain('second summary')
    expect(text).not.toContain('second full a')
  })

  it('folds an open block back from anywhere inside it', () => {
    const sink = host(12, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['above'])
    screen.appendFold(['summary', ''], ['head', 'body', 'tail', ''])
    screen.toggleFolds()
    flush(sink)

    // Row 4 is the middle of the open block, not its head row: a block whose
    // head has scrolled off the top would otherwise have nothing to click.
    screen.mouseDown(4, 2)
    expect(screen.mouseUp()).toBeUndefined()
    const text = [...painted(flush(sink)).values()].join('\n')
    expect(text).toContain('summary')
    expect(text).not.toContain('tail')
  })

  it('leaves a block alone when the click was a drag over it', () => {
    const sink = host(12, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['above'])
    screen.appendFold(['summary', ''], ['head', 'body', 'tail', ''])
    screen.toggleFolds()
    flush(sink)

    // Selecting inside a block is a drag, and a drag hands over its text
    // instead of collapsing what was just read.
    screen.mouseDown(2, 1)
    screen.mouseDrag(3, 4)
    expect(screen.mouseUp()).toBe('head\nbody')
    const text = [...painted(flush(sink)).values()].join('\n')
    expect(text).not.toContain('summary')
  })

  it('still copies a drag that starts on a collapsed block', () => {
    const sink = host(12, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.appendFold(['summary line', ''], ['full a', 'full b', ''])
    flush(sink)

    screen.mouseDown(1, 1)
    screen.mouseDrag(1, 7)
    expect(screen.mouseUp()).toBe('summary')
    // A drag is a selection, not a click: the block stayed shut.
    expect(flush(sink)).not.toContain('full b')
  })

  it('keeps a scrolled reader in place when a block above the tail opens', () => {
    const sink = host(6, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['head 1', 'head 2'])
    screen.appendFold(['summary', ''], ['full a', 'full b', 'full c', ''])
    screen.append(['tail 1', 'tail 2', 'tail 3', 'tail 4', 'tail 5'])
    // Scrolled all the way back: the two head lines, then the summary.
    screen.scrollBy(-9)
    flush(sink)

    screen.mouseDown(3, 1)
    screen.mouseUp()
    const open = painted(flush(sink))
    // The rows above the block did not move; the block grew where it stood.
    expect(open.get(1)).toContain('head 1')
    expect(open.get(2)).toContain('head 2')
    expect(open.get(3)).toContain('full a')

    // And folding it back puts the reader exactly where they started.
    screen.mouseDown(3, 1)
    screen.mouseUp()
    const shut = painted(flush(sink))
    expect(shut.get(1)).toContain('head 1')
    expect(shut.get(3)).toContain('summary')
    expect(shut.get(5)).toContain('tail 1')
  })

  it('folds everything back when a click has already opened it all', () => {
    const sink = host(12, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.appendFold(['summary', ''], ['full a', 'full b', ''])
    screen.mouseDown(1, 2)
    screen.mouseUp()
    flush(sink)

    // Every block is open, so the key closes them rather than doing nothing.
    expect(screen.toggleFolds()).toBe(true)
    const text = [...painted(flush(sink)).values()].join('\n')
    expect(text).toContain('summary')
    expect(text).not.toContain('full b')
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

describe('mouse selection', () => {
  it('highlights the dragged span and hands over its text on release', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['alpha beta', 'gamma delta'])
    flush(sink)

    // Rows 1-2 hold the two lines (content is top-aligned).
    screen.mouseDown(1, 7)
    screen.mouseDrag(2, 5)
    const frame = flush(sink)
    expect(frame).toContain('\u001B[7m')
    const text = screen.mouseUp()
    // From column 7 of the first row through column 5 of the second.
    expect(text).toBe('beta\ngamma')
  })

  it('copies plain text out of styled rows', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append([`\u001B[1mbold words\u001B[0m`])
    screen.mouseDown(1, 1)
    screen.mouseDrag(1, 10)
    expect(screen.mouseUp()).toBe('bold words')
  })

  it('counts columns by display width, so wide characters stay whole', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['中文 text'])
    screen.mouseDown(1, 1)
    // Through display column 4: both wide characters, nothing sliced apart.
    screen.mouseDrag(1, 4)
    expect(screen.mouseUp()).toBe('中文')
  })

  it('ignores a bare click, and a click dismisses a standing highlight', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['some content here'])
    screen.mouseDown(1, 2)
    expect(screen.mouseUp()).toBeUndefined()

    screen.mouseDown(1, 1)
    screen.mouseDrag(1, 5)
    expect(screen.mouseUp()).toBe('some ')
    flush(sink)
    // The highlight stood after the copy; a fresh click clears it.
    screen.mouseDown(1, 2)
    screen.mouseUp()
    expect(flush(sink)).not.toContain('\u001B[7m')
  })

  it('clamps a drag that leaves the content, and a resize voids the selection', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['only row'])
    screen.mouseDown(1, 1)
    // Dragged into the padding far below: the selection ends at the content.
    screen.mouseDrag(6, 30)
    expect(screen.mouseUp()).toBe('only row')

    screen.mouseDown(1, 1)
    screen.mouseDrag(1, 5)
    sink.size.columns = 30
    screen.resize()
    // Reflow voided it: release finds nothing to copy.
    expect(screen.mouseUp()).toBeUndefined()
  })

  it('starts nothing from the chrome or an empty transcript', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.mouseDown(1, 1)
    expect(screen.mouseUp()).toBeUndefined()
    screen.append(['row'])
    // The chrome row (bottom) is not selectable content.
    screen.mouseDown(8, 1)
    screen.mouseDrag(8, 5)
    expect(screen.mouseUp()).toBeUndefined()
  })
})

describe('the block under the pointer', () => {
  it('fills the hovered block and names it', () => {
    const sink = host(10, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['above'])
    screen.appendFold(['summary', ''], ['full one', 'full two', ''], '', 'thinking')
    flush(sink)

    // Row 2 is the block's summary line.
    expect(screen.mouseMove(2, 3)).toEqual({ label: 'thinking', lines: 3, expanded: false })
    expect(flush(sink)).toContain('\u001B[48;5;236msummary')
  })

  it('picks a lighter fill on a light background', () => {
    const sink = host(10, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.appendFold(['summary', ''], ['full'], '', 'thinking')
    screen.setLight(true)
    flush(sink)
    screen.mouseMove(1, 3)
    expect(flush(sink)).toContain('\u001B[48;5;253m')
  })

  it('fills every visible row of the hovered block', () => {
    const sink = host(10, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.appendFold(['summary', ''], ['head', 'body', 'tail', ''], '', 'thinking')
    screen.toggleFolds()
    flush(sink)

    expect(screen.mouseMove(3, 2)?.expanded).toBe(true)
    const frame = flush(sink)
    expect(frame).toContain('\u001B[48;5;236mhead')
    expect(frame).toContain('\u001B[48;5;236mbody')
    expect(frame).toContain('\u001B[48;5;236mtail')
  })

  it('repaints only when the block under the pointer changes', () => {
    const sink = host(10, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['above'])
    screen.appendFold(['summary', ''], ['full one', ''], '', 'thinking')
    flush(sink)

    screen.mouseMove(2, 3)
    expect(flush(sink)).not.toBe('')
    // Moving along the same block: nothing on screen has changed, and motion
    // arrives a report per cell crossed.
    expect(screen.mouseMove(2, 4)).toEqual({ label: 'thinking', lines: 2, expanded: false })
    expect(flush(sink)).toBe('')

    // Off the block, the mark goes with it.
    expect(screen.mouseMove(1, 2)).toBeUndefined()
    const frame = flush(sink)
    expect(frame).not.toContain('\u001B[48;5;')
    expect(painted(frame).get(2)).toBe('summary')
  })

  it('still names a block whose head row is off the top of the screen', () => {
    const sink = host(6, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    // Taller than the viewport once open, which is the case the readout exists
    // for: there is no head row on screen to mark or to aim a click at.
    const full = Array.from({ length: 12 }, (_, index) => `line ${index}`)
    screen.appendFold(['summary'], full, '', 'Bash(pnpm test)')
    screen.toggleFolds()
    flush(sink)

    expect(screen.mouseMove(2, 3)).toEqual({ label: 'Bash(pnpm test)', lines: 12, expanded: true })
    // The head is off the top; the visible body of the same block is still marked.
    expect(flush(sink)).toContain('\u001B[48;5;')
  })

  it('forgets the block it was on when the transcript is cleared', () => {
    const sink = host(10, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.appendFold(['summary', ''], ['full one', ''], '', 'thinking')
    screen.mouseMove(1, 3)
    flush(sink)
    screen.clearTranscript()
    screen.append(['fresh'])
    // A mark held over a cleared buffer would point at a block that is gone.
    expect(flush(sink)).not.toContain('\u001B[48;5;')
  })
})

describe('the rule down a block\'s edge', () => {
  it('repeats the rule on every row a line wraps to', () => {
    const sink = host(5, 12)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    flush(sink)
    // Eleven content columns, two of them the rule's, so nine characters fit a
    // row — and the rule is on the continuation too, or the edge breaks exactly
    // where a long line made it matter.
    screen.append(['x'.repeat(20)], '| ')
    const rows = painted(flush(sink))
    expect(rows.get(1)).toBe(`| ${'x'.repeat(9)}`)
    expect(rows.get(2)).toBe(`| ${'x'.repeat(9)}`)
    expect(rows.get(3)).toBe('| xx')
  })

  it('leaves the blank line between blocks unmarked', () => {
    const sink = host(5, 20)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    flush(sink)
    screen.append(['head', ''], '| ')
    const rows = painted(flush(sink))
    expect(rows.get(1)).toBe('| head')
    // A lone mark hanging under the block it ended would read as a row of it.
    // An unchanged empty row is not repainted at all, which says the same thing.
    expect(rows.get(2) ?? '').toBe('')
  })

  it('hands over the text without the rule it swept across', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['alpha beta', 'gamma delta'], '| ')
    flush(sink)
    screen.mouseDown(1, 1)
    screen.mouseDrag(2, 40)
    // The rule is a mark this surface drew, not text anyone typed.
    expect(screen.mouseUp()).toBe('alpha beta\ngamma delta')
  })

  it('keeps a block\'s rule across a fold toggle', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.appendFold(['summary'], ['full one', 'full two'], '| ')
    flush(sink)
    screen.toggleFolds()
    const rows = painted(flush(sink))
    expect(rows.get(1)).toBe('| full one')
    expect(rows.get(2)).toBe('| full two')
  })

  it('works a ruled block on a click, under the rule it was drawn with', () => {
    const sink = host(10, 12)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    // Two of the eleven content columns are the rule's, so this line takes
    // three rows rather than two — and the block under it starts one row lower
    // than a measure that forgot the rule would say.
    screen.append(['x'.repeat(20)], '| ')
    screen.appendFold(['summary'], ['full one', 'full two'], '| ')
    flush(sink)

    // Row 4 is where the block starts, so a click there works it — and both
    // forms come back under the rule the block was drawn with.
    screen.mouseDown(4, 3)
    expect(screen.mouseUp()).toBeUndefined()
    let rows = painted(flush(sink))
    expect(rows.get(4)).toBe('| full one')
    expect(rows.get(5)).toBe('| full two')

    // Open, only that same head row folds it back.
    screen.mouseDown(4, 3)
    expect(screen.mouseUp()).toBeUndefined()
    rows = painted(flush(sink))
    expect(rows.get(4)).toBe('| summary')
  })

  it('folds a finished block back under the rule it was drawn with', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['status'], { row: 0, column: 0 }, false)
    screen.append(['one', 'two', ''], '| ')
    screen.foldBack(3, ['summary', ''])
    screen.collapseFolds()
    flush(sink)
    screen.toggleFolds()
    const rows = painted(flush(sink))
    expect(rows.get(1)).toBe('| one')
  })
})

describe('transcript search', () => {
  it('finds hits newest-first and steps without changing the text', () => {
    const sink = host(8, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['box'], { row: 0, column: 0 }, false)
    screen.append(['alpha line', 'bravo line', 'alpha again'])
    const first = screen.searchTranscript('alpha')
    expect(first).toEqual({ query: 'alpha', hits: 2, index: 1 })
    const next = screen.nextTranscriptHit(-1)
    expect(next).toEqual({ query: 'alpha', hits: 2, index: 0 })
    const frame = flush(sink)
    expect(frame).toContain('alpha')
    screen.clearTranscriptSearch()
    expect(screen.transcriptSearch).toBeUndefined()
    expect(flush(sink)).toContain('alpha')
  })

  it('scrolls an off-screen hit into view', () => {
    const sink = host(6, 40)
    const screen = new Screen(sink)
    screen.enter()
    screen.setChrome(['box'], { row: 0, column: 0 }, false)
    screen.append(['needle', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(screen.scrolledBy).toBe(0)
    screen.searchTranscript('needle')
    expect(screen.transcriptSearch?.hits).toBe(1)
    expect(screen.scrolledBy).toBeGreaterThan(0)
  })

  it('forgets find when the transcript is cleared', () => {
    const sink = host()
    const screen = new Screen(sink)
    screen.enter()
    screen.append(['needle'])
    screen.searchTranscript('needle')
    screen.clearTranscript()
    expect(screen.transcriptSearch).toBeUndefined()
  })
})
