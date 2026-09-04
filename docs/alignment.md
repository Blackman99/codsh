# Alignment Matrix

The memory of the alignment pipeline: every interaction/feature gap between
codsh and the reference agents (ADR-0001: Claude Code > opencode > Codex
CLI/gemini-cli as corroboration), and its state. **Done** means every row is
in a terminal state.

## Operating rules

- **Discovery**: native Claude Code knowledge seeds the inventory; reading
  the open-source references (opencode, Codex CLI, gemini-cli) extends it;
  behavioral probing (driving the real tool in the e2e PTY/VT harness) is
  reserved for disputes.
- **Autonomy**: within a batch, implementing, testing, syncing the dev
  install, changesets, and pushing are autonomous. Work stops for a question
  only when (a) references conflict beyond the ADR-0001 rule, (b) alignment
  requires changing the dsh runtime upstream, or (c) it contradicts a stated
  owner preference. Publishing releases always waits for the owner.
- **Cadence**: a batch starts on the owner's word and runs to a reported
  finish; no unattended background loops.
- **Test anchor**: an `aligned` row MUST name at least one test that pins the
  behavior. No anchor, not aligned.
- **TUI verification**: a surface row is not `aligned` until the behaviour has
  been driven on a real TTY — a PTY e2e that paints the frame, or
  `MOCK=… pnpm run dev`. Unit specs pin the seam; they do not replace seeing
  the chrome. This is part of every batch, not an optional extra.
- **Surface inventory (2026-08-27)**: remaining interaction gaps include
  uninventoried surface work, not only protocol rows. dsh-underneath
  capabilities (MCP, LSP, permission model, compaction algorithm, sandbox,
  agent loop) do not enter. Aligned divergences stay terminal. A feature
  present in any of Claude Code, opencode, or Codex CLI may open a row
  (arbitration when they disagree remains ADR-0001). Mixed rows — surface
  UX that may need a dsh API — stay `open` until implementation hits
  upstream, then `limitation`. Batch pick order: first-week surface, then
  remaining surface, then mixed; the three protocol rows (modifyOtherKeys,
  2027, OSC 8) are their own batch.

## States

| State | Meaning |
|---|---|
| `open` | Known gap, not started |
| `wip` | In a batch now |
| `aligned` | Shipped and pinned by the named tests (terminal) |
| `limitation` | Cannot align without upstream/terminal support; reason noted, README limitation section updated (terminal) |
| `rejected` | Deliberately not aligned; reason noted, owner confirmed (terminal) |

## Matrix

