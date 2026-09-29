# macOS interaction performance (#202)

Frozen thresholds and before / after reports for the installed Rust client
against the pinned Grok 1.0.34 reference on GitHub Actions `macos-15`
(Apple M1 Virtual, 3 CPUs, ~7 GiB).

## Method

`scripts/rust-perf-bench.py` (Python 3 + `pyte`) does one `bench` run on one
machine:

1. measures the pinned reference (SHA-256 checked, never redistributed) in
   both screen modes: cold and warm start, typing, a large paste, a long
   streamed answer, scroll, resize, quit and process-tree memory;
2. freezes numeric thresholds from those samples with the method recorded in
   `docs/rewrite/reference/baseline.json`, writes `thresholds.json` and logs
   its SHA-256 *before* any candidate process is started;
3. measures the installed candidate (`codsh --rust` from the packed tarball,
   dsh from the registry) with the same terminal, fixture and data,
   alternating with reference control sessions, and judges it against the
   frozen file only.

Both products talk to one loopback model fixture, so model / network time is
reported apart from client and adapter overhead. Everything runs in fresh
temporary Homes. Thresholds are never loosened after the fact.

Latency ceiling = max(reference p95 × 1.20, reference p95 + 16.7 ms).
Throughput floor = reference median × 0.90. Resource ceiling = reference p95
× 1.20. A metric the reference did not produce in every valid run is
not-applicable.

The `macos-perf` job of `rust-platforms.yml` runs this on branches whose name
contains `perf` (`PERF_RUNS` / `PERF_COLD_RUNS`, default 30). A full run takes
most of an hour of a macOS runner.

## How to re-run

```bash
# On macos-15, after packing and installing the product and fetching the
# pinned reference (see the macos-perf job):
python3 scripts/rust-perf-bench.py \
  --reference /path/to/grok-1.0.34-macos-aarch64 \
  --launcher /path/to/lib/node_modules/codsh-cli/bin/codsh.mjs \
  --runs 30 --cold-runs 30 --purge --output evidence/perf
```

Elsewhere, pass `--only candidate` for measurements without judging (the
pinned reference is the macOS arm64 build).

## Runs kept here

