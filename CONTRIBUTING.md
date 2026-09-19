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
Section extraction and owner context share a fence-aware Markdown scan: code
comments cannot hide subsequent prose, and fenced examples are retained as section
evidence, not standalone behavior paragraphs. Audit extraction deltas for actual
prose preservation rather than preserving misclassified code-fragment identities.
Environment extraction recognizes literal reads/setters, named constants, env-map
lookups and key loops, enclosing environment-variable tables, assignment-form hints
such as `COLORTERM=truecolor`, and documented process reads, credential inputs and
launcher-resolution controls without vendor-prefix or underscore requirements.
Guide-qualified variables and assignment forms resolve to canonical functional
owners; a path mentioning a variable is not itself an environment identity.
Workflow budget/lifecycle subcontracts keep #182/#183 even under a slash owner;
actual memory-v2 capture/Dream controls use #186 and campaign patches use #139/#141.
Keep documented gates separate from newer source-only overrides in acceptance. Alias ownership follows explicit “Also ENV”
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
minimal dashboard refusal, typing and clean quit. It does not establish populated
banners, new-agent cwd, overlay rendering or argument passthrough. The model probe
rejects malformed structured output and missing terminal events.
Freeze measured numeric performance thresholds before collecting candidate data.
Run the ordinary typecheck and full unit suite for changes to these workflows.

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
