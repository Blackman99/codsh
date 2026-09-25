---
'codsh-cli': minor
'codsh-bundle': minor
---

`codsh --rust` saves scheduled loops with their session and restores them on `--continue`, `--resume`, or `/resume`. A loop whose fires were missed while nothing ran fires once, an expired loop is removed without firing, and a fire that was running when its process ended is shown as `outcome unknown` and never run again. `durable: true` is accepted when the session has an owner. Only the client holding the session owner lock saves and fires loops, so a second client or a lost lock does not fire a loop a second time (fires are not exactly-once: an interrupted one is reported unknown, not retried); deletes and durable expiries are reported only after they are saved. Loop rows show saved, durable, paused, the last outcome, and a changed permission mode; with subagents off saved loops are listed as paused.
