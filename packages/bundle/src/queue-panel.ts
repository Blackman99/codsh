/**
 * The queue's own surface: the collapsed readout parked under the input, the
 * steering row for a message sent mid-turn, and the `QueuePanel` a person
 * opens with {@link QUEUE_KEY} to look at, edit, reorder, steer, or drop what
 * is waiting.
 *
 * Pure state and pure rendering, like the selector and the todo readout: keys
 * and items in, an action or rows out. The panel owns only where the mark and
 * the window sit — the queue itself, and what a settled action does to it,
 * belong to whoever wires this in.
 * @module codsh-bundle/src/queue-panel
 */

import { displayWidth, truncate } from './theme.ts'
import type { Key } from './keys.ts'
import type { QueueItem } from './queue.ts'
import type { Theme } from './theme.ts'

/** What one key did to the panel. */
export type PanelAction =
  | { kind: 'pending' }
  | { kind: 'close' }
  | { kind: 'edit'; id: number }
  | { kind: 'remove'; id: number }
  | { kind: 'move'; id: number; delta: -1 | 1 }
  | { kind: 'steer'; id: number }

/** What a pointer is over, in the panel's own row space. */
export type PanelTarget = { kind: 'header' } | { kind: 'item'; index: number } | { kind: 'footer' }

/** Items shown at once before the list windows. */
export const QUEUE_ROWS = 8

/** The chord that opens and closes the panel, named in the readout's trailer. */
export const QUEUE_KEY = 'Ctrl+Q'

/** An item's first line: what tells one queued line from the next at a glance. */
function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

/**
 * Fit `body` and `trailer` into one row, shrinking the preview before the key.
 *
 * The preview is what a glance needs; the key is a convenience it can go
 * without. Cutting the key first would leave `Ctrl+Q` legible while the work
 * it names is unreadable, which is backwards for a row whose only job is to
 * say what is queued — so the preview is truncated down to a two-column
 * minimum before the key is dropped at all.
 * @param body - the row up to the trailer, unstyled.
 * @param trailer - the trailing key hint, unstyled, its separator included.
 * @param columns - display columns the whole row may use.
 * @returns the row, never wrapped.
 */
function fitTrailer(body: string, trailer: string, columns: number): string {
  const withTrailer = `${body}${trailer}`
  if (displayWidth(withTrailer) <= columns) return withTrailer
  const budget = columns - displayWidth(trailer)
  if (budget >= 2) return `${truncate(body, budget)}${trailer}`
  return truncate(body, columns)
}

/**
 * The collapsed readout: what is queued, named in one line under the input.
 *
 * One item names itself directly (`queued: …`); several are counted first, so
 * a glance tells "one more thought" from "a pile building up" without reading
 * the previews. `queued: <text>` stays one contiguous span — dim wraps the
 * whole row rather than each piece — so a PTY wait can match it as raw bytes,
 * the same discipline the todo row's hint keeps.
 * @param items - the queue, in order.
 * @param theme - styling for the row.
 * @param columns - display columns available; a longer row is cut, never wrapped.
 * @returns the row, or undefined when nothing is queued.
 */
export function queueRow(items: readonly QueueItem[], theme: Theme, columns: number): string | undefined {
  if (items.length === 0) return undefined
  const previews = items.map(item => firstLine(item.text)).join(' · ')
  const body = items.length === 1 ? `  ↳ queued: ${previews}` : `  ↳ ${items.length} queued: ${previews}`
  const trailer = ` · ${QUEUE_KEY}`
  return theme.dim(fitTrailer(body, trailer, columns))
}

/**
 * The row for a steer in flight: what was sent into the running turn, while
 * it is still on its way rather than merely queued for the next one.
 * @param text - the steered submission, as typed.
 * @param theme - styling for the row.
 * @param columns - display columns available; a longer row is cut, never wrapped.
 * @returns the row.
 */
