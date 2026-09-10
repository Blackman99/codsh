# Chrome Redesign

Status: shipped
Branch: ship/chrome-redesign
Base-Commit: a62d959a9d6b63ff6820350dc6d474d56136be1c
Original-Branch: main
Goal-Id: goal-f57b063f-27b9-4550-a497-f2df3d357ecb
Issue: https://github.com/Blackman99/codsh/issues/89

## Requirement

图 2 是当前输出按照新实现后显得非常零碎
图 3 是 grok 输出排版非常舒适
同时，整体的状态栏，输入框，显示信息布局，颜色搭配也没有 grok 的好，参考它进行推翻重头设计实现

## Problem Statement

As someone reading a working session, the surface does not hold together as a
document.

Every thought is immediately followed by one or two tool lines, and those two
kinds of line are drawn with four different indentations and markers — the
thought header sits flush at the marker, its body indents under it, the tool
group sits behind a `│` rule, and the footer hint indents again. Blocks run
straight into each other with no gap, so there is no visual answer to "where
does this step end". The result reads as a list of fragments rather than a
sequence of steps (image 2).

The chrome around that transcript has the opposite problem: it spends rows on
decoration and piles environment detail into the one place I look most. The
input is wrapped in a full rounded, saturated border with a long placeholder
inside it, and directly under it a second row repeats `model · cwd (branch) ·
? shortcuts`. So three or four rows of the screen — the rows nearest my hands —
carry almost no information, while the branch and the context pressure I
actually glance at are buried at the end of a row that truncates from the right
as soon as the path is long.

Colour is used as decoration rather than as meaning: the box border, the tool
name, the thinking mark and the user mark are all saturated and all competing,
so nothing tells me at a glance who is speaking.

## Solution

As someone reading a working session, the reasoning and its tools become one
step I can see the edges of, and the chrome recedes to the edges of the screen.

A thought and the tool calls it led to are drawn as a single block: one header,
the reasoning body, then the tool lines belonging to that step, all on one
indent, with a blank row between steps. I can see where one step ends and the
next begins without counting markers.

Environment facts move out of the way of my hands and into one bar across the
top — the branch and directory on the left, context pressure on the right, plus
the plan and `/ship` markers when they apply. My input loses its box: a divider
above it, a `›`, and a single line of help underneath. The model and reasoning
level go where I can find them on demand rather than sitting under the cursor.

Colour goes back to meaning: one restrained palette, applied by who is speaking
— me, the agent's reasoning, the agent's tools, and errors — instead of by
which element wants attention.

## Grill Decisions

1. **A step is one block — reasoning and its tools share an indent and a gap
   follows.**
   Reason: the fragmentation has a concrete cause, verified in the transcript
   composer: a thinking fold at `blockRules().agent` (`✻`), its body indented
   further, and a tool group behind `blockRules().tool` (`│`) with its own
   larger indent, alternating with no blank row between them. Re-grouping the
   existing rows is preferred over re-laying out the transcript because the
   grouping semantics were just delivered and verified in
   `docs/specs/agent-output-rendering.md`.

2. **Image 3 is the baseline, not a spec sheet.**
   Reason: the owner reads it as "comfortable" and wants the same qualities —
   no box around the input, no per-line timestamps, spaced blocks, restrained
   colour. Its exact pixel values are not the contract; the acceptance is a
   screenshot of the finished surface.

3. **Scope is the screen frame: input region, status bar, information layout,
   colour, line spacing, block outer margin.**
   Reason: the owner named exactly those ("状态栏，输入框，显示信息布局，颜色搭配").
   The transcript's *semantics* — what counts as a group, what folds — stay as
   `docs/specs/agent-output-rendering.md` settled them, so this change cannot
   silently invalidate that spec or its e2e suite.

4. **Control interactions may be redesigned; global key bindings may not be
   remapped.**
   Reason: expanding a fold, entering a child session and summoning a panel are
   part of how the new layout feels and must be free to move. The key
   bindings are muscle memory and an alignment surface recorded in
   `docs/alignment.md`, so moving a control must not cost the person the key
   that reaches it.

5. **One restrained palette; colour carries meaning only.**
   Reason: today the box border is accented cyan (`inputbox.ts`), the tool name
   amber (`theme.tool`), the user mark magenta (`theme.user`), and the thinking
   mark magenta (`theme.agent`) — four saturated roles none of which outranks
   the others. Roles stay semantic (person, reasoning, tool, error) but get
   re-weighted and de-saturated, and decoration stops being coloured at all.

6. **Colour may diverge from image 3.**
   Reason: what makes the reference comfortable is low contrast and restraint,
   not its specific hues. Pinning codsh to image 3's pixel values would fight
   the existing theme system and its tests for no readability gain.

7. **`/ui compact|comfortable` survives, and grows from one number into the
   whole spacing scale.**
   Reason: it is a delivered, documented setting with tests and both READMEs
   behind it. Deleting it would be a silent capability loss; expanding it is
   what lets one axis control block gaps, preview rows and the expansion
   threshold coherently.

8. **Environment facts move to a top bar.**
   Reason: the owner chose this over keeping them at the foot. It also fixes a
   real defect: `statusLine` drops `shortcuts`, then `cwd`, then `model` as the
   line runs out of room, so on a long path the branch — the thing worth
   glancing at — is what disappears.

9. **The top bar carries branch, directory, context pressure, and the plan and
   `/ship` chips.**
   Reason: branch plus directory is what image 2 shows on the left and context
   occupancy on the right; plan mode and the ship gate chip already have to be
   permanently visible, so they belong on the one always-present row rather
   than in a second one.

10. **The top bar is row 0; the sticky panel sits below it.**
    Reason: `screen.ts` composes the viewport as `panel + visible + padding`,
    and the pinned sticky panel — a long user prompt held at the top — already
    claims that space. The two carry different things (environment vs. what the
    person just said) so they stack rather than replace each other; the panel's
    own padding yields when the screen is short.

11. **The input loses its border: a divider, `›`, and a help row.**
    Reason: the rounded box costs three or more rows and is the single largest
    piece of pure decoration on the screen. A divider plus the existing `›`
    mark keeps the input's edge legible and hands the freed rows back to the
    transcript.

12. **`? shortcuts` is the one discovery path that must not be lost.** It is
    the only entry point to the shortcuts overlay and cannot sit under the
    cursor any more, so it moves into the help row at the foot; if it does not
    fit there the top bar carries it. Reason: the overlay is how a person
    learns the keys decision 4 promises to keep working.

## Main Track

**Track-1.** A step is one block: the reasoning header, its body, and the tool
lines of that step share one indent, and a gap separates consecutive steps.

**Track-2.** Colour is meaning, not decoration: one restrained palette,
re-weighted by role (person, reasoning, tool, error), with no coloured box
border and no competing saturated marks.

**Track-3.** Environment facts live in a top bar at row 0: branch and directory
on the left, context pressure on the right, plus the plan-mode and `/ship` gate
chips. The foot no longer carries cwd, branch or model.

**Track-4.** The top bar and the pinned sticky panel coexist: the bar keeps row
0, the panel renders below it, and the panel's padding yields first on a short
screen.

**Track-5.** The input region is borderless: a divider, a `›` mark, the input,
and one help row — including the `? shortcuts` entry.

**Track-6.** `/ui compact|comfortable` remains and governs the whole spacing
scale: block gaps, live thinking preview rows, and the expansion threshold.

**Track-7.** Control interactions may move (expand, enter a child session,
summon a panel), but every existing global key binding stays reachable and
unremapped.

