# Ticket 5: Release & Documentation Compliance

Blocked by: Ticket 1, Ticket 2, Ticket 3, Ticket 4
Track: 9

## Delivers

CONTEXT.md Ship gates names Main Track, occupancy, and hybrid compass. Bilingual README `/ship` sections name occupancy, the frozen track, and that `/goal` shows the compass during a run. A changeset on `codsh-bundle` with a `minor` bump.

## Acceptance

- [ ] `rg -n "Main Track|occupancy" CONTEXT.md README.md README.zh.md` prints matches in all three.
- [ ] `.changeset/` includes a file naming `'codsh-bundle': minor` for this workflow.
- [ ] `pnpm run typecheck` exits 0.
- [ ] `pnpm test` exits 0 with zero new failures against the Phase 3 baseline.
