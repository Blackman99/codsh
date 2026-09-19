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
- `small-command-observations.json`: two supplemental offline PTYs from the same
  frozen binary. They retain byte-exact announcement usage, GBOOM graphics refusal,
  dashboard/location-picker and minimal-mode outcomes. They are separate from the
  unchanged original captures and performance samples. Actual banners, a subsequent
  agent's cwd, active overlay rendering and argument passthrough remain unverified.
- `source-evidence.json`: source file hashes and line counts, exact referenced
  line fragments, public guide text, independently extracted source-surface
  expectations, and command enum/argument relationships from the clean pinned
  checkout. Expectations are generated directly from source, not from surviving
  discovery rows. These are research quotations, not a buildable Rust import.
- `observations.json`: 98 actual CLI observations, all 27 guides emitted by the
  pinned binary into a fresh home, ten baseline PTY recordings (five per mode),
  paired `GROK_FPS=0/1` PTYs, fullscreen/minimal tutorial and help/docs/debug
  PTYs, and five process-start samples. PTY chunks retain base64 bytes, timestamps,
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
`capture:environmentProbes/N/events/M` selects a raw output event from an isolated
paired environment probe. `capture:tutorialProbes/N/events/M` selects an output
event from the real tutorial/alias/mode probe. `capture:uiProbes/N/events/M`
selects a help palette, guide reader or diagnostic probe event.
`model:requests/N/tools/NAME` selects a tool schema in the model capture.
`binary-guide:FILE#Lx` selects line x of the named embedded guide in observations.
`source-guide:FILE#Lx` selects the pinned public pager `docs/user-guide/FILE`.
`source:PATH#Lx` selects the pinned public source path. Guide content and source
hashes distinguish 1.0.34 declarations from 1.0.35 declarations; conflicting
observations are retained rather than resolved by silently choosing the newer one.

## Completeness and limits

The machine check requires set equality between discovery and inventory, unique
identities, valid story/ticket ownership, an acceptance scenario for every owner,
resolved evidence locators and explicit pending blockers. It re-extracts captured
commands, guides and model schemas; checks source path/line bounds and exact quoted
fragments; and enforces the pinned binary hash across discovery, captures and
provenance. Source evidence itself is hashed in provenance and can be regenerated
from the pinned checkout. The portable check also requires every independently
extracted source surface and observation—even if removed from both discovery and
inventory—and every source-derived command path must have an actual help probe.
Tests delete all source-only rows together, or individual source declarations,
while recomputing the register digest; those mutations must fail.
Tests deliberately delete rows, duplicate identities,
remove owners, invent capture/source locations, alter binary hashes, and fabricate
verification—even after recomputing the register digest—to prove rejection. Re-extraction from the pinned clean source checkout and raw
captures detects discovery drift; review any diff rather than regenerating a
smaller register to make validation green.

The help probe seeds traversal with source-declared command enums and their
nested argument relationships, including hidden roots and aliases, then expands
the visible binary help tree. Every invocation ends in `--help`; no share, remote
start/stop, login, update or plugin action is executed. Source-only paths rejected
by the frozen binary are recorded as unavailable/unverified, not silently removed.
The extraction covers that combined installed help tree,
all binary-emitted guide headings/behavior paragraphs/table rows, all published
config-reference fields and all TOML example fields (including pager/Grove settings), source slash registries and
macros, tool IDs/constants, boolean feature registry, source CLI declarations
(including `clap` attributes, camelCase compatibility aliases and hidden options),
quoted environment-control names throughout the exported Rust crates and `prod/`,
and named public ACP declarations. Source environment controls remain provisional
unless separately observed; build/test/service knobs are not automatically release
features. It intentionally
retains over-inclusive source metadata pending classification. It cannot prove
absence of undocumented or account-gated behavior. Feature/service/platform
variants described in each excerpt remain required even when not runnable here.

