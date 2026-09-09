<p align="center">
  <a href="https://blackman99.github.io/codsh/">
    <img src="assets/banner.svg" width="900"
         alt="codsh — a terminal coding agent for DeepSeek">
  </a>
</p>

<p align="center">
  <a href="https://blackman99.github.io/codsh/"><b>Site</b></a> ·
  <a href="https://www.npmjs.com/package/codsh-cli">npm</a> ·
  English | <a href="README.zh.md">中文</a>
</p>

> npm: [`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · command: `codsh`

**`/ship`** takes one sentence to verified code. A terminal coding agent for DeepSeek — and any OpenAI-compatible endpoint.

Yet another agent CLI. This one is for people who already run [dsh](https://github.com/deepseek-ai/deepseek-harness), who want DeepSeek (or their own gateway) instead of a closed agent, and who bounced off the default TUI. Not a fork: a coding profile and a terminal that is its own space.

[![The /ship flow](assets/ship-demo.gif)](https://blackman99.github.io/codsh/)
<p align="center"><a href="assets/codsh-ship-demo.zh.mp4">中文口播版 · 70 秒</a></p>

## Install

```sh
npm install -g @deepseek-ai/dsh codsh-cli
codsh
```

Key: `DEEPSEEK_API_KEY`. Already have dsh? `npm i -g codsh-cli` is enough.

`codsh --resume <id>` · `codsh --continue` · `codsh -p "task"` · `codsh --version` · `codsh update`

## `/ship`

`/ship <one-sentence idea>` — pre-flight isolation, grill, two approvals, autonomous TDD, dual-layer DoD:

0. **Pre-flight & Isolation** — checks working tree hygiene (`ship · preflight` prompt if dirty); cuts an isolated `ship/<slug>` branch so the base branch stays pristine.
1. **Grill** — the grill-me skill: recon first, then a design-tree interview; each round batches the unblocked frontier with a recommended answer and `header` `ship · grill`; nothing is assumed until the frontier is empty and confirmed.
2. **Spec (Gate 1)** — synthesized automatically as the to-spec skill (exhaustive stories, public seams, Out of Scope). You confirm. Records branch, base commit, decisions, proving commands, and a `.scratch/` copy (tracker if configured).
3. **Tickets & Baseline (Gate 2)** — to-tickets vertical slices with a DAG, per-ticket acceptance checklists, `.scratch/.../issues/` files, plus the release compliance ticket. You approve. Baseline runs across proof commands and repo guardrails.
4. **Landing** — the tdd skill: one red test witnessed failing, then minimal green, then the suite; 3-strike circuit breaker; cascading re-verification on resume; each green ticket is a clean commit. A larger plan runs as a Ralph loop of fresh agents; while a round works, the working line names that round and its latest call (the chrome already holds the plan), the plan row ticks as the spec's checkboxes change on disk, and the round's end line says what it did — Esc stops the whole loop, mid-ticket.
5. **Done (Dual-Layer DoD)** — verifies acceptance criteria (exit 0) and zero new repo failures against baseline; interactive delivery prompt (`ship · deliver`: merge back, keep PR branch, or stay).

Bare `/ship` resumes an unfinished spec with cascading re-verification of prior tickets.

```sh
/ship let long diffs open in a pager instead of scrolling past
```

## How it works

`codsh` is a zero-dependency launcher. It finds your dsh, registers [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) into a dedicated `code` profile, and boots `dsh --profile code`.

A session says so when a newer codsh is published. `codsh update` moves the
pair from the shell, `/update` does it from inside a session, and either way
the update also moves the code profile's runtime to match — the next boot only
registers a runtime a bare `npm install -g codsh-cli` upgrade left behind.
`CODSH_UPDATE_CHECK=off` silences the automatic check; asking still asks.

Or skip the launcher:

```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

Any OpenAI-compatible endpoint is a dsh route — declare it once, then `/model`. See [Third-party endpoints](#third-party-endpoints).

## The surface

The [site](https://blackman99.github.io/codsh/) shows each one as a real capture. In brief:

**Reading a long session**

- A submitted prompt takes the viewport top and its reply fills the space beneath it. Read back into history and the way home is the same frame: the wheel and PgDn land on it again.
- Whatever you are reading, the prompt that asked for it pins itself at the top; the next prompt pushes it away.
- A one-column timeline on the right marks the turn you are in — ticks and arrows click-jump, hover previews the real prompt lines. Shift+←/→ does it from the keyboard, and `/jump` is a searchable, reversible preview. `/rewind` forks the conversation from before a turn you pick and continues there; the original session stays in `/resume`, and Esc Esc still recalls the last prompt.
- Thinking and long tool output fold: click one, Ctrl+O all, and what you opened by hand stays open across later turns. A finished answer stays whole. Compaction — automatic, or `/compact` — leaves a fold too: how many items and tokens became a summary, which model wrote it, and the summary itself; the hint row says `compacting history…` while it runs.
- A running in-process subagent is a view: as soon as the child exists, its card says `click to enter`. The child's transcript replaces the parent's and streams while it works; Esc pops one level. Typing there is refused — this is looking, not a follow-up. Workflow/Ralph rounds stay a line: those children run in a worker thread and no click could enter one.
- `/view 1` opens an answer full screen, `/view 1:1` its first code block; Esc restores the conversation exactly. `/copy` addresses the same targets — raw Markdown, or fence-free code.
- `/diff` reads uncommitted changes in the same reader rather than scrolling them past, and a diff card too long for its own body opens there on click. Piped, it stays lines.

**Working**

- Alternate screen; the box never leaves the bottom; quitting gives your shell back untouched.
- Todos stay in the chrome (Ctrl+T / `/todos`). Markdown, thinking, and tool cards stream in. The inline HTML an answer uses instead of Markdown renders too: `<font color>` and `<span style>` colours (the terminal's own for ANSI names, truecolor or the nearest palette entry otherwise), `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<br>`, and entities; unknown tags stay as written. Drag to copy, in the transcript or the box.
- Ctrl+V pastes images. While the cursor rests on the `[Image #N]` token a card centered over the transcript previews it: the picture itself wherever the terminal paints one — Ghostty, kitty and WezTerm through Kitty graphics, iTerm2 through its own — and a colour half-block mosaic everywhere else. Ctrl+O, or a click on the card, opens the original in the system viewer. (Native vision; DeepSeek text models borrow Vision Exp automatically; other text routes keep the file + optional sidecar fallback.)
- `/` commands, `$` skills, `!` shell, `@` files — the menu sits above the box. ⇧Tab is plan mode.
- Type while the agent works and the line queues, shown as `↳ queued: …` under the box. Prompts queued together go as ONE message when the turn ends, a blank line between them; a `!` line or `/` command keeps its place in the order and runs alone. Ctrl+Q, or a click on that row, opens the queue: Enter edits a line back into the box, `d` deletes, Shift+↑/↓ reorders, `s` steers it into the running turn. Ctrl+Enter steers straight from the box on terminals that speak the kitty keyboard protocol; the line shows as `↳ steering:` until the model takes it. Esc interrupts, queue and all — the queue then goes as the next message. ↑ still recalls the lines one at a time.
- `/ui compact|comfortable` sets how much room the transcript takes. Compact is the default and the shape everything above is described in; comfortable only adds — a blank row between turns, a two-line preview while thinking streams, and a higher click-to-pager threshold on expanded diffs. The choice persists across sessions.
- Approvals, `/model`, `/resume`, and `/thinking` (or `/effort`) are arrow-key widgets; `/clear`, Esc Esc, `/init`, and `/update` round it out. `!cmd` prints in-session and the agent sees it.
- `/thinking [level]` (alias `/effort`) configures reasoning deliberation (e.g. `off`, `low`, `high`, `max`, or shortcuts `on`/`off`) with an interactive selector on TTY, per-model persistence, and active level tags in MetaBar (e.g. `deepseek-chat (high)`) and `/status`.
- Away from the window, a decision waiting or a turn over ten seconds ending rings the bell and sends a desktop notification: OSC 9 on iTerm2, WezTerm, Ghostty, kitty, and Windows Terminal, `osascript` on Terminal.app, `notify-send` beside it on other Linux terminals. Focused, nothing. `bell` and `notify` are the two switches.
- An approval names the call — `Allow bash: git push origin main?` — and its third answer remembers it: `bash(git push *)` goes to `.dsh/permissions.local.json` (personal; gitignore it) and the same prefix is never asked again in this project. `.dsh/permissions.json` (committed) and `~/.dsh/permissions.json` are hand-written, `{ "allow": ["tool", "tool(prefix *)", "tool(exact command)"] }`; a compound command — `&&`, `;`, `|`, a newline — never matches a prefix.

Off a TTY it becomes a line reader: no widgets, no drawing.

## Terminals

Three tiers decide what a release must not break:

| Tier | Terminals | Meaning |
|---|---|---|
| First | iTerm2, Terminal.app, VS Code integrated terminal, tmux, Windows Terminal + WSL | a regression here blocks a release |
| Second | Ghostty, kitty, Alacritty, Warp | a regression here is a bug, not a blocker |
| Best-effort | native Windows (pwsh) | persistent terminals are unavailable there; the rest is expected to work |

Protocol use is progressive: the kitty keyboard protocol, focus reports, and OSC 11 theme detection are requested and take effect wherever the terminal answers; one that ignores them keeps the legacy path — Ctrl+Enter steering needs the kitty protocol, and elsewhere the queue panel's `s` does the same. A terminal with software flow control left on swallows Ctrl+Q silently; the click on the `↳ queued:` row opens the panel there. Inline graphics are chosen the same way, and by what each terminal actually implements rather than by what it is — Kitty graphics on Ghostty, kitty, and WezTerm, `OSC 1337` on iTerm2, a half-block mosaic everywhere else, and nothing inside tmux or screen, which forward neither.

## Third-party endpoints

Any OpenAI-compatible endpoint is a dsh route. Declare it once in `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`, hot-reloaded), then pick it with `/model`:

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

`/model acme-gateway/acme-large` switches to it and saves it as the default; `/status` names the route. The key resolves per request from the named environment variable, then `$DSH_HOME/.credentials.yaml`, then `<cwd>/.env`, then `$DSH_HOME/.env`. A gateway that rejects the request shape is a `compat` question: the full switch table, per-model `reasoningEfforts` (including `false` for a model that must never receive a thinking field), and `modelOverrides` for correcting one catalog model are in the `@deepseek-ai/dsh-llm-pi-ai` README.

## Development

```sh
pnpm install
pnpm run dev                 # build → .dev-home → boot
MOCK=markdown pnpm run dev   # keyless, against the e2e mock
pnpm test
pnpm run typecheck
pnpm run test:e2e            # pack, install, drive the real binary
pnpm run site:screens        # re-shoot the site's terminals from the real binary
```

`MOCK=<mode>` boots against the keyless mock model: `write` (the default),
`bash`, `heredoc`, `slow`, `steer` (holds a turn 3s and reports whether a
mid-turn message arrived), `tall`, `spec`, `markdown`, `reasoning`, `echo`,
`vision`, and the `auto-vision`, `auto-vision-slow`, `auto-vision-fail` trio
behind the automatic image description. `INSPECT=1` opens the Node inspector on
the app process alone, so a breakpoint does not stop the build that precedes it.

`CODSH_TRACE=<path>` tees every byte the viewport writes, and the size it wrote
them at, into a file. A frame that arrives corrupted is a disagreement between
what the surface emitted and what the terminal did with it, and the emitted
half is gone by the time anyone looks; replaying the file through a terminal
emulator reproduces the screen it drew. Off unless the variable is set.

`pnpm run sync:dsh` tracks published `@deepseek-ai/dsh-*` releases. This repo never forks the harness.

## Talk to it

Bugs, Windows, other models, “I came from Claude Code” — open an [issue](https://github.com/Blackman99/codsh/issues). [Discussions](https://github.com/Blackman99/codsh/discussions) are on for longer threads. See [CONTRIBUTING.md](CONTRIBUTING.md) if you are changing the surface.

## License

MIT