export function steeringRow(text: string, theme: Theme, columns: number): string {
  const row = `${theme.dim('  ↳ ')}${theme.pending('steering:')}${theme.dim(` ${firstLine(text)}`)}`
  return truncate(row, columns)
}

/**
 * Why `s` did nothing, for the owner to flash beside the panel.
 *
 * The kind check comes first: a `!` or `/` line can never steer, turn running
 * or not, so that is the more useful thing to say about it. Only once the item
 * itself could steer does whether a turn is running matter.
 * @param item - the marked item, or undefined for an empty list.
 * @param canSteer - whether a turn is running to steer into.
 * @returns the reason, or undefined when `s` would have worked.
 */
export function steerRefusal(item: QueueItem | undefined, canSteer: boolean): string | undefined {
  if (item === undefined) return undefined
  if (item.kind !== 'prompt') return 'only a message can steer — ! and / lines run in their turn'
  if (!canSteer) return 'nothing is running — it stays queued'
  return undefined
}

/**
 * The list widget a person opens on the queue: what to edit, reorder, steer,
 * or drop before it drains into a turn.
 *
 * State mirrors {@link import('./selector.ts').Selector}: a marked row Enter
 * would act on, a window that follows it, and a wheel-scrolled window that
 * springs back on the next key — because a list scrolled away from what a key
 * would act on answers a question nobody asked. The mark lives in row space
 * (an index into `items`), never in the id space the queue itself uses, so a
 * drain or a reorder elsewhere is read fresh on the next call rather than
 * chased here.
 */
export class QueuePanel {
  private mark_ = 0
  private hovered: PanelTarget | undefined
  private scrolled: number | undefined

  /**
   * Start over: mark on the first item, no hover, window at the top.
   * Call when the panel opens, so a stale mark from the last time it was
   * open never shows through.
   */
  reset(): void {
    this.mark_ = 0
    this.hovered = undefined
    this.scrolled = undefined
  }

  /** Row index relative to the panel's first row → what sits there. */
  get mark(): number {
    return this.mark_
  }

  /**
   * Clamp the mark and the scrolled window to the current list, so a queue
   * that drained under an open panel — the running turn finished a line, or
   * another key removed one — never leaves either pointed past the end.
   */
  private clamp(items: readonly QueueItem[]): void {
    const last = Math.max(0, items.length - 1)
    this.mark_ = Math.min(Math.max(0, this.mark_), last)
    if (this.scrolled !== undefined) {
      this.scrolled = Math.min(Math.max(0, this.scrolled), Math.max(0, items.length - QUEUE_ROWS))
    }
  }

  /** First row of the window: where the wheel left it, else following the mark. */
  private windowStart(items: readonly QueueItem[]): number {
    const following = Math.min(Math.max(0, this.mark_ - QUEUE_ROWS + 1), Math.max(0, items.length - QUEUE_ROWS))
    return this.scrolled ?? following
  }

  /**
   * Move the window only, not the mark. Wheel: mouse-driven, so it must never
   * decide what a key would act on.
   * @param delta - rows to move by; negative scrolls towards the top.
   * @param items - the queue, in order.
   */
  scrollBy(delta: number, items: readonly QueueItem[]): void {
    this.clamp(items)
    const limit = Math.max(0, items.length - QUEUE_ROWS)
    this.scrolled = Math.min(limit, Math.max(0, this.windowStart(items) + delta))
  }

  /** Mark the row the pointer rests on, or none. */
  setHovered(target: PanelTarget | undefined): void {
    this.hovered = target
  }

