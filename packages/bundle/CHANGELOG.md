# codsh-bundle

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

### Patch Changes

- df39acb: A finished answer stays whole. It is no longer a fold: moving on does not collapse it, a click does not work it, and the pointer resting on it names nothing and paints no fill. Thinking and long tool output still fold the same way.
- df39acb: The approval question names the call, not only the tool: `Allow bash: git push origin main?`, the paths for a file tool. The request carries no arguments, but its call id links to the card the transcript already rendered, so the answer is never blind once that card has scrolled away or folded. Piped, the line reads `? allow bash: git push origin main`, and a denial says what it denied.
- df39acb: A click on the pinned `/ship` plan — or the todo readout — now opens the list and closes it again, the same way a fold works. Ctrl+T still does it from the keyboard. The teaser names both: `click or Ctrl+T opens the list`.
- df39acb: Compaction shows itself. While it runs — automatically under pressure, or on `/compact` — the hint row says `compacting history…` and the working line says Compacting; when it lands, the transcript gets a fold: `✂ compacted 6 history items (~545 tokens) into a summary · deepseek-v4-flash`, with the summary itself behind a click or Ctrl+O. A failed attempt says why. A resumed session replays the fold like any other.
- df39acb: Away from the window, the bell's two moments — a decision waiting, a turn over ten seconds ending — also send a desktop notification naming what waits: `waiting for approval: bash: git push origin main`, `finished in 42s`. The terminal is asked first with OSC 9 (iTerm2, WezTerm, Ghostty, kitty, Windows Terminal); Terminal.app, which ignores it, gets `osascript`; an unknown Linux terminal gets `notify-send` beside it. Focused, nothing is sent. `notify` beside `bell` turns it off.
- 39e0bde: While `/ship` is in grill and the agent asks a frontier interview question (`header` `ship · grill`), a short card sits above the input — recommended option focused, `[y]` take / `[e]` edit / arrows pick, Esc dismisses back to typing without aborting `/ship`. Spec and ticket doors still open GateModal; ordinary `ask_user_question` stays on Selector.
- df39acb: A key legend sits under the box — `? shortcuts · ⇧Tab plan · Ctrl+T todos · Ctrl+O folds` — and stays while you type, where the placeholder used to leave with the first character. It lives on the hint row, so a hint, a copy toast, a find, or a hover replaces it instead of adding a row; the box does not move, and under a selector the row steps aside.
- df39acb: An approval can be remembered. Its third answer, `d`, writes a rule such as `bash(git push *)` to `.dsh/permissions.local.json`, and every later call the rule covers — in this session and the next — is allowed with one dim line naming the rule instead of a question. The prefix is the command's first word, plus the subcommand for git, npm, pnpm, cargo, go, and docker; a tool without a command line is remembered whole; a compound command (`&&`, `;`, `|`, a newline) is offered nothing and never matches a prefix. `.dsh/permissions.json` and `~/.dsh/permissions.json` hold hand-written rules in the same `{ "allow": [...] }` shape, read on every question; a file that does not parse is named once and left alone.
- df39acb: `/rewind` takes the conversation back to before a turn you pick — a searchable picker of your prompts, newest first, or `/rewind 3` — and continues from there. The session log is append-only, so the rewind is a new session seeded with everything up to that point, with the old one as its parent; the old session stays in `/resume`. Esc Esc still recalls the last prompt.
- 713b3d2: Selector, GateModal, and FrontierCard now share one key vocabulary: take (Enter, and `y` on a single-select Selector), edit (`e` when a custom answer is offered), back (Esc), abort (`n`, GateModal only). Approvals paint `[enter] take · [y] take · [esc] back` (take keys green, Esc warn); a question that can take free text adds `[e] edit`. Gate paints `[y] confirm · [e] edit · [n] abort`. Frontier paints `[y] take · [e] edit · [↑↓] pick`.
- 7bfdcd5: While `/ship` runs, MetaBar shows an orientation chip — `ship · grill`, the existing gate warn chips, `ship · land k/n` in the agent colour (a brief ok flash when a ticket turns green), then `ship · verify` and a short `ship · done` before the chip clears. A narrow MetaBar still drops cwd then model first, never the ship chip.
- 86f883b: The pinned todos row is always one line — `todos k/n · ▶ write the fix · Ctrl+T` — and expands to the checklist on Ctrl+T. Escape folds it back without aborting the session.
- df39acb: The box has undo. Ctrl+Z or Ctrl+_ takes the last edit back — a typed word at a time, a paste or a kill whole, a run of Backspace as one — and on a terminal speaking the kitty keyboard protocol Ctrl+Shift+Z brings it back again. A submission starts the history over; Esc Esc still recalls the sent line. `?` lists the key.

