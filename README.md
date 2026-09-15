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

<p align="center">
  <a href="https://www.npmjs.com/package/codsh-cli"><img src="https://img.shields.io/npm/v/codsh-cli.svg" alt="npm version"></a>
  <a href="https://github.com/Blackman99/codsh/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Blackman99/codsh.svg" alt="MIT license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-1f6feb" alt="dsh-plugin topic"></a>
  <a href="https://dshfind.com/en/plugins/Blackman99/codsh?ref=badge"><img src="https://dshfind.com/api/badge/Blackman99/codsh" alt="dshfind"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://cdn.rawgit.com/sindresorhus/awesome/d7305f38d29fed78fa85652e3a63e154dd8e8829/media/badge.svg" alt="Awesome"></a>
</p>

> npm: [`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · command: `codsh`

**`/ship`** takes one sentence to verified code. A terminal coding agent for DeepSeek — and any OpenAI-compatible endpoint.

Yet another agent CLI. This one is for people who already run [dsh](https://github.com/deepseek-ai/deepseek-harness), who want DeepSeek (or their own gateway) instead of a closed agent, and who bounced off the default TUI. Not a fork: a coding profile and a terminal that is its own space.

[![The /ship flow](assets/ship-demo.gif)](https://blackman99.github.io/codsh/)

## Install

```sh
npm install -g @deepseek-ai/dsh codsh-cli
codsh
```

Key: `DEEPSEEK_API_KEY`. Already have dsh? `npm i -g codsh-cli` is enough when that dsh matches this release. An older harness is refused at boot with the install line.

`codsh --resume <id>` · `codsh --continue` · `codsh -p "task"` · `codsh --version` · `codsh update`

## `/ship`

`/ship <one-sentence idea>` — pre-flight isolation, wayfinder, grill, two approvals, autonomous TDD, dual-layer DoD:

0. **Pre-flight & Isolation** — checks working tree hygiene (`ship · preflight` prompt if dirty); cuts an isolated `ship/<slug>` branch so the base branch stays pristine.
1. **Wayfinder** — before grill, name the destination and resolve the open decisions. Large efforts get a named decision map and dependency-linked decision tickets on the configured tracker (local Markdown under `.scratch/<slug>/wayfinder/` otherwise). These are decisions, not implementation tickets. Unfinished maps pause at `Status: wayfinding`; bare `/ship` resumes them, at most one non-research decision ticket per invocation. A small, already-clear route asks whether to continue without a map. Confirmation advances to `Status: grilling` and the next turn loads grill. The contract ships with codsh; no separate skill installation is required.
2. **Grill** — the grill-me skill: recon first, then a design-tree interview; each round batches the unblocked frontier with a recommended answer and `header` `ship · grill`; ←/→ revisit an earlier answer in that round; a write-in option is an inline field when focused. The card wraps the whole question — it never clips the body to two lines. Nothing is assumed until the frontier is empty and confirmed.
3. **Spec (Gate 1)** — synthesized automatically as the to-spec skill (exhaustive stories, public seams, Out of Scope). Keeps `## Original Requirement` as the user's wording, distinct from the compact Main Track. You confirm. Records branch, base commit, decisions, proving commands, and a `.scratch/` copy (tracker if configured).
4. **Tickets & Baseline (Gate 2)** — to-tickets vertical slices with a DAG, per-ticket acceptance checklists, `.scratch/.../issues/` files, plus the release compliance ticket. You approve. Baseline runs across proof commands and repo guardrails.
5. **Landing** — the tdd skill: one red test witnessed failing, then minimal green, then the suite; 3-strike circuit breaker; cascading re-verification on resume; each green ticket is a clean commit. Investigation, research, ticket implementation, and review go to a fresh `subagent` (not a history fork). The parent keeps questions, gates, and coordination, and independently re-runs final proofs. Children return at most 20 lines plus evidence/log paths. The working tree is shared: read-only work may run in parallel; writers and git mutations stay serial. Every plan uses the same path: the parent coordinates one fresh child for the active unblocked ticket, then ends that turn. The runner checks the goal snapshot, unchanged ticket contracts, dependencies, and checkbox changes before dispatching the next ticket. Final verification runs in a separate turn after all tickets are checked. Two consecutive turns without checkbox progress, an unresolved `## Blocker`, or the per-invocation budget of three turns per ticket plus final verification stops automatic continuation; recorded progress remains resumable. `/ship` does not call Ralph; the tool remains available for an explicit request outside the workflow. Esc stops coordination, including a running ticket.
6. **Done (Dual-Layer DoD)** — verifies acceptance criteria (exit 0) and zero new repo failures against baseline; interactive delivery prompt (`ship · deliver`: merge back, keep PR branch, or stay). Coverage is original requirement → Track-N → acceptance → ticket → evidence; a green suite cannot hide a missing requirement or an out-of-scope change.

In a grill round, ↑/↓ moves focus; on a multi-select question, Space toggles `[x]` choices and Enter submits them (with nothing checked, Enter takes the focused option). ← goes back and → returns to the next visited question; previous selections and submitted write-ins are restored. While editing text, ←/→ moves the caret first and navigates only at its boundary. Switching options keeps the write-in draft. Each answered question is printed once when the round ends, using its latest submitted answer. Esc closes the remaining questions in that round without aborting `/ship`; unsubmitted questions return empty answers. The focused option's explanation is shown in full, and `❯` remains visible without color.

Each `/ship` turn injects only one contract — wayfinder, grill, to-spec, to-tickets, or TDD — so later phases do not crowd the one in play. The runtime binds one spec for phase, goal, UI, and completion. Several unfinished specs open a selector; a pipe refuses the ambiguity instead of guessing. The status chip begins at `ship · wayfinder`, then follows that bound spec on disk alongside the plan row. The spec's `## Wayfinder` section links the decision map for grill and spec synthesis. Existing `interviewing`, `confirmed`, `planned`, and `landing` specs keep their original phase mapping; resuming them does not restart wayfinder. Bare `/ship` resumes unfinished work without blanking the original requirement; resuming implementation tickets starts with cascading re-verification.

Gate 1 Confirm seals Main Track and acceptance criteria. The runner persists the original requirement plus those sealed sections, when present, in an adjacent `<spec>.ship.json` it owns (`widget.md` → `widget.ship.json`) — the model must not edit, remove, or regenerate it. Commit it unchanged with the spec to retain the wording baseline across checkouts. Later phases and resumed runs check that snapshot at phase boundaries; mismatch or corruption stops the run instead of accepting a rewrite. A first snapshot cannot verify earlier history, so this is limited protection, not a tamper-proof sandbox. Plan mode writes no snapshots. Distinct from that wording snapshot, Confirm also compiles a sealed Mission Contract (`.scratch/<slug>/mission.contract.json`) the runner owns: REQ / NEG / ACC ids, write-tier protection of immutable Main Track, Alignment Gate / Drift Detector / Verifier, and a compact contract summary prepended on later turns so landing cannot rewrite the design. After seal, protected writes are denied before execution; external Main Track changes stop the run and remain on disk for inspection instead of being silently restored. Final delivery also requires recorded acceptance evidence. Land injects only the active ticket. Goals stay optional; a bare `/ship` still keeps the original wording. Identity, snapshot, and phase checks plus review and real proofs are the guardrails — not a guarantee of semantic zero drift. If an unrelated `/goal` is current, `/ship` pauses it and asks `ship · occupancy` (Replace / Abort) before any phase starts; on a pipe it auto-Replaces. `/goal` during a run shows the `[ship]` compass. Chrome is unchanged: no extra chrome, no GoalBar.

```sh
/ship let long diffs open in a pager instead of scrolling past
```

## How it works

`codsh` is a zero-dependency launcher. It finds your dsh, registers [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) into a dedicated `code` profile, and boots `dsh --profile code`. The found dsh must meet this release's harness floor; an older one is refused at boot rather than crashing on a missing export.

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
- Thinking streams into the transcript and stays open under its clock (`✻ thought for 3.2s`) until the next prompt folds it to that row; every tool call is one row — what it did, `+n -m` or `· 12 lines`, `✔` or `✗`, and a failed row's reason — with the output behind it. Click a block to work it, Ctrl+O to work them all (it opens whatever is folded, and folds everything once nothing is), and what you opened or folded by hand keeps that form across later turns. A finished answer stays whole. Compaction — automatic, or `/compact` — leaves a fold too: how many items and tokens became a summary, which model wrote it, and the summary itself; the hint row says `compacting history…` while it runs.
- A running in-process subagent is a view: as soon as the child exists, its card says `click to enter`. The child's transcript replaces the parent's and streams while it works; Esc pops one level. Typing there is refused — this is looking, not a follow-up. Workflow/Ralph rounds stay a line: those children run in a worker thread and no click could enter one.
- The children a session started stay counted under the box — `subagents 2 · 1 running · 1 done · Ctrl+G`. Ctrl+G, or a click on that row, opens the list: each child's state, elapsed time, calls, and latest call; Enter or a click opens one, and its status row names it. A finished child stays listed and opens read-only. `/subagents` prints the same list.
- `/view 1` opens an answer full screen, `/view 1:1` its first code block; Esc restores the conversation exactly. `/copy` addresses the same targets — raw Markdown, or fence-free code.
- `/diff` reads uncommitted changes in the same reader rather than scrolling them past, and a diff card too long for its own body opens there on click. Piped, it stays lines.

**Working**

- Alternate screen; the box never leaves the bottom; quitting gives your shell back untouched.
- Todos stay in the chrome (Ctrl+T / `/todos`). Markdown, thinking, and tool cards stream in. The inline HTML an answer uses instead of Markdown renders too: `<font color>` and `<span style>` colours (the terminal's own for ANSI names, truecolor or the nearest palette entry otherwise), `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<br>`, and entities; unknown tags stay as written. Drag to copy, in the transcript or the box.
- Ctrl+V pastes images. While the cursor rests on the `[Image #N]` token a card centered over the transcript previews it: the picture itself wherever the terminal paints one — Ghostty, kitty and WezTerm through Kitty graphics, iTerm2 through its own — and a colour half-block mosaic everywhere else. Ctrl+O, or a click on the card, opens the original in the system viewer. (Native vision; DeepSeek text models borrow Vision Exp automatically; other text routes keep the file + optional sidecar fallback.)
- `/` commands, `$` skills, `!` shell, `@` files — the menu sits above the box. ⇧Tab is plan mode.
- Type while the agent works and the line queues, shown as `↳ queued: …` under the box. Prompts queued together go as ONE message when the turn ends, a blank line between them; a `!` line or `/` command keeps its place in the order and runs alone. Ctrl+Q, or a click on that row, opens the queue: Enter edits a line back into the box, `d` deletes, Shift+↑/↓ reorders, `s` steers it into the running turn. Ctrl+Enter steers straight from the box on terminals that speak the kitty keyboard protocol; the line shows as `↳ steering:` until the model takes it. Esc interrupts, queue and all — the queue then goes as the next message. ↑ still recalls the lines one at a time.
- `/ui compact|comfortable` sets how much room the transcript takes. Compact is the default and the shape everything above is described in; comfortable only adds — a blank row between turns and a higher click-to-pager threshold on expanded diffs. The choice persists across sessions.
- Approvals, `/model`, `/resume`, and `/thinking` (or `/effort`) are arrow-key widgets; `/clear`, Esc Esc, `/init`, and `/update` round it out. `!cmd` prints in-session and the agent sees it.
- `/thinking [level]` (alias `/effort`) configures reasoning deliberation (e.g. `off`, `low`, `high`, `max`, or shortcuts `on`/`off`) with an interactive selector on TTY, per-model persistence, and active level tags in MetaBar (e.g. `deepseek-chat (high)`) and `/status`.
- The status row shows the next request's estimated context usage and window capacity, e.g. `context 32k/128k (75% left)`. It stays visible during normal usage and after `/resume`, warns at 25% remaining, and turns red at 10%. Unknown figures show `?`; before either figure is available, the segment is absent. Narrow terminals drop the directory before context, falling back to the remaining percentage when needed. `/status` keeps the full token breakdown.
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
`bash`, `fail` (a command that prints a line and exits 3), `heredoc`, `slow`,
`steer` (holds a turn 3s and reports whether a mid-turn message arrived),
`tall`, `spec`, `markdown`, `reasoning`, `reasoning-slow` (a thought long
enough to interrupt), `reason-write` (a thought, a write, a second thought,
an answer), `echo`, `todo`, `questions`, `workflow`, `subagents` (two
background children, one of which fails),
`context` (32k input usage against a 128k window; 64k on `cli-mock-pro`),
`ship-wayfinder` (`/ship SMALL_WAYFINDER` exercises the confirmed grill handoff;
`/ship PENDING_WAYFINDER` leaves a resumable planning ledger), `ship-delegate`,
`ship-landing`,
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
