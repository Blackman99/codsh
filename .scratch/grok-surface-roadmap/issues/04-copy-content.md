# 04 — Conversation content index and /copy

Status: completed

Blocked by: none

## Objective

Copy raw assistant Markdown or an exact fenced code block through a filterable
TTY selector or stable direct address.

## Change intent

- Build a pure index over session events with answer `N` and code `N:C` targets.
- Add `/copy`, `/copy N`, and `/copy N:C`; no-argument selection is newest-first.
- Copy raw Markdown for answers and fence-free source for code.
- Never touch the clipboard in non-TTY mode or on cancel/error.

## Verification

- RED/GREEN: event indexing, fences, malformed input, commands, clipboard outcomes.
- PTY: selector and OSC 52 receipt.
- `pnpm run typecheck`.

## Acceptance

- [x] Tools/images do not create targets; plugin-produced assistant answers remain copyable.
- [x] Copied text contains no ANSI, Rule, sticky copy, or code fence for code targets.
- [x] Missing/disabled clipboard paths report clearly and make no write.
- [x] Docs, alignment entry, minor changeset, and scoped commit exist.
