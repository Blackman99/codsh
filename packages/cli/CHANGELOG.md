# codsh

## 0.22.2

## 0.22.1

### Patch Changes

- 7921f65: chore: sync `@deepseek-ai/dsh-*` (and co-released cordis packages) to 0.1.5-rc.1

## 0.22.0

## 0.21.0

## 0.20.0

### Minor Changes

- 6c563bb: `/ship` now follows the grill-me skill as a contract: recon first, batched frontier rounds with recommended answers, the `ship · grill` header, and an exhaustion handshake before the spec.

## 0.19.0

### Minor Changes

- bb29725: `/ship` now follows the to-spec, to-tickets, and tdd skills as contracts: exhaustive stories, vertical tickets with a DAG and per-ticket acceptance, `.scratch/` plus tracker when configured, and red-first landing.

## 0.18.3

## 0.18.2

## 0.18.1

## 0.18.0

## 0.17.12

## 0.17.11

## 0.17.10

## 0.17.9

## 0.17.8

## 0.17.7

## 0.17.6

## 0.17.5

### Patch Changes

- 0b90398: feat(tui): show execution duration on completed tool cards
  
  Tool cards now report their start-to-finish execution duration in the headline (e.g., `● Read a.ts +1 -1 · 1.2s ✔`), matching the visibility previously only available for thinking blocks. Additionally, the expanded thinking block now indents its reasoning text to provide breathing room from the background panel border.
- 17962ad: feat(tui): track entire turn duration at the thinking line instead of individual tool calls
  
  Tool card duration statistics have been reverted. The completion time of the entire assistant output turn (from starting execution to final output settling) is now presented collectively as a single unified `· total Y.Ys` suffix appended to the `thought` line itself.
- 7689efa: fix(tui): restore background border and symmetric inner padding to thinking summary
  
  The collapsed `thought` summary now re-integrates its background block to match other panels but with top and bottom inner padding directly embedded (expanding into a symmetric 3-row block when isolated). This properly isolates the thought text from touching adjacent block borders while still maintaining the intended structural boundary constraints of the user interface.

## 0.17.4

### Patch Changes

- a463eb5: fix(screen): accurately hover and select individual tool cards in joined runs
  
  When multiple consecutive tool calls joined a single panel, the preceding fold's closing padding was replaced in the logical buffer without updating the fold's length. This caused earlier folds to overlap subsequent cards, making mouse hover and click always span two or more rows. Screen fold tracking now truncates superseded folds and strips ANSI escapes when measuring effective fold ranges, ensuring each tool card is individually hovered and selected.
- 81d4d20: fix(tui): vertically center thinking line between consecutive tool runs
  
  The one-line summary for a thinking block now correctly checks if an active tool run preceded it and prepends a blank line if so, preventing the thinking line from appearing visually glued to the bottom padding of the previous tool's output.
- 8340962: fix(tui): restore bottom margin for thinking summary preceding assistant text
  
  The background-less thinking summary relies on the top margin of the subsequent block for its bottom spacing. When the thinking block was immediately followed by assistant text (which normally omits leading margins if not preceded by a tool run), the text appeared visually attached to the thinking line. Assistant text now correctly prepends an unstyled blank line if its message also contained a reasoning block, ensuring the thinking summary remains perfectly centered.
- e0d84f2: fix(tui): remove background color from thinking summary to balance vertical spacing
  
  The collapsed one-line summary for a thinking block now uses the default terminal background instead of `bgThinking`. Removing the background color allows the line to serve as a natural unstyled separator between the padded background blocks of the tools preceding and following it, effectively shrinking the excessive gaps and perfectly centering the clock line.

## 0.17.3

### Patch Changes

- 20f9e41: feat(ship): reliable delivery with branch isolation, TDD proof logging, cascading re-verification, and dual-layer DoD
  
  The `/ship` command workflow now enforces comprehensive reliable delivery:
  - Phase 0 pre-flight working tree check (`ship · preflight` prompt) and automatic feature branch isolation (`ship/<slug>`).
  - Extended spec Markdown metadata (`Branch:`, `Base-Commit:`, `Original-Branch:`) and verification log parsing.
  - Cascading re-verification on resumption, gracefully degrading state when past steps fail before continuing.
  - Anti-cheating mechanical TDD proof logging (capturing non-zero exit code failure logs before implementation) and single clean commits per ticket.
  - 3-strike circuit breaker per ticket escalating persistent failures to human guidance.
  - Phase 5 dual-layer DoD verifying acceptance criteria exit code 0 and zero new repo failures against baseline.
  - Post-ship delivery modal (`ship · deliver`) for merging back, generating PR push commands, or remaining on the branch.

