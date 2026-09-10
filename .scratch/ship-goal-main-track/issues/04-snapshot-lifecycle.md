# Ticket 4: Snapshot prepend + lifecycle + re-assert

Blocked by: Ticket 1, Ticket 2, Ticket 3
Track: 1, 3, 4, 7

## Delivers

After grill handshake (Status interviewing, draft `## Main Track` on disk): edit objective to `[ship]` + draft track, pause. On Status confirmed: snapshot `## Main Track`; later injects of this run prepend that snapshot even if the file is rewritten; edit objective to `[ship]` + sealed track; pause. Land Ralph objective includes the snapshot and the spec path. Every later inject re-asserts: drifted objective edited back; armed goal paused. Status shipped (session write) completes the ship goal. Abort/Esc after placeholder leaves it paused (complete is not called). Always pause after mutate.

## Acceptance

- [ ] After a spec write that seals `## Main Track` and Status confirmed, later injects prepend that snapshot even if the file's Main Track is later rewritten.
- [ ] Re-assert on a later inject: drifted objective edited back; armed goal paused.
- [ ] Status shipped (session write): complete called.
- [ ] Abort/Esc after placeholder: complete is not called.
- [ ] Land prompt / Ralph objective contains the sealed track and the spec path.
- [ ] `pnpm exec vitest run packages/bundle/tests/ship-run.spec.ts packages/bundle/tests/ship.spec.ts` exits 0.
