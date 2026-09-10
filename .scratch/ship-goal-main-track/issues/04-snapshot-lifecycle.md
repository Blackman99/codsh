# Ticket 4: Snapshot prepend + lifecycle + re-assert

Blocked by: Ticket 1, Ticket 2, Ticket 3
Track: 1, 3, 4, 7

## Delivers

After grill handshake (Status interviewing, draft `## Main Track` on disk): edit objective to `[ship]` + draft track, pause. On Status confirmed: snapshot `## Main Track`; later injects of this run prepend that snapshot even if the file is rewritten; edit objective to `[ship]` + sealed track; pause. Land Ralph objective includes the snapshot and the spec path. Every later inject re-asserts: drifted objective edited back; armed goal paused. Status shipped (session write) completes the ship goal. Abort/Esc after placeholder leaves it paused (complete is not called). Always pause after mutate.

## Acceptance

- [x] After a spec write that seals `## Main Track` and Status confirmed, later injects prepend that snapshot even if the file's Main Track is later rewritten.
- [x] Re-assert on a later inject: drifted objective edited back; armed goal paused.
- [x] Status shipped (session write): complete called.
- [x] Abort/Esc after placeholder: complete is not called.
- [x] Land prompt / Ralph objective contains the sealed track and the spec path.
- [x] `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts packages/bundle/tests/ship.spec.ts` exits 0.

## Proof (Track: 1, 3, 4, 7)

Red-first:
- `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts -t 'prepends the Confirm snapshot'` exit 1 — 1 failed | 22 skipped. `prepends the Confirm snapshot on later injects even if the file Main Track is rewritten (Track: 3,4)` — expected prompt to contain `**Idea.** Bind /goal into /ship.`, received the phase contract with no snapshot prepend.
- `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts -t 're-asserts a drifted or armed compass'` exit 1. `re-asserts a drifted or armed compass on later injects (Track: 1,7)` — expected log to include `edit:goal-new:[ship] ## Main Track…`.
- `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts -t 'edits the compass to the draft|leaves the placeholder paused on abort|puts the sealed track and spec path'` exit 1 — 2 failed | 1 passed. `edits the compass to the draft then the sealed track and completes on shipped (Track: 7)` — expected draft-track edit; `puts the sealed track and spec path into the land Ralph objective (Track: 4)` — expected land prompt to contain the spec path.

Green: `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts` exit 0 — 27 tests passed (Confirm snapshot prepend, re-assert edit-back + pause, draft then sealed then complete, abort leaves paused, Ralph land prompt carries sealed track + spec path).
Proof: `pnpm exec vitest run packages/bundle/tests/ship.spec.ts packages/bundle/tests/ship-run.spec.ts packages/bundle/tests/plan.spec.ts` exit 0 — 3 files, 83 tests passed.
typecheck still only red on `packages/bundle/tests/startup.spec.ts` TS2307 `@deepseek-ai/cordis-plugin-include` (baseline; zero-new-failures).
