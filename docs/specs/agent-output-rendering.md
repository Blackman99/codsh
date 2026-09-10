# Agent Output Rendering

Status: planned
Branch: ship/agent-output-rendering
Base-Commit: 1c71c7a92f769f8b5d981bb5df0c4057d223bdba
Original-Branch: main
Goal-Id: goal-f54f6bf7-99f2-490c-ae68-7fd54b653fb1
Issue: https://github.com/Blackman99/codsh/issues/76

## Requirement

当前针对 agent 输出的实现整体逻辑有问题，参考 grok build cli
agent 持续思考的输出应当是主要展示区，工具调用不应当占太多输出内容，工具调用的命令也不该高亮
重新设计 agent 输出的渲染实现

## Problem Statement

As someone watching an agent turn, the transcript shows me the least
informative part of the work in the most prominent way.

While the agent is thinking — the part I actually want to follow, because it is
where the agent decides what to do — I see a single row of it (compact default),
and once the thought ends even that row is replaced by a count of seconds. But
each tool call the agent makes takes up to four rows of its own, sits inside a
shaded panel, and paints the tool's name in amber. A run of five quick file
reads costs twenty rows and five coloured headlines; the deliberation that chose
those five files cost one row.

The result is that the transcript I scroll back through is mostly tool
mechanics, and the reasoning that explains the work is gone. I cannot tell at a
glance what the agent was trying to do, and I cannot find the one call that
failed without reading every call. Commands the agent runs are the loudest thing
on the screen even though they are the thing I least need to re-read.

## Solution

As someone watching a turn, the reasoning becomes the main thing I see and the
tool calls become quiet.

While the agent thinks, the thought streams into several rows so I can follow
it. Once it finishes, it settles to a compact one-line summary that I can open
if I want the detail back — I was already shown the reasoning as it happened,
which is what makes the summary honest rather than lossy.

Tool calls stop being cards. Each one is a single muted row with no shading and
no coloured name, and a run of consecutive calls is summarised as one header
that tells me what kinds of work happened and how many of each — "Read 3 files,
Searched 2 patterns". The header is alive while the work is: it reads in the
present tense while calls are in flight and tells me if anything failed. If I
want the detail, I open the group and see the calls, including the real diffs
for edits.

Two things deliberately do not become quiet. A destructive command — the kind
that deletes or rewrites something I cannot get back — stays visible on its own
line in a warning style, even though everything around it is muted, because a
warning folded inside a collapsed summary is a warning I never see. And a call
that is waiting for my approval never gets folded away, because that is a
question addressed to me.

## Grill Decisions

1. **Direction — full reshape to the grok-build output model.**
   Reason: the owner's words were "整体逻辑有问题" and "重新设计渲染实现". A
   targeted de-emphasis inside the existing card model would leave the
   pad/panel structure that causes the row growth. Cost accepted: the ~20
   assertions in `packages/bundle/tests/transcript.spec.ts` that pin the amber
   tool name and the `bgTool` panel are rewritten.

2. **A settled thought — keep the one-line header, body in the Fold.**
   Reason: grok-build's `Collapsed` mode. The reasoning is *shown* while it
   streams; keeping every finished thought inline would grow the transcript
   without adding information the reader did not just see. This is the reading
   of the requirement under which "主要展示区" governs the live display.

3. **Live thought preview — 3 rows compact, 6 rows comfortable.**
   Reason: the current compact preview is one row
   (`thinkingStreamPreview`), which is the concrete reason thinking does not
   read as the main area. Raising only compact to 3 would make both densities
   identical and silently delete the preview axis that `README.md:100` and
   `README.zh.md:99` already promise, so both move.

4. **Tool call compression — one row each, consecutive calls merged.**
   Reason: grok-build's verb-group fold. Removes `blockPad`/`blockClose`, the
   `bgTool` panel, and the separate `$ command` row's cost; a run of reads costs
   one row rather than four per read.

5. **Command emphasis — tool name and command both muted, panel removed.**
   Reason: the owner's "命令不该高亮" applies to the tool name as well, since
   the name is the command's label. grok-build reaches the same place via
   `muted_collapsed: true`. The `bgTool` panel goes because a filled panel is
   emphasis by another means.

