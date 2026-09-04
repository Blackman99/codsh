# 03 — Conversation timeline

Status: completed

Blocked by: 01, 02

## Objective

Render and operate a one-column conversation timeline without reducing transcript
width.

## Change intent

- Add a pure timeline layout module with current-turn windowing and overflow marks.
- Paint dim `·`, user-colored current `●`, and `↑`/`↓` in the reserved right column.
- Hover shows a two-line display-only prompt preview; click jumps to that turn.
- Hide the rail beneath selectors/viewers and omit it from copy/search/pipes.

## Verification

- RED/GREEN: pure layout boundaries, Screen painting, hover/click, resize/trim.
- PTY: current marker follows sticky ownership and cross-turn scrolling.
- `pnpm run typecheck`.

## Acceptance

- [x] Timeline never changes content wrapping or chrome height.
- [x] Every visible tick maps to the correct real prompt.
- [x] Hover and click do not mutate transcript or selection.
- [x] Docs, alignment entry, minor changeset, and scoped commit exist.