**Track-8.** Scope is the screen frame. The transcript's grouping semantics and
fold mechanics — settled by `docs/specs/agent-output-rendering.md` — are not
reopened.

**Track-9.** Acceptance is visual: a screenshot of the finished surface against
image 3, plus the existing automated gates staying green.

**Out of Scope.**

- The transcript's grouping semantics and fold mechanics: what counts as a
  tool group, what folds, and what a group expands into stay exactly as
  `docs/specs/agent-output-rendering.md` shipped them.
- Remapping or removing any global key binding, including Ctrl+O, Ctrl+Q,
  Ctrl+T, Ctrl+F, Esc, Tab/Shift+Tab, wheel scrolling, and drag selection.
- Matching image 3's exact colours, glyphs or pixel metrics.
- Removing the `/ui` axis, the `✻` thinking mark, or the `›` user mark.
- Any change to the dsh harness upstream (`@deepseek-ai/dsh-*`); codsh adds no
  fork.
- The Markdown renderer's own typography (tables, code fences, diffs) beyond the
  palette its roles resolve to.
- Making the surface a general-purpose themable TUI: one palette, not a theme
  file format.
- Preserving image 2's per-line timestamp column; the reference does not have
  one and it is not part of this surface.

## User Stories

1. As a person reading a working session, I want a thought and the tool calls it led to drawn as one block, so that I read a sequence of steps instead of a list of fragments.
2. As a person reading a working session, I want a blank row between consecutive steps, so that I can see where one step ends without counting markers.
3. As a person reading a working session, I want the reasoning and its tool lines to share one indent, so that the eye does not have to re-anchor on every change of row kind.
4. As a person reading a working session, I want the tool lines of a step to stay quieter than its reasoning, so that the agent's thinking remains the thing I read.
5. As a person glancing at the screen, I want the branch and directory on a bar across the top, so that I can see where I am without looking under my hands.
6. As a person watching context fill up, I want the context pressure on the same top bar, so that I notice before the session runs out rather than after.
7. As a person in plan mode, I want that state on the top bar, so that a mode that changes what the agent may do is visible the whole time it holds.
8. As a person running a `/ship` workflow, I want its gate chip on the top bar, so that a workflow which owns the turn is still visible while I read.
9. As a person on a narrow terminal, I want the branch to survive even when the directory path is long, so that the fact I glance at most is not the first thing dropped.
10. As a person typing a long message, I want my pinned message to remain visible below the top bar, so that I can still see what I asked while the answer streams.
11. As a person on a very short screen, I want the pinned message to give up its padding before it gives up its text, so that I lose decoration rather than content.
12. As a person typing, I want my input to sit on a plain divider without a border around it, so that the screen near my hands is not spent on decoration.
13. As a person typing, I want a single line of help at the foot, so that the commands and keys I can use are discoverable without a menu.
14. As a person learning the keys, I want the shortcuts entry to stay visible while I type, so that I can find the overlay at the moment I need it.
15. As a person who has started typing, I want the long placeholder to get out of the way, so that it does not compete with what I am writing.
16. As a person reading the transcript, I want the colours to tell me who is speaking, so that I can follow a conversation without reading every word.
17. As a person with a colour-blind terminal or a low-quality display, I want meaning to survive without colour, so that the hierarchy still reads when the palette does not.
18. As a person who likes a roomier transcript, I want one setting to give me more air between steps, so that I do not have to trade it against the reasoning preview separately.
19. As a person who prefers a tight transcript, I want the compact setting to stay genuinely compact, so that the default does not become the roomy one.
20. As a person whose session was interrupted or resumed, I want the top bar and the input region to look the same as in a live session, so that a resumed screen is not a second visual language.
21. As a person reading a child session, I want the top bar to keep telling me where I am, so that an entered subagent is not a screen with no context.
22. As a person opening a modal panel, I want the panels that take the screen to still take it whole, so that a modal is never half-drawn over the new chrome.
23. As a person who resizes the terminal, I want the top bar and the input region to re-lay out with the transcript, so that a resize does not leave chrome painted over content.
24. As a person reviewing the finished surface, I want a captured screenshot of a real session, so that I can judge the result against the reference instead of trusting a description.

## Implementation Decisions

**Block gap is a transcript concern, not a frame concern.** What separates two
steps is knowledge the transcript already has: it knows when a step's run of
tool activity has ended and a new reasoning header begins. The gap therefore
comes out of the transcript as part of the block it emits, rather than being
inferred by the frame from row shapes. The transcript keeps sole ownership of
"what is one step"; the frame keeps ownership of where the screen's fixed
regions are.

**Grouping semantics are untouched.** What counts as a tool group, what folds,
and what a group expands into do not change. This work changes the indent and
the spacing between blocks, and the palette those blocks resolve to; it does not
re-decide membership or folding.

**The input region returns rows, not a frame.** The input module's public
function currently returns a bordered box with a cursor position. It becomes a
borderless region: a top divider, the input rows, and one help row beneath.
Its return value keeps carrying the cursor position and the row/column geometry
that the pointer hit-testing depends on, because clicking to place the caret and
dragging to select must survive the change.

**The help row is always present and stable.** It carries the commands-and-keys
entry. It renders in the same place whether the input is empty or has text; the
long placeholder belongs to the input row and leaves on the first keystroke,
while the help row does not move. This ordering is what the existing chrome
behaviour already promises, and it is what makes the shortcuts overlay
reachable while typing.

**The status surface splits into a top bar and a slimmer foot.** The existing
status line keeps producing the foot, minus the branch, directory and model; a
new top-bar producer emits the environment row. Both live behind the same
status module and share its formatting helpers, so one place still decides what
an environment fact looks like. The top bar packs two sides: a left group
(plan and ship chips, branch, directory) and a right group (context pressure),
with the separator and truncation rules applied so the left group degrades
before the right.

**The top bar is a reserved row in the screen's composition.** It is chrome, not
transcript: it does not scroll, and it must not be produced by appending
transcript rows. The screen reserves its row and renders the pinned panel
beneath it, so the viewport becomes top bar, then panel, then content, then
padding. When the screen cannot afford every region, the panel's padding is what
gives way first.

**Density grows into the whole spacing scale.** The density value currently
drives exactly three things: the live thinking preview row count, an inter-turn
blank row, and the diff expansion threshold. It gains the block gap as a fourth
consumer, expressed as a lookup on the density rather than a conditional inside
the renderer, so a future density value adds an entry instead of a branch.

**Roles are resolved once, centrally.** The palette keeps one semantic role per
speaker — person, reasoning, tool, error, plus the muted/dim weights used for
structure — and every surface resolves through those roles rather than choosing
a colour at the call site. Decoration (the input border, block rules that carry
no meaning) stops being coloured entirely. The existing background-fill roles
that still have non-transcript callers stay as they are.

**Nothing about the key map changes.** The bindings that expand a fold, enter a
child session, summon a panel or open the shortcuts overlay keep working through
whatever control the new layout presents. Moving a control's visual affordance
is allowed; removing the key that reaches it is not.

## Testing Decisions

**Primary seam — the real PTY chrome suite (`e2e/experience-chrome.e2e.ts`).**
It is the highest existing seam that already asserts this exact surface: it
drives the packed profile and reads painted frames, including the one test that
pins the help row's stability across empty and typing frames. Frame-level
behaviour belongs here: the block gap between steps, the top bar carrying branch
and directory and context, the absence of a bordered input, the help row still
present while typing, the pinned panel below the top bar, and the modal panels
still taking the screen whole. Existing assertions that name the old placeholder
or the old box geometry are rewritten to the new shape rather than deleted, so
the behaviours they protect stay covered.

