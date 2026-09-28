---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` responds faster: Ctrl+Q quits at once even while dsh is still starting (and no dsh is left behind), text typed during startup is kept, a large paste no longer looks up each of its lines on disk, bursts of typed keys are painted once, a finished answer is shown before the session is read back for auto-compaction, synchronous dsh requests return as soon as they are answered, and the launcher remembers a verified client instead of hashing it on every start. Closing the terminal window now ends the client and dsh instead of leaving them spinning. `scripts/rust-perf-bench.py` measures the installed client against the pinned reference on macOS with thresholds frozen before the candidate runs.
