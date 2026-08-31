# codsh-bundle

## 0.10.0

### Minor Changes

- 7bd477d: Add an interactive right-side conversation timeline with turn previews and click navigation.
- a3eaaa3: Add stable assistant answer and fenced-code addresses with an interactive `/copy` selector and exact raw-content clipboard output.
- 2098dfc: Add a resize-safe `/view` reader for assistant answer and fenced-code content addresses with exact viewport restoration.
- 08bee80: Keep explicit click and Ctrl+O fold choices across streaming and later turns while newly created and replayed folds retain their automatic defaults.
- 7fe31a3: Place newly submitted prompts at the top of the interactive viewport while streamed replies fill beneath them. The reserved space scrolls with the transcript, so reading back and returning to the tail lands on the anchored frame again.
- 98c7e4d: Move the scrollback notice to the foot of the viewport and make the row a click that returns to the latest.
- 5ea12b6: Add semantic conversation navigation in the interactive TTY: Shift+Left and Shift+Right move between real user turns, while `/jump` provides a searchable preview that restores the previous viewport when cancelled.

## 0.9.0

### Minor Changes

- 78a570b: User prompts now become sticky turn headers in the interactive TTY, keeping the prompt that owns the visible response at the top while long conversations scroll. Long prompts fold to three rows, can be expanded by click or Ctrl+O, and preserve the existing transcript, search, copy, resize, replay, and pipe behavior.

## 0.8.0

### Minor Changes

- 741bcfe: DeepSeek Flash and Pro now read pasted images automatically: codsh asks `deepseek-v4-flash-vision-exp` for a one-shot description, then gives that text to the still-selected conversation model and tells it to answer directly from the visual context without a no-image disclaimer. Explicit `CODSH_VISION_*` sidecars keep priority, and vision failures still fall back to the saved image file.

## 0.7.0

### Minor Changes

- b1a6845: `!cmd` runs in your shell, prints the command plus its output into the session, and the agent spends a turn on the result.
- b1a6845: First-week surface alignment: Ctrl+R history search, Ctrl+F transcript find, type-to-filter `/model` and `/resume`, `?` shortcuts overlay, an activity-aware working line, and Escape to take back a queued message.
- b1a6845: `$` searches user-invocable skills the way `/` searches commands. Pick one and it stays in the prompt; submit rewrites known `$name` tokens into the `/name` gesture dsh injects.

### Patch Changes

- 70c89be: Lay chrome and the live line out to the same content width as the viewport, so the left gutter cannot put an ellipsis on every box row or wrap output into the input.
- b1a6845: Completion matches a fragment anywhere in the name, not only a prefix. The menu sits above the box so opening it cannot lift the prompt. A finished `/command` or `$skill` is coloured in the box.
- 70c89be: A click on a running subagent card enters that child's transcript; Esc returns to the parent.
- b1a6845: Hover no longer jumps the input box: the readout borrows the hint or status row instead of adding one. The block under the pointer fills like opencode's panel, so the paragraph is obvious without underlining every letter.
- b1a6845: The first screen paints the current mark: a › chevron, a hull, water, and a whale tail.
- 70c89be: The completion menu floats over the transcript instead of growing the chrome, so opening candidates cannot shake the output.
- 8e07c5a: `/ship` now grills as a design-tree frontier, then synthesizes the spec and tracer-bullet tickets without another interview, and lands them test-first at the spec's seams.
- b1a6845: The status row re-fits when the terminal is resized. A previously truncated line grows back instead of staying stuck with an ellipsis.
- 09b8703: Inset every painted row two columns from the window edge, so transcript text is not flush against the frame.

## 0.6.1

### Patch Changes

- 5ada92a: Sync `@deepseek-ai/dsh-*` to 0.1.1-rc.2 so the published
  `deepseek-v4-flash-vision-exp` route accepts pasted images as first-class
  attachments. Resolve the current model's exact modalities at submission time
  so a startup or stale catalog cannot misroute them; keep the file and optional
  sidecar fallback for text-only models.

## 0.6.0

### Minor Changes

