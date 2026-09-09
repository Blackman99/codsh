# View Running Subagents

Status: landing
Branch: ship/view-running-subagents
Base-Commit: 6311fb418b2deccce9ca8fb08c50eb6124f8683e
Original-Branch: main

## Requirement

支持 agent 执行过程中的子代理查看功能

## Problem Statement

When the live agent delegates, a person watching the parent transcript cannot see what the child is doing until that call settles. Continuable spawn and fork starts already become a Fold that is a view — a click enters the child Session, Esc restores the parent — but that door only appears after the tool result prints `started subagent <id>`. A foreground wait (`run_in_background: false`) sits on a pending `subagent` / `subagent_fork` card with no id at all, so the wait that most needs watching has nothing to click. Inside an opened view, later `assistant/chunk` events are not streamed the way they are on the parent, so a running child's thinking and text arrive in lumps or not at all. Esc is a single slot: entering a grandchild replaces the child, and Esc skips the middle. Child tool grants are answered only when `req.agent` is the live agent, so a spawn/fork child's bash or write fails closed without a prompt. Workflow/Ralph rounds were already refused as views (worker-thread Sessions are never in this process); that remains correct, but it is not a substitute for watching an in-process child while it works.

## Solution

Keep the existing nested Child view as the product. As soon as an in-process child Session exists (`subagent/start`), promote the matching pending `subagent` / `subagent_fork` card into a view with the same dim `click to enter` line the finished continuable card already has. A click opens that child's transcript in place of the parent's; the view streams thinking, text, and tool cards the way the parent does; Esc pops one stack level. The view is read-only: typing still flashes that Esc returns. Approvals from in-process descendants use the same keyboard gate as the live agent, so a watched child that needs a grant can proceed. Fork views skip the inherited parent prefix. One-shot background jobs and Workflow/Ralph worker children stay non-views.

## Grill Decisions

1. **Viewing shape — nested Child view, not a catalog or inline progress panel.**
   Reason: the surface already has click-to-enter; the gap is that it does not work *during* a run. A catalog or parent-card progress stream would be a second product.

2. **Which children — in-process Sessions only.**
   Reason: `sessions.get` is the enter seam. Continuable children already name an id on start; foreground one-shot children publish on `subagent/start` before the tool result. One-shot background jobs are Tasks, not Sessions. Workflow/Ralph children run in a worker thread; CONTEXT.md already records that no click could enter one.

3. **Inside the view — read-only; Esc returns.**
   Reason: the request is 查看 (view). Follow-up typing and interrupt are composer/control features; the model already has `send_message` and `interrupt_agent`.

4. **When enterable — promote the pending card on `subagent/start`.**
   Reason: that event publishes `{ id: SessionId }` as soon as the child exists, which is the first moment `sessions.get` can succeed. Continuable start-result cards stay as they are. Two unmatched pending subagent cards in one turn match FIFO.

5. **Live updates — stream like the parent.**
   Reason: “during execution” means thinking, text, and tool cards append the same way they do on the live path. Finished-events-only would look idle between cards; a snapshot would require re-entry to refresh.

6. **Keyboard — click only this ship.**
   Reason: Folds are already a click language; a `/agents` picker is a separate surface and is not required to make the nested view work during a run.

7. **Settlement while viewing — stay.**
   Reason: auto-exit would yank the person away mid-read. Esc still pops. A later click after the Session has left the store still flashes that the subagent is no longer running. A finished foreground result is the answer, not a view.

8. **Nesting — stack; Esc pops one level.**
   Reason: `maxDepth` is 3, so a child can spawn a grandchild. Today's single slot skips the middle. Nested view means nested Esc.

9. **Child approvals — answer in-process descendant grants at the keyboard.**
   Reason: approvals are not typing; they are the child's turn waiting on a person. Without them, a watched child that calls bash cannot be watched to completion. `user-questions/request` already has no agent filter.

10. **Fork prefix — child-owned events only.**
    Reason: `subagent_fork` seeds the child with the parent's completed turns. Replaying `snapshotEvents()` whole would reprint the parent conversation inside the nested view.

11. **Pending copy — the same `click to enter` hint as the finished card.**
    Reason: one language for both states. The hover readout already names a view when `enter` is set.

12. **Isolation — transcript and spinner follow the view; parent chrome stays.**
    Reason: that split already exists (status becomes `subagent · Esc returns to the parent`; todos and the ship chip still track the live agent). Sibling events never paint into this view.

## User Stories

