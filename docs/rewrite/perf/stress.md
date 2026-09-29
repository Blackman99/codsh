# Concurrency and long-run resource stress (#209)

Frozen thresholds and evidence for the installed Rust client against the
pinned Grok 1.0.34 reference under concurrent background work and a long
session. Measured on GitHub Actions `ubuntu-22.04`, `macos-15` and
`windows-2022`. Absolute process-tree RSS is reported, not judged here: the
candidate's Node launcher + dsh tree was accepted as an architecture gap in
#202.

## Method

`scripts/rust-stress-bench.py` (Python 3 + `pyte`, and `pywinpty` on Windows)
does one `bench` run on one machine:

1. measures the pinned reference (SHA-256 checked, never redistributed) under
   one fixed load, several times;
2. freezes per-platform thresholds from those samples with the method below,
   writes `thresholds.json` and logs its SHA-256 *before* any candidate
   process starts;
3. measures the installed candidate (`codsh --rust` from the packed tarball,
   dsh from the registry) under the same load, terminal and fixture, and
   judges it against the frozen file only;
4. checks both products for leftover processes and model traffic after a
   quit and after a crash (SIGKILL / TerminateProcess of the client) under
   load, and what a resumed session shows about work that was running.

Both products talk to one loopback OpenAI-compatible model fixture that
scripts the tool calls with each product's own tool names
(`spawn_subagent` / `run_terminal_command` / `workflow` for the reference,
`subagent` / `bash` / `workflow` for the candidate). Nothing reaches the
network. Thresholds are never loosened after the fact.

Latency ceiling = max(reference p95 × 1.20, reference p95 + 16.7 ms).
Memory-growth ceiling = max(reference p95 × 1.20, reference p95 + 32 MiB).
A metric the reference did not produce in every valid run is not-applicable
and fails the run until the harness measures it on that platform. The
candidate passes a metric when its p95 over every valid run is at or under
the ceiling. Hard requirements, not derived from the reference: no process of
the session tree is left 5 s after a quit or 10 s after a crash; the model
fixture sees no request and no open stream from 2 s after the client is
gone; a resumed session does not claim that the killed work still runs.

The `stress` job of `rust-platforms.yml` runs this on `ci/**` branches whose
name contains `stress` (`STRESS_RUNS` / `STRESS_CRASH_RUNS`, default 5 / 2).

## Load (one fullscreen session per run, 100×32 terminal)

- **fanout:** one prompt makes the model start 4 background subagents (each
  streams 150 lines at 10/s) and 1 background command (400 lines at 20/s);
  typing and scrolling are probed while they run;
- **workflow:** an inline Rhai workflow with 3 streaming children; typing is
  probed, then `/workflow pause stress`, `/workflow resume stress` and
  `/workflow stop stress` from the prompt;
- **long session:** 30 short turns in a row; process-tree and client memory
  after turn 5 and turn 30, typing after the last turn;
- **quit under load:** a second fanout, then quit while it runs;
- **crash under load:** SIGKILL / TerminateProcess the client while the
  fanout runs; then relaunch with `--continue` and check honesty.

## How to re-run

```bash
# After packing and installing the product (see the stress job):
reference=$(python3 scripts/rust-stress-bench.py --fetch-reference /tmp/reference)
python3 scripts/rust-stress-bench.py \
  --reference "$reference" \
  --launcher /path/to/lib/node_modules/codsh-cli/bin/codsh.mjs \
  --runs 5 --crash-runs 2 --output evidence/stress
```

Pass `--only candidate` or `--only reference` for development measurements
without judging.

## Client fixes that land with this ticket

- **Quit under load (dsh stall).** dsh's `credentials-local` plugin watches
  `$DSH_HOME/.credentials.yaml`. When the file was absent, its chokidar
  watcher fell back to the whole dsh home, and every write there during quit
  (session records, MCP catalogs, the last-session marker) armed a 1 s
  readdir throttle timer that closing the watcher did not clear. That timer
  alone kept dsh alive ~1.1 s after Ctrl+Q with background work. Creating an
  empty owner-only `.credentials.yaml` in the isolated dsh home when none
  exists (never replacing an existing file) keeps the watch on the file
  itself. `/logout` does not count that empty file as a stored credential.