**Secondary seam — the module-level render specs.**
`packages/bundle/tests/inputbox.spec.ts` already pins the box's frame, its
placeholder behaviour, its accent, and — most importantly — the mapping from a
buffer position to a screen row and column. That mapping is the invariant the
pointer hit-testing depends on, so it is re-expressed for a borderless region
and must keep passing in spirit: clicking a character still lands on that
character, dragging still selects the same span, and a wide character still
counts as two columns. `packages/bundle/tests/status.spec.ts` gains the top
bar's two-sided packing and truncation order. `packages/bundle/tests/transcript.spec.ts`
gains the block gap. `packages/bundle/tests/theme.spec.ts` pins the role
palette.

**Prior art to follow.** `e2e/experience-chrome.e2e.ts` already drives real
frames and asserts the help row's position across frames — that is the pattern
for every new chrome assertion. `e2e/pty-selectors.e2e.ts` and
`e2e/pty-mouse.e2e.ts` drive clicks and drags against the input region and are
the tests that will catch a geometry regression. `docs/specs/agent-output-rendering.md`
established the habit of rewriting a stale frame assertion to the new contract
rather than deleting it; the same applies here.

**Visual acceptance is an artifact, not a test.** `e2e/capture.e2e.ts` already
replays frames from the packed binary and writes the screens out with styling
intact. It runs under an environment flag because it writes into the repository
rather than asserting. The visual criterion uses it to produce the frames a
person reviews against the reference; it is not a pass/fail gate, and the
automated criteria below are what the landing phase runs.

## Out of Scope

- The transcript's grouping semantics and fold mechanics: what counts as a tool
  group, what folds, and what a group expands into stay exactly as
  `docs/specs/agent-output-rendering.md` shipped them.
- Remapping or removing any global key binding, including Ctrl+O, Ctrl+Q,
  Ctrl+T, Ctrl+F, Esc, Tab/Shift+Tab, wheel scrolling, and drag selection.
- Matching image 3's exact colours, glyphs or pixel metrics.
- Removing the `/ui` axis, the `✻` thinking mark, or the `›` user mark.
- Any change to the dsh harness upstream (`@deepseek-ai/dsh-*`); codsh adds no
  fork.
- The Markdown renderer's own typography (tables, code fences, diffs) beyond the
  palette its roles resolve to.
- Making the surface a general-purpose themable TUI: one palette, not a theme
  file format.
- Preserving image 2's per-line timestamp column; the reference does not have
  one and it is not part of this surface.
- Adding a per-line timestamp column, a gutter, or any other new transcript
  decoration.
- A settings file or `/theme` command for choosing palettes.
- Restyling the banner shown at startup beyond the roles it already resolves
  through.
- Changing the `!` shell-line path, which the previous spec recorded as a known
  non-goal.

## Acceptance Criteria

Each criterion names the command that proves it and the output that counts as
passing. As in the previous spec, the commands invoke the installed tools
directly: this workspace's `minimumReleaseAge` policy makes `pnpm run <script>`
print a policy error while exiting 0, so it cannot be used as evidence.

1. **The chrome behaves on a real terminal — PTY chrome suite.**
   Command: `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/experience-chrome.e2e.ts`
   Passing: exits 0 with **zero skipped** and every test green, including the
   rewritten block-gap, borderless-input, top-bar and help-row assertions.

2. **The whole PTY surface still holds — no neighbouring regression.**
   Command: `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts`
   Passing: exits 0 with **0 failed** across every e2e file, so input, mouse,
   selectors, navigation, reading, viewport, folds and session suites are all
   unaffected by the new geometry.

3. **The input region keeps its geometry contract.**
   Command: `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts`
   Passing: exits 0 with zero skipped, including tests that place the cursor by
   pointer, select a dragged span, and count a wide character as two columns.

4. **The top bar, block gap and palette hold at the module seam.**
   Command: `node node_modules/vitest/vitest.mjs run packages/bundle/tests/status.spec.ts packages/bundle/tests/transcript.spec.ts packages/bundle/tests/theme.spec.ts packages/bundle/tests/density.spec.ts`
   Passing: exits 0 with zero skipped, covering the top bar's two-sided packing
   and truncation order, the block gap under both densities, and the role
   palette.

5. **Nothing else regressed — full unit suite.**
   Command: `node node_modules/vitest/vitest.mjs run`
   Passing: exits 0 with every file green; the suite currently reports 53 files
   and the new count must be green rather than reduced by deletions.

6. **Types are clean.**
   Command: `./node_modules/.bin/tsc --noEmit`
   Passing: exit code 0 with no diagnostics.

7. **The input is genuinely borderless.**
   Command: `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts packages/bundle/tests/prompt.spec.ts`
   Passing: exits 0 with assertions proving no rendered row opens with the
   rounded top-left frame glyph and that the region still emits a divider and
   the `›` mark.

8. **The shortcuts path survived the move.**
   Command: `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/experience-chrome.e2e.ts -t "key legend"`
   Passing: exits 0, **the matching test reports passed rather than skipped**,
   and it still asserts both that the shortcuts entry is present in the empty
   and typing frames and that it holds the same row in both.

9. **The user-facing description matches the new chrome — both languages.**
   Command: `grep -icE "input|status|bar|box" README.md; grep -cE "输入框|状态栏|顶部" README.zh.md`
   Passing: both printed counts are non-zero, so each README describes the new
   input and status chrome in its own language and the two stay in parity. The
   real check is that the sentences they carry match the shipped behaviour (no
   bordered box, environment facts on the top bar); the counts prove neither
   language was left behind, which is the failure that actually happens.

10. **The release note exists.**
    Command: `grep -lE "top bar|status bar|input region|palette|spacing|borderless" $(grep -ln "codsh-bundle" .changeset/*.md)`
    Passing: prints at least one path — a changeset naming `codsh-bundle` whose
    text describes the chrome work. Pre-existing changesets do not satisfy it on
    their own; in particular the earlier `/ship`-chrome changeset matches on the
    word "chrome" and must not be mistaken for this one.

11. **The visual artifact exists for review.**
    Command: `CAPTURE_SCREENS=1 node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/capture.e2e.ts`
    Passing: exits 0 and prints the paths of the frames it wrote. This is an
    artifact for human review against the reference, not an automated pass/fail;
    the criterion is that the capture runs clean and writes frames.

12. **The spec always reflects its phase.**
    Command: `grep -n "^Status:" docs/specs/chrome-redesign.md`
    Passing: the line reads `Status: shipped` once landing completes, and the
    phase actually in progress before that.

## Plan

