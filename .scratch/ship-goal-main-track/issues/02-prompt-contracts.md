# Ticket 2: Prompt contracts (prepend, freeze, forbid tools, cites, Ralph)

Blocked by: none
Track: 2, 3, 4, 5, 7

## Delivers

`shipPromptFor(status, { track?, goalId? })`. Grill template includes `$GOAL_ID`. Every phase forbids `create_goal` / `update_goal` / `get_goal` and silent `## Main Track` rewrite after Confirm; a needed contradiction is a blocker. Spec / tickets / land / done prepend the supplied track. Land requires `Track:` on plan lines and a Track-N cite on the first red test or the ticket commit. Ralph's objective carries the sealed track plus the spec path. Phase 5 no longer authorizes silent decision rewrites; progress (Status, checkboxes, proof logs) remains writable.

## Acceptance

- [x] `SHIP_PROMPT` / `shipPromptFor` pin: `## Main Track`, `Track:`, `$GOAL_ID`, forbid goal tools, freeze-after-Confirm, contradiction is a blocker, Track-N cite, Ralph sealed track.
- [x] Grill injection still excludes later phase contracts.
- [x] Spec / tickets / land prepend `track` when provided and still exclude grill.
- [x] `pnpm exec vitest run packages/bundle/tests/ship.spec.ts` exits 0.

## Proof (Track: 2, 3, 4, 5, 7)

Red-first (first failing test, then later slices):
- `pnpm exec vitest run packages/bundle/tests/ship.spec.ts` exit 1 — 1 failed | 21 passed. `passes Goal-Id into grill so the spec header records the session compass (Track: 5)` — expected SHIP_PROMPT to contain `$GOAL_ID`.
- `pnpm exec vitest run packages/bundle/tests/ship.spec.ts -t 'prepends the compact Main Track'` exit 1. `prepends the compact Main Track on later phases without substituting the phase contract (Track: 2)` — expected `startsWith(track)` true, got false.
- `pnpm exec vitest run packages/bundle/tests/ship.spec.ts -t 'forbids goal tools'` exit 1. `forbids goal tools in every phase so the model cannot fight the runner (Track: 7)` — expected grill prompt to contain `create_goal`.
- `pnpm exec vitest run packages/bundle/tests/ship.spec.ts -t 'freezes Main Track after Confirm'` exit 1. `freezes Main Track after Confirm so a contradiction is a blocker not a silent rewrite (Track: 3)` — expected later-phase prompt to contain `## Main Track`.
- `pnpm exec vitest run packages/bundle/tests/ship.spec.ts -t 'requires Track: on plan lines|puts the sealed Main Track'` exit 1 — 2 failed. Missing `Track:` cite tokens and `/sealed track/` in the Ralph objective (Track: 4).

Green: `pnpm exec vitest run packages/bundle/tests/ship.spec.ts` exit 0 — 27 tests passed.
Proof: `pnpm exec vitest run packages/bundle/tests/ship.spec.ts packages/bundle/tests/ship-run.spec.ts packages/bundle/tests/plan.spec.ts` exit 0 — 3 files, 67 tests passed.
typecheck still only red on `packages/bundle/tests/startup.spec.ts` TS2307 `@deepseek-ai/cordis-plugin-include` (baseline; zero-new-failures).