6. **Everything merges, including shell commands and edits.**
   Reason: owner-confirmed, overriding grok-build's label-only split for
   `Command`/`EditFile`. The owner's compensating requirement is that an edit's
   expanded payload is the diff, so nothing is lost by folding its row.

7. **Merged header content — every category, with its count.**
   Reason: owner's "工具都合并". The header names each category rather than
   collapsing to a bare total, which is what keeps the summary readable.

8. **Single-call groups — fold too, same as any run.**
   Reason: grok-build's `folds()` threshold is `members >= 1`. One rule with no
   "only one item" special case means one shape to implement and test.

9. **Glyphs — keep `✻` as the thinking mark.**
   Reason: `✻` is already codsh's thinking role
   (`packages/bundle/src/gutter.ts`, `blockRules().agent`) and the same glyph
   appears in the banner, with tests pinning it under NO_COLOR. Replacing it
   with grok-build's `◆` would move the banner and the whole theme vocabulary,
   which is not what this rendering change is about.

10. **Deferred — the tool bullet glyph itself.**
    Reason: codsh currently draws `│ ` as the tool block rule. The concrete
    single-row marker is a detail to fix during implementation against the new
    model, not a decision that changes the structure.

11. **Destructive commands — keep an alert style.**
    Reason: today's amber tool name is the only signal that a dangerous command
    ran. Muting everything removes it. The matching cost (a table that can
    miss) is accepted deliberately.

12. **Destructive commands — break out of the group onto their own row.**
    Reason: decision 11 and the merge rule genuinely conflict. If a destructive
    command is folded into a collapsed `Ran 6 commands` header, its alert colour
    is invisible and decision 11 is void. Breaking the group is what makes the
    safety decision real.

13. **Destructive matcher — categories plus a named-pattern allowlist.**
    Reason: bound the miss/false-positive risk. Delete (`rm -rf`, `rm -r`),
    history rewrite and force push (`push --force`, `reset --hard`, `clean -fd`,
    `branch -D`), disk and permission (`mkfs`, `dd of=`, `chmod -R 777`,
    `shutdown`), database and remote destruction (`DROP TABLE`, `TRUNCATE`,
    `kill -9`). Matched against the command head, not by loose substring
    containment.

14. **Approval-gated commands — never folded.**
    Reason: these are the ones with `is_pending_user_input` chrome. grok-build's
    `run_step` classifies exactly these as non-members; hiding a call that is
    waiting on the person would be the worst case of the merge.

15. **Merged header health — running and failed states.**
    Reason: once rows are folded, the header is the only place a failure can be
    seen without expanding. Mirrors grok-build's `BucketAccumulator`
    (`running` → present tense, `failed_count` → alert suffix).

16. **Merged header tense — present while any member runs, past when settled.**
    Reason: grok-build's `VerbGroupKind::verb(running)`. A settled run must not
    read as if it were still working.

17. **Expansion — reuse the existing soft cap and pager.**
    Reason: the mechanism already exists and is tested (`DIFF_SOFT_CAP`: 24
    compact / 48 comfortable, `click reads it · Ctrl+O expands`). Only the
    carrier changes, from one tool card to one tool group.

18. **Mouse — keep the hover-and-click path, redesign what it reveals.**
    Reason: expand and enter-a-child-session are the only mouse paths into a
    Fold, and both are documented capabilities. The redesign is of the revealed
    content (a group expands to its calls and diffs), not of the gesture.

19. **Scope — the output layer only.**
    Reason: the requirement is about agent output rendering. Scrolling, wheel,
    text selection, paste, rewind navigation and the input box are untouched.

20. **Delete the similar-run layer.**
    Reason: `absorbSimilar` / `similarRun` / `… +N similar` is a second
    compression mechanism doing what the merged header now does. Two overlapping
    compressors cannot be explained, and `skeleton()` matching becomes dead
    weight. This is a simplification, not a lost capability.

21. **Durable records — PTY e2e, unit rewrites, bilingual README, changeset,
    and a new ADR.**
    Reason: `alignment.md` states a surface row is not aligned until the
    behaviour has been driven on a real TTY. The README's `/ui` and tool-card
    descriptions change with the render. The ADR is required because this
    design diverges from *every* agent ADR-0001 names.