| Item | Reference behavior | State | Tests / Notes |
|---|---|---|---|
| Kitty keyboard protocol | probed 2026-08-19: claude pushes `CSI >1u`/pops `CSI <u` unconditionally; codex pushes `>7u` + queries `?u`; opencode & gemini query | `aligned` | push/pop: screen.spec "pushes the kitty keyboard flag"; decode map: keys.spec "decodes the kitty report" suite; e2e: pty "speaks the kitty keyboard protocol" |
| Shift+Enter breaks the line | Claude Code: Shift+Enter inserts a newline on kitty-capable terminals | `aligned` | keys.spec 13;2u cases; pty e2e submits a two-line message; legacy terminals keep Alt+Enter |
| modifyOtherKeys | probed: claude sets `CSI >4;2m`; codex resets `>4;0m`; opencode sets it | `open` | xterm-proper coverage; kitty path already shipped |
| Grapheme clustering (mode 2027) | probed: only opencode sets 2027 | `open` | emoji ZWJ sequences in tables |
| Focus events (mode 1004) | probed: claude, codex, gemini all enable 1004 | `aligned` | keys.spec "reports focus in and out"; console.spec "the bell and focus" suite; pty e2e "focus and background reports". Use: the bell rings only while unfocused; terminals that never report keep always-ring |
| Theme detection (OSC 11) | probed: opencode, codex, gemini query OSC 10/11; claude does not (opencode decides per ADR-0001) | `aligned` | theme.spec setLight/backgroundIsLight; screen.spec entry query; pty e2e light-palette adoption. Scope: the absolute 256-color secondary gray adapts (245→242); base ANSI colors stay the terminal theme's job |
| OSC 8 hyperlinks | probed: claude emits OSC 8 at startup; gemini/opencode link paths | `open` | markdown links + file:line |
| Segment framing in the transcript | probed 2026-08-20: opencode (1.18.x) draws each message block with `border: ["left"]` plus a `backgroundPanel` fill that becomes `backgroundElement` when focused; claude 2.1.236 carries `borderLeft` with `dashed`/`subtle` variants and `borderLeftDimColor` (e.g. userMessage) and reserves `borderStyle:"round"` boxes for panels | `aligned` | screen.spec "the rule down a block's edge" suite; transcript.spec "which block a line belongs to" suite; pty e2e "rules each block down its left edge, by what the block is". Divergence: the left rule is adopted, opencode's background fill is not — base colours and the terminal background stay the theme's per ADR-0001, and a fill would also fight the surface's own selection highlight |
| Sticky turn headers | Grok Build pins the user prompt owning the visible response, shrinks a multi-row header while it crosses the top, and lets the next prompt push it away ([source at owner-selected commit](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/sticky.rs)). Recorded as an owner-confirmed Surface addition beyond the four Reference Agents | `aligned` | sticky.spec pure layout suite; screen.spec prompt grouping/fold/resize/trim/search/click suites; transcript.spec real-user boundary cases; experience e2e "keeps the owning prompt above each turn while scrolling across the boundary". codsh keeps its `›`, user colour, heavy Rule, and existing scroll notice — which sits at the foot of the viewport and clicks back to the tail (screen.spec "puts the scrollback notice under what is being read", "returns to the latest when the notice row is clicked"; experience e2e "says how far back it is, at the foot of the screen, and clicks home"). Prompts cap at three visual rows; an expanded long prompt remains a turn boundary but is temporarily non-sticky. The header copy is display-only and never enters search, selection, transcript, or pipe output |
| Semantic turn navigation | Grok Build exposes turn jumps and a reversible `/jump` preview over real user prompts | `aligned` | keys.spec legacy/Kitty Shift+Left/Right; screen.spec retained turn index and viewport restore; prompt.spec selector preview; experience e2e shifted-arrow turn crossing. Plugin context never becomes a turn and pipe mode owns no viewport |
| Prompt-top anchoring | Grok Build's page-flip behavior places a submitted prompt at the viewport top while reply rows consume the space beneath it | `aligned` | screen.spec anchor lifecycle/streaming/resize/replay cases plus the return cases (step off row by row, wheel and PgDn back onto the anchored frame, streaming into the gap under a scrolled reader, next prompt taking the gap over); experience e2e paced streaming capture and "gives the anchored prompt back when the reader wheels home again". codsh models the gap as display-only tail rows that scroll with the transcript: search, selection, folds, scrollback trimming, replay, and pipes never observe them, and the gap ends only when the reply fills the viewport or the next prompt takes it over |
| Conversation timeline | Grok Build renders a windowed turn rail whose enabled arrows target the nearest turn anchors above/below the viewport top, with shared render/hit geometry and a two-line real-prompt hover preview | `aligned` | timeline.spec arrow targets/windowing; screen.spec reserved-column paint, arrow/tick hits, explicit-line preview, image-metadata exclusion, shared geometry cache, selector-hide, trim, and resize; experience e2e three-turn tick/arrow navigation across sticky boundaries. codsh uses its already-reserved anti-wrap column, so transcript width and chrome height stay unchanged; one-turn and sub-three-row rails stay hidden |
| Conversation content index and `/copy` | Grok Build exposes answers and fenced code as selectable copy targets; codsh adds stable `N` and `N:C` direct addresses for the same reading workflow | `aligned` | content-index.spec raw event indexing, canonical addresses, malformed fences, and newest-first grouping; experience e2e exact OSC 52 receipts, selector cancel, and disabled clipboard. Answers preserve raw Markdown; code excludes its fence. Tool/image/reasoning-only events, ANSI, Rules, timeline, and Sticky turn header copies cannot become targets; the command is TTY-only |
| Fullscreen response viewer | Grok Build opens response content in a transient full-viewport reader with keyboard scrolling and exact return to conversation context | `aligned` | viewer.spec pure Markdown/code layout, line/page/boundary navigation, wide-character/table reflow, resize clamp, and tiny windows; screen.spec overlay isolation and exact frame restore; prompt.spec key ownership/abort/resize; experience e2e selector plus answer/code restore and live PTY resize; pipe e2e unsupported path. `/view N` and `/view N:C` share the content index; successful viewing adds no prompt, fold, transcript row, session event, search result, clipboard write, or pipe UI |
| Persistent manual fold choices | Grok Build keeps explicitly opened or closed response blocks stable while automatic fresh-output folds still collapse as the conversation advances | `aligned` | screen.spec mixed manual/automatic states, future-fold defaults, prompt resize recreation, near-tail viewport anchoring, sticky eligibility, trimming/search/clear regressions; experience e2e preserves one manually expanded reasoning block across a real next turn; pty e2e proves session replacement/replay restores fold capability but not ephemeral preferences. Choices remain Screen-only and do not change the dsh session schema or redirected output |
| Folds survive replay | probed 2026-08-20: both references re-render a resumed conversation through the same components that drew it live, so a collapsed block stays collapsible; codsh's replay wrote raw lines, leaving a `Ctrl+O expands` summary with no fold behind it | `aligned` | transcript.spec "the forms a long block keeps" suite; pty e2e "replays history as folds, so a resumed long output still opens" |
| Todo status display | probed 2026-08-20 (claude 2.1.236): the list renders with per-state marks (tick / filled square / hollow square), a `N tasks (X done, Y in progress, Z open)` header, and completed items struck through and dimmed; the list stays reachable as a panel rather than only as the write that produced it | `aligned` | todos.spec (`todoRow`/`todoReport` suites); prompt.spec "pins the todo readout over the hint and status rows", "opens the whole list on Ctrl-T and closes it again"; transcript.spec "renders the todo list with its progress"; pty e2e "pins the todo list in the chrome and opens it on Ctrl-T"; pipe e2e "prints the todo list on /todos". Divergence: codsh keeps its own `✔`/`▶`/`○` marks (the transcript's since todos first rendered) and pins one chrome row over the status row, Ctrl+T opening it, instead of a side panel this surface has no room for |
| Image paste | probed 2026-08-20 (claude 2.1.237 binary): `ctrl+v` (alt+v on win/wsl) is bound to `chat:imagePaste` — the app reads the platform clipboard itself (macOS `osascript … «class PNGf»` to a temp file; linux `xclip -t TARGETS`/`wl-paste -l` probed for `image/*`; windows PowerShell), inserts an atomic `[Image #N]` placeholder, and answers an empty clipboard with "No image found…" | `aligned` | keys.spec ctrl+v + kitty 118;5u cases; editor.spec "deletes a pasted-image token as one thing"; prompt.spec paste suite (attach, drop-on-delete, queue pairing, empty clipboard); clipboard-image.spec; vision.spec; images e2e (capable route blocks, DeepSeek Pro borrowing Vision Exp, interrupt, failure fallback, explicit-sidecar precedence, ordered multi-image descriptions, other-provider file fallback). DeepSeek's `deepseek-v4-flash-vision-exp` declares `inputModalities: ['text', 'image']` and takes the first-class block path; Flash and Pro remain text-only, but now borrow that sibling route automatically for a one-shot description while keeping their own conversation route. An explicit `CODSH_VISION_*` OpenAI-compatible sidecar still wins; any failure keeps the saved-file fallback. This recognition pipeline remains an owner-confirmed addition (ADR-0001) |
| /ship: one sentence to shipped | none — no reference agent ships an equivalent; recorded as an explicit user-confirmed addition beyond the reference set (ADR-0001 divergence rule). Hardened 2026-08-20: the spec file is the durable memory (plan written into it as checkboxes, `Status:` phase line, resume on bare /ship), green is grounded (baseline recorded before code, commit per milestone, per-criterion proof commands re-run by the session after a Ralph loop, loop bounded with a stall stop), and pasted images are requirements material. Tightened 2026-08-28 to the grill-me → automatic to-spec → automatic to-tickets → TDD landing pipeline: design-tree frontier rounds with a recommended answer, spec synthesized without another interview, tracer-bullet tickets as the plan, red-green at recorded seams | `aligned` | ship.spec SHIP_PROMPT suite (9 cases: template, tools, gates, durable memory, baseline+commits, mechanical verification, images, grill+to-spec+to-tickets); pipe e2e "runs /ship as a built-in canned prompt carrying the typed idea" |
| Hover feedback on a block | probed 2026-08-20 (claude 2.1.237 binary): the TUI writes only `CSI ?1000h` + `?1006h` — click tracking with no motion reporting, so no reference agent can mark what the pointer merely rests on. Its own renderer carries `onMouseEnter`/`onMouseLeave` props with nothing to feed them. Recorded as an owner-confirmed addition beyond the reference set (ADR-0001 divergence rule) | `aligned` | screen.spec "the block under the pointer" suite; keys.spec "reports the pointer moving with nothing held"; prompt.spec "names the block under the pointer, and gives the hint row back after", "repaints nothing while the pointer stays on one block", "does not grow the chrome when the hover readout appears"; experience e2e "names the block the pointer rests on, and gives the row back". Divergence: mode 1003 goes on over the 1002 already pushed, so terminals implementing only the older mode keep the drag that selects; the mark is a panel fill on every visible row of the block (opencode's `backgroundElement`), not an underline and not a permanent block fill. Owner 2026-08-27: the whole visible span so the named paragraph is obvious; the readout borrows the hint or status row so the box does not jump; fill is hover-only so the terminal theme still owns the resting background |
| Click a fold to work it | owner-reported gap against opencode and Claude Code: the mouse opens a collapsed block there, while codsh had only the global Ctrl+O. Not probed — recorded as an owner-confirmed addition (ADR-0001 divergence rule) | `aligned` | screen.spec folds: "opens the block a click lands on", "folds an open block back from anywhere inside it", "leaves a block alone when the click was a drag over it", "still copies a drag that starts on a collapsed block", "keeps a scrolled reader in place"; experience e2e "opens the block a click lands on, and folds it back from inside it" |
| Mouse selection in the input box | owner-reported gap: click-and-drag selected nothing in the box once mouse reporting was on, while the Viewport already copies a transcript drag on release. Claude Code positions the cursor on a click in the prompt and copies a conversation drag on release; opencode's textarea supports mouse selection with copy-on-select | `aligned` | editor.spec "buffer selection" suite; inputbox.spec "painting a buffer selection"; prompt.spec "selects in the box on a drag and copies on release", "still places the cursor when the press never moved"; pty e2e "selects text in the box with a drag and copies on release". A click is still Caret placement; a drag is Box selection. Typing replaces the span. A Viewport-anchored drag released over the box is still that transcript copy |
| Ctrl+R history search | claude, opencode, Codex: incremental search through prompt history | `aligned` | first-week; inventoried 2026-08-27, not probed. keys.spec Ctrl-R + kitty 114;5u; editor.spec "history search" suite; inputbox.spec "names reverse history search"; experience e2e "searches prompt history on Ctrl+R" |
| Transcript search | claude, opencode, Codex: find/filter in scrollback | `aligned` | first-week; inventoried 2026-08-27, not probed. keys.spec Ctrl-F + kitty 102;5u; screen.spec "transcript search" suite; prompt.spec "opens transcript find"; experience e2e "searches the transcript on Ctrl+F" |
| Type-to-filter selectors | claude resume/model search; opencode palettes | `aligned` | first-week. selector.spec "filterable" suite. `/model` and `/resume` pass `filterable`; approvals keep digits/shortcuts |
| Copy answer / code block | claude `/copy` + code-block copy; opencode message/code copy; Codex copy | `open` | first-week; copy today is drag-select only |
| Attach non-image files | claude paths/files; opencode attachments; Codex file attach | `open` | first-week; Ctrl+V is image-only; bracketed paste is text |
| Drag-drop files | claude, opencode | `open` | first-week; mouse decoder is left-drag + wheel only |
| Shortcuts overlay (`?`) | claude `?`; opencode/Codex footer + help | `aligned` | first-week. prompt.spec "opens the shortcuts overlay on ?"; experience e2e "opens the shortcuts overlay on ? from an empty box". `/help` still prints the command list |
| Activity-aware working line | all three: "Reading x" / "Running npm…" | `aligned` | first-week. spinner.spec "names the in-flight activity on the working line"; session `tool/call` sets Reading/Running/Searching/Editing from the tool name |
| Edit/cancel queued messages | claude, opencode, Codex: queue is editable or dismissable | `aligned` | first-week. prompt.spec "dequeues the tail back into the box on Escape"; experience e2e "gives a queued line back on Escape" |
| Vim mode | claude `/vim`; opencode modal; Codex vim composer | `open` | rest surface; inventoried 2026-08-27, not probed |
| Editor undo/redo | all three | `open` | rest surface; editor has no undo stack |
| External `$EDITOR` | claude Ctrl+G; opencode `/editor`; Codex editor | `open` | rest surface |
| Kill-ring yank | claude/Codex emacs composers (Ctrl+Y) | `open` | rest surface; Ctrl+K/U/W drop text with nowhere to yank |
| Forward kill-word (Alt+d) | emacs in the reference composers | `open` | rest surface; only backward kill-word is bound |
| Double-click / keyboard selection | typical in the reference TUIs | `open` | rest surface; selection is press-drag-release only |
| Idle keybinding footer | claude, opencode, Codex always-on key chrome | `open` | rest surface; placeholder vanishes once you type |
| /theme picker | opencode, Codex | `open` | rest surface; OSC 11 only remaps secondary gray, no catalog |
| Desktop notifications | claude, Codex (osascript / notify-send / OSC 9) | `open` | rest surface; today BEL + title only. Distinct from footnote bell/title |
| Session rename/delete | claude, opencode session lists | `open` | rest surface; `/resume` lists but cannot rename or delete |
| Vision badge on model rows | claude, opencode | `open` | rest surface; catalog has `inputModalities`, picker does not show them |
| /context breakdown | claude `/context` (system/tools/messages bars) | `open` | rest surface; status has % left, no per-bucket view |
| Cost in the status row | claude `$`; Codex cost-ish | `open` | rest surface; limitation if the meter exposes no money |
| Reasoning effort control | Codex; claude on some routes | `open` | rest surface; `/model` picks provider/id only |
| Update-available chrome | claude, opencode tell you a newer version is out and name what installs it | `aligned` | update.spec version ordering, cache lifetime, opt-out, registry override, and every unreachable/malformed answer; pipe e2e "checks the registry on /update, and installs nothing when it is current" and "moves the profile runtime when /update finds a newer codsh"; experience e2e "says a newer codsh is out, once, under the welcome"; wrapper e2e "answers --version for the pair", "updates the pair from outside a session", "moves the profile runtime when update finds a newer codsh", the pinned/current/legacy cases, and the unreachable-registry case. Divergence: codsh's line is one dim transcript row under the welcome, not a chrome row — chrome height is what keeps the box still — and the check is a 6-hour-cached dist-tag read behind a two-second budget that installs nothing on its own. An update installs the launcher and moves the profile's runtime to match in the same command; the boot only registers a runtime a bare npm upgrade left behind. `CODSH_UPDATE_CHECK=off` silences the check; `/update` in a session and `codsh update` outside one still ask |
| Markdown strikethrough / task list | claude, opencode answers | `open` | rest surface; markdown has no `~~`; lists are `•` / `1.` only |
| Custom keybind file | opencode | `open` | rest surface; bindings hardcoded in keys.ts. low |
| Voice input | claude | `open` | rest surface; low |
| In-app screenshot capture | claude | `open` | rest surface; low. Distinct from aligned image paste |
| Rewind / undo conversation | claude `/rewind`; opencode `/undo` `/redo`; Codex rewind | `open` | mixed: surface picker + session truncate API. inventoried 2026-08-27, not probed |
| Approval command preview | all three show the bash/path | `open` | mixed: widget is `Allow {tool}?` with optional reason; request currently has no arguments |
| `@` beyond files | claude; opencode similar (agents, MCP, git, docs) | `open` | mixed: mention UI is surface; catalogs are dsh |
| `#` add-to-memory | claude | `open` | mixed: `#` token is surface; memory store is dsh |
| Background-shell chrome (Ctrl+B) | claude | `open` | mixed: chrome/key is surface; job runtime is dsh |
| /compact chrome | claude, opencode, Codex (instructions, progress, kept/dropped) | `open` | mixed: command is dsh; dedicated UX is surface |

Completed alignment work before this matrix existed (thinking collapse, `!`
passthrough, /clear, /resume selector, ESC-ESC recall, todo cards, Ctrl+O
folds, tables, /diff, /init, custom commands, bell/title, alt-screen
viewport, wheel/scroll, welcome banner, select-to-copy) is pinned by the
existing unit and e2e suites and enters the matrix only if a regression or a
finer reference detail surfaces.