1. As a person watching a turn, I want a pending `subagent` or `subagent_fork` card to become clickable as soon as the child exists, so that I can open it without waiting for the call to finish.
2. As a person who clicked a running child's card, I want that child's transcript to replace the parent's in the Viewport, so that I am reading the child's work rather than the parent's cards.
3. As a person inside a Child view, I want thinking, text, and tool cards to stream as they happen, so that a long child does not look idle between finished events.
4. As a person inside a Child view, I want Esc to return me one level (grandchild to child, child to parent), so that nested delegation is navigable rather than a jump.
5. As a person inside a Child view, I want typing to be refused with the existing flash that Esc returns, so that I cannot accidentally send a parent prompt from the child's screen.
6. As a person looking at a fork child, I want to see only that child's own events, so that the parent's inherited turns are not dumped again.
7. As a person whose in-process child needs a tool grant, I want the same approval keyboard as the live agent, so that the child can proceed while I watch it.
8. As a person still inside a child when it finishes, I want to keep reading that transcript until I Esc, so that settlement does not yank the Viewport away.
9. As a person who Escaped after a one-shot child left the store, I want a later click to flash that the subagent is no longer running, so that a disposed Session is not a broken door.
10. As a person watching a Workflow or Ralph round, I want the round line to remain a line (no `click to enter`), so that a worker-thread child is not offered as a view that can only fail.
11. As a person on a terminal without a mouse, I want this ship not to invent a picker I did not ask for, so that click-to-enter stays the affordance and a keyboard catalog can be a later surface.
12. As a reviewer of a resumed session, I want a continuable start-result card that already names a child to remain a view, so that replay matches the live turn.

## Implementation Decisions

1. **Child view stack (new surface module).**
   A stack of nested views, each naming the child Session being shown and the Transcript rendering it. Push on enter, pop on Esc, current is the top. Empty means the parent transcript. The composition root asks the stack whether a `session/event` should paint, whether typing is refused, and which Session replay/streaming follows. Spinner activity follows the current view's tools; parent chrome (todos, ship chip, live-agent status facts) stays; the status row while the stack is non-empty is the existing `subagent · Esc returns to the parent`.

2. **Pending-card promotion on `subagent/start`.**
   Transcript grows a public operation that binds the oldest unmatched pending call named `subagent` or `subagent_fork` to the published child Session id (FIFO). That operation rebuilds the pending card as a Fold that is a view: same head, plus the dim `click to enter` hint, `takeEnter` returning the id, `takePendingCard` naming the lines the screen must replace. Continuable `tool/result` cards that already parse `started subagent <id>` keep today's path. A failed result still does not become a view. A finished foreground result (the child's final text) is the answer, not a view. One-shot background `started background subagent job <id>` remains ignored by `childSessionId`.

3. **Enter and live streaming.**
   Enter still `sessions.get`s the id; missing still flashes that the subagent is no longer running. On hit: push the stack, clear the Viewport, replay that Session (child-owned events only), then route later events for that Session through the same streaming path the parent uses (`assistant/chunk` thinking and text, tool cards, folds). Sibling and parent events do not append. Settlement of the viewed child does not pop the stack.

4. **Fork prefix.**
   Replay of a Child view skips leading events covered by that Session's `inheritedEventCount`, so a fork child starts at its own prompt and work. Spawn children have a zero inherited prefix and are unchanged.

5. **Approvals.**
   The terminal answerer owns `approval/request` when the requesting agent is the live agent *or* an in-process descendant currently in `ctx.agents` / the live session store under the live agent's tree. Pending-call summaries for the prompt come from the Transcript that rendered that call (the current view's, if the request belongs to it). `user-questions/request` stays unfiltered. This is not a composer: the box still refuses ordinary typing.

6. **Out of this composition.**
   No `/agents` command, no keyboard picker, no interrupt or steer from the view, no Workflow/Ralph enter, no treating a job id as a Session. Ctrl-C remains parent-scoped. Print / non-TTY has no click, so no nested view. `/clear` and `/resume` still drop the stack the way today's single slot is dropped.

7. **Glossary.**
   Add **Child view** to CONTEXT.md: the nested Viewport of an in-process child's transcript; a Fold that names a child Session is a view (click enters, Esc pops one level); worker-thread Workflow children are not views. Avoid: catalog, inspector, pager.

## Testing Decisions

A good test here asserts *external* Fold/view behaviour and Child-view routing, not how `index.ts` wires listeners.

**Primary seam — Transcript (existing).** Extend the existing “a subagent card that is a view” suite: a pending `subagent` / `subagent_fork` call promoted with a child id becomes a view (`takeEnter`, `click to enter`, `takePendingCard` replaces the inert pending lines); FIFO when two pendings start; a later continuable start-result still names the id; a failed result and a background job still do not; a finished foreground body is not a view. Prior art: `packages/bundle/tests/transcript.spec.ts` (`childSessionId`, “a subagent card that is a view”).

**Existing seam — Screen.** The click-enters-instead-of-folding test already pins the Fold contract; keep it, and cover a pending card that was replaced in place still entering on click (the `replaces` path already used by completed cards). Prior art: `packages/bundle/tests/screen.spec.ts` (“enters a subagent block on click instead of expanding it”).