- [x] Ticket 1: Input Region Geometry, Separated From the Frame — Delivers one explicit geometry source (left offset, row offset, gutter width) with the wrap budget, the pointer-to-buffer mapping and the composer's mouse hit-testing all routed through it. Changes no rendered output; it exists because the border width and the caret's left offset are the same number written twice today, and removing the border would shift three consumers at once. (Blocked by: none) (Track: 5)
- [x] Ticket 2: A Step Reads as One Block — Delivers a gap at the step boundary and gives the block gap its own density-derived value, so a step's reasoning header, its body and its tool rows read as one block on one indent. Grouping and fold semantics unchanged. (Blocked by: none) (Track: 1,6)
- [x] Ticket 3: The Input Region Loses Its Border — Delivers the borderless region: a divider, the `›` mark, the input, and one help row carrying the commands-and-keys entry. The cursor geometry must survive exactly, which Ticket 1 is what makes a single-descriptor change. (Blocked by: Ticket 1) (Track: 5)
- [x] Ticket 4: Environment Facts Move to a Top Bar — Delivers a reserved row 0 carrying branch and directory on the left, context pressure on the right, plus the plan-mode and `/ship` gate chips; the foot drops directory, branch and model; the pinned sticky panel renders below the bar and yields its padding first. Also fixes the defect that a long path currently drops the branch first. (Blocked by: none) (Track: 3,4)
- [x] Ticket 5: One Restrained Palette — Delivers one semantic role per speaker (person, reasoning, tool, error) resolved through a single point, with decoration uncoloured, tools quieter than reasoning, and meaning surviving `NO_COLOR`. (Blocked by: Ticket 3, Ticket 4) (Track: 2)
- [x] Ticket 6: Interaction Preservation After the Frame Changed — A verification gate, not a licence to churn: proves every frozen key binding still reaches its feature after the geometry moved, and fixes only what the new frame actually broke. Accepted misses recorded in the commit message. (Blocked by: Ticket 3, Ticket 4) (Track: 7)
- [x] Ticket 7: Release and Documentation Compliance — Delivers the `codsh-bundle` changeset (distinct from the pre-existing `/ship`-chrome one), the bilingual README updates kept in parity, the `CONTEXT.md` terms (top bar, block gap, help row), and the captured visual artifact with its frame paths recorded. (Blocked by: Ticket 5, Ticket 6) (Track: 9)

## Baseline

Recorded at gate 2, before implementation, on `ship/chrome-redesign` cut from
`main` at `a62d959a9d6b63ff6820350dc6d474d56136be1c`.

- Pre-change gates, run directly to bypass the `minimumReleaseAge` lockfile
  gate: `./node_modules/.bin/tsc --noEmit` exits 0; the unit suite reports
  **53 files / 1415 tests** passing with 0 skipped.
- The e2e suite reports **12 files passed / 1 skipped, 135 passed / 1 skipped,
  0 failed**. Like the previous spec's baseline, it is green only with PTY
  access: under the default `workspace-write` sandbox every PTY test fails with
  `OSError: out of pty devices` because `/dev/ptmx` is denied, which is an
  environment denial and not a code failure. Landing must run the e2e commands
  with PTY access and must not read a `workspace-write` run as evidence either
  way.
- Reference for the target shape: the two attached images. Image 3 (comfortable
  reference) is the acceptance baseline; image 2 is the current fragmented
  state.

## Verification Log

Progress writes only; the sealed Main Track is not touched.

### Ticket 1 — Input Region Geometry, Separated From the Frame (Track: 5)

**Delivered.** `packages/bundle/src/inputbox.ts` gains one explicit geometry
source: `RegionGeometry` (`left` 4, `top` 1, `gutter` 2) returned by
`regionGeometry()`, plus `regionCell(column, indent)` for the terminal-column to
region-cell step. The wrap budget, the box's inner width, the caret's row/column
mapping and the cursor column all read their offsets from it; the old
`FRAME_WIDTH` / `GUTTER_WIDTH` / `TEXT_AT` constants are gone.
`packages/bundle/src/prompt.ts` routes both mouse paths (`boxCaretAt` and
`regionTarget`) through `regionCell` instead of its own `column - 1 - GUTTER`
arithmetic. No rendered output changed.

**Red (witnessed before implementation).** New seam `regionGeometry()` /
`regionCell()` stubbed to `throw new Error('not implemented')` in
`packages/bundle/src/inputbox.ts`, with the new tests in
`packages/bundle/tests/inputbox.spec.ts`:

- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts`
  → exit 1, `Tests 4 failed | 44 passed (48)`, each failure
  `Error: not implemented` at `regionGeometry` (`src/inputbox.ts:63`) or
  `regionCell` (`src/inputbox.ts:78`). Tracer-bullet red at the new seam, not a
  syntax or setup error; the 44 pre-existing tests stayed green.

**Green.**

- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts packages/bundle/tests/prompt.spec.ts`
  → exit 0, **2 files / 154 passed (154), 0 skipped**. New coverage: the
  geometry source's three offsets; the wrap budget derived from it; the
  terminal-column to region-cell mapping; a pointer on the first (`a`), middle
  (`c`) and last (`f`) cell of a painted content row and on the first and last
  cells of a wrapped row landing on exactly the character painted there; a
  byte-identical pin of the framed rows and cursor for the empty/placeholder and
  wrapped cases; and a composer click on a wrapped row inserting at the painted
  character.
- `./node_modules/.bin/tsc --noEmit` → exit 0, no diagnostics.
- `node node_modules/vitest/vitest.mjs run` → exit 0, **53 files / 1421 tests**
  passing, 0 skipped (baseline 53 / 1415 plus the 6 new; no regression).

**PTY note.** This ticket changes no rendered output, so it has no PTY
assertion of its own. The PTY geometry proofs named in the spec's Acceptance
Criteria (`e2e/pty-selectors.e2e.ts`, `e2e/pty-mouse.e2e.ts`,
`e2e/experience-chrome.e2e.ts`) cannot run in this sandbox: `/dev/ptmx` is
denied (`OSError: out of pty devices`, exit 1 for all PTY tests) and approval
prompts are disabled, so no PTY result is treated as evidence either way.

### Ticket 2 — A Step Reads as One Block (Track: 1,6)

**Delivered.** `packages/bundle/src/density.ts` gains `BLOCK_GAP` (`compact`
1, `comfortable` 2) and the `blockGap(density)` lookup, so `/ui` now governs
the block gap as a fourth consumer. `packages/bundle/src/transcript.ts` opens
each new step with that gap: `step/start` returns the gap rows as the first
row of the new block, when the previous step painted and did not already end
on a separator. The tail tool run is deliberately left intact — a step
boundary is not prose, and the grouping rule does not break on it — and the
gap is emitted at the *start* of the next step, never after the last one, so
a turn still ends on painted content. The reasoning header, its body and the
step's tool rows already sit on one indent on the coloured surface; this
ticket pins that on the painted rows.

**Reading note on the checklist.** Two of the ticket's checklist items are in
tension: "exactly one blank row, under both densities" and "compact and
comfortable produce different gap settings". The sealed Track-6 (density
governs block gaps), User Story 18 ("more air between steps") and User Story
19 ("compact stays genuinely compact") resolve it as a per-density count:
compact 1 blank row, comfortable 2. Compact is asserted at exactly one blank
row; comfortable at two.

**Red (witnessed before implementation).**

- `blockGap` stubbed to `throw new Error('not implemented')` with the new
  density test:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/density.spec.ts`
  → exit 1, `Tests 1 failed | 11 passed (12)`, `Error: not implemented` at
  `blockGap` (`src/density.ts:43`). Red at the new seam, not a syntax or
  setup error.
- The boundary tests first ran against the unmodified renderer:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/transcript.spec.ts`
  → exit 1, `Tests 3 failed | 136 passed (139)`; every failure
  `expected [] to deeply equal [ '' ]` at the `step/start` render — the new
  behaviour absent by assertion, not a setup error.

**Green.**

- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/transcript.spec.ts packages/bundle/tests/density.spec.ts`
  → exit 0, **2 files / 153 passed (153)**, 0 skipped. New coverage: compact
  one-row gap; comfortable two-row gap; no gap before a turn's first step; no
  gap between consecutive tool calls of one step; no second gap when the next
  step paints nothing; the turn ending on its painted content; and the shared
  indent of the reasoning header, its body and the tool row.
- `./node_modules/.bin/tsc --noEmit` → exit 0, no diagnostics.
- `node node_modules/vitest/vitest.mjs run` → exit 0, **53 files / 1429 tests**
  passing, 0 skipped (baseline 53 / 1415 plus Ticket 1's 6 and this ticket's
  8; no regression, and the existing `agent-output-rendering` assertions are
  unmodified).
- Non-PTY regression, with the packed bundle rebuilt
  (`node ../../node_modules/tsdown/dist/run.mjs`, then
  `node ../../node_modules/typescript/bin/tsc -p tsconfig.build.json`, both
  exit 0):
  `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/pipe.e2e.ts`
  → exit 0, **19 passed (19)**.

**PTY note.** The ticket's own PTY proof,
`node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/pty-folds.e2e.ts`,
cannot run in this sandbox: all 15 tests fail with
`OSError: out of pty devices` (exit 1), the `/dev/ptmx` denial, and are not
treated as evidence either way. The frame-level block-gap assertion named in
the Testing Decisions belongs to `e2e/experience-chrome.e2e.ts` (Acceptance
Criterion 1) and remains for the main session to run with PTY access.

### Ticket 3 — The Input Region Loses Its Border (Track: 5)

**Delivered.** `packages/bundle/src/inputbox.ts` no longer draws a box.
`regionGeometry()` is now the single descriptor `{ left: 2, top: 1, gutter: 0 }`
— two cells before the text (the `›` mark and the space after it) and no
trailing reserve — so the wrap budget, the caret mapping and the composer's
mouse hit-testing all shift from the one value. `inputBox()` emits a full-width
`─` divider as row 0 (still carrying `accent`, so plan and shell modes announce
themselves there), the input rows with the `›`/`!` mark, and the optional help
row beneath, all laid out to the region's width. No row opens with `╭` or
closes with `╮`/`╰`/`╯` any more. Grouping, folding and the menu overlay are
untouched; the menu still floats above the region.

**Red (witnessed before implementation).** New seam test
`the borderless region (Track: 5) > paints a divider above the input instead of
a frame` in `packages/bundle/tests/inputbox.spec.ts`:

- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts -t "borderless"`
  → exit 1, `Test Files 1 failed (1)`, `Tests 1 failed | 48 skipped (49)`,
  `AssertionError: expected '╭────────────────────────────────────…' to match /^─+$/u`.
  Red at the new seam (the old frame is still painted), not a syntax or setup
  error.

**Green.**

- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts`
  → exit 0, **1 file / 50 passed (50)**, 0 skipped (Acceptance Criterion 3).
  The stale frame assertions in this file were rewritten to the borderless
  contract rather than deleted: the divider/`›` shape, the one help row present
  and stable empty vs. typing, wrapping, the cursor column, wide characters and
  the selector emoji, the pointer-to-buffer mapping on the first, middle, last
  and wrapped cell, shell mode, and a byte-identical pin of the borderless rows
  and cursor for the empty and wrapped cases.
- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts packages/bundle/tests/prompt.spec.ts`
  → exit 0, **2 files / 156 passed (156)**, 0 skipped (Acceptance Criterion 7).
  The four composer pointer tests and the six chrome-shape tests in
  `prompt.spec.ts` were re-expressed against the two-cell offset; the drag,
  click-to-place-caret and cursor-row behaviours are unchanged in spirit.
- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/status.spec.ts packages/bundle/tests/transcript.spec.ts packages/bundle/tests/theme.spec.ts packages/bundle/tests/density.spec.ts`
  → exit 0, **4 files / 265 passed (265)** (Acceptance Criterion 4).
- `./node_modules/.bin/tsc --noEmit` → exit 0, no diagnostics (Criterion 6).
- `node node_modules/vitest/vitest.mjs run` → exit 0, **53 files / 1431 tests**
  passing, 0 skipped (baseline 53 / 1415 plus Ticket 1's 6, Ticket 2's 8 and
  this ticket's 2; no regression, and the existing `agent-output-rendering`
  assertions are unmodified) (Criterion 5).
- Non-PTY regression, with the packed bundle rebuilt
  (`node ../../node_modules/tsdown/dist/run.mjs`, then
  `node ../../node_modules/typescript/bin/tsc -p tsconfig.build.json`, both
  exit 0): `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/pipe.e2e.ts`
  → exit 0, **19 passed (19)**. `e2e/wrapper.e2e.ts` could not run in this
  sandbox for an unrelated environment reason — `npm pack` fails because the
  npm cache contains root-owned files (`npm error Your cache folder contains
  root-owned files`) — so it is not read as evidence either way.
- The frame-level seam (`e2e/pty-helpers.ts`, `e2e/pty-input.e2e.ts`,
  `e2e/pty-session.e2e.ts`, `e2e/pty-selectors.e2e.ts`,
  `e2e/experience-viewport.e2e.ts`, `e2e/capture.e2e.ts`,
  `e2e/experience-chrome.e2e.ts`) was updated where it named the old frame: the
  shared `boxTops` now finds the full-width `─` divider, and the accent
  assertion, the resize/streaming corruption checks and the find-row check use
  the borderless shape. These are best-effort rewrites that need PTY access to
  verify.

**PTY note.** Ticket 3's own PTY proof,
`node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/pty-selectors.e2e.ts e2e/pty-mouse.e2e.ts e2e/experience-chrome.e2e.ts`,
cannot run in this sandbox: 3 files / 24 tests fail with
`OSError: out of pty devices` (exit 1; 48 occurrences), the `/dev/ptmx`
denial, and are not treated as evidence either way. Acceptance Criteria 1, 2
and 8 are the same PTY denial. The rendered frame, the byte-level accent on the
divider and the cursor geometry on a real terminal remain for the main session
to run with PTY access; the unit/tsc seam above is what this round can prove.

### Ticket 4 — Environment Facts Move to a Top Bar (Track: 3,4)

**Delivered.** `packages/bundle/src/status.ts` gains `topBar(facts, theme,
columns?)`: one row packing a left group (ship chip, plan chip, branch,
directory) that degrades first — the directory, then the chips, then the branch
— and a right group (context pressure, always shown when a sample exists,
muted routinely and warn/err as it falls) that is aligned to the last column
and never dropped. That fixes the foot's defect, where a long path dropped the
branch first. `statusLine` is now the slimmer foot: the `? shortcuts` entry and
the reasoning level, with branch, directory, model, context and the chips
removed. `packages/bundle/src/screen.ts` reserves row 0 via `setTopBar`, so the
viewport, the sticky panel's padding and the timeline rail all shift below it,
and every terminal-row mapping (`locate`, `coversOverlay`, the rail, the notice,
the sticky hit-test, the graphic placement) accounts for the reserved row; on a
short screen the panel yields its padding before the bar or the input region.
`console.setTopBar`, `prompt.setTopBar` and `refreshStatus()` wire the bar in;
the pipe shape now prints the top bar instead of the removed foot facts, and
`previewRows` gives the overlay the bar's row back.

**Red (witnessed before implementation).**

- `topBar` stubbed to `throw new Error('not implemented')` with the new
  `topBar` tests in `packages/bundle/tests/status.spec.ts`:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/status.spec.ts -t "packs the branch and directory left"`
  → exit 1, `Test Files 1 failed (1)`, `Tests 1 failed | 71 skipped (72)`,
  `Error: not implemented` at `topBar` (`src/status.ts:400`). Red at the new
  seam, not a syntax or setup error.