22. **ADR content — register grok-build as a reference source and record this
    divergence.**
    Reason: ADR-0001 fixes Claude Code > opencode > Codex CLI with gemini-cli as
    corroboration, and diverging from all references must be an explicit,
    owner-confirmed rejection. Registering grok-build in the last arbitration
    slot keeps that record honest; ADR-0001's priority chain is not rewritten.

## Main Track

**Track-1.** Hierarchy: reasoning is the main display area. Live thought
preview is 3 rows compact / 6 comfortable; a settled thought keeps its one-line
`✻ thought for Xs` header and expands via Fold (Ctrl+O / click).

**Track-2.** Every tool call renders as a single muted row: no `bgTool` panel,
no amber tool name, no highlighted command, no `blockPad`/`blockClose`.

**Track-3.** Consecutive tool calls aggregate into one header naming each
category with its count and its running/failed state. A lone call folds the
same way. Edit payloads are the diff a group expands into.

**Track-4.** Destructive commands break out of the group onto their own
alert-styled row; approval-gated calls never fold. Matcher is the category
whitelist of decision 13.

**Track-5.** `compact` / `comfortable` keep two distinct live thinking preview
sizes (3 / 6) and both README languages are updated to match.

**Track-6.** The similar-run compression layer (`absorbSimilar`, `similarRun`,
`… +N similar`) is deleted; group expansion reuses the existing soft cap and
pager.

**Track-7.** Glyph vocabulary stays codsh's: `✻` remains the thinking mark; the
tool bullet for the single-row model is fixed during implementation.

**Track-8.** Interaction scope is the output layer only: hover/click still
expands a group and enters a child session; scrolling, wheel, selection, paste,
rewind navigation and the input box are untouched.

**Track-9.** Durable records: a PTY e2e asserting the new frame, rewritten unit
specs, both READMEs, a `codsh-bundle` changeset, and a new ADR registering
grok-build and recording the divergence.

**Out of Scope.**

- Any change to the dsh harness upstream (`@deepseek-ai/dsh-*`); codsh adds no
  fork.
- Scrolling, mouse wheel, text selection, clipboard, paste, rewind navigation
  and the input box.
- GateModal, MetaBar, the queue panel and other chrome surfaces.
- Persisting or migrating rendering preferences; this is a behaviour change, not
  a schema change.
- grok-build's eager-folding split, which excludes `Command` and `EditFile` from
  folding — decision 6 deliberately overrides it.
- grok-build's `◆` bullet vocabulary — decision 9 keeps `✻`.
- Rebuilding the reasoning navigation into a dedicated review surface (the
  owner chose to keep Ctrl+O / click for recall).
- Removing the `✻` glyph, the `/ui` axis, or the `bgTool` theme role beyond what
  decision 5 requires.

## User Stories