- **Long-session process-tree growth (Node 24).** Node 24's larger young
  generation alone added ~40–55 MiB of dsh RSS over the first 20–30 turns
  (a 100-turn run showed sizing, not a leak). The long-lived dsh process is
  started with `--max-semi-space-size=16` so it keeps Node 22's young
  generation; `process.argv` inside dsh is unchanged by a V8 flag.

## Results and remaining gaps

Three-platform run `ci/209-stress-c`
([36465419485](https://github.com/Blackman99/codsh/actions/runs/36465419485)),
5 measured runs + 1 warm-up and 2 crash runs per product, with both client
fixes above. Candidate p95 vs the frozen ceiling (reference p95 in brackets):

| metric | linux-x64 | macos-arm64 | windows-x64 |
|---|---|---|---|
| idle / load / long input | pass | pass | pass |
| load:scroll | pass | pass | pass |
| workflow:input | pass | pass | pass |
| rss:load-growth, rss:long-growth, rss:client-long-growth | pass | pass | pass |
| long:turn | pass (42 ≤ 42) | pass (58 ≤ 59) | **fail** 213 > 125 ms [104] |
| workflow:pause | pass | pass | **fail** 15 253 > 298 ms [248] |
| workflow:resume | **fail** 195 > 77 ms [60] | pass (330 ≤ 385) | **fail** (no sample) [568] |
| quit:under-load | **fail** 404 > 135 ms [113] | **fail** 517 > 249 ms [208] | **fail** 610 > 219 ms [182] |

Hard requirements (no leftover process 5 s after quit / 10 s after crash, no
model request or open stream from 2 s after exit, resume does not claim the
killed work still runs) pass for the candidate on all three platforms.

Causes found so far:

- **quit:under-load.** The 1.1 s stall is gone (Linux box: ~1 306 → ~300 ms).
  What remains is dsh's own `session/close` under load (stopping 4 background
  subagents and a command, flushing their sessions): ~90 ms in a fresh
  session and ~200 ms after the 30-turn session, then dsh exit and the Rust /
  Node launcher exit. The reference tears down in-process.
- **workflow:resume (Linux).** The engine restarts in ~12 ms; the time is in
  dsh creating the three child agents (`subagents.start`, ~13 ms each,
  serialised) and each child preparing its first model request (~50 ms).
- **Windows workflow pause / resume.** `/workflow pause` answered
  "dsh closed the control channel": the loopback-TCP control channel between
  the Rust client and dsh (used by `/workflow`, steer and `/btw`) was already
  closed, so the pause never reached dsh and the children ran to completion
  (~15 s). Not yet diagnosed.
- **Windows long:turn.** The first five turns match the reference (~108 vs
  ~104 ms); by turns 26–30 the candidate takes ~207 ms. Not yet diagnosed.
- **Windows harness floor.** Through ConPTY + pywinpty both products show a
  ~100 ms echo floor, so Windows input latencies compare coarse numbers.

### Decision (Kara, 2026-09-29 CST)

Kara accepted closing #209 with the two client fixes above integrated and
the four remaining gaps — quit under load (Linux, macOS, Windows), Linux
workflow resume, the Windows `/workflow` control-channel bug and Windows
late-session turn time — tracked in
[#221](https://github.com/Blackman99/codsh/issues/221). Thresholds were not
loosened.

## Runs kept here

| label | branch / run | role |
|---|---|---|
| — | `ci/209-stress-a`, [36456545956](https://github.com/Blackman99/codsh/actions/runs/36456545956) | credentials fix only; long-session growth ~55 MiB on Linux / macOS (Node 24) |
| stress/ | `ci/209-stress-c`, [36465419485](https://github.com/Blackman99/codsh/actions/runs/36465419485) | both client fixes |

`stress/<platform>/` keeps `thresholds.json`, `report.json` and `report.md`
from the Actions artifact `stress-<platform>`. Raw JSON samples and the bench
log stay in the artifact.
