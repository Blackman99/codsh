# codsh-bundle

## 0.4.0

### Minor Changes

- eb136e9: The session now reads two terminal reports the other agent CLIs read. Focus (mode 1004): the bell rings only while the terminal is unfocused — a person already looking at the screen needs no call-back — and terminals that never report focus keep the always-ring behavior. Background color (OSC 11, asked on entry the way opencode and Codex ask): a light answer swaps the secondary-text gray for a shade that stays readable on white, while base ANSI colors remain the terminal theme's to map.
- 1fb7a09: codsh speaks the kitty keyboard protocol, the way Claude Code does: the disambiguate flag is pushed on entering the session and popped on leaving, so on capable terminals (Ghostty, kitty, WezTerm, iTerm2, foot) Shift+Enter breaks the line, Esc reports without the ambiguity timer, and control chords arrive unambiguously. Terminals without the protocol are untouched — every legacy sequence still decodes, and Alt+Enter keeps working everywhere.

## 0.3.0

### Minor Changes

- 91291bc: The package is split so a machine never carries a second dsh. `codsh-cli` is now a zero-dependency launcher a few kilobytes big: it finds the dsh you already have (`DSH_BIN`, a resolvable `@deepseek-ai/dsh`, or `dsh` on PATH), registers the runtime — now published as `codsh-bundle` — into the `code` profile, migrates pre-split profiles off the old fat layout automatically, and upgrades the bundle when the launcher upgrades. Fresh machines install `@deepseek-ai/dsh` alongside; everyone else stops downloading ~300MB they already had.
