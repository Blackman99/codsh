---
'codsh-cli': patch
'codsh-bundle': patch
---

`pnpm run sync:dsh` stays on the newest `@deepseek-ai/dsh` release whose dependency closure is fully published, so a harness release that names a missing package no longer fails the nightly sync.
