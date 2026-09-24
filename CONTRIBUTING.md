# Contributing to codsh

Thanks for helping! codsh is a [dsh](https://github.com/deepseek-ai/deepseek-harness) bundle: this repository owns the terminal surface and the coding-agent preset; everything underneath is the released dsh packages. Changes to the harness itself belong upstream — this repo never forks it.

Not sending a patch? Open an [issue](https://github.com/Blackman99/codsh/issues) or a [discussion](https://github.com/Blackman99/codsh/discussions). Windows, third-party endpoints, and “I came from Claude Code / Codex” are welcome even as incomplete reports — they tell other people the project is lived in.


## Getting started

```sh
pnpm install
pnpm run dev              # build → sync into .dev-home → boot with ~/.dsh models
MOCK=markdown pnpm run dev    # keyless, against the e2e mock model
MOCK=questions pnpm run dev   # consecutive ship questions, including multi-select
MOCK=ship-landing pnpm run dev # per-ticket turns from docs/specs/landing-e2e.md
MOCK=ship-delegate pnpm run dev  # real `subagent` child with a bounded ship brief
MOCK=ship-conflict pnpm run dev  # landing worktrees, git conflict fill, then the next ticket
                                 # seed the git fixture in e2e/pty-ship-conflict.e2e.ts, then type /ship
pnpm run site:screens         # re-shoot the site's terminals from the real binary
```

`MOCK=<mode>` boots against the keyless mock model: `write` (the default),
`bash`, `fail` (a command that prints a line and exits 3), `heredoc`, `slow`,
`steer` (holds a turn 3s and reports whether a mid-turn message arrived),
`tall`, `spec`, `markdown`, `reasoning`, `reasoning-slow` (a thought long
enough to interrupt), `reason-write` (a thought, a write, a second thought,
an answer), `echo`, `todo`, `questions`, `workflow`, `subagents` (two
background children, one of which fails),
`context` (32k input usage against a 128k window; 64k on `cli-mock-pro`),
`ship-wayfinder` (`/ship SMALL_WAYFINDER` exercises the confirmed grill handoff;
`/ship PENDING_WAYFINDER` leaves a resumable planning ledger), `ship-delegate`,
`ship-landing`, `ship-conflict` (real git worktrees; the Conflict-resolution
child fills git-named hunks and `/ship` continues),
`vision`, and the `auto-vision`, `auto-vision-slow`, `auto-vision-fail` trio
behind the automatic image description. The list lives in
`e2e/fixtures/mock-llm.src.ts`. `INSPECT=1` opens the Node inspector on
the app process alone, so a breakpoint does not stop the build that precedes it.

Without `MOCK`, the loop imports the machine's custom providers, default
model, credentials, and thinking prefs from `$DSH_HOME` (default `~/.dsh`)
into `.dev-home`, so `/model` matches the installed `codsh`. A process
`DSH_HOME` that already points at `.dev-home` is skipped; set
`CODSH_DEV_USER_HOME` to another home in that case.

`CODSH_TRACE=<path>` tees every byte the viewport writes, and the size it wrote
them at, into a file. A frame that arrives corrupted is a disagreement between
what the surface emitted and what the terminal did with it, and the emitted
half is gone by the time anyone looks; replaying the file through a terminal
emulator reproduces the screen it drew. Off unless the variable is set.

`pnpm run sync:dsh` tracks published `@deepseek-ai/dsh-*` releases. This repo never forks the harness.

`pnpm run build` also bundles the React Flow Web panorama from `ship-web-app.tsx`
with `scripts/build-ship-web.mjs`. Its JavaScript and CSS are published under
`codsh-bundle/lib/web/` and served locally; no CDN or frontend server is required.
After browser-client edits, rebuild before opening the `/ship` loopback URL.
Verify requirement/goal navigation, per-phase question/answer cards, long-text
scrolling, skipped/missing answers, nested expand/collapse, ticket relations,
live updates, and reconnect behavior on desktop and mobile; test both `/` and
`/index.html`. Check English interface labels without translating user source
text, and answer persistence across graph-cache rebuilds and resumed runs.

## Frozen Grok rewrite reference (#133)

The parallel rewrite's research register is in
[`docs/rewrite/reference/`](docs/rewrite/reference/README.md). It does not alter
legacy behavior or import the new Rust client. Run its portable checks with:

```sh
node scripts/reference-inventory.mjs check
node scripts/reference-mapping.mjs docs/rewrite/reference .scratch/reference-inventory.json
diff -u docs/rewrite/reference/inventory.json .scratch/reference-inventory.json
pnpm exec vitest run scripts/reference-inventory.spec.mjs scripts/reference-evidence.spec.mjs
```

To reproduce reference observations on macOS, use Python 3.10+ and the exact
installed Grok 1.0.34/build 3736acbc8658 binary. The driver creates a temporary
HOME/GROK_HOME/workspace, denies personal-home reads and nonessential networking,
and never reads real auth or sessions. Output directories must be new.

```sh
python3 scripts/reference-probe-test.py
python3 scripts/reference-probe.py --binary /absolute/path/to/grok-1.0.34 --output .scratch/reference-run --samples 5
python3 scripts/reference-model-probe.py --binary /absolute/path/to/grok-1.0.34 --output .scratch/reference-model.json
node scripts/reference-baseline.mjs .scratch/reference-run/observations.json .scratch/reference-baseline.json
```

The model probe serves deterministic SSE on one loopback port, with a synthetic
key and no paid calls. The main probe denies all network access. Both require
`sandbox-exec`; do not remove confinement to make a probe run on another platform.
Native Linux/Windows drivers and full performance workloads remain downstream.

Reconcile discovery using a clean public source checkout pinned at the recorded
commit (this is research, not an application import):

```sh
git clone https://github.com/xai-org/grok-build.git .scratch/reference-source
git -C .scratch/reference-source checkout --detach a28ee2b2063426e8816e380ccea528b9de95e5da
node scripts/reference-inventory.mjs extract docs/rewrite/reference/observations.json .scratch/reference-source .scratch/reference-discovery.json docs/rewrite/reference/model-observations.json .scratch/reference-source-evidence.json
diff -u docs/rewrite/reference/discovery.json .scratch/reference-discovery.json
diff -u docs/rewrite/reference/source-evidence.json .scratch/reference-source-evidence.json
```

Every discovered item needs a story, owning ticket, observable acceptance scenario
and evidence or explicit blocker. A source declaration or guide is not runtime
verification; planned acceptance scenarios are not passing tests. Add newly
found behavior instead of weakening the extraction or shrinking the register.
The validator resolves capture/guide/schema/source-fragment evidence and enforces
the binary pin; changing a locator and recomputing the inventory digest is not
verification. Audit semantic ownership: terminal gestures need their actual
UI/session behavior, and headless input options need provider-wire assertions.
`reference-mapping.mjs` and `reference-scenarios.mjs` are the committed mapping
source. Regeneration uses captured ticket metadata, exact guide heading ancestry,
namespace defaults and narrow contextual overrides; it needs no scratch generator
or GitHub access. The checker rejects owner/scenario drift even when IDs and stories
are internally consistent; regeneration alone is not an independent semantic oracle.
Expected-owner regressions must be grounded in the quoted contract. Repeated TOML
settings retain their functional namespace owner as well as contextual enterprise
owners; broad `ui`, `toolset` and `compat` groups do not imply appearance or file
search behavior. Classify by context, not isolated words: hook prompt
blocks and sandbox write protection need real effects, MCP headers/stdio belong to
MCP, model headers to providers, ACP updates to protocol/session replay, and plan
feedback to plan review rather than telemetry. ACP `x.ai/review/comment` instead
records cloud code-review events and requires consent/destination acceptance.
Section extraction and owner context share a fence-aware Markdown scan, including
nested blockquote containers: normalize syntax for TOML fields while preserving
original quotation bytes and line locators. Code comments cannot hide subsequent
prose, and fenced examples remain section evidence, not behavior paragraphs. Audit extraction deltas for actual
prose preservation rather than preserving misclassified code-fragment identities.
Environment extraction recognizes literal reads/setters, named constants, env-map
lookups and key loops, enclosing environment-variable tables, assignment-form hints
such as `COLORTERM=truecolor`, and documented process reads, credential inputs and
launcher-resolution controls without vendor-prefix or underscore requirements.
Literal source names are not shell identifiers: preserve case, punctuation,
whitespace, leading underscores and single letters across reads, child injection,
env maps and loops. `container` is not `CONTAINER`; `PROGRAMFILES(X86)` and
`CARGO_BIN_EXE_xai-grok-pager` retain their full names in qualified/assignment forms.
Empty names, equals signs and NUL are not valid literal keys. New source identities require contextual mapping
and source-evidence/count digest updates, not new runtime availability claims.
Guide-qualified variables and assignment forms resolve to canonical functional
owners; a path mentioning a variable is not itself an environment identity.
Workflow budget/lifecycle subcontracts keep #182/#183 even under a slash owner;
actual memory-v2 capture/Dream controls use #186 and campaign patches use #139/#141.
Keep documented gates separate from newer source-only overrides in acceptance.
Audit control effects across canonical/config/example/alias representations: scrolling
and mouse capture are input behavior, ghost text differs from its model routing,
legacy metadata saves differ from model-backed capture, and pruning is compaction.
Diagnostics require real file/filter/destination checks and status-line environment
sanitization requires rc-file canaries. Fetch proxy/domain/enablement tests must not
be replaced by search-policy acceptance; mixed rows may require both scenarios.
Privacy and feedback acceptance (`scripts/rust-privacy-pty-test.py`) drives the
packed `codsh --rust feedback` command and the live `/feedback` form: local
draft save/edit/delete, failed submit retention, explicit submit to a loopback
substitute, redaction when `privacy.share_content` is off, a trace-upload POST
only when that switch is on, refused official hosts, and a network audit that
must not contact an unconfigured host. Diagnostic payloads are kind/ok/count.
`GROK_LOG_FILE` and `GROK_HOOKS_LOG` stay unwired: the launcher allowlist does
not forward them, and the Rust client does not read them.
`GROK_CLAUDE_SKILLS_ENABLED` and `GROK_CURSOR_SKILLS_ENABLED` are on that
allowlist. A packed `codsh --rust inspect` with both set off must not list
`.claude` or `.cursor` skills (`scripts/rust-launcher.spec.mjs`).
Do not treat model `base_url` traffic as telemetry.
Keep shell completion separate from next-prompt suggestions, diagnostic logging from
hook authority, and sandbox auto-approval from confinement. Terminal/editor/platform
aliases and background model/admission/login/goal/compaction controls need observable
functional effects. Memory prose must retain capture, queue/lease diagnostics and
telemetry privacy only where quoted; merged source/binary paragraph identities can
carry different contracts without proving either runtime behavior.
`config-audit.json` records the full generic-fallback review, not a hand-picked
list of environment-name fixes. New generic-only config/env rows must receive a
reviewed classification and effect-specific scenario; the checker rejects an
unreviewed `PARITY-139` fallback. Source-only build/test/internal declarations use
scoped `DISCOVERY-133-*` research and explicit blockers, never effective-config
parity. Preserve frozen public contracts even when the newer source disagrees.
Canonical/documented fields and explicit environment aliases must include the
same core owners/scenarios, while retaining valid context-specific additions.
`reference-config-audit.spec.mjs` tests these invariants on independent fixtures
and samples every classified family; source extraction also checks audit consumer
quotations byte-for-byte against the pinned checkout. Do not regenerate original
captures or source provenance for an ownership-only correction.
Alias ownership follows explicit “Also ENV”
config-reference relationships before lexical namespaces; incidental mentions are
not aliases. Local hook identity variables must not inherit remote-workspace
ownership. `/vim-mode` is scrollback navigation, not prompt Vim editing, and
`/import-claude` imports configuration rather than session histories. Overlay
allowlists require effect-based security acceptance. Source/build controls remain
provisional, not released capabilities. Interactive help/docs/diagnostics require real terminal acceptance;
feature-gated panes retain explicit availability blockers until exercised.
The portable checker requires independent source-only coverage as well as captured
behavior; paired deletion from discovery and inventory must fail. Source evidence
contains command enum/argument relationships that seed hidden-command help probes.
The driver defaults to the checked-in `source-evidence.json`; use
`--source-evidence <path>` for a freshly regenerated artifact. All command-tree probes append
`--help`, never execute the underlying operation, and retain rejected source-only
paths as unverified. The offline probe also covers compatibility options, paired
FPS runs, fullscreen/minimal tutorial navigation, and help/docs palette/reader
filtering, scrolling, aliases, dismissal, debug FPS toggling and error recovery.
It does not open the personal browser or verify live dock resources. For only the
supplemental small-command observations, run `reference-probe.py` with
`--small-commands-only --binary /absolute/path/to/grok-1.0.34 --output .scratch/reference-small`.
This avoids regenerating valid performance/headless captures. Its two PTYs record
announcement usage, unsupported-graphics GBOOM refusal, dashboard location picker
opening/dismissal via Ctrl+L, the `/cd` autocomplete placeholder and invalid path,
minimal dashboard refusal, typing and clean quit. Ticket 27 adds the installed
`sessions list`/`sessions search` contract, `/resume` title-or-content filtering across workspaces,
manual `/rename` priority, configured-model titles, and the fullscreen dashboard.
Foreign Claude/Codex/Cursor session roots stay gated and are not native dsh history. It does not establish populated
banners, new-agent cwd, overlay rendering or argument passthrough. The model probe
rejects malformed structured output and missing terminal events.
Freeze measured numeric performance thresholds before collecting candidate data.
Run the ordinary typecheck and full unit suite for changes to these workflows.

## Isolated Rust client (#134–#139)

Rust 1.98.1 (verified toolchain, edition 2024), Cargo, Node 22.19+, and the ordinary pnpm workspace
are required to build a local native candidate. `rust/Cargo.lock` pins the
selected UI dependency closure. The complete upstream agent closure is not
built: it would initialize official execution/auth/services and also requires
DotSlash/protoc. This slice imports the upstream text editor/inline terminal
crates and extracts offline wide/stacked welcome layout; see
`rust/upstream/import.json` and `rust/upstream/MODIFICATIONS` for provenance.
The client reuses the official fullscreen alternate-screen renderer and the
imported inline crate for minimal native-scrollback mode. `/minimal` and
`/fullscreen` switch in process without restarting dsh; session-scoped CLI flags
do not rewrite `[ui] screen_mode`. This is not a claim of complete Grok parity.
Frozen behavior remains 1.0.34, while the imported public source declares 1.0.35
(correspondence unproven).

```sh
pnpm run build:rust
cargo check --manifest-path rust/Cargo.toml --locked --workspace
pnpm run test:rust
cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets -- -D warnings
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
pnpm run typecheck
pnpm test
pnpm run build
pnpm exec vitest run --config vitest.e2e.config.ts e2e/wrapper.e2e.ts e2e/pty-input.e2e.ts e2e/pty-session.e2e.ts
pnpm run test:rust:pty
pnpm exec vitest run scripts/rust-acp-protocol.spec.mjs
python3 scripts/rust-cancel-pty-test.py
python3 scripts/rust-resume-pty-test.py
python3 scripts/rust-config-pty-test.py
python3 scripts/rust-model-pty-test.py
python3 scripts/rust-compact-pty-test.py
python3 scripts/rust-trust-pty-test.py
python3 scripts/rust-auth-pty-test.py
python3 scripts/rust-permission-pty-test.py
python3 scripts/rust-screen-pty-test.py
python3 scripts/rust-fork-pty-test.py
python3 scripts/rust-plugin-pty-test.py
python3 scripts/rust-prompt-pty-test.py
python3 scripts/rust-voice-pty-test.py
python3 scripts/rust-nav-pty-test.py
python3 scripts/rust-content-pty-test.py
```

`build:rust` stages the host binary under ignored `packages/cli/native/<os>-<arch>`
with SHA-256, selected dependency metadata and license/notice files. `npm pack`
from `packages/cli` includes it; install that tarball locally to try `codsh --rust`.
No download-on-launch, release, global install, or default cutover occurs.
Cross-target packaging/CI publication and native Linux/Windows verification are
later tickets, not established by a macOS build. Packages lacking the artifact
fail explicitly. The regular legacy `build` does not add native artifacts.

`test:rust:pty` requires macOS, Python 3 and clang. It packs and locally installs
the product in a temporary prefix, uses synthetic HOME/DSH_HOME/workspace canaries,
operates the actual Rust UI through a PTY, and checks termios, screen/paste/cursor
restoration after normal exit, cancellation, signals and malformed Profile startup.
It also requires a case-insensitive test volume and checks twenty installed-product
PTY refusals for `DSH_HOME`/`GROK_HOME` aliases: existing root/dsh/Profile, reverse
spelling, a missing child, and genuinely absent root/dsh/Profile/mixed-case paths.
Each must fail before terminal entry or any directory/file mutation. Four separate
missing-Home controls (including a similar prefix) must still launch without
creating the configured legacy Home. The launcher uses native canonicalization
for existing paths and compares device/inode ancestry, not realpath strings alone.
Each missing suffix stays anchored to its nearest existing directory. Suffixes are
compared relative to shared directory identities; merely sharing an ancestor does
not make separate siblings overlap. Metadata errors, non-directories and unavailable
inode identity fail closed. No platform mount-prefix rewrite is used.
The macOS installed matrix requires a real Data-volume firmlink alias. Firmlink
fixtures live under `/tmp` so `/private/tmp` and `/System/Volumes/Data/private/tmp`
have different native realpath strings and the same device/inode. The matrix
exercises both alias directions, absent/partly-existing/existing roots, root/dsh/Profile
and case variants, legacy ancestors, default links and separate prefix-neighbor/nested
controls. Full UI controls verify separate aliased Homes without touching legacy data.
A non-directory Home path is refused because directory identity cannot be established.
When either path has missing components, it conservatively
refuses a case-folded potential overlap on every platform. It neither assumes
case sensitivity for unresolvable suffixes nor creates files to probe the volume.
Every unresolved non-ASCII component is refused before suffix reconstruction,
including separate names; no Unicode folding table or normalization heuristic is
used as a filesystem oracle. Existing Unicode directories keep native identities,
and missing ASCII children beneath resolved separate Unicode ancestors still work.
The installed matrix covers long-s and ligature aliases at root/child paths for both
variables and default links, with genuinely absent/existing roots. Separate ASCII,
Unicode, composed/decomposed, emoji and invisible-character controls distinguish
intentional missing-name refusal from existing-path support. Native realpath,
device/inode and Profile samefile evidence accompany complete tree snapshots.
Existing distinct paths keep their native identities. Node's JavaScript realpath
fallback is insufficient because it preserves case spelling on the verified host.
Eighteen further PTY checks cover dangling explicit/default legacy links, root/child
targets, dangling ancestors, chains, absolute targets, separate missing targets and
cycles for both Home variables. `ENOENT` must be distinguished from a dangling
symlink with `lstat` before reconstructing missing path components; unresolved
symlink ambiguity fails before writes. Native cycle errors fail closed. Six actual
UI controls retain resolvable links to separate legacy Homes (including missing
children under valid links). Snapshot assertions record link text without following
links, along with directories and content hashes. No test uses personal Home data.
The path matrix runs both variables with existing/missing absolute, relative,
literal tilde, Unicode/space paths, directory/symlink/dangling/missing `..`
traversals, and unset/empty/blank/overridden default Homes. It calls the released
`dsh-home-paths` resolver as its dsh oracle; Grok's pinned `xai-dirs/src/lib.rs`
keeps nonempty overrides verbatim. The launcher matches dsh's blank/tilde/lexical
rules but refuses all `GROK_HOME` parent-traversal components before writes,
even when they might be separate: no custom symlink traversal is attempted.
Default Homes stay protected when overridden. Evidence records native filesystem
identities, full synthetic tree snapshots and raw PTY output, not just path strings.
Packing/installing is offline with isolated npm configuration; product fixtures
live temporarily under the output directory. Keep `TMPDIR` at a valid system
temporary directory **outside the repository** when running the existing unit/e2e
suites: their outside-repository fixtures must not discover this worktree's Git root.
The network observer interposes socket/connect/connectx/sendto/sendmsg/DNS calls
without replacing their results; a compiled loopback UDP positive control proves
socket and outbound-send observation.
A Node preload preserves only this audit injection across the launcher's sanitized
child environment. A separate uninstrumented run denies network and synthetic
legacy-home reads with `sandbox-exec`. This is socket-boundary evidence, not
privileged packet capture.
No real credentials, session history, official account or paid service is used.
Logs/screens/result JSON go to a new `.scratch/rust-pty-*` directory; `--output`
can choose another new directory. Do not reuse personal data or a personal Home.

The isolated Home still creates `~/.codsh-rust/dsh/profiles/rust/package.json`
with an empty bundle composition. Interactive `codsh --rust` then starts released
`dsh --profile acp` over ACP/JSON-RPC stdio in that Home; dsh owns execution and
durable sessions. The mock model, when used, is a dsh provider-boundary fixture
(`CODSH_ACP_PATCH`, `DSH_CODE_CLI_MOCK_TOOL`), not a stub of the Rust client or
dsh core. Model/protocol/effort checks (`python3 scripts/rust-model-pty-test.py`)
drive a loopback OpenAI-compatible fixture at the provider boundary and assert
the actual request path, model id, auth, and effort; same-named models on
different backends are not treated as equivalent. Enter submits the draft through dsh when connected. Missing dsh, ACP
protocol mismatch, empty answers, mid-stream failure, and disconnect are shown
as failures or empty results, never as success. File read/write/edit run through
released dsh tools. The Rust UI correlates `session/request_permission` with the
tool-call id, shows the pending operation and dsh-supplied diff, allows once with
`y`, remembers this project only with `a`, and rejects with `n` without writing.
`/revoke-approvals` forgets this project's remembered grants. Allow/ask/deny rules,
remembered project grants, locked always-approve, and hook deny are enforced before the
dsh tool body. Unsplittable shell and Read/Edit path rules on operands cannot
bypass deny; always-approve skips grants and non-shell ask; a corrupt policy
file refuses mutating tools. Wrappers peel to the inner command without eating
the command name; `env -S` prompts; Read/Edit deny follows in-path symlinks;
remembered file grants are path-scoped. Missing files, tool errors, cancelled
approvals, and duplicate replies are observable failures. `Ctrl+C` clears a
draft without cancelling; an empty draft sends ACP `session/cancel` to dsh for a
running turn, including pending approval and in-flight tools. Esc never cancels.
Late allow replies and process teardown cannot execute a cancelled action; unknown
tool results display as cancelled. After cancel, a new prompt still works.
`test:rust:pty` now also runs `scripts/rust-turn-pty-test.py`,
`scripts/rust-file-pty-test.py`, `scripts/rust-cancel-pty-test.py`,
`scripts/rust-resume-pty-test.py`, `scripts/rust-config-pty-test.py`,
`scripts/rust-model-pty-test.py`, `scripts/rust-compact-pty-test.py`,
`scripts/rust-trust-pty-test.py`, `scripts/rust-screen-pty-test.py`,
`scripts/rust-fork-pty-test.py`, `scripts/rust-settings-pty-test.py`,
`scripts/rust-import-pty-test.py`, `scripts/rust-plugin-pty-test.py`,
`scripts/rust-auth-pty-test.py`, `scripts/rust-permission-pty-test.py`,
`scripts/rust-prompt-pty-test.py`, `scripts/rust-content-pty-test.py`,
`scripts/rust-voice-pty-test.py`, `scripts/rust-assets-pty-test.py`, and
`scripts/rust-session-data-pty-test.py` against
the packed native candidate. The session-data PTY checks Markdown export,
explicit share to a loopback substitute, and `du`. `sessions delete`,
`/delete` cancel, the resume picker, and dashboard delete must report the
dsh persistence blocker and leave every session, including the other workspace,
in place. A redirect from the selected share URL must not be followed. Voice PTY uses a local substitute speech-to-text
server and `CODSH_VOICE_FIXTURE`; it does not open the microphone. `/voice doctor`
must not record. A slash command typed while recording parks the draft and
restores it; it must not leave `/` or drop that text. A changed draft drops a
late transcript. Linux and Windows capture stay unverified. The assets test
trusts a fixture repo, checks that ordered rules, a skill, and a flat custom
command change the dsh request, rescans an added skill, requires the deleted
skill to be absent from the next dsh reply, checks `--rules`, and checks an
empty directory. Untrusted inspect must omit project files. A non-user-invocable
skill must stay out of the menu. A skill or command named `login`, `logout`, or
`feedback` must keep the built-in on the bare slash and appear only as
`/local:name`. Nested `SKILL.md` files stop when the walk depth is greater than
five, and a child of a directory that already has `SKILL.md` is still recorded.
A configured `[skills] paths` directory is depth 0, so a sixth child is not
loaded.
Official `xai-grok-markdown` tests run with `cargo test --manifest-path rust/Cargo.toml --workspace`. Packed content PTY covers markdown, tables, mermaid, thoughts, fold, raw, full content, copy-original, `$PAGER`, resume, diffs, and failed tools. The visible fullscreen frame must match official markdown: keep `Vec<T>`, comparisons, fenced Rust, and inline HTML tags, keep a ZWJ emoji together, and paint `failed` plus `[error]` for a missing or rejected tool. A settled full-content page shows the fenced function and the unclosed-fence marker once; the notice under the transcript is not a second copy of that body.
Prompt editing must keep the official textarea, prove Unicode/paste/resize,
history selection, slash/HISTFILE completion cancel, both simple and prompt-Vim
modes, and an actual `$VISUAL` round-trip that does not submit on save or failure.
`/context` and `/compact` are dsh-backed: occupancy and advertised model limits
must not be fabricated, manual/automatic compaction uses the dsh session log,
failed compact must keep the ACP session and original records, cancel must print
`Compaction cancelled.` and accept a following prompt, and resume must hide
replaced history while answering a new prompt. The config test covers `inspect` /
`inspect --json`, CLI/env/overlay/file precedence, invalid TOML preservation,
first-run missing credentials, generated dsh `settings.yaml` mapping, restart
after a config change, unmanaged settings conflict, and refusal to automatically
import legacy `~/.dsh` / `~/.grok` credentials. Explicit `codsh --rust import`
(`scripts/rust-import-pty-test.py`) previews current dsh `settings.yaml` /
`code-cli-thinking.json` / `code-cli-ui.json` sources, lists conversions,
conflicts and unsupported items, maps UI density onto `[ui] compact_mode`,
copies selected providers without tokens or trust grants, keeps the model named
by `agent-default-model`, and leaves source files and nested isolated settings
unchanged on preview, cancel, failure, and repeat apply. The auth test covers `login` /
`logout` / `setup` help without creating Home, independent API-key use,
organization pins that refuse API-key-only ready (`GROK_DISABLE_API_KEY_AUTH`,
empty team list, locked `requirements.toml` `[auth]` or top-level
`force_login_team_uuid`), external-provider login with owner-only `auth.json`, logout that revokes the
identity session and does not revoke model/MCP credentials, unsigned
managed-policy refusal, a signature bound to another principal, fail-closed
policy with no pubkey and no sidecar, a local signed substitute management
service, and `/login` `/logout` in a real PTY. The packed test also records
that a ready identity session is handed to the dsh child and that an
undocumented `GROK_AUTH_*` parent variable is not.
Under an organization pin the PTY starts unready, `/login` must show `Connected to dsh ACP` before the next prompt, and `/logout` must drop that connection.
Public ACP framing, including
file-tool permission, `session/cancel`, `session/list`, `session/resume`, and
dsh-backed conversation fork/rewind, is covered by
`scripts/rust-acp-protocol.spec.mjs`.
`--continue` / `--resume <id>` restore the same dsh session through ACP
`session/resume` plus a read-only persistence projection; `--fork-session`,
`/fork`, and `/rewind` seed a new append-only child without restoring files.
`/rewind` while a turn is streaming is refused; `/fork --no-worktree` copies
conversation only; `--worktree` stays out of this slice. `[ui] confirm_before_rewind`
and `ui.fork_secondary_model` live in `$GROK_HOME/config.toml` (default
`~/.codsh-rust/.grok/config.toml`), the same user file as screen mode.
`ui.fork_secondary_model` applies to `/fork` and `--fork-session`, not rewind.
A second client is refused when it cannot take write ownership. Interrupted
tools are displayed as unknown and are not replayed. `session/load` remains
unsupported by dsh ACP. `--restore-code` is refused.
Fullscreen uses the alternate-screen lifecycle; minimal emits committed turns
into native history through the official inline renderer. `/rewind` and `/fork`
in minimal reset that native buffer the same way compact does, so discarded
turns are not left in scrollback. In-place `/minimal` and `/fullscreen` keep
the dsh session, draft, running turn, and pending approval;
`--minimal`/`--fullscreen` do not rewrite isolated `[ui] screen_mode`.
Fullscreen `/find` searches the transcript overlay, `/jump` previews turns and
restores the prior reading position on Esc, and click-to-fold does not fire on
a drag that copies. Fullscreen paints only the visible transcript rows on a
dedicated Rect that mouse hit-testing uses; the gutter is the painted `>`/` `
prefix, not an inserted bar. Rebuild remaps a selection by turn identity and
drops it when that anchor is gone. Folds persist across rebuild by turn identity.
`/vim-mode` persists `[ui] vim_mode` without changing `ui.simple_mode`.
`ui.mouse_reporting_toggle` / `GROK_MOUSE_REPORTING_TOGGLE` lets Ctrl+R
(scrollback focused) or `/toggle-mouse-reporting` flip capture; teardown always
disables mouse reporting. The hint names `$GROK_HOME/config.toml`. Frozen View
`Ctrl+F` remains the content viewer (ticket 153); transcript search is `/find`.
Vim `y` copies the selected block and `Y` copies block metadata. `inspect`
labels nav prefs as `config` or `env`, including `inspect --json`.
`scripts/rust-nav-pty-test.py` clicks a thought fold, copies a dragged span
(OSC 52), restores `read=` on Esc, scrolls while a turn is still streaming,
and requires wheel input to change `read=`. Scrollback Ctrl+D half-pages
instead of quitting; `Ctrl+Q` still quits. Empty-session Tab still cycles the
welcome menu. `/find [text]` opens browse mode so `n`/`N` step matches. Ctrl+P
refuses the command palette (ticket 154) rather than a silent no-op. Minimal
`/find` and `/jump` refuse with the `/fullscreen` remedy. Dock
(`features.dock` / `GROK_DOCK`) is an explicit unsupported gate, not a fake pane.
`/settings` and `/theme` persist appearance and status-line choices into the
same user `config.toml`; preview/Escape must not write; locked requirements
show their source; status-line scripts must time out and clean process groups.
Queue delivery across a switch remains a later ticket.

## Documentation site

`site/` is a static GitHub Pages site. `index.html` and `zh.html` are the short
homepages; `guide.html` and `guide.zh.html` retain the workflow, terminal captures,
and setup reference. `gallery.html` and `gallery.zh.html` show original requests
and actual project results. Keep each English/Chinese pair in sync.

- `pnpm run site:build` regenerates the terminal captures in the **guide** pages.
- Preview with `python3 -m http.server 4177 --directory site`, then open
  `http://localhost:4177/`. No frontend dependency installation is needed.
- Gallery demos are checked-in builds under `site/demos/`. Pages deploys those
  snapshots; it never needs the local example repository.
  - The WWII game lives in `site/demos/medal-of-honor/`. Do not re-run
    `scripts/site-demo.mjs` against the current `../test-codsh` tree — that
    directory is now the Web Music Player.
  - The International Mall lives in `site/demos/international-mall/`.
  - Refresh the music player with `node scripts/site-music.mjs ../test-codsh` after
    installing the example project's dependencies. It builds with
    relative asset paths, and keeps its source revision and Lucide license
    alongside the demo.
- Gallery images belong in `site/assets/gallery/` and must be real captures of
  the showcased project. Include the original prompt, the model and thinking
  level used to build it, device requirements, provenance, and any relevant
  unofficial-project notice; do not invent entries.
- Verify both languages on desktop and mobile: home → gallery → shop → gallery,
  home → gallery → music player → gallery, and home → gallery → game → gallery,
  language switches, expandable controls, guide scenes, and setup anchors. Also test
  under a URL prefix (such as `/codsh/`) to match GitHub Pages hosting.

## Before you open a PR

```sh
pnpm run typecheck
pnpm test                 # unit suites
pnpm run test:e2e         # drives the installed dsh binary through pipes and a real PTY
pnpm run test:e2e e2e/pty-input.e2e.ts   # one suite; the build still runs first
```

- Tests must declare directly imported packages in the workspace development dependencies; do not rely on transitive hoisting (the startup fixture imports `@deepseek-ai/cordis-plugin-include` directly).
- New rendering or input behavior needs a test at the right level: pure modules (editor, markdown, transcript, …) get unit specs; anything about raw mode, repaints, or key timing gets a PTY e2e step.
- The e2e suites are split by topic because Vitest parallelises by file and a run takes as long as its largest file: `pty-input`, `pty-selectors`, `pty-questions`, `pty-folds`, `pty-mouse`, `pty-session`, `pty-status`, `pty-ship`, `pty-ship-goal`, `pty-ship-landing`, `pty-ship-conflict` for the raw-terminal behaviours, `experience-viewport`, `experience-navigation`, `experience-reading`, `experience-chrome` for the first-five-minutes checklist, plus `pipe`, `images`, and `wrapper`. Put a new step in the file whose topic it belongs to, and split a file that grows past about fifteen steps rather than letting it become the critical path. Shared PTY helpers (keys, `screenAt`, `boxTops`) live in `e2e/pty-helpers.ts`. Each e2e home copies the packed profile's own files (`cordis.yml` especially) and shares `node_modules` plus the installation fallback — dsh rewrites the include root on every boot, so a fully shared profile races under parallel files. The template heals that fallback once (`e2e/heal-template.mjs`) so a cloned home does not write it after Node has already resolved through the shared modules.
- Surface work is not done at unit green. Drive the changed keys and chrome on a real TTY — the PTY e2e that paints the frame, or `MOCK=echo pnpm run dev` — before calling the row aligned. This is standard process, not optional.
- The transcript is append-only and the renderer switches on presenter `card` tags, never tool names — keep both invariants.
- Add a changeset (`pnpm changeset`) describing the user-visible change; releases are cut from accumulated changesets by CI. CI picks the end-to-end suites by what the diff can reach, and the lists are spelled out in `.github/workflows/ci.yml`: changelogs, changesets, a version line, prose, pictures, and unit specs (including `e2e/*.spec.ts`) run typecheck and the unit suites only; a diff confined to `packages/cli` runs the wrapper suite, and one confined to the image modules (vision, preview, paste, terminal graphics) runs the images suite; anything else in the diff runs everything. Extend the lists only for a path no other suite can observe.

## Reporting bugs

Terminal bugs are timing- and TTY-shape-sensitive: please include your terminal emulator, `echo $TERM`, whether the run was interactive or piped, and — if you can — a minimal `MOCK=<mode> pnpm run dev` reproduction.
