# Bind /goal into /ship as a Main Track compass

Status: landing
Branch: ship/ship-goal-main-track
Base-Commit: 48b4b4b8dd06dff9e9ab98007add1e4c93ef12a0
Original-Branch: main

## Requirement

goal 指令没有什么作用，考虑跟 ship 指令做一个结合，ship 的整个过程中，agent 容易偏离原来的主设计轨道；goal 就是起这个作用，这里 ship 要怎么设计才能保证后续所有阶段的每一笔都是种遵循主轨道。

## Problem Statement

A person types `/ship` with one sentence and a long grill. The confirmed spec is supposed to be the design. In later phases the agent only sees the current phase contract plus an instruction to re-read that file. Under TDD pressure, a Ralph loop, or a mid-flight surprise, it quietly rewrites the spec to match what it already built. `/goal` exists as a same-session compass, but it does nothing useful during `/ship`: ship turns are plugin-sourced so the model cannot create a goal, the harness round driver would fight phase injection if a goal were armed, and fresh Ralph workers never inherit the parent session goal. The person who wanted `/goal` to keep the work on the main track instead watches `/ship` drift.

## Solution

`/ship` keeps the spec as durable memory and the phase loop as scheduler. Grill produces a compact **Main Track** (the idea, numbered Track-N decisions, Out of Scope). Gate 1 Confirm seals it. From then on every later `/ship` turn is prepended with a process snapshot of that track — not a live reread the agent can rewrite this run. Plan tickets name the Track-N ids they implement; landing must cite them on the first red test or the ticket commit. A large plan puts the sealed track into the Ralph objective as well as the spec path.

The harness session goal is a **disarmed compass**, not a second scheduler. The ship runner owns occupancy and lifecycle through a narrow goals port: pause an unrelated current goal before asking, replace or abort, create a `[ship]` placeholder, edit it to the draft then the sealed track, complete on shipped, leave it paused on abort. If the goals port is missing or throws, the spec+prepend path still binds later phases. `/goal` remains the human command; during a ship run it merely shows the compass.

## Grill Decisions

1. **Hybrid compass** — Spec stays the durable design contract. Harness `/goal` is a *disarmed* session compass whose objective is the compact Main Track. The ship runner stays the scheduler and never arms continuation, so the harness round driver cannot inject generic goal-round prompts that fight phase contracts. Reason: `/ship` already owns phase injection; the harness goal is one-current-goal state, not a scheduler we can reuse. Ralph workers do not inherit the parent session goal.

2. **Compact Main Track payload** — The track is the one-sentence idea, numbered Track-N grill decisions, and Out of Scope — not the full spec. Full stories, seams, and tickets stay in the spec file. Reason: dumping the whole spec into every later turn would undo phased injection (grill / to-spec / tickets / TDD do not share context on purpose).

3. **Freeze at gate 1 Confirm** — Grill writes a *draft* `## Main Track`. to-spec may complete Out of Scope and tidy wording. Gate 1 Confirm *seals* it. Later phases may update Status, checkboxes, and proof logs, but must not rewrite frozen decisions. A needed contradiction is a blocker (ask / circuit breaker), never a silent spec edit. Reason: today's Phase 5 "update the spec when a decision changes" is exactly how the agent leaves the main track.

4. **Mechanical prepend + per-ticket cite** — Later phase injections prepend the track. After Confirm, prepend a *process snapshot* of `## Main Track` captured at seal time, not a live disk reread the agent can rewrite this run. Each plan ticket records `Track: N[,M]`. The landing prompt requires the first red test (or the ticket commit message) to cite those ids. Ralph's objective carries the sealed track verbatim plus the spec path. Reason: "re-read the spec" is the current miss; instruction-only citation is honor system.

5. **Ship owns the session goal** — A narrow goals port on the ship runner wraps the host goal service when present. Missing or throwing service *degrades*: spec+prepend still binds later phases; flash that `/goal` was not updated. Do not abort the ship run. Objective text is `[ship]` plus the full compact track; if create rejects on length, fall back to `[ship] <idea>` and keep the full track in prompt prepend. Spec header `Goal-Id:` is passed into the grill prompt and written by the model. Reason: model goal tools require a direct human user-turn; `/ship` turns are plugin-sourced. The bundle does not add a goal-package dependency.

