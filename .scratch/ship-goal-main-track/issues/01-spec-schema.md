# Ticket 1: Spec schema (Goal-Id, Main Track, Track: strip)

Blocked by: none
Track: 8

## Delivers

`parseSpecMetadata` returns `goalId` from a `Goal-Id:` header line. A `parseMainTrack` (or equivalent) reads the `## Main Track` section. `parsePlan` strips `Track: N[,M]` from chrome titles the way it already strips blockers and verification, and does not count `## Main Track` checkboxes as plan tickets.

## Acceptance

- [x] `Goal-Id: <id>` round-trips through `parseSpecMetadata`.
- [x] A spec whose only checkboxes sit under `## Main Track` yields an empty plan.
- [x] A plan line with `Track: 1,3` and `(Blocked by: …)` keeps a short chrome title; blocker stripping still works.
- [x] Existing Branch / Base-Commit / Original-Branch / Status / checkbox cases stay green.
- [x] `pnpm exec vitest run packages/bundle/tests/plan.spec.ts` exits 0.

## Proof (Track: 8)

Red-first: `pnpm exec vitest run packages/bundle/tests/plan.spec.ts` exit 1 — 2 failed | 25 passed.
- `reads Goal-Id from spec header metadata (Track: 8)` — expected `undefined` to be `'goal-abc123'` (missing `goalId` on `SpecMetadata`).
- `reads the Main Track section without treating its checkboxes as plan tickets (Track: 8)` — `TypeError: parseMainTrack is not a function`.

Green: same command exit 0 — 29 tests passed (Goal-Id round-trip, Main Track parse, Track: strip beside blockers, empty plan when only Main Track checkboxes).
