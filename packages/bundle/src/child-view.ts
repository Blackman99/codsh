/**
 * Nested Child views: a stack of in-process child Sessions.
 *
 * A Fold that names a child Session is a view. Clicking it pushes; Esc pops
 * one level. The composition root asks this module which Session the
 * transcript follows, which events paint, which inherited prefix a fork
 * replay skips, and which agents the keyboard answers approvals for.
 * @module codsh-bundle/src/child-view
 */

/** One nested view on the stack. */
export interface ChildView {
  /** The child Session this view is showing. */
  readonly sessionId: string
}

/**
 * Stack of nested Child views. Empty means the parent transcript.
 *
 * Push on enter, pop on Esc. `/clear` and `/resume` drop the whole stack.
 */
export class ChildViews {
  private readonly stack: ChildView[] = []

  /** The view on top, or undefined when showing the parent. */
  get current(): ChildView | undefined {
    return this.stack.at(-1)
  }

  /**
   * Open a child Session on top of whatever is showing.
   * @param sessionId - the child Session the card named.
   */
  push(sessionId: string): ChildView {
    const view = { sessionId }
    this.stack.push(view)
    return view
  }

  /**
   * Leave the current Child view. Esc pops one level.
   * @returns the view that closed, or undefined when already on the parent.
   */
  pop(): ChildView | undefined {
    return this.stack.pop()
  }

  /** Drop every nested view — a session replacement has no stack to keep. */
  clear(): void {
    this.stack.length = 0
  }
}

/**
 * Whether an appended event belongs on the current Child view.
 *
 * Sibling and parent Sessions never paint into this view; settlement of the
 * viewed child does not pop the stack.
 * @param view - the current Child view, or undefined on the parent.
 * @param sessionId - the Session the event was recorded on.
 */
export function paintsViewedSession(view: ChildView | undefined, sessionId: string): boolean {
  return view !== undefined && view.sessionId === sessionId
}

/**
 * The events a Child view replays: everything after the inherited fork prefix.
 *
 * `subagent_fork` seeds the child with the parent's completed turns. A nested
 * view starts at the child's own work, so those leading events stay off screen.
 * @param events - the child's log, oldest first.
 * @param inheritedEventCount - how many leading events the child inherited.
 */
export function childOwnedEvents<T>(events: readonly T[], inheritedEventCount: number): T[] {
  const skip = Math.max(0, inheritedEventCount)
  return events.slice(skip)
}

/**
 * Whether the terminal answers an approval for this requesting agent.
 *
 * The live agent always; an in-process descendant currently under that
 * agent's tree also, so a watched child that calls bash can proceed.
 * An unrelated agent falls through.
 * @param requestingId - the agent that asked.
 * @param liveId - the live (parent) agent.
 * @param descendants - in-process descendant session ids under the live agent.
 */
export function ownsApproval(requestingId: string, liveId: string, descendants: ReadonlySet<string>): boolean {
  return requestingId === liveId || descendants.has(requestingId)
}

/** One live Session the descendant walk can see. */
export interface LiveSessionLineage {
  /** This Session's id. */
  readonly id: string
  /** The parent Session this one was spawned or forked from, when known. */
  readonly parentSession?: string
}

/**
 * In-process descendant Session ids under a live agent.
 *
 * Walks `parentSession` on live Sessions. A child that has left the store is
 * gone; only what is here can need a keyboard grant.
 * @param liveId - the live (parent) agent's Session id.
 * @param sessions - live Sessions in this process.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A provider established a published child. Payload is the run identity
     * (`id` is the child Session). Host-plane; the bundle listens without
     * depending on `@deepseek-ai/dsh-subagent`.
     */
    'subagent/start'(info: { id: string }): void
  }
}

export function inProcessDescendants(liveId: string, sessions: readonly LiveSessionLineage[]): ReadonlySet<string> {
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    if (session.parentSession === undefined) continue
    const siblings = children.get(session.parentSession)
    if (siblings === undefined) children.set(session.parentSession, [session.id])
    else siblings.push(session.id)
  }
  const descendants = new Set<string>()
  const pending = [...children.get(liveId) ?? []]
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined || descendants.has(id)) continue
    descendants.add(id)
    pending.push(...children.get(id) ?? [])
  }
  return descendants
}