1. As a person watching a turn, I want the agent's reasoning to stream into several rows at once, so that I can follow what it is thinking while it works.
2. As a person watching a turn, I want the reasoning to stay on screen as it grows rather than being replaced each line, so that I do not lose the thread of an argument mid-sentence.
3. As a person reading a finished turn, I want a settled thought reduced to one summary line, so that a long session does not become a wall of reasoning.
4. As a person reading a finished turn, I want to open that summary line and read the full reasoning again, so that I can recover a detail I skimmed past.
5. As a person scanning a long session, I want each tool call to occupy a single quiet row, so that the conversation and the reasoning remain the dominant text.
6. As a person scanning a long session, I want consecutive tool calls summarised as one line that names what kinds of work happened and how many of each, so that I can skip routine activity without reading each call.
7. As a person scanning a long session, I want a single isolated tool call summarised the same way as a run of them, so that the transcript looks consistent and I do not have to learn two shapes.
8. As a person wanting detail, I want to open a summary of tool calls and see the individual calls it stands for, so that summarising them costs me no information.
9. As a person reviewing an edit, I want opening an edit's summary to show the actual diff, so that I can see what changed on disk.
10. As a person reviewing a long diff, I want a very large expansion handed to the full-screen reader instead of flooding the transcript, so that my reading position survives.
11. As a person watching a long run of calls, I want the summary to read as still working while calls are in flight, so that I can tell the difference between a run in progress and one that finished.
12. As a person whose turn had a failure, I want the summary to tell me something failed, so that I can find the failure without opening every summary on screen.
13. As a person whose tool call failed, I want to open the summary and see which call failed and what happened, so that I can act on it.
14. As a person about to lose data, I want a destructive command to stay on its own visible row in a warning style, so that I can interrupt before it runs.
15. As a person about to lose data, I want that warning not to be hidden inside a collapsed summary, so that muting the rest of the transcript never hides the one command that matters.
16. As a person being asked to approve a command, I want that request never folded away, so that a question addressed to me cannot be hidden behind a summary.
17. As a person who runs my terminal without colour, I want the new hierarchy to still be readable, so that I am not dependent on colour to tell reasoning from tool calls or to notice a failure.
18. As a person using a narrow terminal, I want the summary line to stay on one row and truncate rather than wrap, so that my transcript layout does not fall apart.
19. As a person who prefers a roomier transcript, I want the reasoning preview to be larger still, so that my density setting keeps meaning something.
20. As a person reading a transcript where the agent delegated, I want the subagent's row to remain openable, so that I can still watch what the child did.
21. As a person whose turn was interrupted mid-run, I want the calls that did happen still summarised and readable, so that an interrupted turn is not a blank gap.
22. As a person scrolling back through history, I want previously summarised runs to open the same way after resume, so that replayed history behaves like live history.
23. As a person watching, I want commands the agent runs to stop being the loudest thing on screen, so that I am drawn to the work rather than the mechanics.
24. As a person reviewing a mixed run of reads, searches, edits and commands, I want the summary to distinguish the kinds of work, so that I can tell whether the agent was investigating or changing things.

## Implementation Decisions

**Rendering model.** The transcript gains the notion of a *tool group*: an
ordered, contiguous run of tool calls collapsed into one summary row, with the
individual calls and their payloads in the Fold. A group is the unit of both
layout and interaction — one row on screen, one Fold, one hover/click target.
The existing Fold mechanism (`appendFold`, `updateFold` in the screen, and the
`summary` / `full` / `rule` / `label` / `enter` outputs the transcript already
produces) is reused unchanged; only the content it carries is new.

**Verb classification.** Tool calls are classified into a closed vocabulary of
categories by the tool's view/presenter, not by string-matching the tool name at
render time. Each category supplies a past-tense verb, a present-tense verb, and
a singular/plural noun. Categories with no members never appear in a label, and
labels list categories in first-appearance order. Membership is decided from the
same presenter seam that already distinguishes terminal, diff and other cards.

**Group formation rule.** A run is extended by calls that are groupable; it is
broken by assistant prose, by a real-user message, and by any call that is
excluded from grouping. Excluded from grouping: destructive commands (below) and
approval-gated calls. Subagent cards stay in the group for counting purposes
while remaining individually openable, so the child-session door is not lost.

**Merged header label.** The label is an aggregation over the run, not a
formatting of the last call: per-category counts, present tense if any member is
still pending and past tense once all settle, and a trailing failure segment
when any member failed. Volatile tokens (paths, ids, counts) must not force a
label change on each frame; the label is recomputed from the run, not appended
to. The label is the folded row's copyable text.

**Command classification for destructive detection.** A pure classifier maps a
tool call to "destructive" using the command head, per the category allowlist in
decision 13. It reads the command from the call's own arguments through the
existing presenter seam, and it is deliberately conservative: matching is
anchored to the command head and normalized tokens rather than substring
containment, so that a command merely mentioning a dangerous string is not
flagged. False negatives are treated as a real risk and the classifier is
expected to be extended by category, not by one-off patterns.

**Approval-gated detection.** A call that is waiting on the person is already
represented by the pending-call state the transcript tracks. That state must
suppress grouping rather than be re-derived from the tool name.

**Emphasis and theme.** Tool rows, their names and their commands use the muted
role. All tool-specific emphasis is removed from the group row: no background
panel, no amber name. Destructive rows use the error/warning role. The
`bgTool` background role becomes unused by the transcript; if no other caller
remains it is removed rather than left dead. Failure styling continues to use
the existing error role.

