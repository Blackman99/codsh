/**
 * The type-ahead queue: what a person submits while the agent is busy.
 *
 * Every item is what the box held at Enter — a prompt, a `!` shell line, or a
 * `/` command — with the images its tokens claimed. Adjacent prompts leave
 * the queue as ONE message, joined by a blank line: three thoughts typed
 * while waiting were meant as one turn, not three. A `!` or `/` line is a
 * boundary and leaves alone, in its place, so the shell output lands between
 * the thoughts it separated rather than after all of them.
 *
 * Pure: no console, no theme, no agent. `Prompt` wires it, and the queue panel
 * reads it. The dsh inbox is not mirrored here — it holds only steers.
 * @module codsh-bundle/src/queue
 */

import type { PendingImage } from './prompt.ts'

/** What a queued line is: a message for the model, a shell line, or a command. */
export type QueueItemKind = 'prompt' | 'bang' | 'command'

/** One submission held for a later turn. */
export interface QueueItem {
  /** Surface-local, monotonic per queue; never reused, so a panel row cannot name a later item. */
  readonly id: number
  readonly kind: QueueItemKind
  /** As typed, `[Image #N]` tokens included. */
  readonly text: string
  /** Claimed at Enter, so a paste made afterwards belongs to the next line. */
  readonly images: PendingImage[]
}

/** The loop's next unit of work: one boundary item, or a merged run of prompts. */
export interface Drained {
  readonly kind: QueueItemKind
  readonly text: string
  readonly images: PendingImage[]
  /** The items that went into it, in order. */
  readonly ids: number[]
}

/** Between merged prompts: a paragraph break, so the model reads each as its own thought. */
export const PROMPT_JOINER = '\n\n'

/**
 * Read a submission's kind the way the main loop dispatches it.
 * @param text - the submission, as typed.
 * @returns bang for a `!` line, command for a `/` line, prompt otherwise.
 */
export function classify(text: string): QueueItemKind {
  const trimmed = text.trim()
  if (trimmed.startsWith('!')) return 'bang'
  if (trimmed.startsWith('/')) return 'command'
  return 'prompt'
}

/**
 * Join a run of prompts into the one message they leave as.
 * @param items - adjacent prompt items, in queue order.
 * @returns the joined text and every item's images, in order.
 */
export function mergePrompts(items: readonly QueueItem[]): { text: string; images: PendingImage[] } {
  return {
    text: items.map(item => item.text).join(PROMPT_JOINER),
    images: items.flatMap(item => item.images),
  }
}

/** The ordered type-ahead, with the operations the panel and the loop need. */
export class MessageQueue {
  private readonly list: QueueItem[] = []
  private nextId = 1

  /** Ordered snapshot for the panel and the chrome row. */
  get items(): readonly QueueItem[] {
    return this.list
  }

  get length(): number {
    return this.list.length
  }

  /**
   * Mint an item without queueing it, for a submission that steers instead.
   * @param text - the submission.
   * @param images - the images its tokens claimed.
   * @returns the item, with an id no other item has had.
   */
  make(text: string, images: PendingImage[]): QueueItem {
    const id = this.nextId
    this.nextId += 1
    return { id, kind: classify(text), text, images }
  }

  /**
   * Hold a submission for the next read.
   * @param text - the submission.
   * @param images - the images its tokens claimed.
   * @returns the queued item.
   */
  push(text: string, images: PendingImage[]): QueueItem {
    const item = this.make(text, images)
    this.list.push(item)
    return item
  }

  /** Put an item first: a steer that came back goes before anything typed since. */
  unshift(item: QueueItem): void {
    this.list.unshift(item)
  }

  /** Put an already-minted item last: a line that asked to steer but could not. */
  append(item: QueueItem): void {
    this.list.push(item)
  }

  /**
   * Take the next unit of work.
   *
   * A boundary — a `!` or `/` line — leaves alone. A prompt takes every prompt
   * adjacent to it, so `a, !ls, b, c` drains as `a`, then `!ls`, then `b` with
   * `c`: the shell line keeps its place between the thoughts.
   * @returns what leaves, or undefined when nothing is queued.
   */
  drain(): Drained | undefined {
    const head = this.list[0]
    if (head === undefined) return undefined
    if (head.kind !== 'prompt') {
      this.list.shift()
      return { kind: head.kind, text: head.text, images: head.images, ids: [head.id] }
    }
    let count = 1
    while (this.list[count]?.kind === 'prompt') count += 1
    const run = this.list.splice(0, count)
    const merged = mergePrompts(run)
    return { kind: 'prompt', text: merged.text, images: merged.images, ids: run.map(item => item.id) }
  }

  /** The tail, for a caller that gives the last line back. */
  pop(): QueueItem | undefined {
    return this.list.pop()
  }

  find(id: number): QueueItem | undefined {
    return this.list.find(item => item.id === id)
  }

  /**
   * Take one item out, wherever it sits.
   * @returns the item, or undefined for an id the queue does not hold.
   */
  remove(id: number): QueueItem | undefined {
    const at = this.list.findIndex(item => item.id === id)
    if (at < 0) return undefined
    return this.list.splice(at, 1)[0]
  }

  /**
   * Swap an item with its neighbour.
   * @param id - the item to move.
   * @param delta - -1 towards the head, 1 towards the tail.
   * @returns false at either end, or for an unknown id.
   */
  move(id: number, delta: -1 | 1): boolean {
    const at = this.list.findIndex(item => item.id === id)
    const to = at + delta
    if (at < 0 || to < 0 || to >= this.list.length) return false
    const [moving] = this.list.splice(at, 1)
    if (moving === undefined) return false
    this.list.splice(to, 0, moving)
    return true
  }
}