## 0.15.4

### Patch Changes

- 755bddd: A tool result line wider than three rows is now cut in the card, marked with an ellipsis and a line naming the expand key, and kept whole behind the fold — the same fold a body longer than five lines already earns. A command that printed an HTML document or a minified bundle on one line used to wrap it to hundreds of rows under a card that promised five.
- 710025f: Resuming a session no longer freezes the surface. Wrapping a styled line was quadratic in its length, so one long tool-result line — a 50,000-character HTML dump — cost four seconds every time the scrollback was wrapped, and the scrollback was wrapped far more often than it had to be: twice per resize, once more on a resumed session's first frame, and in full whenever a block opened or closed, including the automatic collapse on every submit. Wrapping is linear now, a resize wraps once, a replayed session paints without wrapping again, and a block swaps only its own rows. On the session that exposed it, `/resume` went from 4.2s to 50ms, `--resume` to the first frame from 9s to 0.5s, and a resize from 8.4s to milliseconds.
- 83c25f6: The status row no longer re-derives plan mode and the permission preset by walking the whole session log on every event and every tick of the working indicator. Both are folded once per session and kept current by the events that change them, so a resumed long session streams without spending a share of every chunk on two booleans — six seconds of a two-minute turn on a 17,000-event session.

## 0.15.3

### Patch Changes

- e090653: Click-and-drag now selects text in the input box the same way it does in the transcript: press anchors, motion extends, release copies, and the span stays marked until the next click or key. A click that never moved still just places the cursor. Typing, paste, and delete replace the selected span.
- ec19e44: An update now moves the whole pair in one command: after installing the new launcher, `codsh update` and `/update` also register the matching `codsh-bundle` into the code profile immediately, instead of leaving the runtime to be registered on the next launcher boot. A profile that launches straight through `dsh` is never left behind, and a pinned development runtime is still never clobbered. The boot-time registration stays as the catch for a runtime a bare `npm install -g codsh-cli` upgrade, or a failed move, left behind.

## 0.15.2

### Patch Changes

- 6f43ce3: Give the status row back when the pointer leaves the window or moves onto the chrome. A hover readout had been sticky: leaving the transcript (or the window) kept showing `thinking · N lines · click to expand` instead of the model/tokens line.
- e7d8458: Include thinking duration statistics for each reasoning block in the turn summary: e.g. `12.3s (thought 3.2s) · 1.2k tokens` or `12.3s (thought 2.1s, 4.3s) · 1.2k tokens`.

## 0.15.1

### Patch Changes

- dcadebc: Deduplicate redundant todos and clean up ticket titles in the `/ship` plan readout.
  
  When `/ship` landed tickets in-session, tracking them via `todo_write` duplicated
  the spec's plan readout verbatim when opened with `Ctrl+T`. The readout now omits
  the duplicate todo section when a live plan covers the same tickets, keeping the
  panel concise. Ticket titles read from spec checkboxes also strip verbose metadata
  (such as blocking edges and deliverables) to avoid overflow and clipping in the TUI.