- b253686: Ctrl+V pastes an image, even into a model that only reads text. The surface
  reads your system clipboard itself — an image has no way in through the
  terminal — and attaches it behind an `[Image #N]` token in the box; one
  backspace removes the token whole, and deleting it drops the image.
  
  What happens at submit depends on the route. A model whose catalog declares
  image input (set `inputModalities: [text, image]` for your model in
  `$DSH_HOME/settings.yaml`) receives the image as a first-class attachment
  block through dsh's durable store, downscaled only as far as the store's
  admission limits demand; `/plan` and `/goal` accept images there too. The
  default DeepSeek routes are text-only, so there the image is saved to a
  content-addressed file under `$DSH_HOME/attachments/pasted/` and the model is
  told its path and dimensions — the agent can still open, commit, or transform
  it with its tools. And when `CODSH_VISION_BASE_URL` + `CODSH_VISION_MODEL`
  (plus optional `CODSH_VISION_API_KEY`) name any OpenAI-compatible multimodal
  endpoint, that sidecar describes the image — everything in it transcribed
  verbatim — and the description rides the same message, standing in for sight.
  A sidecar failure never loses the turn: it flashes, and the text still goes.
  
  The transcript shows the token and a dim meta line saying what became of each
  image (`[image #1 · 2880×1800 png · described]`) rather than pages of
  machine-facing context, on resume as well as live. `CODSH_CLIPBOARD_IMAGE_CMD`
  overrides the platform clipboard reader, which is how the tests drive the
  whole path without touching a real clipboard.
- 6ac05fc: `/ship` now lands reliably, not just intently. The spec file becomes the
  workflow's durable memory instead of the conversation: the approved plan is
  written into it as milestone checkboxes, a `Status:` line names the phase, and
  a bare `/ship` first offers to resume any unfinished spec it finds — an
  interruption, a `/clear`, or a compacted context loses nothing.
  
  Green is grounded rather than asserted. Before any implementation code the
  working tree is checked clean and the plan's proof commands run once to record
  the baseline — a suite that was already red surfaces at the gate, not under
  the diff. Every acceptance criterion must name the exact command that proves
  it; each milestone is committed when it turns green; and after a fresh-agent
  Ralph loop returns, the session re-runs every proof command itself — the
  loop's word is a report, not a verification. The loop is bounded (about three
  rounds per milestone) and told to stop and report rather than spin past two
  consecutive rounds of no progress.
  
  Pasted images are requirements material now that Ctrl+V exists: a mockup or
  screenshot riding the `/ship` message is read and cited in the interview.

## 0.5.0

### Minor Changes

- 3563a53: Collapsed blocks answer the mouse. A click on a fold — a collapsed thought, a
  clipped tool result, a finished answer past a screenful — opens that one block
  where it stands, and a click anywhere inside it folds it back again; Ctrl+O
  keeps working every block at once. A click is a press that never moved, so
  dragging still selects and copies exactly as before: text you sweep over to
  read or copy is a drag, and never collapses under the pointer.
  
  Opening a block no longer throws a reader back to the tail either: the rows
  above the block keep their screen positions while it grows or shrinks below
  them, so a block opened halfway up the history stays where it was clicked. The
  affordance names both gestures now — `… +25 lines (click or Ctrl+O expands)`.
- 59efe88: A resumed session's history is foldable again. Replay used to write the log out line by line, so a long tool output came back as the summary line that promises `Ctrl+O expands` with no fold behind it — the key answered nothing and the output was unreachable for the rest of the session. Replay now rebuilds the same folds the live turn built: collapsed tool bodies keep their full form behind Ctrl+O, a long answer folds to its head lines and a count, and thinking — which is in the log but not in the transcript's visible text — comes back as the one dim `✻ thought` line it was, with the deliberation behind the key. Live and replayed blocks share one summary builder, so the two paths cannot drift.
- 12373b9: The transcript answers the pointer resting on it. A collapsible block now
  marks itself while the pointer is over it — its head row underlined, the way a
  hovered link reads — and the chrome row under the box names it: what the block
  is, how many lines it holds, and whether a click would open or fold it
  (`thinking · 42 lines · click to expand`, `Bash(pnpm test) · 120 lines · click
  to fold`). Move off and the row goes back to whatever it was saying.
  
  The readout is what covers the case the mark cannot: a block taller than the
  screen has no head row in view, and its name is the only thing that can tell
  you which segment you are in. Both appear without a click, so a clickable block
  is no longer a target you find by hitting it.
  
  This turns on any-motion mouse reporting (mode 1003) over the button tracking
  already in use, keeping the drag that selects on terminals that speak only the
  older mode. Motion is a report per cell crossed, so the frame is touched only
  when the block under the pointer actually changes.
