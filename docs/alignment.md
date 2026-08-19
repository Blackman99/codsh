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
| Focus events (mode 1004) | probed: claude, codex, gemini all enable 1004 | `open` | dim/undim, cursor blink gating |
| Theme detection (OSC 10/11) | probed: opencode, codex, gemini query OSC 10/11; claude does not | `open` | today: NO_COLOR/env only |
| OSC 8 hyperlinks | probed: claude emits OSC 8 at startup; gemini/opencode link paths | `open` | markdown links + file:line |

Completed alignment work before this matrix existed (thinking collapse, `!`
passthrough, /clear, /resume selector, ESC-ESC recall, todo cards, Ctrl+O
folds, tables, /diff, /init, custom commands, bell/title, alt-screen
viewport, wheel/scroll, welcome banner, select-to-copy) is pinned by the
existing unit and e2e suites and enters the matrix only if a regression or a
finer reference detail surfaces.
