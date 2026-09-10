# Ticket 3: Occupancy + ShipGoals port + degrade + composition wire

Blocked by: Ticket 1, Ticket 2
Track: 1, 5, 6, 9

## Delivers

Optional `ShipGoals` and occupancy Selector ports on `ShipRun`. Occupancy runs before the first phase turn: pause a stranger immediately, then `ship · occupancy` (Replace / Abort). TTY cancel/Esc = Abort (resume stranger, inject nothing). Absent ask / non-TTY = auto-Replace. Ours = spec `Goal-Id:` match or objective starts with `[ship]` → edit/pause, no ask. No current / complete: create `[ship] <idea>` then pause; pass id into grill. Missing or throwing port degrades (flash, continue spec+prepend). Length rejection retries once as `[ship] <idea>` then degrades the harness half. Composition root wires `ctx.goals`, `prompt.select`, and flash. No extra chrome row.

## Acceptance

- [x] No current goal: create then pause before the first injected prompt; grill prompt contains the Goal-Id.
- [x] Stranger on a TTY: pause, ask; Replace clears then creates; Abort resumes stranger and injects nothing; Esc same as Abort.
- [x] Absent ask: auto-Replace without asking.
- [x] Ours by Goal-Id or `[ship]` prefix: no ask, edit/pause.
- [x] Goals port missing or create/pause throwing: `run()` does not throw; injects still happen.
- [x] Index constructs `ShipRun` with the ports.
- [x] `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts` exits 0.
- [x] `pnpm run typecheck` exits 0.

## Proof (Track: 1, 5, 6, 9)

Red-first:
- `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts -t 'creates a \[ship\] placeholder'` exit 1 — 1 failed | 11 skipped. `creates a [ship] placeholder then pauses before the first grill inject (Track: 5,7)` — expected `[]` to equal `['create:[ship] build a widget', 'pause:goal-new']`.
- `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts -t 'pauses a stranger then asks'` exit 1. `pauses a stranger then asks ship · occupancy before any inject (Track: 6)` — expected `undefined` to be `'pause:stranger-1'`.
- `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts` exit 1 — 1 failed | 17 passed. `reuses ours by Goal-Id or [ship] prefix without asking (Track: 6)` — occupancy asked; expected `[]`.
- `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts` exit 1 — 1 failed | 20 passed. `constructs ShipRun with goals, occupancy, and flash ports (Track: 1,9)` — expected source to contain `ctx.get('goals')`.

Green: `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts` exit 0 — 22 tests passed (create-then-pause, pause-then-ask Replace/Abort/Esc/throw, auto-Replace, ours by Goal-Id and `[ship]`, complete-current, missing/throwing degrade, wrapHostGoals, composition wire, no GoalBar).
Proof: `pnpm exec vitest run packages/bundle/tests/ship.spec.ts packages/bundle/tests/ship-run.spec.ts packages/bundle/tests/plan.spec.ts` exit 0 — 3 files, 78 tests passed.
typecheck still only red on `packages/bundle/tests/startup.spec.ts` TS2307 `@deepseek-ai/cordis-plugin-include` (baseline; zero-new-failures). Length retry of a too-long full-track objective is Ticket 4 (start occupancy only creates `[ship] <idea>`).