Ownership is reproducible using committed `scripts/reference-mapping.mjs` and
`reference-scenarios.mjs`, not an untracked generator. The mapping reads exact
ancestor headings from retained guides, applies guide defaults and narrow section
overrides, and dispatches ACP/config/command names by their namespace. A shared
word such as “update,” “headers,” “prompt” or “feedback” cannot override a domain.
The checker regenerates owners and scenarios to detect internally consistent but
semantically wrong register edits. Tests exercise cross-category and nested-heading
collisions as well as concrete frozen rows. Captured ticket metadata is reused;
regeneration does not contact GitHub. Reproducibility is a consistency check, not
an independent oracle for correct ownership: regression expectations are grounded
in guide/source contracts. Merged documented settings retain their functional
namespace owners alongside contextual enterprise requirements; generic appearance
or configuration defaults cannot displace functional section owners.

Important reconciliations:

- UI approval/yolo, follow-up routing/merging, child cancellation and `simple_mode`
  belong to permissions, queue/steer, cancellation/child lifecycle and prompt editing.
  Screen mode, voice capture/keybindings/language, fork model selection and rewind
  confirmation retain their functional owners rather than appearance-only tests.
  `/vim-mode` and `ui.vim_mode` instead control scrollback navigation/copy and the
  off-mode transition back to prompt focus. Alternate-screen TOML examples retain
  screen-mode ownership.
  `toolset.bash`, questions and web restrictions use their tool domains; compatible
  Hooks/MCP switches do not inherit Skills ownership. Managed MCP, model endpoint,
  folder-trust and permission environment aliases follow their actual effects.
- `COLORFGBG`, `LC_GROK_THEME` and `COLORTERM` have individual frozen-guide and
  pinned-source evidence with renderer ownership. Extraction accepts unprefixed
  env hints, assignment forms, env-map lookups and literal key-loop lookups; the
  generic CLI syntax placeholder `KEY=value` is not an environment identity.
  Enclosing environment-table headings and process `.env("NAME", ...)` injection
  are also extracted. `CLAUDE_PROJECT_DIR` and `GROK_WORKSPACE_ROOT` belong to
  hook runner identity/override protection, not remote workspaces. Explicit config
  alias relationships drive documented environment ownership; incidental mentions
  such as a crash file under `$GROK_HOME` do not reclassify that variable.
- `GROK_CONFIG`/`GROK_CONFIG_PATH` and their guide contracts include management,
  permission and child-environment security acceptance. Tests must attempt forbidden
  process/auth/endpoint/trust/discovery/env-value injections and confirm the soft
  allowlist, raw-disk gates, requirements/MDM precedence and malformed-input fallback.
- `/import-claude` belongs to #193 configuration import: permissions, environment,
  MCP servers, hooks and paths, not #194 session-history import. Planned acceptance
  preserves originals, requires explicit selection and retains trust/credential gates.
- ACP `x.ai/review/comment` and `/delete` upload code-review citation/tombstone
  events, unlike plan review. Their #147/#192 acceptance checks consent, configured
  destination and actual outbound records; an immediate protocol acknowledgement
  does not prove asynchronous upload completion.

- All hook-guide behaviors stay under #164. UserPromptSubmit adds #151/#138 and
  checks blocked text exclusion from provider context/durable history, suspended
  queues, observe-only automatic turns, local recall and documented fail-open timeout.
- All sandbox-guide contracts have #143/#144 actual confinement acceptance,
  including kernel write denial, parent rename protection, symlink refusal and
  fail-closed startup. Security rows in getting-started, headless, plugins, model
  requirements and configuration guides retain their security owners too.