| label | branch / run | role |
|---|---|---|
| before/ | `ci/202-perf-before-c`, [36396967149](https://github.com/Blackman99/codsh/actions/runs/36396967149) | reference baseline + candidate *before* the #202 client fixes (unread poll + verify cache only) |
| after/ | `ci/202-perf-after-f`, [36420609436](https://github.com/Blackman99/codsh/actions/runs/36420609436) | candidate after the full set of #202 fixes |

`before/` and `after/` each keep `thresholds.json`, `report.json` and
`report.md` from the Actions artifact `macos-perf`. Raw JSON samples and the
bench log are not checked in (they are ~650 KiB per run); download the
artifact to inspect them.

## Headline before → after (fullscreen p50)

Numbers below use the frozen thresholds of each run (they drift a little with
CI noise; the control column in `report.md` records that). Units are
milliseconds unless noted. Final after = `ci/202-perf-after-f` run 36420609436.

| metric | before p50 | after p50 / p95 | limit (after) | verdict |
|---|---|---|---|---|
| start:first-output | 133 | 89 / 141 | ≤ 69 | fail |
| start:ready | 138 | 92 / 145 | ≤ 928 | pass |
| input:draft | 3 | 1 / 2 | ≤ 24 | pass |
| input:paste | 54 | 21 / 33 | ≤ 47 | **pass** (was fail) |
| output:first-visible | 375 | 186 / 246 | ≤ 105 | fail |
| output:end-after-model | 240 | 72 / 102 | ≤ 166 | **pass** (was fail) |
| output:throughput | 291 K B/s | 935 K / 1268 K | ≥ 663 K | **pass** (was fail) |
| quit:exit | 679 | 35 / 74 | ≤ 264 | **pass** (was fail) |
| rss:tree-peak | 329 MiB | 305 / 312 MiB | ≤ 129 MiB | fail |

Minimal: paste, quit, throughput pass; `start:first-output`, `first-visible`,
`end-after-model` and `rss:tree-peak` still fail (same causes as fullscreen).

## Breakdown (why some metrics stay above the reference)

Measured on the after-f run (fullscreen, candidate median):

| part | candidate | reference (same fixture) | note |
|---|---|---|---|
| output:submit-to-request | ~120–140 ms | ~40–50 ms | dsh 0.1.5-rc.3 ACP turn start |
| output:model-stream | ~7–9 ms | ~7 ms | fixture itself |
| start:connected | ~1 s | n/a | dsh ACP startup; UI is interactive before this |
| rss:client-peak | ~18 MiB | ~105 MiB | Rust client alone |
| rss:tree-peak | ~305 MiB | ~102 MiB | Node launcher + dsh Node dominate the tree |

dsh 0.1.5-rc.3 delivers a long answer as one `agent_message_chunk` (no ACP
streaming of tokens). `first-visible` therefore cannot beat the full
submit-to-chunk path; the reference streams tokens into the transcript.

## Fixes that moved the numbers (#202)

- ACP unread counter + 8 ms `wait_for_input` slices (no 80 ms sleep while dsh is silent).
- Launcher remembers a verified client (`~/.codsh-rust/artifact-verified.json`).
- Hangup watchdog: SIGHUP / POLLHUP ends the client, dsh and the launcher (`_exit(129)` after a 2 s grace) instead of spinning on `read()==0`.
- First `connect()` on a worker thread; Ctrl+Q during connect exits at once and kills the dsh group; keys typed during connect are kept.
- Large paste: stop resolving each line as a workspace file drop on the first non-file line; coalesce typed-key frames.
- Auto-compaction session read runs off the event loop so the finished answer is painted first.
- Synchronous ACP requests (including `session/close` at quit) return when answered instead of waiting out a 50 ms pump slice.

## Accepted gaps (Kara, 2026-09-28 CST)

Kara accepted the three remaining regressions against the frozen reference
so #202 can close. Thresholds were **not** loosened; the numbers below are
from `ci/202-perf-after-f` run
[36420609436](https://github.com/Blackman99/codsh/actions/runs/36420609436)
(`docs/rewrite/perf/after/`). Paste, quit, throughput and fullscreen
`end-after-model` already pass those limits.

| Gap | Measured (fullscreen after-f) | Frozen limit | Cause |
| --- | --- | --- | --- |
| `output:first-visible` | p50 **186 ms** / p95 246 ms | ≤ **105 ms** | dsh 0.1.5-rc.3 ACP turn start ~120–140 ms (reference ~40–50 ms) and the long answer arrives as **one** `agent_message_chunk` — no ACP token streaming — so first paint cannot beat the full submit→chunk path. Fix needs a newer dsh or a different transport, not more client paint work. Minimal mode fails the same way (p50 206 ms vs ≤ 80 ms); minimal `end-after-model` also fails (p50 90 / p95 406 vs ≤ 152) for the same dsh timing. |
| `rss:tree-peak` | p50 **~305 MiB** (report median 312552 KiB ≈ 305 MiB) / p95 ~312 MiB | ≤ **~129 MiB** (ceiling 132077 KiB) | Architecture: Node launcher + dsh Node dominate the process tree. The Rust client alone is ~18 MiB; the reference is a single ~100 MiB process. Accepting the multi-process stack, not a client leak. |
| `start:first-output` (warm) | p50 **89 ms** / p95 141 ms | ≤ **69 ms** | Warm-start first paint; Node launcher + CI noise. Cold start already passes. Median is close; p95 still crosses the ceiling on some runs. |

These three stay documented product differences for the rewrite vs Grok 1.0.34
on macOS-15. Closing #202 does **not** change the frozen `thresholds.json`
or claim the gates pass.

## Minor UX note (not a gate)

The fullscreen "→ expand" fold hint does not expand answers; Tab / Enter /
End does. Left as a follow-up, not part of the performance gate.

## Related

- [stress.md](./stress.md) — concurrency and long-run resource stress (#209)
  on Linux, macOS and Windows against the same pinned reference.
