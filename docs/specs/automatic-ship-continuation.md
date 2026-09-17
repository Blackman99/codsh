# Automatic /ship continuation and the two-ring panorama

Collapsed from the wayfinder map
[Automatic /ship continuation and the two-ring panorama](https://github.com/Blackman99/codsh/issues/106).
This file is the decision record for a later landing session. It is **not** a
live `/ship` ledger: there is no `Status:` phase line, so chrome must not
adopt it as unfinished work.

## Original Requirement

After every HITL answer, `/ship` continues without a bare `/ship`; the runner
dispatches AFK children (including isolated-worktree landing waves) without a
parent model turn; and the person always has a two-ring panorama — 待认领 /
已认领 / 已关闭 — as a pinned TTY fullscreen overlay plus a local loopback
Web node graph.

## Wayfinder

Canonical map: [Automatic /ship continuation and the two-ring panorama](https://github.com/Blackman99/codsh/issues/106).

Closed decision tickets (detail lives on the ticket; this spec does not restate
a resolution beyond the gist needed to build):

- [Current /ship phase-stop contract surface](https://github.com/Blackman99/codsh/issues/109)
- [Conflict-resolution child's authority](https://github.com/Blackman99/codsh/issues/110)
- [Graph node identity across tracker, spec, and cache](https://github.com/Blackman99/codsh/issues/107)
- [How Claim is recorded when the runner dispatches](https://github.com/Blackman99/codsh/issues/111)
- [Ship graph sidecar fields and rebuild join](https://github.com/Blackman99/codsh/issues/115)
- [Worktree branch names, merge commits, and squash authorship](https://github.com/Blackman99/codsh/issues/114)
- [Local Web node-link panorama](https://github.com/Blackman99/codsh/issues/113)
- [TTY two-ring panorama overlay](https://github.com/Blackman99/codsh/issues/108)
- [Merge order of a finished landing wave](https://github.com/Blackman99/codsh/issues/112)
- [How a synthetic subagent card binds without a parent tool call](https://github.com/Blackman99/codsh/issues/116)
- [Does the spec lock Web panorama look, or only graph semantics?](https://github.com/Blackman99/codsh/issues/117)

Throwaway prototypes (non-normative; steal, do not treat as visual spec):

- TTY frames: branch `prototype/tty-two-ring-panorama`
- Web canvas: branch `prototype/local-web-node-link-panorama`

## Problem Statement

A person types `/ship` with one sentence and then has to type `/ship` again
after every HITL answer. Phase prompts tell the model to stop this turn; the
runner only auto-continues when Status advanced by exactly +1, or inside the
landing loop. Grill, wayfinder, and both gates therefore drop the person back
to the prompt. Landing still spends a parent model turn per ticket, writes on
the shared working tree, and hides in-flight children behind a pending
`subagent` card that a runner dispatch never creates. There is no canvas of
待认领 / 已认领 / 已关闭, so Claim, Occupancy, and “a child is running” collapse
into one feeling. Hybrid compass still forbids armed `/goal`, which is correct,
but the same sentence is easy to read as “the `/ship` runner must not
continue.” The person who wanted one invocation to carry the work watches a
stop-and-retype loop, cannot see the two rings, and cannot enter a child the
runner started.

## Solution

`/ship` stays the scheduler. After every HITL answer in the same invocation,
the runner injects the next needed turn without a bare `/ship`. The parent
wakes only to ask; AFK children (research, landing TDD, Conflict-resolution,
In-place repair) are dispatched from the host plane without a parent model
turn. Gates auto-Confirm and print a transcript notice; interrupt still aborts;
after seal there is no Edit modal — a contradiction is a Blocker. A named
decision map is always charted (the inner ring may be empty). Occupancy and
dirty-tree preflight still ask on a TTY.

Landing becomes a Landing wave: every currently unblocked, unclaimed landing
ticket runs in its own worktree; the parent serial-merges Ready-set and proves.
There is no landing turn-budget breaker. Git conflicts dispatch autonomous
Conflict-resolution attempts in the merge-target tree; the runner owns git. Delivery auto-picks Merge
back (fast-forward, else squash) under the same conflict rule.

The person always has one Ship graph, two projections. The Panorama overlay is
the pinned TTY fullscreen (inner ring then outer ring, bucket on the ticket
row, Track-N as a suffix). The Panorama teaser is the one-line chrome above the
plan row. The Web panorama is a loopback node-link of the same graph. Claim is
the ticket bucket, distinct from Occupancy. A runner-dispatched in-process
child is a Child view Fold that is not a tool-call card. The adjacent
`<spec>.ship.graph.json` is a rebuilt cache, never identity.

After verified delivery (including Merge back), the terminal retires the phase
chip, plan, Panorama overlay/teaser, old Todo readout, and settled Subagents
readout. Explicit history panels remain available; running children stay visible
until they settle, and the Web panorama retains the final graph. A later event
must not restore completed chrome or keep the completed Mission Contract active
for unrelated work. Abort, Blocker, failed verification, and failed delivery do
not take this success-only cleanup path.

## Main Track

Sealed at gate 1 Confirm for a landing of *this* spec. Later phases must not
rewrite these lines. Progress (Status, checkboxes, proof logs) remains writable.

**Idea.** After every HITL answer, `/ship` continues without a bare `/ship`;
the runner dispatches AFK children (including isolated-worktree landing waves)
without a parent model turn; and the person always has a two-ring panorama —
待认领 / 已认领 / 已关闭 — as a pinned TTY fullscreen overlay plus a local
loopback Web panorama.

**Track-1.** Hybrid compass: the `/ship` runner may auto-continue after HITL
and inside landing; `/goal` stays disarmed. Armed continuation is still
forbidden.

**Track-2.** Parent wakes only to ask. The runner stitches phases and dispatches
AFK children without a parent model turn, including isolated-worktree landing
via `agents.create({ meta: { cwd } })`.

**Track-3.** Always chart a named map. An empty inner ring is valid. A confirmed
clear route auto-advances to grill-me. A confirmed no-map is an empty inner
ring, not a hub node.

**Track-4.** Gates auto-Confirm with a transcript notice. Interrupt still
aborts. After seal there is no Edit modal; a sealed-track contradiction is a
Blocker.

**Track-5.** Occupancy (`ship · occupancy`) and dirty-tree preflight
(`ship · preflight`) still ask on a TTY. Off a TTY, occupancy auto-Replace.

**Track-6.** Claim is the panorama bucket of a Decision ticket or Landing
ticket (待认领 / 已认领 / 已关闭), distinct from Occupancy. 已认领 means taken,
not that a child is running. In-flight lives on the teaser.

**Track-7.** Native graph keys: `decision:github:owner/repo#n` /
`decision:local:NN`, `landing:N`, `track:N`. Track anchors are nodes. The
sidecar is a rebuilt cache; a join failure stops the run.

**Track-8.** A Landing wave dispatches every currently unblocked, unclaimed
landing ticket in parallel worktrees. Serial-merge Ready-set (lowest
`landing:N` among finished, unblocked, 已认领). Tick now after that merge’s
parent proof is green. No landing turn-budget breaker. A Blocker freezes new
dispatch and further serial merges; in-flight independents finish.

**Track-9.** A Conflict-resolution child autonomously resolves git-named
conflicts in the merge-target tree. Lockfiles/generated artifacts are
regenerated; modify/delete and binary conflicts use history and ticket intent.
The runner owns add, commit, and rollback. Validation feedback retries up to
three attempts per merge, without aborting between attempts. Protected hunks
or exhausted retries → snapshot + rollback + Blocker. Interrupt rolls back
without `## Blocker`; success continues landing and proof.

**Track-10.** Worktree branch `wt/<slug>/<directory>` from the graph key
(`landing-N`, `decision-<github-number>`, `decision-<local-NN>`). Worktree
commit, `--no-ff` land merge (kept if red), then Tick commit or Blocker
commit. Delivery auto-picks Merge back: fast-forward when possible, else
squash. Same conflict-retry rule. Red delivery resets Original-Branch and
keeps `ship/<slug>`.

**Track-11.** Panorama overlay: alternate-screen fullscreen opened by Ctrl+G
or a click on the teaser (not pinned by default), inner then outer, bucket on
the row, Track-N suffix, wrap `Blocked by: <name>`, empty overlay kept,
exclusive with Queue/Todo, grill HITL dismisses to the teaser. Panorama
teaser: `待认领 n · 已认领 n · 已关闭 n` plus in-flight when greater than
zero, plus the loopback URL when bound, above the plan row. Drop the key
hint first when the line will not fit.

**Track-12.** Web panorama: `127.0.0.1` ephemeral port, one server for the
TTY session. The URL is pinned on the Panorama teaser and overlay title; `/ship`
does not open a browser. Off a TTY the URL is printed once. The page polls the live graph
and is not rebound when `/ship` continues or a spec appears. TTY and Web are
two projections of one Ship graph. The spec locks graph semantics and forbids
only; look is the implementer’s. The throwaway page is non-normative.
The Web projection now uses local React Flow sub-flows in six ordered layers:
Wayfinder → Grill → Spec (Gate 1) → Tickets (Gate 2) → Landing → Done. Each
layer contains descriptive workflow steps and the corresponding canonical
nodes (decisions in Wayfinder, anchors in Spec, implementation tickets in Landing).
These view-only groups/steps do not extend the Ship graph's node kinds. The
ledger Status drives phase highlighting; step-level completion is not inferred.
The TTY grouping and empty-inner-ring semantics remain unchanged.

**Track-13.** A runner-dispatched in-process child is a host-plane Child view
Fold keyed by graph key, not a fake `subagent` card. Reconstruct from live
Sessions. The door lasts until the runner releases the child.

**Track-14.** Pipe: sidecar + printed URL, no TTY overlay, no runner Fold.
MetaBar land chip is closed/total; in-flight count lives on the teaser.

**Track-15.** Resume uses this contract. Leftover worktrees are reclaimed as
already 已认领. Missing `Claim: claimed` plus leftover worktree writes the
flag. A leftover worktree with no Session is panorama 已认领, not a dead door.

**Out of Scope.**
- Implementing this spec on the wayfinder map itself.
- A hosted or multi-user Web product; binding the panorama server beyond
  `127.0.0.1` (LAN, auth, a shared hub).
- Arming `/goal` as a second scheduler.
- Using Ralph as the `/ship` coordinator.
- Parallel writers on the shared working tree (worktrees are the isolation).
- Replacing spec `## Plan` checkboxes as the human landing ledger.
- Locking Web panorama palette, type, chrome, empty-state copy, or brief-panel
  layout.
- A fourth Claim bucket, a hub node, Track-N as teaser identity, or in-flight
  as a node kind.

## User Stories

1. As a developer who just answered a grill question, I want `/ship` to inject
   the next frontier round in this invocation, so that I do not type `/ship`
   after every HITL answer.
2. As a developer who just resolved a wayfinder grilling ticket, I want the
   runner to continue from the saved map in this invocation, so that charting
   does not drop me at the prompt.
3. As a developer whose AFK research child has returned, I want the parent to
   wake only if a decision now needs me, so that fact-finding does not cost a
   parent model turn.
4. As a developer watching Status advance by one phase, I want the runner to
   inject the next phase in the same invocation, as it already does, so that
   Confirm still carries forward.
5. As a developer at gate 1, I want Confirm to happen without a modal I must
   click, and a transcript notice that it happened, so that the pipeline after
   HITL does not wait on a second approval ritual.
6. As a developer at gate 2, I want the same auto-Confirm and notice, so that
   tickets-to-landing does not stop for a click I already implied by finishing
   the breakdown.
7. As a developer who interrupts with Ctrl-C, I want the run to abort, so
   that auto-Confirm never traps me in a pipeline I cancelled. Esc still
   dismisses an open gate or card and does not stop the turn.
8. As a developer after Main Track is sealed, I want no Edit modal on a later
   contradiction, so that a needed design change is a Blocker I archive, not a
   silent rewrite.
9. As a developer whose occupancy is a stranger `/goal`, I still want
   `ship · occupancy` on a TTY before any phase turn, so that `/ship` does not
   steal my current objective.
10. As a developer who cancels occupancy, I want my previous `/goal` restored
    and `/ship` stopped, so that closing the dialog does not delete my work.
11. As a developer on a pipe, I want leftover occupancy auto-Replaced, so that
    a scripted run is not frozen on a Selector.
12. As a developer with a dirty working tree, I still want `ship · preflight`
    on a TTY, so that auto-continue does not stash or carry over in silence.
13. As a developer whose session has no working goal service, I want `/ship`
    to continue with spec+prepend, so that a missing host plugin does not
    block delivery.
14. As a developer who runs `/goal` during `/ship`, I want it to show the
    `[ship]` compass and stay disarmed, so that a generic goal-round cannot
    fight the current phase.
15. As a developer who resumes `/goal` by accident, I want the next inject to
    pause it again, so that Hybrid compass still holds while the runner
    continues.
16. As a developer starting `/ship`, I want a named decision map every time,
    so that the inner ring is a real map even when it has no tickets yet.
17. As a developer whose route is already clear, I want Continue-to-grill to
    auto-advance after that HITL, so that a small route is not a second
    `/ship`.
18. As a developer on a confirmed no-map route, I want an empty inner ring
    with no map/spec hub, so that the overlay does not invent a node kind.
19. As a developer in wayfinding, I want at most one non-research decision
    ticket to wake the parent at a time, so that HITL stays one question
    stream.
20. As a developer whose research tickets are unblocked, I want the runner to
    dispatch them as AFK children without a parent model turn, so that reading
    does not serialize on the parent.
21. As a developer landing tickets, I want every currently unblocked,
    unclaimed landing ticket dispatched in parallel worktrees, so that
    independent tickets and siblings of one closed prerequisite do not wait
    on one Active Ticket turn. A numbered `Blocked by: 1, 2` next to
    `Blocked by: 1` is that fan-out.
22. As a developer whose child finished, I want Ready-set merged in lowest
    `landing:N` order among finished, unblocked, 已认领 work, so that merge
    order is the DAG, not completion order or Track-N.
23. As a developer whose earlier-N is still running, I want a finished
    independent later-N that is Ready-set to merge now, so that a slow
    earlier-N is not a barrier.
24. As a developer whose parent proof of that merge is green, I want the
    checkbox ticked now (`Proof: green`, 已关闭), so that dependents unblock
    without waiting for an unrelated claimed ticket.
25. As a developer whose keep-commit stayed `[ ]`, I want dependents to stay
    blocked, so that a red merge cannot masquerade as 已关闭.
26. As a developer whose serial merge hits git conflicts, I want autonomous
    Conflict-resolution in the merge-target tree with validation feedback,
    so that recoverable conflicts do not stop the remaining tickets.
27. As a developer whose conflict is modify/delete, binary, or lockfile, I
    want the child to reconcile or regenerate it using both sides' intent.
    Protected requirement conflicts still need a decision, and exhausted
    retries retain a snapshot and specific blocker rather than losing work.
28. As a developer who interrupts a Conflict-resolution child, I want a
    snapshot and `merge --abort` without `## Blocker`, so that resume is not
    stuck on an archive step I did not mean.
29. As a developer whose parent proof is red after a land merge, I want the
    merge commit kept, the ticket unticked, and a Blocker, so that the honest
    tree survives and repair is in-place.
30. As a developer at delivery, I want Merge back chosen automatically
    (fast-forward when possible, else squash), so that the post-ship modal is
    not a third HITL when the standing preference is already Merge back.
31. As a developer whose Merge-back conflicts, I want the same
    Conflict-resolution child and abort rule, so that delivery does not invent
    a second merge bot.
32. As a developer whose Merge-back proof is red, I want Original-Branch reset
    to pre-merge and `ship/<slug>` kept, so that the feature branch remains the
    recovery vehicle.
33. As a developer whose Landing wave records a Blocker, I want new dispatch
    and further serial merges frozen, so that the shared `ship/<slug>` tree is
    not written while red.
34. As a developer with in-flight independent worktrees during a freeze, I
    want those children to finish and sit as leftover 已认领, so that freeze
    is not a kill of unrelated work.
35. As a developer whose ancestor was unticked after a proof sweep, I want
    that ancestor’s already-dispatched dependents dropped (worktree removed,
    Claim kept, same `landing-N` names), so that they rebuild from the repaired
    HEAD.
36. As a developer resuming a land-merge that never ticked, I want In-place
    repair on `ship/<slug>` with no second land merge, so that the kept merge
    is the base.
37. As a developer resuming a leftover worktree with no Session, I want
    panorama 已认领 and a live Fold only after the runner has a Session on
    that key, so that a dead door is not painted.
38. As a developer resuming with `Claim` missing but a leftover worktree
    present, I want `Claim: claimed` written, so that reclaim matches taken.
39. As a developer whose Occupancy ends or who aborts, I do not want Claim
    cleared, so that taken tickets stay taken until a manual unassign.
40. As a developer looking at the canvas, I want 待认领 / 已认领 / 已关闭 on
    the ticket row, so that I do not hunt a section header for the bucket.
41. As a developer, I want 已认领 to mean taken, not in-flight, so that a
    claimed ticket with no live child is not a lie.
42. As a developer, I want in-flight on the teaser only, so that a fourth
    bucket is not invented.
43. As a developer, I want Occupancy to stay the `/goal` slot, so that Claim
    and Occupancy cannot be used as synonyms.
44. As a developer of a Decision ticket, I want GitHub assignee (or local
    `Status: claimed`) required before AFK dispatch or HITL wake, so that the
    frontier claim is real.
45. As a developer of a Landing ticket, I want scratch `Claim: claimed` before
    worktree and dispatch, with the plan checkbox staying `[ ]` until verified
    `[x]`, so that Claim and done stay different writes.
46. As a developer whose landing GitHub assignee drifted, I want scratch to
    win a rebuild, so that a stray assignee cannot invent 已认领.
47. As a developer whose overlay is open, I want inner ring then outer ring,
    Track-N as a suffix, and `Blocked by: <name>` wrapped rather than
    ellipsized, so that names stay readable at ~120 columns.
48. As a developer on an empty inner ring, I want the overlay kept with a body
    line that says so, so that pinned-empty does not skip to the teaser.
49. As a developer at 80 columns, I want the teaser to drop `click or Ctrl+G`
    first and never drop a bucket word, so that the three counts survive.
50. As a developer with a mixed map, I want the fullscreen to scroll like the
    viewer, so that an 8-row Queue-style window cannot hide the outer ring.
51. As a developer who opens Queue or Todo, I want the overlay dismissed to
    the teaser, so that those surfaces stay exclusive.
52. As a developer in grill HITL, I want the overlay dismissed to the teaser,
    so that the frontier card owns the screen.
53. As a developer who presses Ctrl+G or clicks the teaser, I want the overlay
    toggled, so that the canvas is one gesture away.
54. As a developer who presses Esc on the overlay, I want the teaser above the
    plan row, so that chrome returns without aborting `/ship`.
55. As a developer looking at MetaBar, I want the land chip to be closed/total,
    so that in-flight is not double-counted on the chip.
56. As a developer on a TTY, I want the loopback URL on the panorama teaser
    and overlay title, without a browser opening, so that the node-link view
    is one copy-paste away.
57. As a developer on the Web panorama, I want the same nodes, edges, and
    Claim tokens as the TTY, so that the two projections cannot disagree.
58. As a developer who clicks a Track anchor on the Web panorama, I want a
    stub that it is not a ticket and has no proof, so that Track-N is not
    smuggled into 待认领 / 已认领 / 已关闭.
59. As a developer, I do not want a hub node in the empty inner-ring hole, so
    that a named map is not painted as a ticket.
60. As a developer, I do not want ring angle or radius to mean time, priority,
    or merge order, so that layout is not a third ledger.
61. As a developer on a pipe, I want the sidecar rebuilt and the URL printed,
    with no overlay and no Fold, so that redirected output stays text.
62. As a developer watching a runner-dispatched child, I want a Child view
    Fold at the tail with `click to enter`, so that I can watch work the
    parent model did not tool-call.
63. As a developer, I do not want that Fold named `subagent` or joined to a
    Card run, so that a synthetic tool-call is not implied.
64. As a developer with TDD and Conflict-resolution live on one landing node,
    I want two Folds and a `· conflict` / `· repair` suffix, so that two
    Sessions on one graph key are visible.
65. As a developer after the runner releases the child, I want the Fold gone,
    so that finished-and-merged work is not a historical card.
66. As a developer who clicks a Fold after the Session left the store, I want
    the same `subagent is no longer running` flash, so that enter stays honest.
67. As a developer whose graph cache is corrupt, I want it discarded and
    rebuilt, so that a bad sidecar never stops `/ship`.
68. As a developer whose `Ticket N:` does not match the scratch filename
    integer, I want the run stopped with no guessed cache, so that identity
    is not title-matched.
69. As a developer after Gate 2, I want `Ticket N` never renumbered or reused,
    so that `landing:N` stays stable across resume machines.
70. As a reviewer of git history, I want Worktree commit / land merge / Tick
    or Blocker commit authored by the host git user, so that there is no
    synthetic `codsh` bot and children never commit.
71. As a reviewer, I want nested worktrees gitignored per slug, so that the
    parent tree does not show nested checkouts.
72. As a maintainer, I want Hybrid compass, Claim, Ship graph, Panorama
    overlay, Panorama teaser, Web panorama, Landing wave, Ready-set, Last
    proof, In-place repair, Conflict-resolution child, Worktree branch,
    Worktree commit, Tick commit, and Merge snapshot named in `CONTEXT.md`, so
    that later sessions do not re-invent the words.
73. As a developer reading bilingual READMEs, I want `/ship` described as
    runner-continued after HITL with a two-ring panorama, so that the
    stop-and-retype story is not still the product copy.
74. As an implementer, I want Web look left unspecified, so that landing is
    not blocked on palette.
75. As an implementer, I want the throwaway prototypes available as a steal,
    so that a first canvas can start from something concrete without treating
    it as law.
76. As a developer whose proof sweep fails a sibling 已关闭 ticket, I want
    that ticket unticked (`Proof: red`, Claim kept) and already-closed DAG
    dependents unticked without rewriting their Last proof, so that cascading
    re-verification is not “every later-N.”
77. As a developer, I want one ledger commit per proof sweep, so that there is
    no crash window of mixed lying `[x]`.
78. As a developer, I want `## Blocker` to list every ticket that failed this
    sweep, as evidence not identity, so that archive is HITL and repair is AFK.
79. As a developer of In-place repair that I interrupt, I want `reset --hard`
    to pre-child HEAD and no Blocker, so that Esc is not a sealed-track
    contradiction.
80. As a developer of In-place repair that crashes or times out, I want a
    snapshot, the same restore, and a Blocker, so that a dead child is not
    silent red.
81. As a developer, I want new 待认领 worktrees to wait until drain and
    in-place are idle, so that two writers never share `ship/<slug>`.
82. As a developer, I want Alignment Gate not to apply to Conflict-resolution
    bytes, so that merge hunks are not refused as unmapped implementation.
83. As a developer, I want the land-phase HITL wake to prepend the bound spec
    and the in-flight / Ready-set set, not a single Active Ticket line, so that
    the parent is not lied to about one ticket.
84. As a developer, I want the runner to keep the child Session until it
    releases that child, so that enter stays bound to a live Session.
85. As a developer, I want Claim never to store a Session id, so that a
    leftover worktree is not a stale enter target.

## Implementation Decisions

1. **One runner still owns ship memory.**
   The existing ship-run module remains the only session owner of spec
   polling, the MetaBar chip, the plan row, occupancy, the goals port, the
   sealed-track snapshot, prompt prepend, and phase injection. Auto-continue
   after HITL, gate auto-Confirm notices, Claim writes, worktree Landing wave,
   Ready-set drain, freeze, In-place repair, Conflict-resolution dispatch,
   graph rebuild after canonical writes, teaser counts, loopback Web panorama
   bind, and runner Fold bind join that module through ports. The composition
   root only begins a run, notes a markdown write, aborts, and wires chrome
   plus optional goals, occupancy, child-create, overlay host, and HTTP bind.

2. **Auto-continue is the `/ship` loop, not armed `/goal`.**
   Rewrite Hybrid compass: the runner may inject another turn after HITL
   settles and inside landing; `/goal` stays disarmed. `syncCompass` still
   pauses if activation is armed. Phase prompts drop “this turn then bare
   `/ship`” as the stop rule for HITL-complete work. Occupancy and preflight
   remain the TTY asks they are today.

3. **HITL vs AFK in one invocation.**
   After an `ask_user_question` returns, the same `run()` continues. Research
   and landing children do not spend a parent model turn: the host creates
   them (`agents.create` with `meta.cwd` for a worktree; high-level spawn
   copies parent cwd and is the wrong isolation). Decision-ticket HITL still
   wakes the parent one unblocked ticket at a time. Charting still stops after
   creating the map and dispatching research; the *runner* then continues,
   including auto-advance to grill-me once the route is confirmed.

4. **Always a named map.**
   Wayfinder always charts a `wayfinder:map` (GitHub sub-issues here; local
   markdown under `.scratch/<slug>/wayfinder/` when no tracker). A confirmed
   no-map / empty-frontier route records that conclusion and still has an
   overlay whose inner ring is empty. Do not offer “skip the map” as the
   default product path.

5. **Gates auto-Confirm.**
   When the model presents `ship · gate 1/2` or `ship · gate 2/2`, the runner
   accepts Confirm, writes the Status advance, prints a transcript notice, and
   continues. Ctrl-C interrupt aborts. After seal, do not re-open an Edit modal;
   a later contradiction writes `## Blocker`. Abort as an explicit option
   still stops.

6. **Claim writes before dispatch.**
   Decision: required GitHub assignee, or local `Status: claimed`, committed
   before work. Landing: scratch `Claim: claimed` on
   `.scratch/<slug>/issues/NN-*.md` (no username), then a progress-commit on
   `ship/<slug>`, then worktree, then dispatch. Spec `## Plan` stays `[ ]`
   until verified `[x]` = 已关闭. GitHub landing assignee is a best-effort
   mirror; scratch wins a rebuild. Abort, interrupt, and Occupancy end do not
   unclaim. Manual unclaim = unassign, or omit the `Claim:` line (no
   `Claim: unclaimed` token). Bucket derivation: closed/checked → 已关闭;
   else Claim present → 已认领; else 待认领.

7. **Ship graph rebuild is a pure join.**
   Adjacent `<spec>.ship.graph.json` is a cache. Canonical sources: map
   children (inner), spec `## Plan` checkboxes (outer), sealed `## Main Track`
   `Track-N` lines (anchors). A named-map locator (Canonical map, `[Map]`,
   `wayfinder:map`) is not a Decision ticket and does not hide local
   `.scratch/<slug>/wayfinder/NN-*.md` children; GitHub children listed on
   the named map file still join. Scratch and tracker state derive Claim and
   titles only — they never mint ids. Rebuild on every cache read (teaser,
   overlay, Web bind, dispatch planning, resume) and after every runner write
   to a canonical source, including a wayfinder ticket or approved plan
   written mid-turn. Missing/invalid/unknown-version sidecar: discard and
   rebuild; that never stops `/ship`. Join failure: no guessed cache, stop
   `/ship`. Disk write failure after a successful join: keep the in-memory
   graph, retry next rebuild (atomic tmp+rename).

   Envelope and lean node/edge shape, from the graph-join decision (not a
   freeze snapshot):

   ```json
   {
     "version": 1,
     "specPath": "automatic-ship-continuation.md",
     "nodes": [
       {
         "id": "decision:github:Blackman99/codsh#107",
         "kind": "decision",
         "title": "Graph node identity across tracker, spec, and cache",
         "claim": "closed",
         "ticketType": "grilling"
       }
     ],
     "edges": [
       {
         "from": "decision:github:Blackman99/codsh#115",
         "to": "decision:github:Blackman99/codsh#107",
         "kind": "blocked-by"
       }
     ]
   }
   ```

   Keys: `decision:github:owner/repo#n` / `decision:local:NN`, `landing:N`,
   `track:N`. `claim` is `"unclaimed" | "claimed" | "closed"` (English in
   JSON; renderers map to 待认领 / 已认领 / 已关闭). Track nodes have no
   `claim`. Edges only `blocked-by` and `hangs-off`. GitHub native
   `blocked_by` wins when the dependencies API is available; body
   `Blocked by:` is fallback only; do not union. Stop vs skip follows
   [Ship graph sidecar fields and rebuild join](https://github.com/Blackman99/codsh/issues/115).
   Plan identity is the `Ticket N:` prefix; today’s plan parser accepting any
   checkbox is not the graph join. After Gate 2 Confirm, `N` is never
   renumbered or reused.

8. **Worktree layout and git identities.**
   Directory is the filesystem form of the graph key under
   `.scratch/<slug>/worktrees/`. Ref is `wt/<slug>/<directory>`. Never a
   detached HEAD, never `ship/<slug>/landing-N`, never a parent ref
   `wt/<slug>`. After any merge commit into `ship/<slug>`, remove the
   worktree and delete the ref. Abort without a merge keeps the same
   directory and ref. Nested checkouts are ignored via per-slug
   `.scratch/<slug>/worktrees/.gitignore` and
   `.scratch/<slug>/merge-snapshots/.gitignore`. Author of every runner
   commit is the host `user.name` / `user.email`. Children never commit.

   Landing commits: (1) Worktree commit subject `Ticket N: <title>`, body
   cites Track-N; (2) `--no-ff` land merge `ship: land Ticket N — <title>`,
   kept even if proof is red, checkbox not ticked here; (3) green Tick
   `ship: tick Ticket N — <title>` or red Blocker commit that force-adds the
   Merge snapshot. Interrupt: snapshot on disk only — no git commit, no
   `## Blocker`. Delivery: fast-forward when possible (skip re-prove); else
   squash with host author and spec title; re-prove Layer 1 + Layer 2; red
   resets Original-Branch, does not delete `ship/<slug>`. Merge snapshots
   live at `.scratch/<slug>/merge-snapshots/<directory>/<utc>/` (landing
   directory name, or `delivery`).

9. **Ready-set, proof sweep, freeze, resume vehicles.**
   Dispatch every currently unblocked, unclaimed landing ticket. Serial-merge
   only Ready-set. Tick now after that merge’s parent proof is green. Git
   conflict stays 已认领 on the same node and worktree id, merge as-is, one
   Conflict-resolution child. After every land merge and every Tick, re-run
   each currently-已关闭 ticket’s own named proof commands (not full
   dual-layer; that stays final verification), plus already-landed 已认领
   whose blockers are all 已关闭. Sibling 已关闭 that now fails → untick
   (`Proof: red`, Claim stays) and untick transitive already-已关闭 DAG
   dependents without changing their Last proof. Independents that still pass
   stay `[x]`. One ledger commit writes the whole sweep. Any Blocker freezes
   new dispatch and further serial merges; in-flight independents finish.
   Last proof is scratch `Proof: green|red` beside `Claim: claimed`, omitted
   until the first parent proof. Resume vehicles are git + DAG + Last proof
   as in [Merge order of a finished landing wave](https://github.com/Blackman99/codsh/issues/112).
   In-place repair cwd is the parent `ship/<slug>` tree; new worktrees wait
   until that queue is idle. There is no landing `n*3+1` or two-no-progress
   turn-budget breaker; an unresolved `## Blocker` stops automatic
   continuation until archived.

10. **Conflict-resolution child's authority.**
    Fresh-context child in the merge-target tree (landing or Merge-back).
    Resolve text hunks while preserving surrounding content and both sides’
    non-overlapping intent; regenerate conflicted lockfiles/generated
    artifacts; reconcile modify/delete, rename, or binary conflicts using
    index stages, history, and ticket intent. No unrelated implementation.
    Alignment Gate does not apply to resolution writes. Compare unrelated
    paths with the pre-child baseline: clean Git auto-merges are legitimate,
    but child changes to those files are rejected. Feed validation errors
    back to a fresh child for up to three attempts without aborting between
    attempts. Runner stages only conflict paths and commits non-interactively
    (`commit --no-edit` for landing, explicit title for squash delivery).
    Protected-heading hunks or exhausted retries snapshot + rollback +
    Blocker. Interrupt/crash/timeout: kill, snapshot, rollback, no `## Blocker`.
    A squash has no MERGE_HEAD: rollback uses `reset --merge HEAD`.
    Unchanged markerless conflicts require explicit staging confirmation on
    retry; a no-op child cannot silently choose ours. Git may represent a
    heavily edited rename as modify/delete plus a staged addition, so those
    additions are included in the resolution scope. Markerless protected
    spec content remains immutable. Rollback failures are visible and never
    followed by a blocker commit into the pending merge.

11. **Chrome: overlay, teaser, land chip.**
    Panorama overlay is a pinned alternate-screen fullscreen, prior art the
    viewer (scroll the whole screen). Inner ring, then outer ring. Claim
    bucket word on the ticket row. Track-N suffix only
    (`landing · Track-1 Track-2`). Wrap `Blocked by: <name>` onto the next
    row. Never ellipsize a ticket name to keep chrome. Empty inner ring: one
    body line, teaser `待认领 0 · 已认领 0 · 已关闭 0`, do not skip to
    teaser. Ctrl+G / click teaser toggles; Esc returns to the teaser above
    the plan row. Exclusive with Queue/Todo; grill HITL dismisses to the
    teaser. Teaser keeps the three bucket counts, in-flight, and the loopback
    URL when bound; drop `click or Ctrl+G` first. MetaBar land chip is closed/total (ticked /
    plan length), not `done+1` while a ticket is current. In-flight is not
    on the chip.

12. **Web panorama.**
    Bind `127.0.0.1` on an ephemeral port, one server for the TTY session,
    watching the rebuilt graph cache. Pin the URL on the teaser and overlay
    title; do not open a browser. Off a TTY, print the URL once.
    Do not mint a second port when a spec appears or `/ship` continues.
    Node-link of the same graph; clicking a node shows a stub brief/evidence
    slot. Forbids: hub in the empty inner-ring hole; Track anchors in the
    three buckets or teaser counts; 已认领 meaning in-flight; treating ring
    geometry as time/priority/merge order. Look (palette, type, chrome,
    empty-state copy, brief-panel layout) is not specified. Off a TTY: no
    overlay, still sidecar + printed URL.

13. **Runner Child view Fold.**
    New transcript bind: given a child Session id and a label, paint the same
    `click to enter` door without a parent `tool/call` and without waiting on
    `subagent/start`. Head is `Ticket N: <title>` or the decision name, then
    dim `click to enter`; `· conflict` / `· repair` only when one graph key
    has two live Sessions. No Claim bucket, no Track-N suffix, no graph key
    in the head. Whenever the parent Viewport is shown, one Fold per live
    in-process Session that names a graph key, at the tail, in graph-key
    order. Reconstruct from live Sessions after Enter+Esc, `/clear`, and
    session replacement. The runner keeps the Session until it releases the
    child (worktree removed after land merge; in-place / conflict / research
    child finished), then dispose. Off a TTY: no Fold. Workflow/Ralph worker
    threads stay non-views.

14. **Prompt contracts.**
    `shipPromptFor` / `SHIP_PROMPT`: drop “stop; the next `/ship` injects”
    as the HITL-complete rule; always chart a named map; land prepends
    in-flight / Ready-set, not one Active Ticket; no turn-budget breaker;
    Conflict-resolution is not TDD; forbid goal tools remains; freeze-after-
    Confirm remains; Track-N cite on the first red test or Worktree commit
    remains. Hybrid compass language: runner may continue; `/goal` stays
    disarmed.

15. **Docs and release.**
    Domain language already in `CONTEXT.md` from the map; landing must keep
    it in parity with behavior (Ship gates, Ship delegation, Hybrid compass,
    Claim, Ship graph, overlay/teaser/Web panorama). Bilingual READMEs name
    runner continuation, the two-ring panorama, and that `/goal` stays
    disarmed. Changeset on `codsh-bundle` (minor: user-visible workflow).
    Alignment Matrix `/ship` row records the continuation + panorama
    tightening as the existing owner-confirmed addition, not a new reference
    copy.

## Testing Decisions

A good test asserts observable behavior at a public seam: injected prompts,
Status/Claim/graph bytes, chrome strings, Fold enter targets, bind URLs, git
refs and commit subjects the runner produced. It does not inspect private
helpers, mock a browser, or call live GitHub. Prefer existing seams; do not
add a fourth runtime or a harness-mounted GoalService in unit tests.

Confirmed seams (highest existing first; two new *functions*, not new
runtimes):

1. **Primary — `ShipRun` public API** (existing `ship-run` tests).
   Construct with chrome plus optional goals, occupancy, child-create, and
   bind fakes. Prove, without a live host:
   - After a HITL `ask_user_question` returns, the same `run()` injects the
     next turn without a second `run()` call.
   - Status +1 still auto-continues; unchanged Status that is not waiting on
     the runner (true idle after abort) still stops.
   - Gate auto-Confirm writes Status and a notice; Ctrl-C interrupt aborts
     the run; Esc dismisses an open gate; no Edit path after seal.
   - Named map always; empty inner ring; auto-advance to grill after
     confirmed clear route.
   - AFK child dispatch with `meta.cwd` for a worktree; no parent prompt
     spent for that dispatch.
   - Claim required before dispatch; leftover worktree reclaim writes
     `Claim: claimed`.
   - Landing wave: parallel unblocked unclaimed, including siblings of one
     closed prerequisite; Ready-set lowest
     `landing:N`; tick now; freeze on Blocker; independents finish.
   - Conflict-resolution retries validation feedback up to three attempts;
     text, lockfile, modify/delete, clean auto-merges, and squash completion
     are covered with real Git. Interrupt has no `## Blocker`; protected
     requirements and exhausted retries retain recovery snapshots.
   - No landing turn-budget breaker; unresolved `## Blocker` stops
     continuation until archived.
   - Graph rebuild after canonical writes; join failure stops; bad cache
     rebuilds.
   - Teaser counts on chrome; land chip closed/total.
   - Loopback bind on `127.0.0.1` ephemeral port (fake HTTP); URL surfaced.
   - Runner Fold bind via a transcript port; gone after release.
   - Occupancy and dirty-tree preflight unchanged on a TTY; pipe
     auto-Replace; pipe has no overlay and no Fold.
   - Delivery auto Merge-back (fast-forward vs squash fake git); red resets
     Original-Branch.

2. **Ship graph rebuild** (new pure join, same class as `parsePlan` /
   ship-snapshot).
   Canonical sources in → `{ version, specPath, nodes, edges }` out. Pin
   native keys, derived Claim, `blocked-by` / `hangs-off`, stop vs skip,
   `Ticket N:` identity, empty inner ring, Track nodes without `claim`,
   GitHub `blocked_by` winning over body fallback (injected summary, not a
   network). Do not test GitHub or a browser here.

3. **`shipPromptFor` / `SHIP_PROMPT`** (existing `ship` tests).
   Pin tokens that must not regress: always chart a named map; runner
   continues after HITL; land prepends in-flight / Ready-set not one Active
   Ticket; no `n*3+1` / two-no-progress breaker; Conflict-resolution is not
   TDD; forbid `create_goal` / `update_goal` / `get_goal`; freeze-after-
   Confirm; Track-N cite; Hybrid compass forbids armed `/goal`, not the
   `/ship` loop. Grill injection still excludes later phase contracts.

4. **Panorama overlay + teaser paint** (new paint function; prior art:
   viewer, FrontierCard, QueuePanel).
   Frames at 120 and 80 columns: empty inner ring; mixed inner + outer;
   bucket on the row; Track-N suffix; wrap `Blocked by: <name>`; teaser drops
   the key hint first and never a bucket word; empty overlay kept; exclusive
   with Queue/Todo; grill HITL dismisses to teaser. Web look is out of scope.

5. **Transcript runner Fold** (existing transcript / Child view tests).
   Door without a parent `subagent` card; graph-key slot; reconstruct from
   live Sessions; `· conflict` / `· repair` only for two Sessions on one
   key; gone when the runner releases the child; click after leave still
   flashes `subagent is no longer running`. Pipe: no Fold.

Do not test host GoalService, `dsh-command-goal`, Ralph as coordinator, live
GitHub, or Web visual design. Do not parse real test files or git logs for
Track-N cites in production code beyond the runner-authored commit subjects
named above.

## Out of Scope

- Implementing this spec on the wayfinder map (the map produced decisions;
  landing is a later session).
- A hosted or multi-user Web product; binding the panorama server beyond
  `127.0.0.1` (LAN, auth, a shared hub).
- Arming `/goal` as a second scheduler, or turning `/goal` into a canned
  `/ship`-style prompt.
- Using Ralph as the `/ship` coordinator.
- Parallel writers on the shared working tree.
- Replacing spec `## Plan` checkboxes as the human landing ledger.
- Locking Web panorama look (palette, type, chrome, empty-state copy,
  brief-panel layout).
- A fourth Claim bucket, a hub node in the inner-ring hole, Track-N in
  teaser counts, in-flight as a node kind, or ring geometry as time.
- Forking or patching `@deepseek-ai/dsh-goal`, `dsh-tool-goal`,
  `dsh-command-goal`, `dsh-goal-round-driver`, or the subagent provider to
  add `cwd` on high-level spawn (use `agents.create({ meta: { cwd } })`
  instead).
- A TTY GoalBar or extra MetaBar chip kind for the track.
- A machine evaluator that parses tests or git history for Track-N cites
  beyond runner-authored subjects.
- Restoring a replaced stranger goal after ship completes.

## Acceptance Criteria

1. `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts packages/bundle/tests/ship.spec.ts packages/bundle/tests/plan.spec.ts packages/bundle/tests/ship-snapshot.spec.ts packages/bundle/tests/child-view.spec.ts packages/bundle/tests/transcript.spec.ts` exits 0, and the new cases named in Testing Decisions are present and green (HITL auto-continue, gate auto-Confirm, worktree Landing wave / Ready-set / freeze, Claim-before-dispatch, graph rebuild stop vs skip, overlay/teaser frames, runner Fold without a `subagent` card).
2. Graph-join tests (new module beside plan/snapshot prior art) cover native keys, derived Claim, `blocked-by`/`hangs-off`, `Ticket N:` mismatch stop, bad cache rebuild, empty inner ring.
3. Overlay/teaser paint tests cover 120 and 80 columns, empty overlay kept, wrap `Blocked by:`, teaser drops the key hint first.
4. `pnpm run typecheck` exits 0, or records only pre-existing errors already named in a Baseline (zero new failures).
5. `pnpm test` exits 0 with zero new failures against the landing Baseline.
6. Domain terms Claim, Panorama overlay, Panorama teaser, Web panorama, Landing wave, Ready-set, Last proof, In-place repair, Conflict-resolution child, Worktree branch, Ship graph match in `CONTEXT.md`.
7. Bilingual READMEs mention runner continuation after HITL and the two-ring panorama.
8. A changeset names `codsh-bundle` with a `minor` bump.

## Further Notes

- Vocabulary is `CONTEXT.md`. Overlay/teaser/Web panorama, Claim vs Occupancy,
  and Hybrid compass were updated during wayfinding; landing must not regress
  them. Ship gates and Ship delegation still describe “charting stops” and
  “one ticket per model turn” in places — those sentences are part of this
  change.
- ADR-0001 still applies to surface arbitration. `/ship` remains the
  owner-confirmed addition beyond the reference set; this spec tightens that
  row rather than copying a reference agent.
- Seams were confirmed with the user before this spec was written: `ShipRun`
  public API, graph rebuild join, `shipPromptFor`, overlay+teaser paint,
  transcript runner Fold. Do not fold the graph join into `ShipRun` tests.
- `/to-tickets` should slice vertically across these seams (schema/join,
  runner loop, landing git, overlay paint, Fold bind, docs), not as
  horizontal “one module” tickets.
- Local copy of this spec lives in-repo so a later session does not depend on
  GitHub serving the full issue body. The tracker issue is the published
  parent; do not give this file a `Status:` phase line.
