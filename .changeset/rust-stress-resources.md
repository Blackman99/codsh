---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` quits faster with background work running: dsh no longer stays alive for an extra second after quit because its credentials watcher fell back to watching the whole dsh home (an empty owner-only `.credentials.yaml` is created in the isolated dsh home when none exists; an existing file is never touched, and `/logout` does not count the empty file as a stored credential). The long-lived dsh process keeps Node 22's young-generation size under newer Node, so its memory no longer grows by ~40–55 MiB over the first turns of a session. `scripts/rust-stress-bench.py` measures concurrency and long-run resources (background subagents and commands, workflow pause/resume, a 30-turn session, quit and crash under load) against the pinned reference on Linux, macOS and Windows with thresholds frozen before the candidate runs.