- `Screen.setTopBar` stubbed to `throw new Error('not implemented')` with the
  new top-bar layout tests in `packages/bundle/tests/screen.spec.ts`:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/screen.spec.ts -t "top bar"`
  → exit 1, `Test Files 1 failed (1)`, `Tests 2 failed | 158 skipped (160)`,
  `Error: not implemented` at `Screen.setTopBar` (`src/screen.ts:1373`). Red at
  the new seam.

**Green.**

- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/status.spec.ts packages/bundle/tests/transcript.spec.ts packages/bundle/tests/theme.spec.ts packages/bundle/tests/density.spec.ts`
  → exit 0, **4 files / 262 passed (262)**, 0 skipped (Acceptance Criterion 4).
  New coverage: the two-sided packing with the context figure aligned right;
  the branch still readable under an overflowing directory; the plan/ship chips
  on the left; context pressure surviving when the left group cannot fit; the
  chip/styling palette moved to the bar; and the foot's shortcuts/plus-reasoning
  contract, its drop order and its cut, replacing the old model/cwd assertions.
- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts`
  → exit 0, **1 file / 50 passed (50)**, 0 skipped (Criterion 3).
- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts packages/bundle/tests/prompt.spec.ts`
  → exit 0, **2 files / 157 passed (157)**, 0 skipped (Criterion 7); the fake
  console learned `setTopBar`, and a new test pins the composer's column-aware
  route to the reserved row.
- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/screen.spec.ts`
  → exit 0, **163 passed (163)**: the new top-bar tests cover row 0, the
  transcript and chrome below it, the bar holding row 0 while scrolling, the
  pinned panel rendering below it, the panel's padding yielding first on a short
  screen, and the bar surviving a resize with the transcript below it.
- `./node_modules/.bin/tsc --noEmit` → exit 0, no diagnostics (Criterion 6).
- `node node_modules/vitest/vitest.mjs run` → exit 0, **53 files / 1434 tests**
  passing, 0 skipped (baseline 53 / 1415 plus the tickets' new tests; no
  regression, and the existing `agent-output-rendering` assertions are
  unmodified) (Criterion 5).
- Non-PTY regression, with the packed bundle rebuilt
  (`node ../../node_modules/tsdown/dist/run.mjs`, then
  `node ../../node_modules/typescript/bin/tsc -p tsconfig.build.json`, both
  exit 0): `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/pipe.e2e.ts`
  → exit 0, **19 passed (19)**.

**Frame seam (best-effort; needs PTY access to verify).**
`e2e/experience-chrome.e2e.ts` gains an environment-top-bar suite: the bar owns
row 0 and names the workspace, and the foot carries `? shortcuts` but not the
directory. `e2e/experience-viewport.e2e.ts` was shifted by the reserved row
where it named viewport rows directly (the timeline rail, the pinned panel
padding, prompt-top anchoring and the wheel-home frame), with the comments
saying why. `e2e/capture.e2e.ts` needs no change: the viewer and capture read
the whole screen, and the bar is part of the frame a reviewer wants.

**PTY note.** Ticket 4's own proof,
`node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/experience-chrome.e2e.ts e2e/experience-viewport.e2e.ts`,
cannot run in this sandbox: 2 files / 21 tests fail with
`OSError: out of pty devices` (exit 1), the `/dev/ptmx` denial, and are not
treated as evidence either way. Acceptance Criteria 1 and 2 are the same
denial. The live first-row bar, the context figure changing with a reported
sample, and the resize re-layout remain for the main session to run with PTY
access; the unit/tsc seam above is what this round can prove.

### Ticket 5 — One Restrained Palette (Track: 2)

**Delivered.** `packages/bundle/src/theme.ts` now names the four speaker roles
explicitly: `person`, `reasoning`, `tool`, `error`. `person` is a new role
(blue) used for the `›` mark; `reasoning` is the old `agent` role (magenta);
`tool` re-weights from amber to the muted structural weight (`tool === muted`,
bright black), so tools are the quietest speaking role; `error` stays red.
`user` is now an alias for `person` — it used to alias `agent` — and `agent`
for `reasoning`, so the input marker and the transcript's person rule resolve
to one painting. `packages/bundle/src/gutter.ts` resolves its `user` and
`thinking` rules through `theme.person` and `theme.reasoning` instead of
`theme.accent` and `theme.agent`, which is the drift the old gutter carried
(cyan in the transcript, magenta in the input). `packages/bundle/src/prompt.ts`
stops defaulting the input divider to `theme.accent`: it passes an accent only
when a mode provides one (plan) or the region is in shell mode, so the default
divider is the region's own dim edge. New `packages/bundle/tests/gutter.spec.ts`
pins the single-point mapping and the marks.

**Red (witnessed before implementation).**

- `theme.person`/`theme.reasoning` absent:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/theme.spec.ts -t "paints one role per speaker"`
  → exit 1, `Test Files 1 failed (1)`, `Tests 1 failed | 41 skipped (42)`,
  `TypeError: theme.person is not a function` at `theme.spec.ts:102`. Red at
  the new role, not a syntax or setup error.
- The person role drifted between the transcript and the input:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/gutter.spec.ts`
  → exit 1, `Tests 1 failed (1)`, `AssertionError: expected '\u001b[36m› \u001b[0m' to be '\u001b[34m› \u001b[0m'`
  at `gutter.spec.ts:13` — the gutter's cyan against the role's blue.
- The alias call site still drifted:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/gutter.spec.ts`
  → exit 1, `Tests 1 failed | 1 passed (2)`,
  `expected '\u001b[35m› \u001b[0m' to be '\u001b[34m› \u001b[0m'` at
  `gutter.spec.ts:24` — the input's magenta against the role's blue.
- The tool role was not the quiet weight:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/theme.spec.ts -t "quietest speaking role"`
  → exit 1, `Tests 1 failed | 42 skipped (43)`,
  `expected '\u001b[33mx\u001b[0m' to be '\u001b[90mx\u001b[0m'` at
  `theme.spec.ts:110`.
- The default divider was accented:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/prompt.spec.ts -t "leaves the divider uncoloured"`
  → exit 1, `Tests 1 failed | 107 skipped (108)`, expected the dim divider
  `\u001b[2m───…`, received the accent divider `\u001b[36m───…` at
  `prompt.spec.ts:270`.

**Green.**

- Ticket 5 command:
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/theme.spec.ts packages/bundle/tests/gutter.spec.ts`
  → exit 0, **2 files / 48 passed (48)**, 0 skipped. New coverage: the four
  roles distinct from each other; the tool role on the muted weight and
  reasoning off it; every role unstyled under `NO_COLOR`; the background-fill
  roles resolving for their non-transcript callers; all six gutter roles
  resolving through the theme role; and the `›` and `✻` marks present and
  unstyled under `NO_COLOR`.
- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts`
  → exit 0, **1 file / 50 passed (50)**, 0 skipped (Acceptance Criterion 3).
- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/inputbox.spec.ts packages/bundle/tests/prompt.spec.ts`
  → exit 0, **2 files / 158 passed (158)**, 0 skipped (Criterion 7), including
  the new assertion that the default divider is the uncoloured dim edge.
- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/status.spec.ts packages/bundle/tests/transcript.spec.ts packages/bundle/tests/theme.spec.ts packages/bundle/tests/density.spec.ts`
  → exit 0, **4 files / 266 passed (266)**, 0 skipped (Criterion 4).
