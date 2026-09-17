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

**`/ship`** takes one sentence to verified code. A terminal coding agent for DeepSeek — and any OpenAI-compatible endpoint.

A coding profile and a terminal of its own, on [dsh](https://github.com/deepseek-ai/deepseek-harness). Not a fork. For people who want DeepSeek (or their own gateway) instead of a closed agent.

Want to see what it can build? [Visit the gallery](https://blackman99.github.io/codsh/gallery.html) for original requests, real screenshots, and playable projects. Every project was built from a one-sentence request, with just one round of interaction and the recommended answer selected for every question.

[![The /ship flow](assets/ship-demo.gif)](https://blackman99.github.io/codsh/)

## Install

```sh
npm install -g @deepseek-ai/dsh codsh-cli
codsh
```

Key: `DEEPSEEK_API_KEY`. Already have a matching dsh? `npm i -g codsh-cli` is enough. An older harness is refused at boot with the install line.

`codsh --resume <id>` · `codsh --continue` · `codsh -p "task"` · `codsh --version` · `codsh update`

## `/ship`

```sh
/ship let long diffs open in a pager instead of scrolling past
```

`/ship <one-sentence idea>` walks that idea to verified code:

1. **Pre-flight** — dirty-tree prompt; isolated `ship/<slug>` branch
2. **Wayfinder** — name the destination and settle open decisions
3. **Grill** — design-tree interview, with recommended answers
4. **Spec (Gate 1)** — stories, public seams, Out of Scope; original wording kept
5. **Tickets (Gate 2)** — vertical slices, a DAG, acceptance checklists
6. **Landing** — TDD in parallel worktrees; merge and prove
7. **Done** — acceptance plus no new repo failures; merge back

You answer; the same `/ship` continues. `/goal` stays disarmed. While work is in progress, a panorama stays available: TTY overlay (`Ctrl+G` or the teaser), a one-line ticket count with the local Web flowchart URL on that row, and the flowchart itself — `/ship` does not open a browser.

After verified delivery, the terminal clears the ship phase, ticket counts, plan, old todo readout, and settled subagent readout. Running children remain visible; `Ctrl+T` / `Ctrl+H` still open retained history, and the Web flowchart keeps the final graph. Interrupted or blocked work keeps its progress visible for resuming.

Grill: ↑/↓ focus · Space toggles multi-select · Enter submits · ←/→ revisit · Esc closes the rest of the round.

A dirty tree or an unrelated `/goal` asks first. Bare `/ship` resumes unfinished work. Ctrl-C stops coordination.

Merge conflicts go to an agent automatically, including lockfile and modify/delete conflicts. It preserves both sides’ intent, retries validation failures up to three attempts, then continues landing and verification. Sealed-requirement conflicts or exhausted retries keep a recovery snapshot and report the specific blocker.

The [gallery](https://blackman99.github.io/codsh/gallery.html) pairs original one-sentence requests with screenshots and playable results. Words for the workflow live in [CONTEXT.md](CONTEXT.md).

## How it works

`codsh` finds your dsh, registers [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) into a `code` profile, and boots `dsh --profile code`.

A session says so when a newer codsh is out. `codsh update` from the shell, `/update` from inside; both move the profile runtime too. `CODSH_UPDATE_CHECK=off` silences the automatic check.

Skip the launcher:

```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

Any OpenAI-compatible endpoint is a dsh route — declare it once, then `/model`.

## The surface

The [guide](https://blackman99.github.io/codsh/guide.html#see) includes real terminal captures. In brief:

- Alternate screen; the box stays at the bottom; quit gives the shell back.
- The prompt you just sent pins at the top; its reply fills below. A right-hand timeline jumps turns (`Shift+←/→`, `/jump`). `/rewind` forks from a turn; the original stays in `/resume`.
- Thinking streams and lands folded in a single row (`Ctrl+O` or click to expand). Each tool call is one row (`✔` / `✗`); the success bullet is dim, consecutive rows have a blank between them, and output is behind the row.
- A running in-process child is a view (`click to enter`; Esc pops). `Ctrl+H` lists the session's children.
- `/view`, `/copy`, `/diff` — answers, code blocks, uncommitted changes, in the same reader.
- `/` commands, `$` skills, `!` shell, `@` files. `⇧Tab` is plan mode. Type while it works to queue (`Ctrl+Q`); Ctrl-C interrupts.
- `Ctrl+V` pastes images. `/thinking` (alias `/effort`) sets deliberation. Status shows context left. Drag copies in the transcript, the box, and the chrome under it. Away from the window, a waiting decision rings and notifies.
- Approvals name the call; the third answer remembers a prefix in `.dsh/permissions.local.json`.

Off a TTY it is a line reader: no widgets, no drawing.

## Terminals

| Tier | Terminals | Meaning |
|---|---|---|
| First | iTerm2, Terminal.app, VS Code integrated terminal, tmux, Windows Terminal + WSL | a regression here blocks a release |
| Second | Ghostty, kitty, Alacritty, Warp | a regression here is a bug, not a blocker |
| Best-effort | native Windows (pwsh) | persistent terminals are unavailable there; the rest is expected to work |

Kitty keyboard protocol, focus reports, OSC 11, and inline graphics take effect where the terminal answers; elsewhere the legacy path stays. Ctrl+Enter steering needs the kitty protocol; the queue panel's `s` does the same without it.

## Third-party endpoints

Declare the route once in `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`), then pick it with `/model`:

```yaml
llm-pi-ai:
  providers:
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.acme.example/v1
      compat:
        thinkingFormat: deepseek      # how a thinking level travels on the wire
        supportsDeveloperRole: false  # system prompt as `system`, not `developer`
        maxTokensField: max_tokens
      models:
        - id: acme-large
          contextWindow: 65536
          maxTokens: 4096
```

`/model acme-gateway/acme-large` switches to it and saves it as the default. The key resolves per request from the named environment variable, then `$DSH_HOME/.credentials.yaml`, then `<cwd>/.env`, then `$DSH_HOME/.env`. Compat switches and per-model `reasoningEfforts` are in the `@deepseek-ai/dsh-llm-pi-ai` README.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `pnpm run dev` · `pnpm test` · `pnpm run typecheck` · `pnpm run test:e2e`. This repo never forks the harness (`pnpm run sync:dsh`).

## Talk to it

Bugs, Windows, other models, “I came from Claude Code” — open an [issue](https://github.com/Blackman99/codsh/issues). [Discussions](https://github.com/Blackman99/codsh/discussions) are on for longer threads.

## License

MIT
