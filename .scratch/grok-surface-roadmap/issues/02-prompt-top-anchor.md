# 02 — Prompt-top anchoring

Status: completed

Blocked by: 01

## Objective

Place a newly submitted real prompt at the viewport top while reply rows consume
display-only tail space below it.

## Change intent

- Reuse the turn reveal seam with a logical top anchor and virtual tail rows.
- Activate only for a real prompt submitted while following the tail in a TTY.
- Cancel on manual navigation; preserve the logical anchor across resize.
- Exclude virtual rows from transcript, search, copy, folds, trim, and pipes.

## Verification

- RED/GREEN: Screen anchor lifecycle, streaming, resize, tiny viewport, cancellation.
- PTY: prompt starts at top and reply fills beneath it one row at a time.
- `pnpm run typecheck`.

## Acceptance

- [x] No fake row enters transcript-derived behavior.
- [x] Sticky takeover begins without duplicate prompt rows.
- [x] Historical browsing and non-TTY output retain existing behavior.
- [x] Docs, alignment entry, minor changeset, and scoped commit exist.
