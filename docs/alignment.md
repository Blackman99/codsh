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
| Folds survive replay | probed 2026-08-20: both references re-render a resumed conversation through the same components that drew it live, so a collapsed block stays collapsible; codsh's replay wrote raw lines, leaving a `Ctrl+O expands` summary with no fold behind it | `aligned` | transcript.spec "the forms a long block keeps" suite; pty e2e "replays history as folds, so a resumed long output still opens" |
| Todo status display | probed 2026-08-20 (claude 2.1.236): the list renders with per-state marks (tick / filled square / hollow square), a `N tasks (X done, Y in progress, Z open)` header, and completed items struck through and dimmed; the list stays reachable as a panel rather than only as the write that produced it | `aligned` | todos.spec (`todoRow`/`todoReport` suites); prompt.spec "pins the todo readout over the hint and status rows", "opens the whole list on Ctrl-T and closes it again"; transcript.spec "renders the todo list with its progress"; pty e2e "pins the todo list in the chrome and opens it on Ctrl-T"; pipe e2e "prints the todo list on /todos". Divergence: codsh keeps its own `✔`/`▶`/`○` marks (the transcript's since todos first rendered) and pins one chrome row over the status row, Ctrl+T opening it, instead of a side panel this surface has no room for |
| Image paste | probed 2026-08-20 (claude 2.1.237 binary): `ctrl+v` (alt+v on win/wsl) is bound to `chat:imagePaste` — the app reads the platform clipboard itself (macOS `osascript … «class PNGf»` to a temp file; linux `xclip -t TARGETS`/`wl-paste -l` probed for `image/*`; windows PowerShell), inserts an atomic `[Image #N]` placeholder, and answers an empty clipboard with "No image found…" | `aligned` | keys.spec ctrl+v + kitty 118;5u cases; editor.spec "deletes a pasted-image token as one thing"; prompt.spec paste suite (attach, drop-on-delete, queue pairing, empty clipboard); clipboard-image.spec; vision.spec; images e2e (capable route blocks, text-only file fallback, sidecar description). DeepSeek's `deepseek-v4-flash-vision-exp` declares `inputModalities: ['text', 'image']` and takes the first-class block path; Flash and Pro remain text-only, where the recognition pipeline — save-file fallback plus the `CODSH_VISION_*` OpenAI-compatible sidecar — remains an owner-confirmed addition (ADR-0001) |
| /ship: one sentence to shipped | none — no reference agent ships an equivalent; recorded as an explicit user-confirmed addition beyond the reference set (ADR-0001 divergence rule). Hardened 2026-08-20: the spec file is the durable memory (plan written into it as checkboxes, `Status:` phase line, resume on bare /ship), green is grounded (baseline recorded before code, commit per milestone, per-criterion proof commands re-run by the session after a Ralph loop, loop bounded with a stall stop), and pasted images are requirements material | `aligned` | ship.spec SHIP_PROMPT suite (8 cases: template, tools, gates, durable memory, baseline+commits, mechanical verification, images); pipe e2e "runs /ship as a built-in canned prompt carrying the typed idea" |
| Hover feedback on a block | probed 2026-08-20 (claude 2.1.237 binary): the TUI writes only `CSI ?1000h` + `?1006h` — click tracking with no motion reporting, so no reference agent can mark what the pointer merely rests on. Its own renderer carries `onMouseEnter`/`onMouseLeave` props with nothing to feed them. Recorded as an owner-confirmed addition beyond the reference set (ADR-0001 divergence rule) | `aligned` | screen.spec "the block under the pointer" suite; keys.spec "reports the pointer moving with nothing held"; prompt.spec "names the block under the pointer, and gives the hint row back after", "repaints nothing while the pointer stays on one block"; experience e2e "names the block the pointer rests on, and gives the row back". Divergence: mode 1003 goes on over the 1002 already pushed, so terminals implementing only the older mode keep the drag that selects; the mark is an underline on the block's head row rather than a background fill, which would fight the selection highlight per ADR-0001 |
| Click a fold to work it | owner-reported gap against opencode and Claude Code: the mouse opens a collapsed block there, while codsh had only the global Ctrl+O. Not probed — recorded as an owner-confirmed addition (ADR-0001 divergence rule) | `aligned` | screen.spec folds: "opens the block a click lands on", "folds an open block back from anywhere inside it", "leaves a block alone when the click was a drag over it", "still copies a drag that starts on a collapsed block", "keeps a scrolled reader in place"; experience e2e "opens the block a click lands on, and folds it back from inside it" |

Completed alignment work before this matrix existed (thinking collapse, `!`
passthrough, /clear, /resume selector, ESC-ESC recall, todo cards, Ctrl+O
folds, tables, /diff, /init, custom commands, bell/title, alt-screen
viewport, wheel/scroll, welcome banner, select-to-copy) is pinned by the
existing unit and e2e suites and enters the matrix only if a regression or a
finer reference detail surfaces.
