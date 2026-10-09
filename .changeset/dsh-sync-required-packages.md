---
'codsh-cli': patch
'codsh-bundle': patch
---

`pnpm run sync:dsh` no longer selects a harness release that drops a package codsh depends on (0.1.7 renamed `dsh-agent-presets`). It falls back to the newest release in the current range and names what blocked the newer one, and co-released cordis packages now follow the selected harness instead of their own latest tag.