- `./node_modules/.bin/tsc --noEmit` → exit 0, no diagnostics (Criterion 6).
- `node node_modules/vitest/vitest.mjs run` → exit 0, **54 files / 1442 tests**
  passing, 0 skipped (baseline 53 / 1434 plus this ticket's 8; no regression,
  and the existing `agent-output-rendering` assertions in `transcript.spec.ts`
  are untouched) (Criterion 5).
- Non-PTY regression, with the packed bundle rebuilt
  (`node ../../node_modules/tsdown/dist/run.mjs`, then
  `node ../../node_modules/typescript/bin/tsc -p tsconfig.build.json`, both
  exit 0): `node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/pipe.e2e.ts`
  → exit 0, **19 passed (19)**.

**Stale assertions re-expressed, not weakened.** `theme.spec.ts`'s pinned
palette now names the new roles (`person` blue, `tool` on the muted weight).
`inputbox.spec.ts`'s `/command` and `$skill` hue pins and `markdown.spec.ts`'s
inline-code hue pin now assert through `colour.tool(...)` and
`colour.user(...)`, so they track the role rather than a literal shade.
`e2e/pty-selectors.e2e.ts` stops asserting the idle divider is accent cyan and
asserts it is not, since only a mode accents it now (frame seam, needs PTY
access to run).

**PTY note.** Ticket 5's own proof,
`node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/experience-reading.e2e.ts e2e/experience-chrome.e2e.ts`,
cannot run in this sandbox: 2 files / 18 tests fail with
`OSError: out of pty devices` (exit 1; 36 occurrences), the `/dev/ptmx`
denial, and are not treated as evidence either way. Acceptance Criteria 1, 2, 8
and 11 remain for the main session to run with PTY access; the unit/tsc seam
above is what this round can prove.

### Ticket 6 — Interaction Preservation After the Frame Changed (Track: 7)

**Verification result.** This is a gate, and at the reachable unit seam it
passed without a source change: after Tickets 3–4 moved the geometry, every
frozen binding still reaches its feature. The route was audited end to end —
Ctrl+O (`expand-output`) to `handlers.expandOutput`; Ctrl+Q (`toggle-queue`) to
the queue panel and a click on the queued row through `regionTarget`; Ctrl+T
(`toggle-todos`) to the readout; Ctrl+F (`transcript-search`) to
`console.searchTranscript`; Ctrl+R (`history-search`) to the editor's own
history search; Esc (`escape`) to `handlers.escape` (and, in `index.ts`, to
`childViews`/the gate modal); Tab to the editor's completion; Shift+Tab to
`handlers.shiftTab` (plan mode); `page`/`scroll` to the viewport; and the mouse
paths to `regionRowAt`/`locate`. No `packages/bundle/src` file changed in this
ticket (`git diff -- packages/bundle/src/` is empty), so grouping semantics and
fold mechanics are untouched.

**Regression guards added (the missing "reaches its feature" assertions).**

- `packages/bundle/tests/screen.spec.ts`, `top bar > keeps the bar inert and
  the transcript and rail working below it`: with a bar reserved, the rail ticks
  sit one row lower (row 2 `↑`, 3 `·`, 4 `●`, 5 `↓`), a press/release on the bar
  row copies nothing and starts no selection, and a click on the shifted
  first-turn tick still navigates (`currentTurn` 1 → 0). This is the unit-level
  twin of the stale frame geometry the top bar introduced.
- `packages/bundle/tests/prompt.spec.ts`, `reports Ctrl+O to its owner so the
  fold still opens`: Ctrl+O reaches `handlers.expandOutput`, the one frozen key
  that was only decoded in `keys.spec.ts` and never asserted to arrive.

**Red (witnessed, then reverted — the shipped code already delivered the
behaviour).**

- Rail shift reverted (`index + 1 + this.topBarRows()` → `index + 1` in
  `screen.ts`):
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/screen.spec.ts -t "keeps the bar inert"`
  → exit 1, `Tests 1 failed | 163 skipped (164)`,
  `AssertionError: expected '·' to be '↑'` at `screen.spec.ts:205`.
- Ctrl+O routing disabled (`if (false && key.kind === 'expand-output')`):
  `node node_modules/vitest/vitest.mjs run packages/bundle/tests/prompt.spec.ts -t "fold still opens"`
  → exit 1, `Tests 1 failed | 108 skipped (109)`,
  `expected [] to deeply equal ['expanded']` at `prompt.spec.ts:1379`.
- Both reverts were undone before the green run; the source diff is empty.

**Green.**

- `node node_modules/vitest/vitest.mjs run packages/bundle/tests/keys.spec.ts packages/bundle/tests/prompt.spec.ts packages/bundle/tests/screen.spec.ts packages/bundle/tests/console.spec.ts`
  → exit 0, **4 files / 386 passed (386)**, 0 skipped.
- `node node_modules/vitest/vitest.mjs run` → exit 0, **54 files / 1444 tests**
  passing, 0 skipped (Ticket 5's 1442 plus this ticket's 2; the existing
  `agent-output-rendering` assertions in `transcript.spec.ts` are unmodified).
- `./node_modules/.bin/tsc --noEmit` → exit 0, no diagnostics.
- Non-PTY regression: `node node_modules/vitest/vitest.mjs run --config
  vitest.e2e.config.ts e2e/pipe.e2e.ts` → exit 0, **19 passed (19)**.

**Frame seam fixed (best-effort; needs PTY access to verify).**
`e2e/experience-navigation.e2e.ts` pinned absolute viewport rows in its timeline
test. The reserved top bar moves every viewport row down one — proved at the
unit seam above, where the first turn's tick is terminal row 3 with the bar and
row 2 without — so the rail click rows were shifted (`2→3`, `5→6`, and the
mouse-out to row 7) and the two mark assertions re-expressed one row lower
(`clicked[1]→clicked[2]`, `arrowed[2]→arrowed[3]`). This is the same +1
transformation Ticket 4 already applied to `e2e/experience-viewport.e2e.ts`.
The e2e run cannot confirm it here.

**Accepted misses (recorded, not implicit).**

- **Esc leaving a child-session view** is wired in `index.ts` (`onEscapeKey` →
  `exitView()` when `childViews.current` is set) and the gate modal's Escape is
  asserted in `packages/bundle/tests/gate-modal.spec.ts`. The child-view stack
  itself (`ChildViews.push/pop`) is unit-covered in `child-view.spec.ts`; the
  live key-to-exit path is only exercised by the PTY suites.
- **Ctrl+R** is delegated by the prompt straight to `editor.handle`, so it is
  asserted at that seam in `packages/bundle/tests/editor.spec.ts` rather than
  duplicated at the prompt.

**PTY note.** Ticket 6's own proof,
`node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/pty-input.e2e.ts e2e/pty-selectors.e2e.ts e2e/pty-mouse.e2e.ts e2e/experience-navigation.e2e.ts`,
cannot run in this sandbox: 4 files / 40 tests fail with
`OSError: out of pty devices` (exit 1), the `/dev/ptmx` denial, and are not
treated as evidence either way. The redirected rail rows and the
`experience-navigation` assertions above need that PTY run to be confirmed.

### Ticket 7 — Release and Documentation Compliance (Track: 9)

**Delivered.** The durable records this ticket owns; the visual artifact is the
one item left to a PTY run.

- `.changeset/chrome-redesign.md` names `codsh-bundle` at `minor` and describes
  the chrome in the user's terms: the step block and its gap, the top bar, the
  borderless input with its help row, and the role palette. It is distinct from
  `.changeset/ship-chrome-idle-after-run.md`, the pre-existing `/ship`-chrome
  note that matches the word "chrome".
- `README.md` and `README.zh.md` were corrected in parity: the stale "box at the
  bottom" sentence became the top bar plus a borderless input region with a `›`
  and one help row (`? shortcuts`); each now describes the step block and its
  gap; the `/ui` line names the two-row (comfortable) / one-row (compact) gap
  between steps; and the remaining chrome "box" references in the Working
  section became "input region".
- `CONTEXT.md` gains **Top bar**, **Block gap** and **Help row** under
  `### Surface` (lines 35, 285, 292), and the redefined **Chrome** now names the
  top bar at row 0 and the borderless input region instead of "input box,
  status row".