6. **Occupancy, before inject** — Harness allows one current goal. If an *unrelated* current goal exists at `/ship` start: pause it immediately (stops the round driver), then a Selector with header `ship · occupancy` (Replace / Abort). TTY Esc/cancel = Abort: resume the paused stranger and stop `/ship`. Non-TTY: auto-Replace. Replace → clear → create placeholder → pause, all before the first phase turn. Ours: current id matches spec `Goal-Id:`, or the objective starts with `[ship]` → edit/pause, do not ask. Resume of an unfinished spec uses the same occupancy+placeholder/edit path. Reason: create cannot start a new goal while one is unfinished; pause does not free the slot. Asking while the stranger is still armed lets a goal-round fire in the idle modal.

7. **Lifecycle writes** — Start: create placeholder `[ship] <idea>` then pause (create always arms; pause synchronously before awaiting the first turn). After grill handshake: edit to the draft track, pause. Gate 1 Confirm: edit to the sealed track, pause, snapshot. Status shipped: complete. Abort / Esc / gate Abort: leave the ship goal paused. Always pause after mutate. On every later phase inject, re-assert: if the human `/goal` edited the objective, edit it back to the spec track; if activation is armed, pause. Model must not call goal tools during ship; prompt token in every phase. Reason: human `/goal resume` would otherwise rearm the driver mid-run.

8. **Schema** — New `## Main Track` section (idea, numbered Track-N lines, Out of Scope bullets). Plan lines gain `Track: N[,M]` beside blockers. Plan parsing keeps stripping metadata so chrome titles stay short. Spec metadata gains `Goal-Id:`. Transparent Markdown only — no JSON sidecar.

9. **Chrome** — No new chrome row. MetaBar chip and plan row stay as they are. `/goal` (if the person runs it) is a side channel showing the `[ship]` objective. No TTY GoalBar.

10. **Out of scope (product)** — No harness fork. `/goal` stays the human-owned command. No machine evaluator of track-compliance beyond prompt tokens and unit tests. Do not make `/goal` a canned prompt like `/ship`. Occupancy is a Selector, not a ship gate modal. Preflight (dirty tree) stays inside Phase 0 of the grill prompt; occupancy is the only new runtime modal, because it is the driver race.

## Main Track

Sealed at gate 1 Confirm. Later phases must not rewrite these lines. Progress (Status, checkboxes, proof logs) remains writable.

**Idea.** Bind `/goal` into `/ship` so every later phase stays on the grilled design.

**Track-1.** Hybrid compass: spec is durable memory; harness goal is a disarmed session compass; the ship runner stays the scheduler and never arms continuation.

**Track-2.** Compact payload: idea + numbered Track-N decisions + Out of Scope. Not the full spec.

**Track-3.** Freeze at gate 1 Confirm. Contradiction is a blocker, never a silent spec rewrite.

**Track-4.** Mechanical prepend of a process snapshot after Confirm; each plan ticket names `Track: N[,M]`; first red test or commit cites those ids; Ralph objective carries the sealed track plus the spec path.

**Track-5.** Ship owns the session goal through a narrow port; missing/throwing service degrades to spec+prepend; objective is `[ship]` plus the track (length fallback `[ship] <idea>`); `Goal-Id:` is injected into grill and written on the spec.

**Track-6.** Occupancy before inject: pause a stranger first, then Selector `ship · occupancy` (Replace / Abort). TTY cancel = Abort (resume stranger, stop ship). Non-TTY auto-Replace. Ours = matching `Goal-Id:` or `[ship]` prefix.

**Track-7.** Lifecycle: placeholder at start, draft after grill, sealed at Confirm, complete on shipped, paused on abort; always pause after mutate; re-assert on every later inject; model must not call goal tools.

**Track-8.** Schema: `## Main Track`, `Track:` on plan lines, `Goal-Id:` metadata, Markdown only.

**Track-9.** No new chrome row; no TTY GoalBar.

**Out of Scope.**
- Forking or patching the harness goal service, command, tools, or round driver.
- A TTY GoalBar or extra chrome row for the track.
- Turning `/goal` into a canned `/ship`-style prompt.
- Arming harness continuation during a ship run.
- A machine evaluator that parses tests or git history for Track-N cites (prompt tokens and unit tests only).
- Moving dirty-tree preflight out of the grill prompt into the runner.
- Restoring a replaced stranger goal after ship completes (one-current-goal limit).
- Creating a harness goal inside Ralph workers (they cannot; the sealed track rides their objective).

## User Stories

