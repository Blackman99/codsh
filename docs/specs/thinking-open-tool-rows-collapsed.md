# Thinking Open, Tool Rows Collapsed

Status: shipped (thinking default reversed 2026-09-15)

Owner 2026-09-15: thinking lands folded again, and tool cards paint no
highlight. The one-row tool cards, the `thinking…` head while a thought
runs, the clock, click/Ctrl+O, and the pipe digest stay. What changed is
the default form: the deliberation stays behind the clock until a click
or Ctrl+O, and a tool row has no panel fill and no amber title.

Owner 2026-09-16: the in-progress head ticks. While a thought streams, the
`thinking…` row advances the same Braille frames as the working line, and
the hint row's verb is `thinking`. Pipes still never stream the head.

Owner 2026-09-16: streaming and collapsed thinking each occupy a single row,
like a tool summary. Vertical panel padding remains only in the expanded form.

Owner 2026-09-16: the collapsed clock and the in-progress `thinking…` head
carry no `bgThinking` fill. A full-width thinking background on that one
row is a near-black bar between tool cards; the fill stays on the expanded
deliberation only, and that fill is a lighter violet so it reads as a
panel rather than a blackout.

Owner 2026-09-16: a terminal card that exited non-zero or was killed is a
failed row (`✗`, error rule), not a green pass. dsh still reports the
result without `isError`; the surface is what fails it.

Owner 2026-09-17: a finished success bullet is dim, not green — the trailing
`✔` still says it worked. Consecutive one-row cards on a TTY open with a
blank between them; a pipe still closes each card with a blank.

## Requirement

当前的核心渲染逻辑是"思考折叠，工具展示"；期望反过来："思考展示，工具折叠"。
UI/UX 参考 Grok 官方 CLI（Grok Build）。

Owner 2026-09-15 reversed the thinking default back to folded (Claude-like)
while keeping tool rows collapsed. Grok Build remains the reference for
one-row cards, not for an open thought.

## Problem Statement

A reasoning model's deliberation is the part of a turn a person actually
wants to follow while it happens: it says what the agent is about to do and
why. codsh showed it as one live line under the box and then kept a one-row
clock (`│ thought for 3.2s`) with the text behind a click or Ctrl+O. Tool
cards went the other way: a completed `bash` printed its head and up to five
body lines, a `grep` its first matches, a generic result its first lines —
so the transcript filled with output the person skims while the thinking
they read was hidden.

Grok Build, the surface codsh's chrome already borrows its block palette from
(`bg_thinking`, `bg_dark`, the sticky header, the timeline), does the reverse:
thinking blocks stream in the scrollback (`show_thinking_blocks`, default on),
tool calls are one-line rows with a status glyph that expand on demand, and
runs of finished rows — reads, searches, and finished thoughts among them —
fold together as the conversation moves on (`group_tool_verbs`, default on).

## Reference (Grok Build)

Read from the pager crate's user guide and configuration reference at
`crates/codegen/xai-grok-pager/docs/user-guide/` (05-configuration.md,
03-keyboard-shortcuts.md) on 2026-09-14:

- `show_thinking_blocks = true` — "show agent thinking blocks in the TUI".
- Tool calls are one-line rows with a status glyph; expanding a row shows the
  command's output or an edit's inline diff. `[scrollback.display]
  expandable_indicator = true` marks foldable entries.
- `group_tool_verbs = true` — "fold runs of read/search/list tool calls and
  subagent rows — and finished thoughts among them — into one row".
- `[scrollback.display] anchor_on_fold = true` keeps a block's position when
  it folds; `respect_manual_folds` (opt-in, default off) keeps a person's own
  fold choice through streaming. codsh already has both, the second on by
  design: `setFold` holds the reading position and the Fold preference
  survives moving on.
- A finished thought keeps a three-line preview when collapsed
  (`[scrollback.blocks.thinking] truncated_lines = 3`); the expand indicator
  on foldable entries is `›` (`expandable_indicator_char`).
- Keys, in Vim mode: `e` toggles the selected entry, `E` expands or collapses
  all, `Ctrl+E` toggles every thinking block; simple mode uses Left/Right, and
  a click selects an entry. codsh keeps its own gestures — a click works the
  block under the pointer, Ctrl+O works them all. Grok Build is the
  owner-selected reference for this surface change, case by case
  (docs/alignment.md, "Grok Build case by case"); ADR-0001's Claude Code
  tie-break is what this row deliberately overrides, and the Alignment Matrix
  records it.

## Solution

1. **Thinking streams as a head, then lands folded.** The first reasoning
   delta puts a single magenta `│ thinking…` row in place — without vertical panel
   padding, and on a TTY a Braille spinner that ticks in place —
   and the line still being typed stays in the live region under the box.
   The working line names the thought `thinking` until it lands. Finished
   deliberation lines are not appended to the transcript while it runs.
   When the thought ends, the head becomes the clock (`thought for 3.2s`,
   later `· total 4.1s` when the step ends) and the block is registered as
   a Fold that is **collapsed** and **automatic**. The clock stays one row
   without a panel fill; only an expanded Fold retains the panel's vertical
   padding and fill. The head, and so the clock, is a caption: it takes no
   blank of its own, sits flush under the row before it, and the block that
   follows — a card, the answer — opens none under it.
