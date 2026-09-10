# Ticket 5: Release & Documentation Compliance

Blocked by: Ticket 1, Ticket 2, Ticket 3, Ticket 4
Track: 9

## Delivers

CONTEXT.md Ship gates names Main Track, occupancy, and hybrid compass. Bilingual README `/ship` sections name occupancy, the frozen track, and that `/goal` shows the compass during a run. A changeset on `codsh-bundle` with a `minor` bump.

## Acceptance

- [x] `rg -n "Main Track|occupancy" CONTEXT.md README.md README.zh.md` prints matches in all three.
- [x] `.changeset/` includes a file naming `'codsh-bundle': minor` for this workflow.
- [x] `pnpm run typecheck` exits 0.
- [x] `pnpm test` exits 0 with zero new failures against the Phase 3 baseline.

## Proof (Track: 9)

Red-first (docs seam; no vitest for this ticket):
- `python3` search of `Main Track|occupancy` in CONTEXT.md / README.md / README.zh.md — 0 hits in all three (Track: 9).
- `.changeset/` had no file for this workflow (`'codsh-bundle': minor` + Main Track / occupancy).

Green:
- Same search: CONTEXT.md 6 hits (Main Track, occupancy, hybrid compass under Ship gates); README.md 1 hit; README.zh.md 1 hit.
- `.changeset/ship-main-track-compass.md` names `'codsh-bundle': minor`.
- `pnpm exec vitest run packages/bundle/tests/ship.spec.ts packages/bundle/tests/ship-run.spec.ts packages/bundle/tests/plan.spec.ts` exit 0 — 3 files, 83 tests passed.
- `pnpm run typecheck` still only red on `packages/bundle/tests/startup.spec.ts` TS2307 `@deepseek-ai/cordis-plugin-include` (baseline; zero-new-failures).
- `pnpm test` still only red on that same suite (49 files passed, 1361 tests passed); no new failures.