1. As a developer running `/ship`, I want every later phase to be shown the grilled design as a compact compass, so that the agent cannot rely on a fading conversation or a polite "re-read the spec".
2. As a developer who confirmed the spec, I want that compass frozen, so that landing cannot rewrite the design to match whatever it already built.
3. As a developer whose landing work needs to contradict a frozen decision, I want the run to stop and ask me, so that a real design change is a conscious choice.
4. As a developer who already has a `/goal` when I type `/ship`, I want to choose Replace or Abort before any ship turn starts, so that `/ship` does not silently steal my current objective.
5. As a developer who cancels that occupancy choice, I want my previous `/goal` restored and `/ship` stopped, so that closing the dialog does not delete my work.
6. As a developer running `/ship` on a pipe, I want a leftover `/goal` replaced automatically, so that a scripted run is not frozen on an occupancy question.
7. As a developer whose session has no working goal service, I want `/ship` to continue with the spec compass alone, so that a missing host plugin does not block delivery.
8. As a developer who runs `/goal` during a ship run, I want it to show the ship compass with a clear `[ship]` mark, so that the command is no longer empty during the work that needs it.
9. As a developer who resumes `/goal` by accident mid-ship, I want the next ship turn to put the compass back and keep auto-continue off, so that a generic continuation round cannot fight the current phase.
10. As a developer who Aborts a gate or Escapes the run, I want the ship compass left paused, so that a later `/ship` resume still has it.
11. As a developer resuming an unfinished spec, I want occupancy and the compass restored the same way as a new run, so that a restarted session is not spec-only with an empty `/goal`.
12. As a developer whose current `/goal` is already the ship compass, I want `/ship` to reuse it without asking, so that resume does not prompt me to delete my own track.
13. As a developer landing a ticket, I want that ticket to name which track decisions it implements, so that a reviewer can see the work is on-rail.
14. As a developer whose plan is large enough for fresh workers, I want those workers to receive the sealed compass in their mission, so that a new agent without the parent session still follows the track.
15. As a reviewer of the spec file, I want a dedicated Main Track section and a Goal-Id in the header, so that the compass is readable without the conversation.
16. As a developer looking at the terminal chrome, I want the existing ship chip and plan row unchanged, so that the compass does not add another pinned line.
17. As a developer using `/goal` by itself, I want it to remain the ordinary human command, so that `/ship` does not replace or hide it.
18. As a developer whose ship compass is too long for the session slot, I want a short fallback in `/goal` while the full track still rides every later `/ship` turn, so that a length rejection does not drop the compass.
19. As a developer during grill, I want the spec header to record the session goal id the run created, so that later occupancy can recognize our compass.
20. As a person answering occupancy, I want only Replace and Abort, so that occupancy cannot become a free-text third policy.
21. As a developer on a later `/ship` turn, I want the phase prompt to forbid goal tools, so that the model does not fight the runner for the session slot.
22. As a maintainer of the workflow docs, I want the Main Track, occupancy, and freeze rules named in the product language, so that `/ship` and `/goal` are not described as unrelated.

## Implementation Decisions

1. **One runner still owns ship memory.**
   The existing ship-run module remains the only session owner of spec polling, the MetaBar chip, the plan row, and phase injection. Occupancy, the goals port, the sealed-track snapshot, prompt prepend, and lifecycle writes join that module. The composition root only begins a run, notes a markdown write, aborts, and wires two ports: chrome (as today) plus optional goals and an optional occupancy ask.

2. **Narrow `ShipGoals` port — no new package dependency.**
   The runner never imports the host goal service type. The port exposes get / create / edit / pause / resume / complete / clear plus id, objective, phase, and activation. The composition root wraps `ctx.goals` when present; tests inject a fake. Missing port or a thrown error degrades: flash that `/goal` was not updated, continue spec+prepend. Length rejection on create retries once as `[ship] <idea>` then degrades the harness half.

3. **Occupancy ask port.**
   A Selector, not a gate modal (gates remain spec and tickets). Title/header exactly `ship · occupancy`. Options: Replace (first), Abort. TTY: `cancelled` / empty / Esc = Abort — resume the paused stranger, stop the run without injecting a phase. Non-TTY or absent ask: auto-Replace. Occupancy runs after the runner is constructed and before the first phase turn is awaited.

4. **Ours vs stranger.**
   A current goal is ours when its id equals the live spec's `Goal-Id:`, or when its objective starts with `[ship]`. Ours: edit/pause, never ask. Stranger (non-complete): pause immediately, then ask. Complete or absent: create placeholder. Stale `Goal-Id:` across sessions is ignored and rewritten after a successful create.

