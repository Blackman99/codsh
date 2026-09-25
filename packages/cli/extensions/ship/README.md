# Ship extension for `codsh --rust`

Ship is codsh's staged `/ship` workflow. In the Rust client it is an optional
plugin: nothing Ship-related loads, registers, or writes until you install and
enable it.

```sh
codsh --rust plugin install bundled:ship --trust
codsh --rust plugin enable ship
codsh --rust plugin disable ship     # /ship and its hooks leave the next prompt
codsh --rust plugin uninstall ship --confirm
```

Enabled, it adds `/ship` (also `/ship:ship`; a built-in or native `/ship`
keeps the bare name) and seven command hooks (SessionStart, UserPromptSubmit,
PreToolUse on `ask_user_question`, PostToolUse, PostToolUseFailure on
`subagent`, Stop, SessionEnd). It adds no key bindings, no Goal, and no Rhai.
The hooks keep the legacy records beside the spec: `docs/specs/<slug>.md`
(Status is the phase), `<slug>.ship.json` (the frozen original requirement
and, after gate 1, the sealed snapshot), `<slug>.ship.answers.json` (each
human `ask_user_question` answer, verbatim), the sealed Mission Contract
`.scratch/<slug>/mission.contract.json`, and the tickets in
`.scratch/<slug>/issues/`.

## The whole flow

`/ship <requirement>` sends the legacy first-turn contract to dsh; dsh runs
every agent. The phases follow the legacy runner (`ship-run.ts`), driven from
hook boundaries because a plugin cannot own a loop:

1. **Wayfinder → grill → to-spec → tickets.** When the parent turn ends after
   a legal forward Status change (or a human answer in wayfinder or grill),
   the Stop hook continues the same turn with the next phase's contract and
   prints `Ship · continuing: <phase> (Status: …)`. A turn is continued at most
   8 times in a row (the hook runner's cap); `/ship` resumes after that.
2. **Gates.** `ship · gate 1/2` and `ship · gate 2/2` are auto-Confirmed while a
   run is in flight: the runner writes `Status: confirmed` (compiling and
   sealing the Mission Contract) or `Status: planned`, and refuses the card
   with a short notice. After the seal, an Edit-shaped gate writes a
   `## Blocker`, as legacy does.
3. **Landing.** Unblocked tickets are claimed (`Claim: claimed`, commit
   `ship: claim landing:N`, a brief under `.scratch/<slug>/landing/`) and the
   parent calls `subagent` once per ticket with `isolation: "worktree"` in one
   step, so siblings run in parallel. Each result serial-merges the Ready-set:
   Worktree commit as the host, `merge --no-ff`, worktree and branch removed,
   `Proof: green`, tick commit. A merge conflict stays in progress and one
   conflict-resolution subagent works in the merge-target tree; each attempt
   is checked with the legacy validation, up to three, then the merge is
   snapshotted, aborted, and recorded as a `## Blocker`.
4. **Final verification and Merge-back.** When every ticket is ticked, a
   separate verification turn runs; after `Status: shipped` the runner checks
   the plan, the Blocker section, and the sealed acceptance evidence, then
   merges back into `Original-Branch` (fast-forward, else squash with the same
   resolver) and prints `Ship · shipped: …`.

The runner commits the Ship records it changes (spec, sidecars, tickets,
briefs, graph cache) as `ship: …` commits on the feature branch, as legacy
does.

## Cancel, failure, and recovery

- A failed or cancelled child is never merged or ticked: its side effects are
  unknown. Ctrl+C cancels the whole parallel batch (dsh reports it only when
  every call returns), so even a child that finished its work in its worktree
  is left unmerged. The worktree is kept for you to review (`/worktree`), and
  the ticket keeps its Claim.
- The next `/ship` resumes the one unfinished spec, including a later phase.
  A claimed ticket without a returned result is dispatched again with a notice
  that names any kept worktree; after two dispatches without a result the run
  stops instead.
- A missing or corrupt sealed Mission Contract stops the run
  (`Ship · stopped: Sealed Mission Contract is missing or corrupt…`); it is
  never recompiled. Restore it and run `/ship` again.
- A lost run state (plugin data) is rebuilt from the files: spec, sidecars,
  tickets, and git history. A conflict a cancel left in progress is rolled
  back and merged again.
- A guard failure, an unresolved `## Blocker`, an invalid Status transition,
  or an Abort answer stops the run with `Ship · stopped: …`.

The Alignment Gate and the drift scan of legacy `/ship` are not ported.

## Browser graph

`/ship` prints one line, and prints it again only when it changes:

```
Ship graph · wayfinder-e2e.md · Status: wayfinding · 待认领 1 · 已认领 1 · 已关闭 2 · 2 of 4 decision answers recorded · http://127.0.0.1:<port>/<token>/
```

The URL opens the legacy Web panorama (the same React Flow page legacy
`/ship` serves). Its graph is joined on every poll from the files above plus
local wayfinder tickets (`.scratch/<slug>/wayfinder/NN-*.md`), never from the
graph cache, so the page and the line agree and a deleted or corrupt
`<slug>.ship.graph.json` loses nothing; the hooks rewrite that cache as the
legacy runner does. The Status is the ledger's, never inferred from tickets.

- `hooks/ship-web.mjs` runs detached, one per workspace, for the dsh process
  that ran `/ship`. It listens on `127.0.0.1` only and answers GET/HEAD only
  under a random 128-bit path; other paths are 404 and a non-loopback `Host`
  is refused.
- It stops when the session ends (SessionEnd), when dsh exits, or when its
  record in the plugin data directory disappears (`uninstall` removes it).
- The record (`web/<key>.json`, mode 0600) keeps the port and token, so
  resuming the session (SessionStart) reopens the same URL and an open page
  reconnects by itself. `/ship` never opens a browser.

`hooks/ship-hook.mjs`, `hooks/ship-web.mjs`, `web/`, and `commands/ship.md` are
generated from `packages/bundle/src/ship-extension*.ts` and `ship-web-app.tsx`
by `scripts/build-ship-extension.mjs` (run by `pnpm run build:rust`).