**Child-view module seam (new, still public).** Stack push/pop, current view, event ownership (viewed session paints; siblings do not), inherited-prefix skip, approval ownership (live agent and in-process descendants; unrelated agents do not). This is the seam for behaviour that today lives only in the composition root. Do not spin the full CLI.

Do not add a PTY e2e that starts a real child agent for this ship: the unit seams above are the declared proofs. Workflow/Ralph e2e already asserts the round line has no `click to enter`; that remains a regression, not a new criterion.

## Out of Scope

- Keyboard picker or `/agents` command.
- Typing a follow-up into the viewed child (steer / new turn).
- Interrupt from the Child view (Ctrl-C stays parent-scoped).
- Opening Workflow/Ralph worker-thread children, including via `observeSession` polling.
- Treating one-shot background job ids as views.
- Inline live progress on the parent card as a primary UI.
- Muting parent chrome (todos, ship chip) while viewing.
- Changing `maxDepth`, providers, or the model-facing `subagent` / `subagent_fork` tools.
- Print-mode nested views.

## Acceptance Criteria

1. Pending promotion: `pnpm exec vitest run packages/bundle/tests/transcript.spec.ts -t "a pending subagent card that is a view"` exits 0. A pending `subagent` (and `subagent_fork`) call, once given a child id, includes `click to enter`, `takeEnter()` returns that id, and `takePendingCard()` names the inert pending lines to replace. Two unmatched pendings bind FIFO. A background job string and a failed result still yield no enter id. A finished foreground result body is not a view.

2. Click enters the promoted card: `pnpm exec vitest run packages/bundle/tests/screen.spec.ts -t "enters a subagent block on click instead of expanding it"` exits 0, and the suite still records the child id from a click rather than swapping the Fold. A replaced-in-place pending view card (the `replaces` path) also enters on click rather than expanding.

3. Child view routing: `pnpm exec vitest run packages/bundle/tests/child-view.spec.ts` exits 0. The stack pushes on enter and pops one level per Esc; events for the current Session are owned and sibling Sessions are not; replay skips `inheritedEventCount` leading events; approval ownership is true for the live agent and an in-process descendant, false for an unrelated agent.

4. Types: `pnpm run typecheck` exits 0 with zero TypeScript errors across workspace packages.

5. Full suite: `pnpm test` exits 0 with zero new failures against the Phase 3 baseline.

## Plan

- [x] Ticket 1: Promote pending subagent cards into views — Delivers Transcript binding of the oldest unmatched pending `subagent` / `subagent_fork` call to a child Session id (FIFO), the dim `click to enter` hint, `takeEnter` / `takePendingCard`, Screen click-to-enter on a replaced-in-place pending card, and keeps failed results plus background jobs non-views. (Blocked by: none)
- [ ] Ticket 2: Child-view stack module — Delivers a public Child-view stack (push/pop/current), event ownership (viewed Session paints; siblings do not), `inheritedEventCount` prefix skip, and approval ownership for the live agent plus in-process descendants, pinned by `child-view.spec`. (Blocked by: Ticket 1)
- [ ] Ticket 3: Wire live nested viewing into the composition — Delivers `subagent/start` promotion of pending cards, stacked enter/Esc, parent-like streaming inside the current Child view, descendant keyboard approvals, stay-on-settle, and the existing no-longer-running flash. (Blocked by: Ticket 1, Ticket 2)
- [ ] Ticket 4: Release & Documentation Compliance — Delivers Changeset and bilingual documentation updates (README.md and README.zh.md) plus CONTEXT.md Child view glossary if user-facing surface is touched. (Blocked by: Ticket 1, Ticket 2, Ticket 3)

## Baseline

Recorded on `ship/view-running-subagents` at `6311fb418b2deccce9ca8fb08c50eb6124f8683e` before any implementation. Working tree: spec file untracked only.

- Proof 1 (`pnpm exec vitest run packages/bundle/tests/transcript.spec.ts -t "a pending subagent card that is a view"`): exit 0, 105 tests skipped (no tests matched yet).
- Proof 2 (`pnpm exec vitest run packages/bundle/tests/screen.spec.ts -t "enters a subagent block on click instead of expanding it"`): exit 0, 1 passed / 150 skipped (the existing click-to-enter test; the replaced-in-place pending view path is not covered yet).
- Proof 3 (`pnpm exec vitest run packages/bundle/tests/child-view.spec.ts`): exit 1, no test files found.
- Proof 4 (`pnpm run typecheck`): exit 0, zero TypeScript errors.
- Proof 5 (`pnpm test`): exit 0, 47 files / 1266 tests passed.

Green for this ship means proofs 1–3 gain matching tests and pass, and proofs 4–5 stay at zero new failures versus this baseline.
