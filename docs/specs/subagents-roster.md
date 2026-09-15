# Subagents Roster

Status: shipped

## Requirement

增加子代理展示功能：可以看到当前会话发起的子代理列表，并点击每个进入查看运行情况。
交互参考 Grok 官方 CLI（Grok Build）。

## Problem Statement

A person can already enter a child Session: a `subagent` card that names one
is a Fold that is a view, a click opens the child's transcript, Esc pops one
level (docs/specs/view-running-subagents.md). What is missing is the roster.
The cards scroll away with the transcript; a turn that starts three children
in the background leaves nothing pinned that says three are running, which
one has finished, which one failed, or how to get to any of them without
finding its card. Inside a view the status row says only
`subagent · Esc returns to the parent` — not which subagent, how long it has
run, or what it is doing.

Grok Build keeps a tasks pane, toggled with `Ctrl+G`, that groups the
session's subagents with a status indicator, elapsed time, and description
label; Enter (or a click) opens one in a fullscreen framed view whose title
bar carries the status icon, label, live activity and elapsed time, and
`Esc`/`q` returns; the lifecycle block in the parent's scrollback keeps
updating with a live activity suffix (Grok Build user guide,
`crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md` at the
pinned revision bc7f02ed, read 2026-09-14).

## Solution

1. **Subagents roster.** A pure module keeps one entry per child Session
   the live session started, in start order: id, label (the call's
   `description`, else the first line of its `prompt`, else the tool name),
   when it started, its status (`running`, `done`, `failed`, `stopped`),
   when it ended, how many tool calls it has made, and the latest call named
   the way the working line names a workflow round (`bash: sleep 2`). It is
   fed from `subagent/start` (the child exists; what it logged before the
   edge is folded in, so a one-shot child's first calls count), the child's
   own `session/event`s (`tool/call` counts; `turn/start` runs; `turn/end`
   settles; `subagent/descriptor` names it for good), and `subagent/end`,
   the runtime's own verdict on how the child ended. The mapping, for a
   turn-end reason and a stop reason alike: `completed` → done; `error`,
   `max-tokens`, `refusal`, `blocked` → failed (what the parent is told —
   the runtime reports a blocked turn as a refusal); `aborted`,
   `interrupted` → stopped. A child that did not finish is never marked
   `✔`. Dropped with the rest of the surface state on `/clear` and
   `/resume`. Nested grandchildren belong to the child that started them
   and are not in the parent's roster.
2. **Subagents readout.** A chrome row under the box, beside the Todo
   readout, for as long as the roster holds anything:
   `subagents 3 · 2 running · 1 done · Ctrl+H`, with `failed` and `stopped`
   counted when present. One chrome row that appears once per session, the
   way the Todo readout does — the box moves up one row once; the open
   panel takes its place with up to twelve rows (header, eight entries,
   the two overflow rows, footer), the way the Queue panel does. A click
   on the row, or `Ctrl+H`, opens the panel; either closes it. Grok
   Build's pane is `Ctrl+G`, which Graph's Panorama overlay already owns.
   One open panel at a time with the Todo readout and the Queue panel, by
   key and by click.
3. **Subagents panel.** A numbered list, keyboard-first, the shape the Queue
   panel has: header `subagents 3 · 2 running · 1 done · Ctrl+H closes`
   (the readout's counts, so opening the panel hides nothing); one row per
   entry, newest last, `❯ 1. ▶ label · 12s · 3 calls · bash: sleep 2` while
   it runs (elapsed ticks once a second while any child runs), `✔ label ·
   8s · 2 calls` when done, `✗` failed, `■` stopped; the row of the child
   whose view is on screen ends ` · viewing`; footer `[enter] view · [esc]
   back`. ↑/↓, Tab, Home/End, and digits move the mark; Enter or a click on
   a row enters that child's view; Esc or Ctrl+H closes.
4. **Entering.** The panel enters through the existing Child view: the
   child's transcript replaces the parent's, streams while it runs, Esc pops
   one level, typing is refused. From inside a Child view, Enter on another
   row swaps the view — every open level drops and the chosen child pushes,
   once its door is known to open, so a refused door leaves the person
   where they were — and Esc then returns to the parent; Enter on the
   viewed child's own row flashes `already viewing this subagent`. A child that has left the store
   — every background child, the moment it idles, since the runtime
   disposes it then — is still on the roster with its outcome; Enter on it
   replays its persisted log read-only from the session query, the primary
   door for a finished child, and flashes that the subagent is no longer
   running only when the query cannot serve it.
5. **The view names its subagent.** The status row inside a Child view is
   the title bar: `subagent ▶ label · 12s · 3 calls · bash: sleep 2 · Esc
   returns to the parent`, the glyph and elapsed settling when the child
   ends. The label and the figures are cut before the way out is, the way
   the todo and queue rows keep their keys; the latest call is capped at 32
   columns the way the working line caps its activity. A grandchild
   entered by its card is not on the parent's roster and keeps the plain
   `subagent · Esc returns to the parent`. Parent chrome stays as it is.
6. **`/subagents`.** Prints the roster as lines — the panel's header
   without its key, and its rows without the `❯` cursor — so a pipe and
   `/status`-style reading get it too; on a terminal it prints and leaves
   the panel alone. `no subagents yet` before any child started.

## Grill Decisions

1. **The roster is surface state fed by events, not a query over the
   store.** `sessions.list()` only holds children that are still alive, and
   the point of a roster is to say what ran and how it ended. Start order is
   the order a person watched them appear.
2. **Direct children only.** A grandchild is the child's business: its card
   and its own roster live in that child's view. Keeps the readout's counts
   honest for the turn a person is reading.
3. **`Ctrl+H`, and a click on the readout.** Grok Build's pane is
   `Ctrl+G`; Graph's Panorama overlay already owns that chord, so the
   roster takes `Ctrl+H`. BS (0x08) is the legacy byte; DEL (0x7F) stays
   Backspace, and the kitty form (`CSI 104;5u`) reports the letter rather
   than Backspace. One exception: inside a Ctrl+R history search, Ctrl+H
   cancels the search instead, so a terminal that sends BS for the chord
   does not open the roster while editing a query. No `q` to close a
   view: Esc already does, and `q` is a letter the box accepts.
4. **The panel enters, it does not steer or stop.** The request is 查看.
   Stopping a child is the model's `subagent_control`; the panel offers the
   one verb the person asked for.
5. **Status glyphs are the transcript's own.** `▶` and `✔` are the todo
   readout's marks, `✗` is the failed tool card's; `■` for a stopped child
   is this row's own.
6. **Elapsed is wall time from `subagent/start`, on the roster's own
   clock.** Ticked once a second while any child runs — the spinner's
   cadence is the parent's, paused inside a Child view and stopped when the
   parent's turn ends, and a child runs on after both. Nothing running,
   nothing ticking.
7. **A gone child stays listed.** Its row says how it ended; entering it
   reads the persisted log when the session query can serve it. That is the
   difference from a dead door: the row never promises what a click cannot
   give.
8. **The child's own log names it.** The provider appends a
   `subagent/descriptor` to the child's log with the delegation's
   `description` before its first request; that label names the roster row
   and picks the pending card to bind, so two children started in one step
   keep their own names whichever came up first. The oldest unbound call's
   description is the fallback for a log with no descriptor yet.

## User Stories

1. **US-1**: As a person whose turn started several subagents, I see a row
   under the box counting them by state, for as long as the session holds
   any.
2. **US-2**: As a person who presses Ctrl+H or clicks that row, I get a
   numbered list naming each subagent, its state, how long it has run, and
   what it is doing now.
3. **US-3**: As a person who presses Enter or clicks a row, I am inside that
   subagent's transcript, its status row naming it, and Esc brings me back.
4. **US-4**: As a person reading a finished subagent's row, I see whether it
   completed, failed, or was stopped, and can still open what it did.
5. **US-5**: As a script piping `/subagents`, I get the same lines.

## Implementation Decisions

1. **`packages/bundle/src/subagents.ts`** (new, pure): `SubagentRoster`
   with `start(id, label, at)`, `relabel(id, label)`, `call(id, latest)`,
   `settle(id, status, at)`, `entries()`, `entry(id)`, `has(id)`,
   `clear()`; `outcomeStatus(kind)`; `subagentsRow(entries, theme, columns)`
   for the readout; `SubagentsPanel` with the Queue panel's state shape
   (`reset`, `mark`, `scrollBy`, `setHovered`, `targetAt`, `click`,
   `handle`, `view(entries, theme, columns, now, viewing?)`);
   `subagentsReport(entries, theme, columns, now)` for `/subagents`;
   `subagentTitle(entry, theme, now, columns)` for the Child view's status
   row, fitted with `fitTrailer` so the hint survives.
2. **`packages/bundle/src/transcript.ts`**: `promotePendingView(childId,
   label?)` binds the oldest unbound `subagent`/`subagent_fork` call whose
   `subagentLabel` matches, else the oldest unbound one; `peekSubagentLabel()`
   names the next unbound call for a child whose log has no descriptor.
3. **`packages/bundle/src/keys.ts`**: `\b` → `toggle-subagents`; DEL stays
   Backspace; kitty `CSI 104;5u` is the same chord.
4. **`packages/bundle/src/prompt.ts`**: `setSubagents(entries, viewing?)`
   (content-compared); `tick()` repaints while a child runs; the readout row
   and the open panel among the chrome rows (after the todo rows); `Ctrl+H`
   and the readout click toggle, Ctrl+H inside a history search cancels it;
   panel keys route to the panel; `handlers.enterSubagent(id)` on
   Enter/click; one open panel at a time, the todo click included.
5. **`packages/bundle/src/child-view.ts`**: declares `subagent/end` beside
   `subagent/start`, and `subagent/descriptor` (`label` only) on
   `SessionEventMap` under `@deepseek-ai/dsh-session/types`, so the bundle
   reads them without depending on `@deepseek-ai/dsh-subagent`;
   `descriptorLabel(events)` reads the trimmed creation label.
6. **`packages/bundle/src/index.ts`**: `feedRoster(id, event)` folds one
   child event; `subagent/start` names the child from its log's descriptor
   (else `peekSubagentLabel`), seeds a fresh entry from what it logged
   before the edge, and binds the card by that label; `subagent/end`
   settles it with the runtime's stop reason; `pushRoster()` pushes to the
   prompt with the viewed id and arms or clears an unref'd 1 s interval
   that calls `prompt.tick()` and refreshes the view title; `openChild(id)`
   flashes on the viewed child, enters live from the store, else replays
   `sessionQuery.observeSession` (one in flight per id) as a detached
   frame, dropping every open view (`dropViews`) right before the push;
   `showSession` binds a replayed card by the same `descriptorLabel`;
   `/subagents` command; `clear` and the clock stop on adopt.
7. **Mock** (`e2e/fixtures/mock-llm.src.ts`): `subagents` — the parent
   starts two background `subagent`s in one step (`CODE_CLI_SUBAGENT_ONE`,
   `CODE_CLI_SUBAGENT_TWO`), then answers `CODE_CLI_SUBAGENTS_STARTED`;
   child ONE runs `sleep 4` and answers `CHILD_ONE_DONE`; child TWO runs
   `sleep 3` and ends its turn with a non-retryable error, so the roster
   shows one done and one failed. Each child that settles is disposed and
   wakes the parent with a `Background subagent …` notice; a parent that
   has already delegated answers `CODE_CLI_SUBAGENTS_SETTLED n=<notices>`
   to it and never delegates again.
8. **Docs**: CONTEXT.md (**Subagents readout**, **Subagents panel**, the
   Child view's title), both READMEs, docs/alignment.md row and the
   External `$EDITOR` row's note, changeset, `scripts/dev.mjs` mock list.

## Testing Decisions

- **Unit**: subagents.spec (roster lifecycle from events, relabel, the
  outcome mapping, counts, readout row fit and trailer, panel header
  counts and `viewing`, keys/click/targets/window, report lines, title fit
  and call cap, single-span rows under a coloured theme), keys.spec
  (`Ctrl+H` legacy BS and kitty), prompt.spec (readout pinned, panel opens on
  key and click, Enter reports the id, one panel at a time by key and by
  click, Esc closes, empty-roster flash, digits stay out of the box, the
  roster emptying closes the panel, `tick` moves a running clock and
  nothing else, `viewing`, Ctrl+H inside a search), transcript.spec
  (`peekSubagentLabel` FIFO skips bound calls; label-bound promotion).
- **PTY e2e** (`e2e/pty-subagents.e2e.ts`), every case ending on
  `CODE_CLI_SUBAGENTS_SETTLED n=2` so `/exit` lands on an idle parent with
  no resident children: the readout counts two running past the parent's
  answer and settles to `1 done · 1 failed`, with no third child ever
  started; Ctrl+H opens the panel with the counts header, both children
  with their glyphs, and closes on Esc; Enter enters child ONE, whose view
  shows its `sleep 4` card and a title naming it, and Esc returns to the
  parent (its answer repainted, the card gone); a click on the readout
  opens the panel, each label sits with its own call, and a click on TWO's
  row enters TWO; after both settle, Enter opens child ONE read-only from
  its persisted log (`CHILD_ONE_DONE` on screen, a `✔` title with a stopped
  clock), with the `no longer running` flash named in the wait so a broken
  door is told from a slow one. Ticking is not asserted on a PTY.
- **Pipe e2e**: `/subagents` before any delegation says `no subagents
  yet`; after it, the header and one row per child.

## Out of Scope

Stopping or steering a child from the panel; grandchildren in the parent's
roster; Workflow/Ralph worker-thread rounds (still lines, not views); a live
activity suffix on the parent's `subagent` card (the readout carries the
activity); background `!` jobs in the pane (they stay in `/status`); the
child's model or a forked badge in the title.
