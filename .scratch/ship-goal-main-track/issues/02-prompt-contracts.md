# Ticket 2: Prompt contracts (prepend, freeze, forbid tools, cites, Ralph)

Blocked by: none
Track: 2, 3, 4, 5, 7

## Delivers

`shipPromptFor(status, { track?, goalId? })`. Grill template includes `$GOAL_ID`. Every phase forbids `create_goal` / `update_goal` / `get_goal` and silent `## Main Track` rewrite after Confirm; a needed contradiction is a blocker. Spec / tickets / land / done prepend the supplied track. Land requires `Track:` on plan lines and a Track-N cite on the first red test or the ticket commit. Ralph's objective carries the sealed track plus the spec path. Phase 5 no longer authorizes silent decision rewrites; progress (Status, checkboxes, proof logs) remains writable.

## Acceptance

- [ ] `SHIP_PROMPT` / `shipPromptFor` pin: `## Main Track`, `Track:`, `$GOAL_ID`, forbid goal tools, freeze-after-Confirm, contradiction is a blocker, Track-N cite, Ralph sealed track.
- [ ] Grill injection still excludes later phase contracts.
- [ ] Spec / tickets / land prepend `track` when provided and still exclude grill.
- [ ] `pnpm exec vitest run packages/bundle/tests/ship.spec.ts` exits 0.