5. **Prompt contracts.**
   `shipPromptFor` gains an optional sealed-track argument (and grill gains `$GOAL_ID` via the same template expander already used for `$ARGUMENTS`). Grill / spec / tickets / land / done each contain: forbid goal tools; do not rewrite `## Main Track` after Confirm; contradiction is a blocker. Spec / tickets / land / done prepend the snapshot when one exists, otherwise the live `## Main Track` from disk while still a draft. Land requires `Track: N[,M]` on each plan line and a Track-N cite on the first red test or the ticket commit. Ralph's objective is the sealed track verbatim plus the spec path. Phase 5 no longer authorizes silent decision rewrites; progress (Status, checkboxes, proof logs) remains writable.

6. **Spec schema.**
   Header may include `Goal-Id: <id>`. A `## Main Track` section holds the idea, Track-N lines, and Out of Scope bullets. Plan checkboxes may include `Track: 1,3` next to blockers. Plan parsing strips `Track:` the way it already strips blockers and verification so chrome titles stay short. Metadata parsing returns `goalId` when present.

7. **Lifecycle relative to Status.**
   - Run start, no ours: occupancy as above, then create `[ship] <idea>`, pause, pass the new id into the grill injection.
   - Grill handshake (Status becomes interviewing, spec now has a draft track): edit objective to `[ship]` + draft track, pause.
   - Gate 1 Confirm (Status becomes confirmed): capture `## Main Track` into the run's snapshot; edit objective to `[ship]` + sealed track; pause. Later injects of this run prepend the snapshot.
   - Status shipped, dual-layer DoD passed: complete the current ship goal.
   - Abort / Esc / occupancy Abort: leave the ship goal paused; on occupancy Abort, resume the stranger instead.
   - Every later phase inject: if objective drifted, edit back; if armed, pause.

8. **Create-then-pause race.**
   Create always arms. Pause runs synchronously in the same turn as create, before the first phase followup is awaited. The agent is not idle, so the round driver should not admit a round. Do not fork the harness to add create-paused.

9. **Docs and release.**
   Domain language (Main Track, occupancy, hybrid compass) updates CONTEXT.md under Ship gates. Bilingual README `/ship` sections name occupancy, the frozen track, and that `/goal` shows the compass during a run. A changeset on `codsh-bundle` (minor: user-visible workflow).

## Testing Decisions

Prior art for `/ship` is already three public seams that this change extends, not a new mock-heavy interior. Prefer those same seams; do not add a fourth package or a harness-mounted GoalService in unit tests.

1. **Primary seam — `ShipRun` public API** (`ship-run` tests).
   Construct with chrome plus optional `ShipGoals` and occupancy ask fakes. Prove, without a live host:
   - No current goal: create placeholder then pause before the first injected prompt; grill prompt contains the returned Goal-Id.
   - Stranger on a TTY: pause, ask `ship · occupancy`; Replace clears then creates; Abort resumes the stranger and injects nothing.
   - Occupancy cancel/Esc: same as Abort.
   - Absent ask (pipe): auto-Replace without asking.
   - Ours by Goal-Id or `[ship]` prefix: no ask, edit/pause.
   - Goals port missing or create/pause throwing: run continues; injected prompts still carry the spec track; no throw out of `run()`.
   - After a spec write that seals `## Main Track` and Status confirmed: later injects prepend that snapshot even if the file's Main Track is later rewritten.
   - Re-assert on a later inject: drifted objective edited back; armed goal paused.
   - Status shipped (session write): complete called.
   - Abort/Esc after placeholder: complete is not called.
   - Ralph path (land prompt): objective text for the loop contains the sealed track and the spec path.

2. **Prompt-token seam — `shipPromptFor` / `SHIP_PROMPT`** (`ship` tests).
   Pin tokens that must not regress: `## Main Track`, `Track:`, `$GOAL_ID`, `ship · occupancy`, forbid `create_goal` / `update_goal` / `get_goal`, freeze-after-Confirm, contradiction is a blocker, Track-N cite on the first red test or commit, Ralph objective carries the sealed track. Grill injection still excludes later phase contracts; spec/tickets/land still exclude grill. Prepend appears on spec/tickets/land/done, not as a substitute for the phase contract.

3. **Schema seam — plan parsing** (`plan` tests).
   `Goal-Id:` round-trips in metadata. `## Main Track` is not counted as plan tickets. A plan line `Track: 1,3` is stripped from the chrome title and does not break blocker stripping. Existing Branch / Base-Commit / Original-Branch / Status / checkbox cases stay green.

Do not test host GoalService, the Web GoalBar, or `dsh-command-goal`. Do not parse real test files or git logs for Track-N cites in production code.

## Out of Scope