## 0.17.2

### Patch Changes

- 5c4604b: fix(tui): compact consecutive tool cards into a single shared panel
  
  Intervening non-printing events during multi-step turns (such as `step/start`, `step/end`, and text-free `assistant/message` events) prematurely cleared the active tool card run. This caused consecutive one-line tool cards (such as repeated `read` or `grep` operations) to each render in separate panels with extraneous blank padding lines between them. The active tool run now persists across non-printing events so that consecutive tool cards share a single compact panel without gaps.
- 5441184: fix(tui): preserve /status column alignment and prevent card headline truncation on tiny screens
  
  Adjust the session elapsed time label in `/status` to `time` so maximum label width does not exceed 11 columns, preserving column alignment. On narrow viewports, ensure short tool card titles avoid premature truncation.
- 2c5f9ac: fix(tui): accurately calculate thinking duration from step start to handle buffered reasoning deltas
  
  When model providers or proxies buffer reasoning tokens and deliver them in a single burst or delta late in a step, measuring elapsed thinking time only between chunk arrivals resulted in inaccurate durations (such as 0.1s). Deliberation timing now anchors to step start and concludes when reasoning finishes or subsequent text/tool calls begin.
- 22e75fb: fix(tui): prevent tool card headline overflow and unexpected line wrap
  
  Tool card headlines previously truncated against raw terminal columns (`io.console.columns`) rather than viewport content columns (`io.console.contentColumns`). Because content columns account for left gutters and terminal padding, truncated headlines exceeded the screen's wrap boundary by several columns, causing trailing status glyphs (`… ✔`) to wrap onto an unintended second line. Transcript now reads content columns dynamically so card headlines always stay strictly on a single line.
- 7eced9d: feat(tui): improve markdown code block presentation with rich syntax highlighting and clean padding
  
  Enhance code block rendering with IDE-grade syntax highlighting (function calls, types, properties, constants, keywords, strings, and numbers). Add top and bottom padding within code blocks and ensure appropriate vertical margins separate code blocks from adjacent text and list items.
- 0ef8149: feat(tui): display cumulative session duration in turn summary and /status
  
  Display cumulative session elapsed time alongside turn duration in the turn footer when multiple turns have run (`15s (thought 4.2s) · session 4m 30s · 3.2k tokens`). Also report session duration (including active execution time) in `/status`.

## 0.17.1

### Patch Changes

- 309cbb0: fix(tui): separate intermediate blocks and following text output with a blank line
  
  Ensure a blank line separates intermediate blocks (such as tool cards) and the assistant's text output, preventing text from rendering flush against the preceding block's bottom border.
- 47170cc: feat(theme): darken soft amber highlight for lower visual glare and improved contrast
  
  - Adjust amber highlights (`warn`, `tool`, `pending`) from bright `#ffaf00` (ANSI 214) to a deeper, warm amber `#d78700` (ANSI 172) in dark mode to reduce eye strain and glare.
  - Darken light mode amber highlight from `#d78700` (ANSI 172) to `#af5f00` (ANSI 130) to preserve text contrast against light backgrounds.
- c941e14: fix(tui): remove phantom comfortable density idle tip causing status bar multi-line wrapping
  
  Remove the comfortable density idle tip (`⇧Tab plan · Ctrl+T todos`) under the prompt box. The tip rendered as an unexpected extra line on startup and when idle, appearing as a broken multi-line wrap above the MetaBar status line that disappeared upon typing and caused chrome height jumping.

## 0.17.0

### Minor Changes

