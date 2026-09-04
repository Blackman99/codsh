# 01 — Semantic turn navigation

Status: completed

Blocked by: none

## Objective

Let an interactive reader move between real user turns with `Shift+Left`,
`Shift+Right`, and `/jump`, including reversible selector previews.

## Change intent

- Add a public Screen/TerminalConsole turn-navigation seam over existing prompt descriptors.
- Decode legacy and Kitty modified arrows into previous/next-turn keys.
- Register `/jump [N]`; filterable selection previews a turn, Enter commits, Esc restores.
- Count only `source.kind === "user"` prompts; keep pipe mode unchanged.

## Verification

- RED/GREEN: keys, selector preview, Screen turn/trim/resize/clear tests.
- PTY: direct shortcut, `/jump` commit, `/jump` cancel.
- `pnpm run typecheck`.

## Acceptance

- [x] Turn ordinals remain stable across folding, rewrap, trimming, clear, and resume.
- [x] Preview cancellation restores the exact original viewport.
- [x] Boundary navigation is a safe no-op with feedback.
- [x] Docs, alignment entry, minor changeset, and scoped commit exist.
