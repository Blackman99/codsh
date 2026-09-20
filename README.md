<p align="center">
  <a href="https://blackman99.github.io/codsh/">
    <img src="assets/banner.svg" width="900"
         alt="codsh — a terminal coding agent for DeepSeek">
  </a>
</p>

<p align="center">
  <a href="https://blackman99.github.io/codsh/"><b>Site</b></a> ·
  <a href="https://blackman99.github.io/codsh/gallery.html">Gallery</a> ·
  <a href="https://www.npmjs.com/package/codsh-cli">npm</a> ·
  English | <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codsh-cli"><img src="https://img.shields.io/npm/v/codsh-cli.svg" alt="npm version"></a>
  <a href="https://github.com/Blackman99/codsh/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Blackman99/codsh.svg" alt="MIT license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-1f6feb" alt="dsh-plugin topic"></a>
  <a href="https://dshfind.com/en/plugins/Blackman99/codsh?ref=badge"><img src="https://dshfind.com/api/badge/Blackman99/codsh" alt="dshfind"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://cdn.rawgit.com/sindresorhus/awesome/d7305f38d29fed78fa85652e3a63e154dd8e8829/media/badge.svg" alt="Awesome"></a>
</p>

> npm: [`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · command: `codsh`

**codsh** is an autonomous terminal coding agent for DeepSeek — and any OpenAI-compatible endpoint — built directly on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Not a fork.

Its flagship feature, **`/ship`**, turns a one-sentence idea into fully verified code through an autonomous 7-stage engineering pipeline, with a built-in live task flow panorama across terminal and browser.

Want to see what it builds? [Visit the gallery](https://blackman99.github.io/codsh/gallery.html) for real projects, screenshots, and playable results. Every project was built from a **one-sentence request**, with just **one round of interaction** and the **recommended answer selected for every question**.

## Install

```sh
npm install -g @deepseek-ai/dsh codsh-cli
export DEEPSEEK_API_KEY="your-api-key"
codsh
```

Common flags:
- `codsh -p "task"` — Run a non-interactive task directly
- `codsh --continue` — Continue the last session
- `codsh --resume <id>` — Resume a specific session
- `codsh update` — Update launcher and profile runtime

## Isolated Rust client (local candidates)

`codsh --rust` explicitly selects the parallel Rust client; plain `codsh` keeps
using the existing version. The Rust UI submits prompts over ACP/JSON-RPC to a
real `dsh --profile acp` process in the isolated Home. Streamed answers, provider
thoughts, empty replies, and failures are shown as dsh reports them; a protocol
mismatch or missing dsh is refused instead of faked as success. It reuses licensed
Grok Rust UI components, requires no official account, and does not start the
legacy Bundle, official agent core, update check, telemetry, or feedback upload.
Enter submits the draft through dsh when connected, or reports that execution is
unavailable without sending it.

The preview uses `~/.codsh-rust/dsh` and Profile `rust`, ignores inherited
`DSH_HOME`, provider credentials and Grok settings, and never migrates legacy
sessions. A symlinked preview Home/Profile or overlap with `DSH_HOME`/`GROK_HOME`
is refused before writes, including differently cased aliases on case-insensitive
filesystems. Overlap checks compare device/inode ancestry, including existing
ancestors of missing paths, so macOS firmlink aliases cannot hide behind different
realpath strings. Separate Homes reached through those aliases remain supported.
Unavailable directory identity fails closed before writes.
If either Home is missing, a case-only potential overlap is refused
conservatively on every platform, without creating paths to test filesystem rules.
Any missing path component containing non-ASCII characters is also refused before
writes, even for a separate Home: Unicode lowercase/normalization is not a reliable
filesystem-identity test. Use an existing separate Unicode directory or a path with
only ASCII missing components. Existing Unicode ancestors and separate Homes still
use native filesystem resolution; missing ASCII children beneath them are supported.
Unresolved symlinks in explicit or default legacy Home paths are also refused
before writes; repair dangling links or symlink cycles before launching the preview.
Resolvable links to separate legacy Homes remain supported. Isolation checks follow
released dsh rules for `DSH_HOME`: blank means unset; `~`, `~/` and `~\` expand to
the OS Home, then relative paths and `..` normalize lexically. Nonempty `GROK_HOME`
is literal (no tilde expansion or whitespace trimming). The preview conservatively
refuses **any `..` component in `GROK_HOME`**, even for a separate existing Home,
rather than guessing symlink traversal. Use a path without parent traversal.
Default `~/.dsh` and `~/.grok` are protected even when overrides are set.
`Ctrl+Q`/`Ctrl+D` quits; `Ctrl+C` clears a draft, or quits when empty. Unsupported
arguments fail explicitly. `codsh --rust --help` describes this path. Mock-model
tests inject the fixture at the dsh provider boundary (`CODSH_ACP_PATCH` /
`DSH_CODE_CLI_MOCK_TOOL`); the Rust client and dsh remain real products.

Maintainers stage a native candidate with `pnpm run build:rust`, then locally
pack/install `packages/cli`; the npm entry includes the prebuilt native artifact
and notices, so candidate users do not compile Rust. A package without a native
artifact reports an actionable error, never falls back silently. No published
release or default cutover is implied. See [Contributing](CONTRIBUTING.md) for
build, installed-product verification, and platform limitations.

## `/ship`: One Sentence to Verified Code

```sh
/ship let long diffs open in a pager instead of scrolling past
```

`/ship` automates the complete engineering workflow from idea to delivery:

1. **Pre-flight** — Checks git working tree state and creates an isolated `ship/<slug>` branch.
2. **Wayfinder** — Clarifies core goals, constraints, and trade-offs.
3. **Grill** — Interactive design interview with smart, recommended defaults.
4. **Spec (Gate 1)** — Formulates user stories, public seams, and explicit Out of Scope boundaries.
5. **Tickets (Gate 2)** — Decomposes work into vertical slices structured as an explicit dependency DAG.
6. **Landing** — Dispatches tickets into parallel Git worktrees for TDD implementation and continuous integration.
7. **Done** — Verifies acceptance criteria, ensures zero repo regressions, and merges back cleanly.

### Live Task Flow Panorama
- **Live TTY Teaser**: Pinned status row showing real-time ticket counts (`待认领 n · 已认领 n · 已关闭 n`), in-flight parallel landing worktrees, and the Web flowchart URL.
- **ASCII DAG Overlay (`Ctrl+G`)**: Instant fullscreen terminal visualization of task dependencies and claim states.
- **Local Web Flowchart**: Interactive React Flow map (`127.0.0.1:<port>`) with decision context, recorded Q&As, and landing tickets.

### Autonomous Resilience
- **Automated Conflict Resolution**: Git merge conflicts (including lockfiles and renames) are autonomously resolved by agent sub-tasks with validation retries.
- **Pause & Resume**: `Ctrl+C` safely pauses coordination; running a bare `/ship` resumes unfinished work from where it left off.

## The surface

Designed for high-efficiency, keyboard-driven terminal development:

- **Clean Terminal UI**: Full-screen alternate buffer; input stays pinned at the bottom; restores your shell cleanly on exit.
- **Foldable Reasoning**: Streaming thoughts collapse into a single line (`Ctrl+O` or click to expand/collapse).
- **Subagent Matrix**: Background and parallel subagents run in isolated views (`Ctrl+H` to list, click/enter to inspect, `Esc` to return).
- **Timeline Navigation**: Jump between dialogue turns (`Shift+←/→`, `/jump`) or branch off from an earlier turn (`/rewind`).
- **Shortcuts & Controls**:
  - `Shift+Tab`: Toggle plan mode
  - `Ctrl+Q`: Queue input while the agent is running
  - `Ctrl+C`: Interrupt current execution
  - `Ctrl+V`: Paste images directly from clipboard
  - `/view`, `/diff`, `/copy`: Inspect files, uncommitted changes, or code blocks in a dedicated pager

## Third-party endpoints

Connect to any OpenAI-compatible gateway in `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`):

```yaml
llm-pi-ai:
  providers:
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.acme.example/v1
      compat:
        thinkingFormat: deepseek
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: acme-large
          contextWindow: 65536
          maxTokens: 4096
```

Switch and persist default model:
```sh
/model acme-gateway/acme-large
```

API keys resolve in order: specified environment variable → `$DSH_HOME/.credentials.yaml` → `<cwd>/.env` → `$DSH_HOME/.env`.

## How it works

`codsh` is a zero-dependency launcher that finds your local `dsh`, registers [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) into a `code` profile, and boots `dsh --profile code`.

To run directly via dsh:
```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

## Terminals

| Tier | Terminals | Support Level |
|---|---|---|
| First-class | iTerm2, Terminal.app, VS Code, tmux, Windows Terminal + WSL | Release-blocking compatibility |
| Second-class | Ghostty, kitty, Alacritty, Warp | Fully supported; regressions handled as bugs |
| Best-effort | Native Windows (pwsh) | Basic TTY support; persistent PTY unavailable |

Supports Kitty keyboard protocol, focus reporting, OSC 11 color detection, and terminal image rendering where available.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
pnpm run dev          # Start local development surface
pnpm test             # Run unit tests
pnpm run typecheck    # TypeScript typecheck
pnpm run test:e2e     # Run E2E tests
```

## Feedback

Bugs, feature requests, or migrating from Claude Code / Cursor? Open an [issue](https://github.com/Blackman99/codsh/issues) or join the [Discussions](https://github.com/Blackman99/codsh/discussions).

## License

[MIT](LICENSE)