- 17d8e4f: Fix drag selection dying at the edges of the transcript.
  
  A drag swept down past the last line and released over the input box copied
  nothing: the rows below the transcript are routed to whatever composed them, so
  the release never reached the viewport that had anchored the selection — it
  neither copied nor cleared. A gesture now belongs to where it began, through
  release.
  
  A press on the blank space under the last line started nothing at all, so
  sweeping up out of it selected nothing. It anchors at the nearest row now,
  while a bare click there still works no block.
- cf69c4d: Fix the frame corruption that survived every later repaint.
  
  A row painted with a control character in it does not stay in its row: the
  width authority scores a newline zero columns, so the row measures as a fit,
  paints its head where it belongs, and drops the rest at column 1 of the row
  below — usually a box border the frame diff considers unchanged, so nothing
  ever paints over the spill. A bash command that was a heredoc put one there.
  
  Text now flattens to one row wherever it becomes one: the cut does it before it
  measures, the wrap breaks a row where a newline asked for one, and the frame
  flattens again as it paints. A multi-line command reads as its lines in the
  card that ran it, and the one-row summary above names its first line.

## 0.15.0

### Minor Changes

- 0799769: The wheel scrolls the list it is over. An open selector or completion menu now holds a window of its own while the wheel moves it, so looking further down a list never changes what Enter would take — and any key brings the window back to the marked row. A scroll from the keyboard is left to the transcript wherever the pointer happens to rest, because a scroll now carries where it turned and one without a place did not come from the mouse.
- 3e6323a: The completion menu answers the mouse. Clicking a row finishes the word with that candidate — the row the pointer named, not the one the mark is on — and resting on a row shows a dim `·` beside it without moving the `❯`. The menu is drawn over the transcript rather than among the rows below it, so it answers in the overlay's own row space.
- b424ef8: Ctrl+T opens the `/ship` plan: every ticket with the landed ones dimmed and the one in flight marked, beside the agent's own todo list, since the two are different granularities of the same work. The fullscreen reader can copy what it is showing with `c` — which covers a diff, the one thing `/copy` cannot address, because tool cards are deliberately outside its index. Its footer leads with how to leave and how to copy, so a narrow terminal cuts a navigation hint rather than the way out.
- b69db97: Selectors answer the mouse. A click takes a row in `/model`, `/resume`, `/jump`, `/copy`, `/view`, and every `ask_user_question` — a multi-select row toggles the way Space does, and the "type your own" row opens free text. Resting on a row underlines it without moving the `❯`, so the pointer never changes what Enter would take, and a press commits only where it is released. Approvals stay keyboard-only, and the transcript is untouched: press-to-anchor, drag-to-extend, release-to-copy work exactly as before.
- fea74dc: A `/ship` run says how far through its plan it is while it works. The working line reports `done/total` and names the ticket in flight, read from the spec file's `## Plan` checkboxes — the round number a ralph loop reports counts against a budget, not against the work, so it could say which round was running but never how much was left. The figure appears as soon as the plan is on disk and updates as each round ticks its box.

### Patch Changes

- 4c8f9b9: An approval cannot be answered by a click. Making selectors answer the pointer made approvals answer it too, because they ask through the same widget — and one of their rows grants a tool for the rest of the session, which cannot be taken back. A selection can now refuse the pointer outright: no row to press, no mark under the pointer suggesting there is one, and the wheel refused as well.
- 03bca03: Clicking in the input box puts the cursor there. A long line wraps across several rows and a tall one scrolls inside the frame, and the click follows both, because it reads the same wrapped rows and the same window the box drew. Near misses clamp instead of missing: a border row takes the nearest line, a column past the end of a line takes its end. The completion menu closes with the move, since its candidates were computed for the token the cursor just left.
- b424ef8: A workflow round no longer offers to be entered. The event that reports a round names the child session it ran in, so each settled round said `click to enter` — but a workflow's children run in a worker thread and their sessions are never in this process, so clicking one could only ever answer "no longer running". Driven on a real terminal, that is exactly what it answered. The line stands on its own.

## 0.14.0

### Minor Changes