2. **Moving on folds it.** The next turn spent — a prompt, or a canned
   command that expands into one — collapses an automatic open thought to its
   clock row, exactly as the Fold preference already says for fresh-output
   states; a thought the person folded or re-opened by hand keeps that form
   across later turns. An empty Enter, a command that only works the chrome
   (`/status`, `/help`, `/ui`), and a `!` line spend no turn and fold nothing.
   Replay creates collapsed thinking folds — history is what a resumed
   session reads back through — and returning from a Child view is a replay.
3. **Every tool card is one row.** A completed call is
   `● title · stats ✔` (or `✗`) — the success bullet is dim, the trailing
   `✔` stays green — and the whole body — command output, search
   hits, read content, diff hunks, a generic result's text — lives in the
   fold. Any two TTY blocks are one blank apart: the first card of a run
   opens with a blank unless the transcript already ends on one, the cards
   inside a run stack flush — a failed row keeps its place in the run — and
   a runner notice or an answer landing under a run opens with one too,
   though none under a thought clock; a pipe still closes each card with a
   blank. The stats segment says what the row withholds: `+n -m` for a diff,
   `N results` for a search, `N of M lines` for a read, and for a terminal or
   generic result a new `· N lines` count of everything behind the row — the
   description a terminal call came with included, so the count and the
   hover readout agree. A pending terminal call is one row
   too (`● command (cwd)`, pending bullet), so the finished row takes its
   place without the card growing and shrinking. A run of similar cards is
   `● title · N similar ✔`; a burst of unpaired results is
   `● (result) · N results`. A subagent card keeps its `click to enter` row —
   that is a door, not a body. A failed row also names its reason: the first
   line of what came back rides in the stats segment, cut to half the width,
   so a column of `✗` rows still says which file was missing or which call
   was refused; a terminal failure keeps `(exit N)` and its count instead.
4. **Ctrl+O and a click are unchanged.** A click works the block under the
   pointer; Ctrl+O works every fold, and the direction follows what the
   blocks show: it opens whatever is folded, and folds everything once
   nothing is. With an open thought and a collapsed card on screen the first
   press opens the card, the next folds both — a click is the gesture for
   folding the one thought. The hover readout names an open thought as
   `thinking · N lines · click to expand` when folded, or `click to fold`
   when open, and a collapsed card as
   `title · N lines · click to expand`, where N is what the block withholds —
   the same figure the card's own row carries — and a door names no count.
5. **A pipe gets the digest.** Off a terminal there are no keys to expand
   with, so redirected output keeps the clock row and the one-line cards, as
   it does today.
6. **Density loses one axis.** `/ui comfortable` no longer has a two-line
   thinking preview under the box — finished lines are in the transcript for
   both densities. Comfortable keeps its blank row between turns and its
   higher click-to-pager threshold on expanded diffs.

## Grill Decisions

1. **An open thought closes when the conversation moves on, not when it
   finishes.** Grok Build's `group_tool_verbs` folds finished thoughts into
   one row with the tool rows around them as the conversation goes on; codsh
   keeps the whole turn's deliberation readable until the next turn — the
   person asked for thinking *shown*, and a thought that vanishes the instant
   the answer starts is not shown — and reuses the Fold preference's
   moving-on rule rather than inventing a third timer. Moving on is a turn
   spent, never an empty Enter or a chrome command: a nudge on Enter while
   reading must not fold what is being read.
2. **The collapsed thought stays the clock row.** Grok Build keeps a
   three-line preview (`truncated_lines = 3`); codsh keeps `│ thought for Xs`
   so the hover readout, the replay contract, and the sticky/timeline row
   arithmetic are untouched. A collapsed thought is one a person has moved
   past; the clock says how much was there.
3. **Failures collapse too, and say why.** A failed call is still one row:
   `✗`, the error rule down its edge, and the first line of the reason. The
   body is a click away. One rule for every card beats a special case that
   makes the transcript's shape depend on outcomes — and an agentic loop's
   retries are exactly the failures a person skims — but a column of `✗`
   rows that all look alike would say nothing, so the row carries the reason.
   A non-zero exit or a kill is a failure to the row even when dsh reports
   it without `isError`: the model still decides how to react, but the card
   paints `✗` and the error rule, and says `(exit N)` or
   `(killed by SIGTERM)` beside the count. A green tick on a failed command
   is a lie.
4. **No new key.** Grok Build's `e`/`E`/`Ctrl+E` map onto codsh's click and
   Ctrl+O; Ctrl+E is end-of-line in the box and stays that.
5. **`●` stays the bullet; the count is the affordance.** Grok Build draws a
   `›` on foldable entries. codsh's cards already carry the Claude-shaped
   `●` with a status glyph — dim on success, red on failure — and every row
   that withholds a body now says how much (`· 12 lines`); the hover readout
   says what a click does.
6. **Pipes keep the digest.** A script reading `codsh -p` output wants the
   answer, not the deliberation or a command's output; the clock row and the
   one-line card are what it gets, unchanged.
