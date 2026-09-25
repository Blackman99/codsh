---
'codsh-cli': minor
'codsh-bundle': minor
---

`codsh --rust` captures memory: the end of a session saves a metadata summary to `sessions/`, `/flush` (and an idle flush) appends a model-written summary of the last 20 messages to the daily session log, and `/dream` (and the gated automatic Dream at launch) merges the session logs into the workspace `MEMORY.md` under a cross-process lock. Each call names the route, what was sent and the token usage; the cost is not reported. Existing logs are appended to, a `MEMORY.md` edited while Dream ran is kept, and the previous `MEMORY.md` and consolidated logs move to `sessions/.archive/`. `/memory` then `s` shows content-free diagnostics. `GROK_MEMORY_LOG` writes content-free event lines, `--memory-flush` flushes after a `-p` turn, and `[memory_v2] enabled = true` is refused because that store is not implemented.