- ba492fc: `CODSH_TRACE=<path>` records every byte the viewport writes, and the size it wrote them at, so a frame that arrives corrupted can be replayed afterwards. A rendering fault is a disagreement between what the surface emitted and what the terminal did with it; without this the emitted half is gone by the time anyone looks. Off unless the variable is set, and a trace that cannot be written never costs the session.

### Patch Changes

- fbddfcf: Appending stays cheap however long the conversation gets. Locating a block or a prompt among the wrapped rows re-wrapped every line above it, which a profile showed to be 84% of the time spent appending — 1200 turns of a session took 113 seconds. The wrapped buffer already records which line each row came from, so the positions are read from it: the same 1200 turns take 335ms, and the cost is linear again.
- 1aa8021: `codsh --resume`, `--continue`, and `/resume` open a long conversation quickly. Replaying a session wrote one line at a time and painted a frame after each, so a 2000-event log sent about 24,000 frames and 39MB of escape sequences to the terminal before the conversation appeared. The replay now hands over a whole event's lines at once and holds painting until the log is in: the same session sends 4 frames.

## 0.13.0

### Minor Changes

- 2f25502: `/resume` offers the folder you are standing in, and folds every other folder behind one row that opens the rest. Rows are ordered by when a session was last touched rather than when it was created, and each names its title, that age, how many messages it holds, and — only when the session belongs to another folder — which one, `~`-shortened.
- 29bac89: A workflow shows its progress while it runs. `/ship`'s ralph loop spends minutes per round and printed nothing until the whole run returned; the surface now opens the run with its name, prints a line as each round settles, names the round still running in the working line, and closes with the stop reason. A settled round is a door: clicking it enters that round's child session, where its todos and tools are.

### Patch Changes

- c37eb5c: chore: sync `@deepseek-ai/dsh-*` (and co-released cordis packages) to 0.1.1-rc.2
- 433ab87: Elapsed times grow a unit instead of counting seconds forever: a long run reads `1h 37m` rather than `5845s`. The working line, the figure a finished turn reports, and a thinking block's header all share one formatter, which keeps the decimal while a turn is quick and shows the finest unit that still changes visibly.
- ff89f25: Typing stays responsive while a reply streams into a long conversation. Past the scrollback cap, every appended line re-wrapped the entire buffer to drop its first line — measured at about 50ms per line against 0.02ms below the cap, which is the surface going deaf to the keyboard exactly when output is fastest. The trim now cuts the rows the dropped lines owned and leaves the survivors alone.
- 2b97ab1: Up and Down move by the rows you see. A long line wraps across several rows in the box but is one line in the buffer, so Up from its second row decided there was nothing above it and recalled the previous prompt — replacing what was being typed. Movement now wraps at the same width the box draws at; only the top row hands the key to the history.

## 0.12.0

### Minor Changes

- 639fa0a: `/diff` reads uncommitted changes in the fullscreen reader instead of writing them into the transcript, and a diff card too long for its 24-line body opens there on click. The reader colours a diff by what each line does to the file; Ctrl+O still expands a block in place, and off a TTY `/diff` stays a line reader.

### Patch Changes

- 7a836cf: `/ship`, `/init`, and custom commands now take the top of the viewport the way a typed message does, so the reply fills the space beneath instead of scrolling the command off. Commands that only work the chrome are unchanged: they answer nothing, and clearing the screen for a reply that never comes would only lose what was on it.
- 241173d: Arrow keys work with Caps Lock or Num Lock held. A lock rides in the modifier field of a CSI report, so Down arrived as `ESC [ 1;65 B`, matched none of the chords the decoder listed, and was typed into the box as `[1;65B` instead of moving the command menu. Cursor and editing keys are now parsed rather than enumerated, and locks are stripped the way the kitty path already stripped them.

## 0.11.0

### Minor Changes

- d615a96: Tell a session when a newer codsh is published, install it on `/update` or `codsh update`, and answer `codsh --version` for the pair instead of the runtime it launches.

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
