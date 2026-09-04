# 05 — Fullscreen response viewer

Status: completed

Blocked by: none

## Objective

Open an answer or code target in a transient, scrollable full-viewport reader.

## Change intent

- Add `/view`, `/view N`, and `/view N:C` over the shared content index.
- Render answer Markdown and fence-free code with a title and navigation footer.
- Support wheel, shifted arrows, page/home/end, resize, and Escape restore.
- Do not mutate transcript, search, session events, clipboard, or pipe output.

## Verification

- RED/GREEN: viewer layout/navigation/resize/restore and command selection.
- PTY: long answer and code viewers restore the exact prior viewport.
- `pnpm run typecheck`.

## Acceptance

- [x] Input chrome and timeline are hidden only while the viewer owns the viewport.
- [x] Wide characters and Markdown reflow safely.
- [x] Non-TTY use reports unsupported without adding UI output.
- [x] Docs, alignment entry, minor changeset, and scoped commit exist.