7. **The rail is always `│`.** Colour — not a different glyph — says what
   the row is. Uncoloured terminals still draw `│` down the clock, the pads,
   and the deliberation so the connecting line does not break.
8. **The step total finds its block by identity.** The collapsed clock is a
   prefix of the open block, so the screen must never search its rows for a
   summary to update; `updateFold` finds the Fold by the forms it was given
   and swaps whichever it is showing.
9. **A row written into a streaming thought does not split it.** The update
   check can answer while the first thought streams, landing its notice
   between two deliberation lines. The finished block then finds its rows
   where they stand, takes them off, and lands whole at the tail under the
   notice — never twice.

## User Stories

1. **US-1**: As a person watching a reasoning model work, I see a
   `thinking…` head tick while it runs, then a clock when it ends, with
   the deliberation behind a click or Ctrl+O while the tool calls and the
   answer follow it.
2. **US-2**: As a person reading a long session, an earlier turn's thoughts
   are one clock row each, and a click on the clock opens the one I want.
3. **US-3**: As a person skimming a turn, every tool call is one row that
   says what it did and how much it produced; a click or Ctrl+O opens the
   output when I need it.
4. **US-4**: As a person who folded a thought or opened a card by hand, that
   choice survives the next turn; only what I never touched folds away.
5. **US-5**: As a script piping `codsh -p`, I get the same terse digest as
   before: a clock row for thinking and one row per tool call.

## Implementation Decisions

1. **`packages/bundle/src/transcript.ts`**: `outcome()` returns an empty
   shown body and the full body for the fold whenever the result has one; the
   head's stats gain a `· N lines` count for terminal, generic, and orphan
   results; the pending terminal card is one row; `absorbSimilar` and the
   orphan run drop their hint rows; `capBody`/`fit`/`MAX_RESULT_*` go, with
   the diff pager threshold kept as a plain predicate. New helpers
   `thinkingOpenRows(theme, frame?)` (the streaming head and its rules; the
   optional frame is the same Braille cycle as the working line) and
   `thinkingLineRule(theme)` (the rule one streamed deliberation row carries).
2. **`packages/bundle/src/streaming.ts`**: `ThinkingTracker` records the rows
   the surface has painted for the thought in flight (`markPainted`,
   `replacePainted` when the head ticks) and hands them back with the flush,
   so the finished fold can take their place.
3. **`packages/bundle/src/screen.ts` / `console.ts`**: `appendFold` takes an
   `expanded` flag; an expanded fold shows its full form from the start and
   is automatic (moving on collapses it). A block that takes the place of
   already-printed rows holds a scrolled reader where they were.
   `updateFold` finds its block by identity and swaps the form it shows. The
   hover readout counts what a block withholds. Off a terminal the summary
   is written regardless.
4. **`packages/bundle/src/index.ts`**: `paintStreamChunk` puts the head on
   the first reasoning delta — on a terminal only — names the working line
   `thinking`, and ticks the head in place until it lands; the live line
   stays under the box; `landThinking` replaces the painted head with the folded
   clock; `flushThinking` (interrupt) shares the path; `collapseFolds` moves
   from the read loop into `answer()`, so only a turn spent moves on;
   entering and leaving a Child view resets the parent's tracker; the
   comfortable two-line preview is gone.
5. **`packages/bundle/src/density.ts`**: `thinkingStreamPreview` removed.
6. **Docs**: both READMEs, CONTEXT.md (Fold, Fold preference, Card run, Hover
   readout), docs/alignment.md (a new row recording the reversal of the
   thinking-collapse alignment with Grok Build as the reference), a minor
   changeset.

## Testing Decisions

- **Unit**: transcript.spec (one-row cards, counts, pending row, similar and
  orphan runs, fold contents, thinking clock rows, unhighlighted tool
  rows, dim success bullets, TTY run gaps, ticking thinking head), streaming.spec (painted head through
  push/flush/reset, replacePainted), screen.spec (folds, collapse on moving
  on, manual choice kept, replace-in-place, in-place thinking-head ticks,
  Ctrl+O direction with mixed folds), console.spec (pipe digest),
  density.spec.
- **PTY e2e** (`pty-folds`, `experience-navigation`): thinking lands folded
  under its clock; a click on the clock opens it and a click inside folds
  it; Ctrl+O opens a folded thought; moving on leaves it folded; a hand
  choice survives the next turn; a
  terminal card is one row that opens on click and on Ctrl+O; a failed call
  is one `✗` row; a thought followed by a tool call and another thought keeps
  both open and the card closed; replay restores collapsed folds; the hover
  readout names each form.
- **Pipe e2e**: the digest is unchanged.
- **Mock modes** (`e2e/fixtures/mock-llm.src.ts`, regenerated into
  `mock-llm.mjs` with `node:module`'s `stripTypeScriptTypes`): `reason-write`
  — a thought, a `write`, a second thought, an answer, all in one turn; `fail`
  — a `bash` call that prints one line and exits 3.
- **Answers to `ask_user_question`** fold like any generic result: the
  batch already writes one summary line per answered question into the
  transcript when it settles, so the card need not repeat them.