**Thinking preview shape.** The live preview's row budget becomes
density-dependent (3 compact, 6 comfortable) and is expressed as a row count
derived from density rather than a branch inside the preview function, so a
future density value does not require touching the preview logic. The preview
keeps the most recent rows and stays within its budget.

**Similar-run removal.** The similar-run machinery — its key function, its run
state, and the `… +N similar` row — is deleted outright, along with any tests
that exist only to pin it. No compatibility path is kept.

**Deletion of the old card shape.** The pad/close helpers, the terminal card's
dedicated `$ command` row, and the card-title budget helper exist to serve the
old shape. They are removed where they become unreachable, rather than left
unused.

## Testing Decisions

**Primary seam — the real PTY e2e suite (`e2e/pty-folds.e2e.ts`).** This is the
highest existing seam and the one the repository's own alignment rules require:
it drives the packed profile through the mock scenarios and asserts the painted
frame, so it verifies the hierarchy the requirement is actually about. All
frame-level behaviour is pinned here: multi-row thinking preview, the settled
one-line summary, single-row tool rows, the merged header including counts,
tense and failure segment, destructive-command break-out, the expanded group
showing calls and diffs, and that the summary truncates rather than wraps on a
narrow terminal. Existing tests in this file that assert `●`-prefixed cards and
`│ `-prefixed output rows are rewritten to the new shape, not deleted.

**Secondary seam — the module-level render specs
(`packages/bundle/tests/transcript.spec.ts` and `density.spec.ts`).** These
already test the transcript as a pure function of events and are the right place
for the combinatorial cases that a PTY boot per case would make slow: every
category's verb and noun, pluralization at one and many, first-appearance
ordering, mixed categories in one run, an empty group, a lone call, running
versus settled tense, failure counts, and the density row budgets. The
destructive classifier is covered here across all four categories, including
commands that look dangerous but are not (so a false positive is caught) and
commands that are dangerous with unusual flags.

**Prior art to follow.** `e2e/pty-folds.e2e.ts` already pins the current
one-line thinking collapse and the tool-card shape, including a long-diff pager
test and a Ctrl+O toggle test; those become the rewritten counterparts of the
new behaviour. `packages/bundle/tests/transcript.spec.ts` already asserts
`formatToolCardLine` output directly, which is the pattern for the new label
builder. `packages/bundle/tests/screen.spec.ts` pins fold append/update with an
explicit `summary`/`full` pair and is the pattern for a group Fold.

**Out-of-scope for testing.** The no-colour path is covered by the existing
NO_COLOR tests at the theme seam rather than by new PTY cases; the requirement's
monochrome story is satisfied by those plus the layout assertions above.

## Out of Scope

- Any change to the dsh harness upstream (`@deepseek-ai/dsh-*`); codsh adds no
  fork and no patch to the runtime.
- Scrolling, mouse wheel, text selection, clipboard, paste, rewind navigation,
  and the input box.
- GateModal, MetaBar, the queue panel, the ship plan panel, the todo readout,
  and other chrome surfaces.
- Persisting or migrating rendering preferences; this is a behaviour change, not
  a schema change.
- grok-build's eager-folding split, which excludes `Command` and `EditFile`
  from folding — decision 6 deliberately overrides it.
- grok-build's `◆` bullet vocabulary — decision 9 keeps `✻`.
- Rebuilding reasoning recall into a dedicated review surface; Ctrl+O and click
  remain the recall path.
- Removing the `✻` glyph, the `compact`/`comfortable` axis, or the `/ui`
  command.
- A user-facing setting to choose the old card rendering; the redesign replaces
  it rather than sitting beside it.
- Reworking the pre-existing `pnpm` `minimumReleaseAge` lockfile policy. The
  acceptance commands below therefore invoke the tools directly and do not
  depend on `pnpm run <script>`.
- Publishing a release; landing stops at a verified branch.

## Acceptance Criteria

Each criterion names the command that proves it and the output that counts as
passing. The commands bypass `pnpm run` because this workspace's active
`minimumReleaseAge` policy rejects the lockfile and turns `pnpm run <script>`
into a policy error rather than a run; invoking the installed tools directly is
the same verification without the gate. The final phase runs these verbatim.