- MCP stdio/HTTP/SSE, headers, session IDs and remote authentication use #167/#168
  handshake/result/reconnect scenarios. `MCP_TIMEOUT` and `MAX_MCP_OUTPUT_BYTES`
  have individual binary-guide, source-guide and source-declaration evidence;
  precedence, millisecond rounding, malformed values, byte truncation and spill
  remain planned installed-MCP tests, not measured enforcement claims. Extraction
  includes documented env names and literal env reads/named constants beyond
  GROK/XAI/OTEL prefixes, retaining build/platform controls provisionally.
- Model headers use #140 wire assertions, including case-insensitive inheritance,
  environment/static precedence and no leakage to media services. Every ACP row
  retains #147; session updates/replay/chunks additionally involve #148/#138 and
  require pagination, order, completion, routing and explicit errors. Plan feedback
  is #179 review/revision behavior, not #192 product feedback.
- `/announcements`, `/cd` and `/gboom` have dedicated banner, dashboard-cwd and
  overlay/passthrough acceptance. The supplemental PTYs establish only observed
  idle/error behavior: `/cd` initially leaves an autocomplete placeholder; Ctrl+L
  opens the actual location picker. A following invalid path includes that retained
  placeholder. No agent was dispatched, banner injected or graphics capability
  fabricated; these full 1.0.34 behaviors remain explicitly unverified. No-op
  show/hide and unavailable commands can emit no new frame, so their failed raw
  frame-wait markers are retained and are not promoted to behavioral success;
  evidence tests assert reconstructed screens only for actually observed outcomes.

- The entire permissions-and-safety guide maps to #142's effect-based rule/mode
  acceptance, with #164 hook-ordering, #141 administration and #143/#144
  confinement owners where applicable. Permission “rules,” “authorization” and
  “prompt” do not mean Skills discovery, OAuth or composer editing. These are
  planned controlled-effect tests, not security behavior verified by #133.
- `/help` is a command palette; `/docs`, `/howto` and `/guides` are interactive
  guide pickers/readers. #154 scenarios cover filtering, selection, scrolling,
  aliases, invalid targets and nested dismissal. `/debug` and `/scroll-debug`
  have separate real-terminal/local-log acceptance. Offline observations cover
  palettes/readers, fullscreen FPS toggle, error paths and prompt recovery;
  browser opening, other diagnostic variants and active draft/queue preservation
  remain downstream work.
- The dock gate/config/environment entries map to #152's pane-navigation
  acceptance plus queue/child/task/watcher owners. Frozen 1.0.34 enabled-dock
  availability and behavior remain explicitly unverified; a declaration is not
  evidence of working panes. The idle help/docs/debug probe does not verify dock.

- Hidden `share` and `workspace start/pause/resume/stop/restart/status`, `list`
  alias and all their observed flags are itemized. Sharing belongs to #162;
  workspace exposure, its gate and hub URL belong to #190 with a controlled-hub
  acceptance scenario. Help recognition is not a remote-execution claim.
- `/tutorial`, `/tour`, `/onboarding` and tutorial behavior rows belong to #154's
  dedicated interactive acceptance. Real PTYs opened topics, moved next/previous,
  returned to the list, dismissed aliases and continued typing; minimal mode
  refused with the fullscreen remedy. Existing-session draft/queue preservation
  remains part of downstream acceptance, not inferred from these idle probes.

- Isolated missing-value probes confirm recognition of `--allowedTools`,
  `--disallowedTools`, `--system-prompt`, `--append-system-prompt`,
  `--compaction-mode` and `--compaction-detail`. Recognition is not proof of
  their execution semantics. `/log` and `/summarize` are recorded source aliases.
- Paired real terminal runs show the FPS overlay with `GROK_FPS=1` and no overlay
  with `0`. Its renderer acceptance is separate from CLI help. Global shortcuts
  are assigned by action/context; headless input file/JSON/system-prompt options
  have provider-wire acceptance rather than composer-editing scenarios.
- Both the executable model probe and retained-evidence tests parse every
  structured format. They verify text, stop reason, session identity and exactly
  one final `end`/`result` record; marker text alone is not passing evidence.

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