  /**
   * What sits on one row of {@link view}'s output.
   * @param row - a row index within this panel's own rows, header at zero.
   * @param items - the queue, in order.
   * @returns what the row offers, or undefined for a row that offers nothing.
   */
  targetAt(row: number, items: readonly QueueItem[]): PanelTarget | undefined {
    this.clamp(items)
    if (items.length === 0) return undefined
    if (row === 0) return { kind: 'header' }
    let at = 1
    const first = this.windowStart(items)
    if (first > 0) at += 1
    const shown = Math.min(items.length, first + QUEUE_ROWS) - first
    const below = items.length - first - shown
    const footerRow = at + shown + (below > 0 ? 1 : 0)
    if (row === footerRow) return { kind: 'footer' }
    if (row < at || row >= at + shown) return undefined
    return { kind: 'item', index: first + (row - at) }
  }

  /**
   * A press+release on a target: an item edits, the way a click settles a
   * single-select row in {@link import('./selector.ts').Selector}; header and
   * footer are the way out, same as Escape.
   * @param target - the row chosen.
   * @param items - the queue, in order.
   * @returns the action the click took.
   */
  click(target: PanelTarget, items: readonly QueueItem[]): PanelAction {
    this.clamp(items)
    if (target.kind !== 'item') return { kind: 'close' }
    const item = items[target.index]
    if (item === undefined) return { kind: 'pending' }
    this.mark_ = target.index
    return { kind: 'edit', id: item.id }
  }

  /**
   * Apply one key.
   * @param key - the decoded keystroke.
   * @param items - the queue, in order.
   * @param canSteer - whether a turn is running to steer into.
   * @returns the action the key took.
   */
  handle(key: Key, items: readonly QueueItem[], canSteer: boolean): PanelAction {
    this.clamp(items)
    // The wheel moves the window only; every other key below snaps it back to
    // the mark, so scrolling to look around never decides what Enter takes.
    if (key.kind === 'scroll' && key.at !== undefined) {
      this.scrollBy(key.lines, items)
      return { kind: 'pending' }
    }
    this.scrolled = undefined
    switch (key.kind) {
      case 'up':
        if (items.length === 0) return { kind: 'pending' }
        this.mark_ = (this.mark_ - 1 + items.length) % items.length
        return { kind: 'pending' }
      case 'down':
      case 'tab':
        if (items.length === 0) return { kind: 'pending' }
        this.mark_ = (this.mark_ + 1) % items.length
        return { kind: 'pending' }
      case 'home':
        this.mark_ = 0
        return { kind: 'pending' }
      case 'end':
        this.mark_ = Math.max(0, items.length - 1)
        return { kind: 'pending' }
      case 'enter':
        return this.edit(items)
      case 'delete':
        return this.removeMarked(items)
      case 'scroll':
        // Shift+Up/Down, at-less: reorder the marked item, and follow it so a
        // second press keeps moving the same line rather than its neighbour.
        return this.moveMarked(key.lines < 0 ? -1 : 1, items)
      case 'text':
        return this.typed(key.text, items, canSteer)
      case 'escape':
      case 'toggle-queue':
        return { kind: 'close' }
      default:
        return { kind: 'pending' }
    }
  }