- 6aa42ab: Each transcript block now carries a rule down its left edge, so segments are told apart at a glance in a long history: the person's own message gets the heavy mark, a tool block the light one — in the error colour when the call failed — and what a person actually reads, an answer or a thinking summary, stays flush so the rules mark the machinery around it rather than everything equally. The rule repeats on every row a line wraps to, the blank line between blocks stays unmarked, and a selection that sweeps across a rule hands back the text without it: the mark is chrome this surface drew, not something anyone typed. Both references converge on a left border for this (Claude Code's `borderLeft`, opencode's `border: ["left"]`); the background fill opencode layers on top stays out, because the terminal's background is the theme's to decide (ADR-0001).
- 80c1c5d: A new built-in, `/ship <one-sentence requirement>`, drives an idea from 0 to 1 with exactly two approvals: a research-grounded interview (one ask_user_question at a time) ends in a spec file you confirm, then an implementation plan you approve — and from there the agent lands the feature autonomously, small plans implement→test→fix in-session and large ones through the ralph fresh-agent loop with the spec on disk as cross-round memory, until the spec's acceptance criteria pass with actually-run tests. Run it bare and it asks for the sentence first. `ship` joins the reserved built-in names: a custom `ship.md` command file is now skipped with a startup warning instead of loading.
- 18bd80f: Todos now have a display that outlives the write that produced them. A pinned readout sits in the chrome directly over the status row for as long as a list is live: progress (`1/3`), the item in flight — or, between items, the one coming next — and `✔ all done` when the list is finished. Ctrl+T opens it into the whole list and closes it again, the way Ctrl+O swaps a fold; `/todos` prints the same list into the transcript, which is how the pipe shape reads it with no chrome and no keys. Both read the session's `todos` projection, so `--resume` reopens on the list it left off with, and one renderer now serves the readout, the transcript card, and `/todos` — the card's header gained the state breakdown (`todos 1/3 · 1 in progress · 1 open`) as a result.

### Patch Changes

- 0d5598f: Plan mode no longer kills the session. `/plan` and Shift-Tab crashed the app
  outright — `Cannot read properties of undefined (reading 'length')` from inside
  the harness's plan-mode plugin — for anyone whose profile resolved the newer
  plugin against an older runtime, which a fresh install did by default.
  
  The cause was a version split, not a bug in either half: every
  `@deepseek-ai/dsh-*` range was a caret on a prerelease, which admits the next
  `rc`, so a lockfile-free profile install picked up `0.1.0-rc.8` plugins while
  the launcher found an `rc.7` runtime — and rc.8's command registry passes an
  image-attachment batch that rc.7 never did. Every dsh range is now on rc.8, so
  the pair matches, and the surface passes the empty batch a plain slash command
  carries.

## 0.4.0

### Minor Changes

- eb136e9: The session now reads two terminal reports the other agent CLIs read. Focus (mode 1004): the bell rings only while the terminal is unfocused — a person already looking at the screen needs no call-back — and terminals that never report focus keep the always-ring behavior. Background color (OSC 11, asked on entry the way opencode and Codex ask): a light answer swaps the secondary-text gray for a shade that stays readable on white, while base ANSI colors remain the terminal theme's to map.
- 1fb7a09: codsh speaks the kitty keyboard protocol, the way Claude Code does: the disambiguate flag is pushed on entering the session and popped on leaving, so on capable terminals (Ghostty, kitty, WezTerm, iTerm2, foot) Shift+Enter breaks the line, Esc reports without the ambiguity timer, and control chords arrive unambiguously. Terminals without the protocol are untouched — every legacy sequence still decodes, and Alt+Enter keeps working everywhere.

## 0.3.0

### Minor Changes

- 91291bc: The package is split so a machine never carries a second dsh. `codsh-cli` is now a zero-dependency launcher a few kilobytes big: it finds the dsh you already have (`DSH_BIN`, a resolvable `@deepseek-ai/dsh`, or `dsh` on PATH), registers the runtime — now published as `codsh-bundle` — into the `code` profile, migrates pre-split profiles off the old fat layout automatically, and upgrades the bundle when the launcher upgrades. Fresh machines install `@deepseek-ai/dsh` alongside; everyone else stops downloading ~300MB they already had.
