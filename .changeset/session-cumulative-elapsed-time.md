---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): display cumulative session duration in turn summary and /status

Display cumulative session elapsed time alongside turn duration in the turn footer when multiple turns have run (`15s (thought 4.2s) · session 4m 30s · 3.2k tokens`). Also report session duration (including active execution time) in `/status`.