  /**
   * Resolve a typed character.
   *
   * A digit jumps the mark to that row without acting on it — a deliberate
   * divergence from {@link import('./selector.ts').Selector}, where a digit is
   * itself an answer: this list offers four verbs per row, so a digit can only
   * ever pick which row they apply to, and the verb is a separate key.
   * @param text - what was typed.
   * @param items - the queue, in order.
   * @param canSteer - whether a turn is running to steer into.
   * @returns the action the key took.
   */
  private typed(text: string, items: readonly QueueItem[], canSteer: boolean): PanelAction {
    const digit = Number(text)
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9 && digit <= items.length) {
      this.mark_ = digit - 1
      return { kind: 'pending' }
    }
    const letter = text.toLowerCase()
    if (letter === 'e') return this.edit(items)
    if (letter === 'd') return this.removeMarked(items)
    if (letter === 's') return this.steerMarked(items, canSteer)
    return { kind: 'pending' }
  }

  private edit(items: readonly QueueItem[]): PanelAction {
    const item = items[this.mark_]
    return item === undefined ? { kind: 'pending' } : { kind: 'edit', id: item.id }
  }

  private removeMarked(items: readonly QueueItem[]): PanelAction {
    const item = items[this.mark_]
    return item === undefined ? { kind: 'pending' } : { kind: 'remove', id: item.id }
  }

  private steerMarked(items: readonly QueueItem[], canSteer: boolean): PanelAction {
    const item = items[this.mark_]
    if (item === undefined) return { kind: 'pending' }
    return canSteer && item.kind === 'prompt' ? { kind: 'steer', id: item.id } : { kind: 'pending' }
  }

  /**
   * Move the marked item past its neighbour, and move the mark with it, so a
   * second Shift+Up keeps walking the line the person is looking at rather
   * than the one that used to be above it.
   */
  private moveMarked(delta: -1 | 1, items: readonly QueueItem[]): PanelAction {
    const item = items[this.mark_]
    if (item === undefined) return { kind: 'pending' }
    const to = this.mark_ + delta
    if (to < 0 || to >= items.length) return { kind: 'pending' }
    this.mark_ = to
    return { kind: 'move', id: item.id, delta }
  }

  /**
   * Render the panel: the header, the windowed list, and the footer.
   * @param items - the queue, in order.
   * @param theme - styling for the marks and text.
   * @param columns - display columns available; longer rows are cut.
   * @param canSteer - whether a turn is running to steer into.
   * @returns the rows, empty when there is nothing queued.
   */
  view(items: readonly QueueItem[], theme: Theme, columns: number, canSteer: boolean): string[] {
    this.clamp(items)
    if (items.length === 0) return []
    const rows: string[] = [truncate(this.header(items, theme), columns)]
    const first = this.windowStart(items)
    if (first > 0) rows.push(truncate(theme.dim(`  ↑ ${first} more`), columns))
    const shown = Math.min(items.length, first + QUEUE_ROWS)
    for (let index = first; index < shown; index += 1) {
      const item = items[index]
      if (item !== undefined) rows.push(truncate(this.row(index, item, theme), columns))
    }
    const below = items.length - shown
    if (below > 0) rows.push(truncate(theme.dim(`  ↓ ${below} more`), columns))
    rows.push(truncate(this.footer(theme, canSteer), columns))
    return rows
  }

  /** `queue k · Ctrl+Q closes`, count and hint dim — todos header parity. */
  private header(items: readonly QueueItem[], theme: Theme): string {
    return `  ${theme.tool('queue')} ${theme.dim(`${items.length} · ${QUEUE_KEY} closes`)}`
  }

  /**
   * One rendered row: the mark or the pointer's dot, the row's number within
   * the whole list, and the item's first line — with a dim tail counting the
   * rest when it carries more than one.
   */
  private row(index: number, item: QueueItem, theme: Theme): string {
    const marked = index === this.mark_
    const hoveredHere = !marked && this.hovered?.kind === 'item' && this.hovered.index === index
    const marker = marked ? theme.bold(theme.accent('❯')) : hoveredHere ? theme.dim('·') : ' '
    const number = theme.dim(`${index + 1}.`)
    const lines = item.text.split('\n')
    const extra = lines.length > 1 ? theme.dim(` ⏎ +${lines.length - 1} lines`) : ''
    const label = lines[0] ?? ''
    const body = marked ? theme.bold(theme.accent(label)) : label
    return `  ${marker} ${number} ${body}${extra}`
  }

  /** Take / edit / delete / move / back chrome, `[s] steer` only while a turn runs. */
  private footer(theme: Theme, canSteer: boolean): string {
    const parts = [
      '[enter] edit',
      '[d] delete',
      ...canSteer ? ['[s] steer'] : [],
      '[⇧↑↓] move',
      '[esc] back',
    ]
    return `    ${theme.dim(parts.join(' · '))}`
  }
}
