# Frozen reference register (#133)

This directory records reference research, not a rewritten application. The
behavior target is **Grok 1.0.34 (3736acbc8658)**. The separately pinned public
source is **1.0.35**, commit `a28ee2b2063426e8816e380ccea528b9de95e5da`, monorepo
revision `e8563f8f182296ebb53cadb3e1eab7615d76408e`. Exact correspondence is
unproven. The preceding inspected export declares 1.0.32, not 1.0.34.

## Audit files

- `provenance.json`: binary hash, source revisions, licenses/notices, guide
  differences, and explicit import/distribution boundaries.
- `discovery.json`: individual commands, flags/aliases, settings, environment
  switches, tools, feature gates, keys, documented behaviors and public ACP
  declarations. Each has exact source/guide line or captured observation
  locators and verbatim evidence. Source-only items remain provisional.
- `inventory.json`: one row per discovery identity, with story IDs, live GitHub
  ticket IDs, planned acceptance scenario IDs, evidence locators and blockers.
  Every row is `pending-parity`; no rewrite capability is claimed implemented.
  Acceptance scenarios are parameterized by the exact discovery row and its
  quoted contract, not merely by a feature-family label. They are **planned**,
  not executable candidate tests or passing results.
- `observations.json`: 76 actual CLI observations, all 27 guides emitted by the
  pinned binary into a fresh home, ten real PTY recordings (five per mode), and
  five process-start samples. PTY chunks retain base64 bytes, timestamps,
  actions, sizes, sampled RSS and hashes. No personal session was copied.
- `model-observations.json`: four real headless formats driven by a deterministic
  loopback-only SSE model fixture; actual advertised tool schemas are retained.
  Request messages and credentials are not retained. No tool is executed by the
  fixture and no agent is spawned.
- `follow-ups.json`: scoped local task proposals for exact source correspondence,
  private-worker registration, provisional deployment tools and expanded performance
  measurements. GitHub publication requires separate authorization.
- `dimensions.json`: explicit mode, native-platform, terminal-emulator and service
  dependency matrix linked to concrete inventory identities and owning tickets.
- `baseline.json`: statistics reproducibly derived from raw samples and the
  prospective threshold method. No candidate measurements exist.
- `UPSTREAM-*`: unmodified license and notice texts for quoted public material.
  Hashes and original locations are in provenance. They are not a license audit
  of a future codsh Rust distribution.

### Locator semantics

`capture:commands/N` selects `observations.json.commands[N]`.
`model:requests/N/tools/NAME` selects a tool schema in the model capture.
`binary-guide:FILE#Lx` selects line x of the named embedded guide in observations.
`source-guide:FILE#Lx` selects the pinned public pager `docs/user-guide/FILE`.
`source:PATH#Lx` selects the pinned public source path. Guide content and source
hashes distinguish 1.0.34 declarations from 1.0.35 declarations; conflicting
observations are retained rather than resolved by silently choosing the newer one.

## Completeness and limits

The machine check requires set equality between discovery and inventory, unique
identities, valid story/ticket ownership, an acceptance scenario for every owner,
real evidence locators and explicit pending blockers. Tests deliberately delete
rows, duplicate identities, remove owners and fabricate verification to prove the
check rejects them. Re-extraction from the pinned clean source checkout and raw
captures detects discovery drift; review any diff rather than regenerating a
smaller register to make validation green.

The extraction covers the complete recursive **visible** installed help tree,
all binary-emitted guide headings/behavior paragraphs/table rows, all published
config-reference fields and all TOML example fields (including pager/Grove settings), source slash registries and
macros, tool IDs/constants, boolean feature registry, source CLI declarations
(including hidden options), and named public ACP declarations. It intentionally
retains over-inclusive source metadata pending classification. It cannot prove
absence of undocumented or account-gated behavior. Feature/service/platform
variants described in each excerpt remain required even when not runnable here.

Important reconciliations:

- Installed help includes `clone` and `cursor-worker`; public source availability
  alone does not establish build-flag parity. Remote-worker connection belongs to
  #190/#207; clone/Grove variants belong to #191/#201.
- Runtime model schemas advertise `spawn_subagent`,
  `get_command_or_subagent_output`, `kill_command_or_subagent`, and `write`.
  Source tool IDs such as `task` and `run_terminal_cmd` are not interchangeable
  proof of the installed wire names.
- Small/hidden commands (`/cd`, `/queue`, `/tasks`, `/voice`, `/gboom`, diagnostics,
  aliases), media, management, remote services and feature gates remain itemized.
- Source-declared deployment tools `deploy_app`/`init_or_update_app` are assigned
  to remote-service research, but their presence in 1.0.34 is **unverified**.
  If they are confirmed and exceed #190's accepted scope, add a dedicated local
  ticket proposal before implementation; never use the final audit as catch-all.
- Linux/Windows behavior, real remote/auth/media substitutes, OS confinement,
  long-session recovery and model task success have not been exercised here.
  They remain downstream acceptance work, not reasons to change the target.

## Replay safely

See CONTRIBUTING for exact commands. Python 3.10+ and macOS `sandbox-exec` are
required for the installed-reference driver; the driver refuses unsupported hosts
rather than falling back to unconfined execution. The ordinary register/evidence
unit tests require only the repository's locked Node dependencies.

The probe environment is allowlisted, with fresh HOME/GROK_HOME/workspace,
synthetic fixture credentials, no inherited tokens or SSH agent, disabled updater,
telemetry, managed MCP and remote fetch, filesystem writes confined to the fixture,
personal-home reads denied except the selected executable, and keychain access
denied. Offline probes deny all networking. Model probes allow only the one
local TCP fixture port. Safety tests attempt actual forbidden file reads/writes
and network connections; they do not just inspect the sandbox profile string.

A reference UI may say “Logged in with API key” because the supplied key is a
synthetic string. That is not authentication to any official account. Do not copy
real `auth.json`, settings, sessions, memory or credentials into this directory.

## Performance interpretation

The five-run pilot records warm-cache startup, visible draft response, settings
opening, next-frame scroll/resize response, emitted bytes and sampled parent RSS
on Apple M4 Pro / Darwin arm64. Latency includes driver polling and a 30ms settle;
next-frame arrival is not full reflow latency. Settings scroll is not a long
transcript benchmark. Parent RSS is not a process-tree peak. Minimal mode does not
enter/leave the alternate screen; successful `/quit` exits zero in both modes.

Before candidate measurements, #202/#209 must run at least 30 valid reference
samples for each agreed workload/platform and commit raw evidence plus numeric
thresholds. The fixed method is p95 latency ≤ max(reference p95 × 1.20,
reference p95 + 16.7ms), median throughput ≥ reference median × 0.90, and
process-tree resource ceilings/growth as specified in `baseline.json`. Repeat
reference/candidate on identical hardware, fixture timing, terminal dimensions,
power/cache policy and alternate run order. Invalid runs stay in the record.
Changing the method after seeing candidate results requires a reviewed decision,
not a silent threshold adjustment.

No Changeset is included: no released package, CLI option, user-facing behavior,
dependency or default was changed. Developer workflow and scoped architecture
rules are documented here, in CONTRIBUTING, CONTEXT and ADR-0002.
