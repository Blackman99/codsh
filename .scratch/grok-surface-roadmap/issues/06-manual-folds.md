# 06 — Persistent manual fold choices

Status: completed

Blocked by: none

## Objective

Preserve explicit fold choices through streaming and later turns without changing
the session schema.

## Change intent

- Distinguish automatic fold state from explicit expanded/collapsed preferences.
- Click and Ctrl+O pin the chosen state; turn submission collapses automatic folds only.
- New and replayed folds default collapsed; clear/session replacement resets choices.
- Preserve reading position when an expansion occurs near the tail.

## Verification

- RED/GREEN: mixed choices, prompt folds, stream completion, resize/trim/search/clear.
- PTY: one manually expanded block stays open across the next turn.
- `pnpm run typecheck`.

## Acceptance

- [x] Expanded prompts remain non-sticky until manually collapsed.
- [x] Automatic folds retain current default behavior.
- [x] Resume restores fold capability but not ephemeral manual state.
- [x] Docs, alignment entry, minor changeset, and scoped commit exist.