- `e2e/capture.e2e.ts`'s user-facing scene copy stops calling the input a box
  and the foot a status row, so the captured frames are described in the
  shipped terms.

**Red (witnessed before the docs were written).**

- The release note was absent:
  `grep -lE "top bar|status bar|input region|palette|spacing|borderless" $(grep -ln "codsh-bundle" .changeset/*.md)`
  → exit 1, no output (the three pre-existing `codsh-bundle` changesets carry
  none of those words).
- The stale sentence was present:
  `grep -n "box never leaves the bottom" README.md` → line 96;
  `grep -n "输入框钉底" README.zh.md` → line 95.
- The new terms were absent: `grep -cE "top bar|block gap|help row" CONTEXT.md`
  → `0`, exit 1.

**Green.**

- Criterion 9: `grep -icE "input|status|bar|box" README.md; grep -cE "输入框|状态栏|顶部" README.zh.md`
  → `10` and `5`; both non-zero.
- Criterion 10: `grep -lE "top bar|status bar|input region|palette|spacing|borderless" $(grep -ln "codsh-bundle" .changeset/*.md)`
  → `.changeset/chrome-redesign.md`, exit 0.
- The stale box-at-the-bottom sentences are gone:
  `grep -n "box never leaves the bottom" README.md` and
  `grep -n "输入框钉底" README.zh.md` → exit 1 each.
- The terms resolve: `grep -nE "^\*\*(Top bar|Block gap|Help row)\*\*" CONTEXT.md`
  → lines 35, 285, 292.
- `./node_modules/.bin/tsc --noEmit` → exit 0, no diagnostics (Criterion 6).
- `node node_modules/vitest/vitest.mjs run` → exit 0, **54 files / 1444 tests**
  passing, 0 skipped (Criterion 5).

**PTY note (Criterion 11 — the one checklist item still open).**
`CAPTURE_SCREENS=1 node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts e2e/capture.e2e.ts`
cannot run in this sandbox. It fails before any frame is replayed:
`EPERM: operation not permitted, mkdir '/Users/zhaodongsheng/.cache/codsh/showcase'`
at `e2e/pty-driver.ts:188` — the sandbox denies the capture workspace write
outside the session workspace — and its PTY path is denied as well (`/dev/ptmx`
→ `OSError: out of pty devices`). It is an environment denial, not a code
failure, so it is not read as evidence either way. The frames it writes,
`site/data/screens.json`, and their paths therefore cannot be recorded here.
That is the only Ticket 7 checklist item left, so the Plan checkbox is
deliberately left unticked and `Status:` stays `planned` until the main session
runs the capture.



## Final Verification (Phase 5)

Run by the main session with PTY access, after the six stale frame assertions
that the loop could not see were repaired. Every command below is the literal one
from `## Acceptance Criteria`; every exit code was read from the run.

| # | Criterion | Result |
|---|---|---|
| 1 | PTY chrome suite | exit 0 — **10 passed**, 0 skipped (baseline 9; +1 for the top-bar test) |
| 2 | Whole PTY surface | exit 0 — 12 files passed / 1 skipped, **136 passed / 1 skipped, 0 failed** (baseline 135, +1) |
| 3 | Input region geometry | exit 0 — **50 passed**, 0 skipped |
| 4 | Top bar, block gap, palette | exit 0 — **266 passed** across status/transcript/theme/density |
| 5 | Full unit suite | exit 0 — **54 files / 1444 passed**, 0 skipped (baseline 53/1415) |
| 6 | Types clean | **exit 0**, no diagnostics |
| 7 | Input genuinely borderless | exit 0 — **159 passed** across inputbox/prompt |
| 8 | Shortcuts path survived | exit 0 — the matching test reports **passed, not skipped** (1 passed / 9 skipped) |
| 9 | Bilingual README parity | counts **10** and **5**, both non-zero |
| 10 | Release note | prints `.changeset/chrome-redesign.md`; the pre-existing `/ship`-chrome changeset does not satisfy it |
| 11 | Visual artifact | exit 0 — **captured 8 screens → `site/data/screens.json`** |
| 12 | Spec phase | `Status: shipped` |

**Zero new failures against `## Baseline`.** Unit 1415 → **1444** (+29, nothing
deleted). E2E 135 → **136** passed, 0 failed both before and after. Re-verified on
the frozen tree: `tsc` exit 0.

### Correction: the blocker was half right, and the other half hid six defects

The loop stopped because Criterion 11 is PTY-only and writes
`~/.cache/codsh/showcase`, outside its sandbox. That part was true, and the main
session ran it: `CAPTURE_SCREENS=1 … e2e/capture.e2e.ts` exits 0 and writes 8
screens.

But the loop also listed Criteria 1, 2 and 8 as merely outstanding, and reported
that the frame-seam rewrites from Tickets 2-6 were still to do. Running the suite
found **six real failures** behind that summary — stale assertions naming places
the new layout deliberately moved:

1. Three tests asserted the model (`cli-mock`) on the foot's status row. The model
   is no longer persistently painted anywhere: the bar carries ship/plan/branch
   and the directory, the foot carries the reasoning level and `? shortcuts`.
   Those assertions now name the workspace on row 0 and the shortcuts entry on the
   foot, which is what they were really pinning — that bar and foot stay stable
   while other chrome comes and goes.
2. Two mouse tests pressed at row 1 before dragging. Row 0 is the environment bar
   now, so the press landed on the bar, no selection started, and the PTY driver
   **timed out instead of failing an assertion** — a silent hang, not a red test.
   The presses move to row 2, the transcript's first row.
3. The undo test anchored the input row on the frame's closing `│`; the input is
   borderless, so it anchors on `›` instead.

Had Criterion 2 been taken as "outstanding" and left unrun, all six would have
shipped.

### Observations carried forward

Both are consistent with the sealed Main Track, so neither was changed silently:

- **The model name has no persistent home.** Track-3 and the reference image put
  ship/plan/branch/directory and context pressure on the bar, and the foot keeps
  only the reasoning level and the shortcuts entry. The model is reachable in
  `/status` but is no longer visible at a glance. If it should be, that is a new
  decision about where it goes, not a defect in this one.
- **Context pressure is on from the first sample.** `topBar` carries `N% left`
  whenever the session has reported usage — `contextPressure` returns the figure
  muted routinely and only escalates to warn at 25% or below and err at 10% or
  below — so User Story 6's always-on figure is what shipped, not a threshold.
  (An earlier draft of this note described the foot's old alarming-headroom
  policy; it never applied to the bar.)