- Forking or patching `@deepseek-ai/dsh-goal`, `dsh-tool-goal`, `dsh-command-goal`, or `dsh-goal-round-driver`.
- Adding `@deepseek-ai/dsh-goal` as a bundle dependency or peer solely to type the host service.
- A TTY GoalBar, extra chrome row, or MetaBar chip kind for the track.
- Making `/goal` a canned prompt, or routing `/goal` through `ShipRun`.
- Arming harness continuation at any point in a ship run.
- A machine evaluator, git hook, or commit-message linter that rejects missing Track-N cites.
- Restoring a replaced stranger goal after ship completes.
- Creating or mutating goals inside Ralph / workflow child sessions.
- Moving dirty-tree preflight (`ship · preflight`) from the grill prompt into the runner.
- Changing rewind, turn-source, or plugin-sourced canned-command provenance.
- Remote Git hosting, issue-tracker publication (tracker unconfigured), or new GateModal kinds.

## Acceptance Criteria

1. `pnpm exec vitest run packages/bundle/tests/ship.spec.ts packages/bundle/tests/ship-run.spec.ts packages/bundle/tests/plan.spec.ts` exits 0, and the new cases named in Testing Decisions are present and green (occupancy pause-then-ask, snapshot prepend after Confirm, goals-port degrade, `Goal-Id` / `Track:` parsing, forbid-goal-tools tokens, Ralph track in the land prompt).
2. `pnpm run typecheck` exits 0.
3. `pnpm test` exits 0 with zero new failures against the Phase 3 baseline.
4. `rg -n "Main Track|ship · occupancy|\\$GOAL_ID" packages/bundle/src/ship.ts packages/bundle/src/ship-run.ts packages/bundle/src/plan.ts` prints matches in all three modules (the contracts live in code, not only in this spec).
5. `rg -n "Main Track|occupancy" CONTEXT.md README.md README.zh.md` prints matches in all three docs.
6. `ls .changeset/*.md` includes a changeset that names `codsh-bundle` with a `minor` bump for this workflow change.

The issue tracker is unconfigured for agent work. Local store: `.scratch/ship-goal-main-track/spec.md` and `.scratch/ship-goal-main-track/issues/`. Run `/setup-engineering-workflows` if later tickets should land in a tracker; this pass will not invent one.

## Plan

- [x] Ticket 1: Spec schema — Delivers Goal-Id metadata, ## Main Track parse, and Track: strip on plan lines so chrome titles stay short (Blocked by: none) (Track: 8)
- [x] Ticket 2: Prompt contracts — Delivers shipPromptFor track/goalId, $GOAL_ID, forbid goal tools, freeze-after-Confirm, Track-N cites, Ralph sealed track (Blocked by: none) (Track: 2,3,4,5,7)
- [x] Ticket 3: Occupancy and ShipGoals port — Delivers pause-then-ask ship · occupancy, ours-vs-stranger, create-then-pause, goals-port degrade, composition wire; no extra chrome (Blocked by: Ticket 1, Ticket 2) (Track: 1,5,6,9)
- [x] Ticket 4: Snapshot lifecycle — Delivers Confirm snapshot prepend, handshake/seal/complete/abort lifecycle, re-assert on later injects, Ralph objective includes sealed track (Blocked by: Ticket 1, Ticket 2, Ticket 3) (Track: 1,3,4,7)
- [ ] Ticket 5: Release & Documentation Compliance — Delivers Changeset and bilingual documentation updates (README.md and README.zh.md) if user-facing code or bundle/cli is touched (Blocked by: Ticket 1, Ticket 2, Ticket 3, Ticket 4) (Track: 9)

## Baseline

- Branch: `ship/ship-goal-main-track` at `48b4b4b` plus this spec (untracked) and `.scratch/ship-goal-main-track/` (untracked). Unrelated untracked: `.dsh/`, `.pnpm-store/`. No other tracked diffs.
- Proof command 1 (`pnpm exec vitest run packages/bundle/tests/ship.spec.ts packages/bundle/tests/ship-run.spec.ts packages/bundle/tests/plan.spec.ts`): exit 0 — 3 files, 57 tests passed.
- Proof command 2 (`pnpm run typecheck`): **already red** — `packages/bundle/tests/startup.spec.ts(13,21): error TS2307: Cannot find module '@deepseek-ai/cordis-plugin-include'`. Pre-existing; zero-new-failures applies.
- Proof command 3 (`pnpm test`): **already red** — 49 files passed (1335 tests), 1 failed suite `packages/bundle/tests/startup.spec.ts` (`Cannot find package '@deepseek-ai/cordis-plugin-include'`). Same pre-existing hole; green for this ship means no new failures beyond that suite.