1. **The new render holds on a real terminal — PTY fold suite.**
   Command: `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/pty-folds.e2e.ts`
   Passing: the file exits 0 with every test green, **and the summary line
   reports zero skipped** — a pure `-t` filter exits 0 even when every test is
   skipped, so skipped tests are a failure here, not a pass. The green set must
   include the rewritten tests for the multi-row thinking preview, the settled
   one-line summary, single-row tool rows, the merged header with counts and
   tense, destructive break-out, group expansion showing diffs, and single-row
   truncation on a narrow terminal.

2. **The whole PTY surface still holds — no neighbouring regression.**
   Command: `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts`
   Passing: exits 0 with all e2e files green, so the input, mouse, navigation,
   reading, viewport, chrome and image suites are all unaffected.

3. **The module-level render contract holds — unit suite.**
   Command: `node node_modules/vitest/vitest.mjs run packages/bundle/tests/transcript.spec.ts packages/bundle/tests/density.spec.ts packages/bundle/tests/streaming.spec.ts packages/bundle/tests/screen.spec.ts`
   Passing: exits 0 with **zero skipped tests**, covering the category
   vocabulary, pluralization, first-appearance ordering, lone-call folding,
   running versus settled tense, the failure segment, and the 3/6 density
   budgets.

4. **Nothing else in the repo regressed — full unit suite.**
   Command: `node node_modules/vitest/vitest.mjs run`
   Passing: exits 0 with every test file green; the suite currently reports 52
   files / 1388 tests, and the new count must be green rather than reduced by
   deletions.

5. **Types are clean.**
   Command: `./node_modules/.bin/tsc --noEmit`
   Passing: exit code 0 with no diagnostics emitted.

6. **The muted tool row is genuinely unhighlighted.**
   Command: `node node_modules/vitest/vitest.mjs run packages/bundle/tests/transcript.spec.ts packages/bundle/tests/theme.spec.ts`
   Passing: exits 0 with assertions proving a settled tool row contains no
   `bgTool` background sequence and no `theme.tool` (amber) escape, and that a
   destructive row does carry the warning role.

7. **The destructive classifier is precise.**
   Command: `node node_modules/vitest/vitest.mjs run packages/bundle/tests/transcript.spec.ts -t destructive`
   Passing: exits 0, **the summary line reports the matching tests as passed
   rather than skipped**, and at least one negative case (a benign command
   containing a dangerous-looking token) and one positive case for each of the
   four categories in decision 13 are present and green.

8. **The user-facing descriptions match the new render — both languages.**
   Command: `grep -n "preview while thinking streams" README.md README.zh.md`
   Passing: exit code 1, i.e. the stale two-line-preview sentence is gone from
   both files, and `grep -n "3" README.md` shows the new row budget documented.

9. **The release note exists.**
   Command: `grep -ln "codsh-bundle" .changeset/*.md | xargs grep -ln "tool call\|reasoning\|rendering\|transcript"`
   Passing: prints at least one path — a changeset naming `codsh-bundle` whose
   text describes this rendering change. Pre-existing changesets are not
   affected by the rewrite and do not satisfy this criterion on their own.

10. **The reference decision is recorded.**
    Command: `ls docs/adr/ && grep -rn "grok-build" docs/adr/`
    Passing: a new ADR file exists and mentions `grok-build` together with the
    arbitration relationship to ADR-0001.

11. **The spec always reflects its phase.**
    Command: `grep -n "^Status:" docs/specs/agent-output-rendering.md`
    Passing: the line reads `Status: shipped` once landing completes, and at
    every earlier phase it reads the phase actually in progress.

## Plan

