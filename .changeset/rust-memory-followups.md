---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` memory fixes from the real-model check of #186: the first `/flush` after a restart or `--resume` now sends the delta prompt against the session's last flush on disk instead of re-summarizing (and duplicating) the whole window; first-turn recall uses the reference keyword search (stop words dropped, any keyword matches, best match first), so a conversational question finds session logs before any Dream; `[memory_v2] enabled = true` no longer adds an `unknown security/policy field` warning to `inspect` next to its refusal; and a `Dream is already running` refusal is cleared once the running job reports.