- a869d7c: feat(tui): preview a pasted image with the terminal's own graphics protocol, and stop the card corrupting the surface
  
  The preview card came up as an empty box in Ghostty and took the rest of the frame with it. Two causes, both fixed:
  
  - **The wrong protocol was being sent.** Ghostty, kitty, and WezTerm implement Kitty graphics and ignore `OSC 1337 ; File=`; iTerm2 is the other way round. Sending the wrong one fails silently — the payload is swallowed and the card is blank. The protocol is now read off the terminal: Kitty graphics (`APC _G`, chunked, `C=1` so a placement cannot scroll the layout, `q=2` so the terminal's reply never arrives as keystrokes) for the first three, `OSC 1337` for iTerm2. A multiplexer forwards neither, so inside tmux or screen no graphic is attempted at all.
  - **The payload was being cut into a row.** Base64 image bytes inside a card row measure as tens of thousands of display columns, so the row fitting cut the escape mid-sequence and dropped its terminator; the terminal then ate every following sequence as string data, which is what smeared the frame across the prompt. The card now reserves blank cells and the frame paints the picture over them at an absolute position — a graphic travels beside the rows, never inside one.
  
  Also in this change:
  
  - **No native image decoder is loaded in the TTY process.** Pixel dimensions come from a pure-JS header parser (PNG, JPEG, WebP, GIF), and the half-block mosaic used by terminals without a graphics protocol is resampled in a short-lived child process. Loading sharp here pulls libvips in, and with a second copy reachable — a checkout and an installed profile each resolving their own, the normal development shape — the macOS Objective-C runtime prints a `GNotificationCenterDelegate` duplicate-class warning straight to file descriptor 2. There is no JavaScript hook on that write: it lands on the terminal, over a frame the surface believes it owns.
  - **The card fits the viewport.** It is sized against the rows the chrome leaves rather than the terminal's own height. Measured against the terminal, its caption and bottom border fell off the bottom while the picture kept the space.
  - **Centered, near-fullscreen, and uncropped** — the whole picture in frame rather than a centre cut of it.
  - **Ctrl+O, or a click on the card, opens the original** in the platform viewer (Preview.app, `xdg-open`, `start`). When the card closes, a Kitty placement is deleted by id: it is not cell content, so clearing the rows it covered would leave the picture on screen.

### Patch Changes

- 8069e7c: docs: show the surface as it is now — captures, banner, and the gaps in between
  
  The pages described a surface two months of UI work had moved on from, and the
  pictures were worse than the prose: the site's terminals were captured before
  the panel work landed, and could not have shown it anyway.
  
  - **The site's captures can show a panel.** The terminal model behind them
    tracked foreground colour and attributes only, so every background the
    surface paints — the person's own message, a tool run, thinking — was dropped
    on the way out, and the frame generator then read the `2` inside a direct
    colour as *dim text*. A blank cell carrying a fill is ink, not padding, so it
    also survives the trailing-blank trim now. Re-shot: the plum message panel,
    the tool card on its own fill, the collapsed `✻ thought for` row, and the
    timeline rail are all on the page.
  - **The README banner is the current surface**, read off a real capture rather
    than memory — which is how the rules got their colours back: cyan for the
    person, amber for a tool card, magenta for thinking. It had been showing a
    thin left rule where the plum panel goes, a status row of fields that moved
    into `/status` two releases ago, and a placeholder missing half its menus.
  - **`/ui compact|comfortable` is documented**, in both languages. It persists
    across sessions and was written down nowhere.
  - **Inline graphics join the progressive-protocol paragraph**: chosen by what
    each terminal implements, not by what it is.
  - **The development loop matches itself.** `CONTRIBUTING.md` sent readers to
    the README for the `MOCK` modes and `INSPECT=1`, and the README documented
    neither; the mode list in `scripts/dev.mjs` was four modes short of the
    fixture it describes; `pnpm run site:screens` sets `CAPTURE_SCREENS=1` on its
    own and no longer asks to be given it.
- d273a9e: fix(tui): total a turn's thinking time in the footer instead of listing every segment
  
  A turn that stopped to think before each of seventeen tool calls ended on
  `10m 22s (thought 0.9s, 4.2s, 0.1s, 1.1s, 0.1s, 10.0s, 0.0s, 6.0s, 3.8s, 6.1s, 0.1s, 5.1s, 2.1s, 0.0s, 1.1s, 0.0s, 1.7s) · 9.5M tokens`
  — a line of durations longer than some of the answers it summarized, and one
  that said nothing new: every thinking block already carries its own clock, on
  its own summary row, written into the transcript where that thinking actually
  happened (`✻ thought for 4.2s`). The footer now reports the total it belongs
  to instead: `10m 22s (thought 42s) · 9.5M tokens`. A turn with a single
  thinking block reads exactly as it did before.

## 0.16.2

### Patch Changes

- 3d9a685: feat(tui): adopt deep plum background color for user prompt blocks and sticky turn headers
  
  Align the background color of user prompt message blocks (`theme.bgUser`) and sticky turn headers to a unified deep plum / eggplant tone (`#1e1326`, 256-color fallback `#53`) in dark mode, and soft lavender (`#f3eaf6`, 256-color fallback `#225`) in light mode:
  
  - Unifies the visual identity of user prompts in the transcript and when pinned at the top as sticky turn headers, ensuring seamless transition during scrolling.
  - Responds to the user prompt's magenta identity (`--user: #d98ce8` / `›`) with distinct brand visual cohesion.
  - Provides strong contrast and recognizability so turn prompts stand out cleanly from agent answers and tool execution outputs.
  - Supports 24-bit TrueColor with graceful fallback to 256-color palette.

## 0.16.1

### Patch Changes

- 293ebb7: fix(tui): pad transcript panels at their edges, not around every card
  
  Background-filled blocks read as panels only when their text does not touch the
  panel edge — but padding each card separately spent three rows on every card
  that had one line to say, so a batch of reads pushed the answer off the screen.
  
  - Tool cards that follow one another now share one panel: the first pads above,
    the last pads below, and inside the run a card with body rows keeps the pad
    above it as its divider while a bare one-liner takes that row over. Three
    consecutive reads went from twelve rows to five.
  - A card closes on that padding row instead of on a plain blank, so the gap to
    whatever follows is one row rather than two. Piped output is unchanged.
  - The person's own message is a panel too, inset two columns like every other
    block and padded above and below. Its padding wraps the block rather than
    joining it, so the turn's navigation seam, its fold, and its pinned copy stay
    the text that was actually typed — and a submitted prompt arrives with that
    opening row showing rather than pressed against the top of the screen.
  - A collapsed thinking block is one row again. Padding a one-line summary only
    stacked the `✻` the gutter repeats down every row of a block, three deep, to
    say one word.
  - Card heads, thinking summaries and prompt text are inset two columns, lining
    up with the body lines under them and off the block rule beside them.
  - The pinned sticky turn header is a panel too: a padding row of its fill above
    the prompt and one below, then the divider that hands the screen back to the
    transcript. It spends one more viewport row than before.
- 293ebb7: fix(tui): settle a tool call into one card instead of two
  
  A completed card was only allowed to take the place of its own pending card
  when the result happened to be long enough to collapse into a fold. Every
  shorter result — most reads, most short commands — took the path that dropped
  that link, so the finished card printed underneath the pending one and the
  same call appeared twice.
  
  The link itself was fragile too: it removed the last N lines of the transcript
  rather than the pending card's own lines, so an approval note or a second
  call's card arriving in between was what got removed instead.
  
  A finished card now replaces the exact lines its pending form printed, wherever
  they still sit — on the live path, inside a subagent view, and in the replay
  that rebuilds a resumed session.

## 0.16.0

### Minor Changes

- e904c8b: feat(bundle): configurable thinking level via /thinking and /effort commands
  
  - Add `/thinking` command and `/effort` alias to configure reasoning deliberation level.
  - Support interactive selector prompt in TTY, non-TTY listing, direct argument input, and `on`/`off` shortcut toggles.
  - Add per-model thinking preference persistence (`~/.dsh/code-cli-thinking.json`), restoring chosen levels on `/model` switches.
  - Display active thinking level tag in MetaBar status line (`model (effort)`) and detail row in `/status` report.
  - Provide auto-completion for `/thinking` and `/effort` arguments based on model capabilities.

### Patch Changes

- 6d8a5ae: fix(tui): replace pending tool call lines in-place on result, align hover bounds, and improve card margins
  
  - Replace pending tool call lines in-place when the completed tool result arrives, eliminating duplicate pending headers while preserving live in-flight commands and PTY interrupt visibility.
  - Exclude trailing blank separator rows from fold ranges and hover fills, ensuring hover highlights align precisely with card bounds.
  - Add vertical breathing padding to multiline tool results and avoid low-yield folds for 1-2 excess lines.

## 0.15.11

### Patch Changes

- 8e4f52e: fix(transcript): add vertical padding (vpad) and breathing room around functional blocks
  
  - Add vertical padding rows (`vpad`) at the top and bottom of functional blocks (user prompts, tool cards, execution results, thinking deliberation, and code blocks) so text is not pressed directly against block edges.
  - Ensure tool call invocations and completed results are cleanly separated with proper margins.
- df8987a: fix(ci): restore clean line layout and fix viewport background/hover coordinate alignment
  
  - Revert artificial synthetic vpad rows in transcripts that caused line count and turn offset mismatches in PTY and sticky headers.
  - Keep left gutter glyphs clean without inner background wrappers to prevent trailing line truncation anomalies.
  - Align viewport padding and hover fill index coordinates in `Screen.render`.
- f7bc14e: fix(screen): ensure uniform hover fill without resting background text cutouts
  
  - Strip resting background escape sequences when rendering hover fill (`fill`), ensuring uniform, clean highlight across the entire hovered block without dark text cutouts.
  - Order rendering so full-width padding applies before hover fill overlays.

## 0.15.10

### Patch Changes

- 5e0a64d: fix(screen): pad functional background rows across full content width as unified block panels
  
  - Ensure rows carrying functional background colors (user messages, tool execution outputs, thinking blocks, code blocks, and diffs) are padded with spaces across the full content width (`padRowBackground`).
  - Replaces text-only background hugging with seamless, solid rectangular card panels for each functional section.

## 0.15.9

### Patch Changes

- b4ff674: feat(theme): add Grok color scheme with distinct background colors for functional output sections
  
  - Adopt Grok Build's color scheme with semantic background differentiation across different output blocks:
    - User prompts: elevated background (`bgUser`, Grok `bg_light`)
    - Tool calls and execution results: surface background (`bgTool`, Grok `bg_dark`)
    - Thinking and reasoning deliberation: subtle violet/purple background (`bgThinking`, Grok `bg_thinking`)
    - Error notices and failed tool calls: wine red background (`bgError`, Grok `toolErrorBg` / `diff_delete_bg`)
    - Markdown fenced code blocks: code background (`bgCode`, Grok `md_code_bg`)
    - Diff additions and deletions: green and red backgrounds (`diffAdd` / `diffDel`, Grok `diff_insert_bg` / `diff_delete_bg`)
    - System and meta events: subtle meta background (`bgMeta`)
  - Support 24-bit TrueColor (`COLORTERM=truecolor` / `24bit`), 256-color palette fallback, and adaptive dark/light background switching (`setLight`).
  - Ensure graceful degradation: under `NO_COLOR` or off-TTY, output remains completely unstyled plain text.
- 9acbff5: feat(tui): visually distinguish sticky turn header from agent output with panel background and bottom divider
  
  - Fill pinned sticky header rows with the panel background shade (`FILL_DARK` / `FILL_LIGHT`), adapting to dark or light terminals.
  - Add a muted horizontal divider line (`─`) in the gap row between the pinned sticky header and the scrolling transcript content.
  - Improves contrast and spatial hierarchy so pinned turn prompts are immediately distinguishable from the response text scrolling underneath.

## 0.15.8

### Patch Changes

- ec7e0d3: feat(tui): always show full ASCII logo banner on fresh start and /clear
  
  - Always display the full ASCII whale logo and welcome tips whenever a fresh session is started in an interactive terminal, regardless of prior sessions in the workspace.
  - Redisplay the full ASCII logo banner after a `/clear` command in an ongoing session.
  - Keep skipping the welcome banner when resuming or continuing a previous session (`--resume` / `--continue`).
- ac5f952: feat(tui): atomic image token navigation and automatic image preview overlay
  
  - Treat `[Image #N]` tokens as atomic units in the input editor: cursor navigation (Left/Right, Up/Down, Word, Home/End, mouse clicks) jumps over the token and never positions the cursor inside it.
  - Support atomic forward deletion for image tokens (`delete` key before `[`).
  - Style `[Image #N]` tokens in the input box with accent color (`theme.accent`).
  - Automatically show a floating image preview overlay above the prompt box when the cursor is directly at the left or right edge of an image token, displaying image metadata, dimensions, file size, and half-block ANSI thumbnail.
- 94b2f06: feat(tui): support GFM task lists and ~~strikethrough~~ in Markdown answers
  
  - Add first-class `Theme.strike` method backed by ANSI SGR 9 (`\u001B[9m`), gracefully degrading under `NO_COLOR` and off-TTY environments.
  - Render Markdown task list items natively: unchecked (`- [ ]`, `* [ ]`, `+ [ ]`) render as `○`, checked (`- [x]`, `* [x]`, `+ [X]`) render as `✔` with dimmed, struck-through body text, preserving nested indentation.
  - Render double-tilde inline strikethrough (`~~text~~`) in prose and table cells.
- ac5f952: feat(tui): merge `? shortcuts` hint into bottom status line
  
  - Move `? shortcuts` into MetaBar bottom status line instead of dedicating a standalone row under the input box.
  - Make `Prompt.setStatus` support dynamic column-aware formatting, dropping shortcuts first when terminal columns are constrained before cwd and model.
- ac5f952: feat(theme): replace glaring bright yellow highlights with soft amber on 256-color terminals
  
  - Map `warn`, `tool`, and `pending` highlights to a softer amber shade (`\u001B[38;5;214m` in dark mode, `\u001B[38;5;172m` in light mode) on 256-color terminals.
  - Retain standard ANSI yellow in basic 16-color mode for backwards compatibility.
  - Eliminates eye strain caused by high-intensity fluorescent yellow on dark terminal themes.

## 0.15.7

### Patch Changes

- dd78479: fix(cli): clean redundant profile plugins and invalidate stale dev-home
  
  - Automatically remove redundant `@deepseek-ai/dsh-llm-pi-ai` entries and directories from `~/.dsh/profiles/code` on startup and update, avoiding version conflicts with `@deepseek-ai/dsh-base`.
  - Track `.dev-stamp` in `scripts/dev.mjs` to invalidate and rebuild stale `.dev-home` environments when dsh or bundle dependencies update.

## 0.15.6

### Patch Changes

- 5a0e631: chore: sync `@deepseek-ai/dsh-*` (and co-released cordis packages) to 0.1.2-rc.1
  
  Adapt the terminal surface to the 0.1.2-rc.1 harness APIs: `ToolCallId`, `TodoItem` from `dsh-tool-todo`, `Session.snapshotEvents()`, fork `isSeeded`/`inheritedEventCount`, and the `user-questions/request` waterfall.

## 0.15.5

## 0.15.4

## 0.15.3

### Patch Changes

- ec19e44: An update now moves the whole pair in one command: after installing the new launcher, `codsh update` and `/update` also register the matching `codsh-bundle` into the code profile immediately, instead of leaving the runtime to be registered on the next launcher boot. A profile that launches straight through `dsh` is never left behind, and a pinned development runtime is still never clobbered. The boot-time registration stays as the catch for a runtime a bare `npm install -g codsh-cli` upgrade, or a failed move, left behind.

## 0.15.2

## 0.15.1

## 0.15.0

## 0.14.0

### Patch Changes

- 2737dbd: Keep the registered runtime in lockstep when a dsh profile records `codsh-bundle` as an exact registry version. The launcher now upgrades that stale runtime before boot instead of mistaking it for a development pin and repeatedly showing an update notice.

## 0.13.0

### Patch Changes

- c37eb5c: chore: sync `@deepseek-ai/dsh-*` (and co-released cordis packages) to 0.1.1-rc.2

## 0.12.0

### Patch Changes

- b8a4225: Lead the npm page with what `/ship` does and show the capture, before the launcher's own mechanics. The page is what an npm search lands on, and it opened on the sentence "This package bundles nothing".

## 0.11.0

### Minor Changes

- d615a96: Tell a session when a newer codsh is published, install it on `/update` or `codsh update`, and answer `codsh --version` for the pair instead of the runtime it launches.

## 0.10.0

## 0.9.0

## 0.8.0

## 0.7.0

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

## 0.2.0

### Minor Changes

- 3d0ded4: Mouse selection is back on the alternate screen, the way opencode and Claude do it: dragging with the left button highlights transcript text in place, and releasing copies it automatically — through OSC 52 and the platform clipboard both, with a `✓ copied` toast. `CODSH_CLIPBOARD=osc52|system|off` narrows the channel; Shift-drag still reaches the terminal's own selection.
- c657591: The session is now its own terminal space, the way Codex and opencode feel: codsh takes the alternate screen, keeps the transcript in a scrollback buffer it owns (mouse wheel, PgUp/PgDn, Shift+arrows; a notice shows how far back you are), and pins the input box to the bottom by construction. Your shell's history is untouched underneath and restored on exit, with a short session summary left behind. Every frame paints as a synchronized, row-diffed update, which removes the resize-ghost and overlap bugs of the old in-place drawing wholesale. Piped and `--print` runs are unchanged.

### Patch Changes

- f95b2fa: The input box is pinned to the bottom of the screen — at session start, after Ctrl-L, and after `/clear` — instead of floating wherever output happened to end. Resizing the terminal no longer leaves ghost copies of the box frame: relative erase math is void once a terminal rewraps, so the recovery now clears the old region's estimated rewrapped footprint from an absolute position and redraws anchored to the bottom.
- 39fb667: Thinking is collapsed by default, the way Claude shows it: while a reasoning model deliberates only the current line streams live above the input box, and when the answer starts the transcript keeps a one-line summary — `✻ thought for 12.3s · +40 lines (Ctrl+O expands)` — instead of pages of deliberation. Ctrl+O expands the full thought, sharing the key with collapsed tool output.
- 3f95faf: Six field-reported paper cuts, plus the harness that keeps them fixed. The completion menu and every selector now window around the selection instead of pinning their first page, and the selected row is an accent colour rather than barely-visible bold. The mouse wheel scrolls the right way, one line per event, with a gesture's burst coalesced into a single repaint. The working indicator is one continuous clock for the whole turn — it no longer resets at every step or flickers the layout by appearing and disappearing mid-stream. The welcome screen carries the codsh lettermark at the top and returns after `/clear` (which now actually empties the session's own viewport — as does `/resume`, before replaying). Long tool results collapse to a five-line sliver behind "+N lines (Ctrl+O expands)". A new screen-level experience suite asserts all of this the way a person sees it, so the next rendering change fails in CI before it reaches a terminal.
- 58193eb: Finished answers are collapsible too: a completed answer longer than a screenful streams in the open, then folds to its head lines once the conversation moves on — Ctrl+O swaps every folded block between summary and full form, exactly like the thinking and tool-output folds.
- 5706d5f: Tables are now bordered grids — outer frame, one space of cell padding, and a rule between every pair of rows — so text never touches an edge and a wrapped continuation can never blur into the record below. And collapsing works the way Claude's does: EVERY collapsed block (tool outputs and thoughts alike) keeps both of its forms in the session's own scrollback; Ctrl+O swaps all of them open in place, Ctrl+O again — or simply moving on with the next submission — folds them back.
- 6df1514: Markdown fidelity for what models actually write. Bold or emphasis wrapping a code span now renders both (the backticks and stars are consumed, and the bold survives across the embedded span) instead of leaving raw backticks in headings. Tables keep their shape at any width: cells render their inline constructs, widths are computed from the visible text, and a table wider than the terminal wraps inside its cells — proportionally shrinking the wide columns — rather than degrading to raw pipe rows. The keyless mock now streams a torture sample (wide Chinese table, bold-wrapped code) and the experience suite asserts the rendered screen, so fidelity regressions fail in CI first.
- 026e8b5: Display widths now come from `string-width` — the same width authority cli-table3, ink, and every maintained terminal renderer sit on — instead of a hand-kept range table. The hand-kept table mis-sized emoji-presentation symbols (`⚡` measured one column, rendered two), which sheared table columns whenever a cell carried one. Wrapping, truncation, table layout, and the input box all measure through the one function, with an ASCII fast path for the per-character hot loops.
- 2c1591c: Tables no longer grow ghost columns: the header row defines the column count (as GFM reads it), stray trailing pipes on body or delimiter rows are ignored, and columns empty across every row are trimmed — so real columns keep their width instead of wrapping.
- f03a1fd: Tables whose cells wrap now rule between rows too: a full-width `─┼─` separator under every record, so a wrapped continuation cannot blur into the next row. Compact tables — nothing wrapped — keep only the head rule and stay dense.
- de6cb78: Tables no longer shear apart on screen, and they read like tables. The root cause of the shearing was a one-column budget mismatch: Markdown laid tables out at the full terminal width while the viewport wraps everything at width minus one, so a full-width table row was refolded and its second column dropped to the left margin. Layout now uses the console's single `contentColumns` figure. Styling follows suit: dim `│` rules between columns (wrapped continuation rows carry them too, so they read as part of their column) and one unbroken `─┼─` separator under the whole header instead of a line under the first column only.

## 0.1.0

Initial release: the interactive terminal surface (input box, streaming Markdown with thinking, tool cards, selectors), the `code-cli` agent preset, session flow (`/clear`, `/resume`, Esc-Esc recall, `!` passthrough), canned prompts (`/init`, custom command files), and the `codsh` launcher wrapper over `dsh --profile code`.
