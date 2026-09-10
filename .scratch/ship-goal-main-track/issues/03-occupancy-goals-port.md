# Ticket 3: Occupancy + ShipGoals port + degrade + composition wire

Blocked by: Ticket 1, Ticket 2
Track: 1, 5, 6, 9

## Delivers

Optional `ShipGoals` and occupancy Selector ports on `ShipRun`. Occupancy runs before the first phase turn: pause a stranger immediately, then `ship · occupancy` (Replace / Abort). TTY cancel/Esc = Abort (resume stranger, inject nothing). Absent ask / non-TTY = auto-Replace. Ours = spec `Goal-Id:` match or objective starts with `[ship]` → edit/pause, no ask. No current / complete: create `[ship] <idea>` then pause; pass id into grill. Missing or throwing port degrades (flash, continue spec+prepend). Length rejection retries once as `[ship] <idea>` then degrades the harness half. Composition root wires `ctx.goals`, `prompt.select`, and flash. No extra chrome row.

## Acceptance

- [ ] No current goal: create then pause before the first injected prompt; grill prompt contains the Goal-Id.
- [ ] Stranger on a TTY: pause, ask; Replace clears then creates; Abort resumes stranger and injects nothing; Esc same as Abort.
- [ ] Absent ask: auto-Replace without asking.
- [ ] Ours by Goal-Id or `[ship]` prefix: no ask, edit/pause.
- [ ] Goals port missing or create/pause throwing: `run()` does not throw; injects still happen.
- [ ] Index constructs `ShipRun` with the ports.
- [ ] `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts` exits 0.
- [ ] `pnpm run typecheck` exits 0.