- [ ] Ticket 1: Tool Verb Vocabulary and Group Label Builder — Delivers a new pure module mapping a call's declared presentation view to a closed category vocabulary, plus the merged group-header label builder (per-category counts, first-appearance order, present/past tense, failure segment). Changes no rendered output. (Blocked by: none) (Track: 3)
- [ ] Ticket 2: Tool Group Rows Replace Tool Cards — Delivers the end-to-end hierarchy change: one muted row per tool call with no panel, no amber name and no command highlight; consecutive calls aggregated into one group row carrying the Ticket 1 label; the group as a Fold expanding to its calls and their real diffs; reused soft cap and pager; subagent rows still openable; a chosen single-row tool bullet. Rewrites the pre-existing card-shape assertions rather than deleting them. (Blocked by: Ticket 1) (Track: 2,3,7,8)
- [ ] Ticket 3: Destructive Commands Break Out of the Group — Delivers a pure, conservative classifier over the decision-13 category allowlist anchored to the command head, the destructive row rendered on its own alert-styled row instead of joining a group, and the rule that approval-gated calls never fold. (Blocked by: Ticket 2) (Track: 4)
- [ ] Ticket 4: Live Thinking Preview Owns the Display Area — Delivers the density-derived live preview budget (3 compact / 6 comfortable), the unchanged one-line `✻ thought for Xs` settled summary, and the corrected `/ui` description in both README languages. (Blocked by: Ticket 2) (Track: 1,5)
- [ ] Ticket 5: Contract — Retire the Card Path and the Similar-Run Layer — Delivers deletion of the similar-run machinery, its skeleton helper and its `… +N similar` row, plus the now-unreachable card pad/close helpers, the terminal card's `$ command` row, and the `bgTool` role when the transcript is its last caller. (Blocked by: Ticket 3, Ticket 4) (Track: 6)
- [ ] Ticket 6: Destructive Detection Edge Cases and Cross-Path Parity — Delivers adversarial coverage of the classifier (chained, reordered, quoted and wrapper commands; accepted misses recorded) and the guarantee that the live and replay paths produce identical group rows, including interrupted and resumed runs. Optional hardening: if already satisfied, check the boxes and change no code. (Blocked by: Ticket 5) (Track: 4,8)
- [ ] Ticket 7: Release and Documentation Compliance — Delivers the `codsh-bundle` changeset, the bilingual README updates kept in parity, the new ADR registering `grok-build` and recording both deliberate divergences, and the `CONTEXT.md` domain terms. (Blocked by: Ticket 5, Ticket 6) (Track: 9)

## Baseline

Recorded at gate 2, before any implementation code, on a clean working tree at
`1c71c7a` on `ship/agent-output-rendering`.

**Unit gates — green.**

- `./node_modules/.bin/tsc --noEmit` → exit 0, no diagnostics.
- `node node_modules/vitest/vitest.mjs run` → exit 0, **52 files / 1388 tests**
  passing, 0 skipped.

**E2E gate — green, but only with PTY access this sandbox does not grant by
default.**

- `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts` →
  exit 0, **12 files passed / 1 skipped, 134 tests passed / 1 skipped**,
  including all 14 tests in `e2e/pty-folds.e2e.ts`, which is the primary seam.
- The same command under the default `workspace-write` file policy is **red**:
  every PTY test fails with `OSError: out of pty devices`, because opening
  `/dev/ptmx` is denied (`Operation not permitted`) inside that sandbox. This is
  an environment denial, not a code failure — confirmed by allocating a PTY
  successfully under `danger-full-access` and by the full suite then passing.
  Landing must therefore run the e2e commands with PTY access and must not
  accept a `workspace-write` run as evidence either way.

**Why the acceptance commands invoke the tools directly.** This workspace's
active `minimumReleaseAge` policy rejects `pnpm-lock.yaml`, so `pnpm run
typecheck` and `pnpm test` print a policy error. Reconciling that policy is out
of scope. The accepted workaround is to invoke the installed tools directly
(`./node_modules/.bin/tsc`, `node node_modules/vitest/vitest.mjs`), which is the
same verification without the gate. Ticket 1 additionally confirms the gates
executed as real commands rather than returning a policy error, because a gate
that silently does not run is worse than a failing one.

**Reference source read for the target shape.** `xai-org/grok-build`
(`crates/codegen/xai-grok-pager/src/scrollback/blocks/thinking.rs`,
`.../scrollback/state/verb_group.rs`, `.../scrollback/blocks/tool/mod.rs`, and
`crates/codegen/xai-grok-pager-render/src/appearance/config.rs`).
