<p align="center">
  <a href="https://blackman99.github.io/codsh/">
    <img src="assets/banner.svg" width="900"
         alt="codsh — a terminal coding agent whose interaction design fuses the best of today's agent CLIs, composed on the DeepSeek Harness">
  </a>
</p>

<p align="center">
  <a href="https://blackman99.github.io/codsh/"><b>Site &amp; showcase</b></a> ·
  <a href="https://www.npmjs.com/package/codsh-cli">npm</a> ·
  English | <a href="README.zh.md">中文</a>
</p>

> npm: [`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · command: `codsh`

A terminal coding agent whose interaction design fuses the best of today's agent CLIs, composed on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin runtime. codsh is two small packages over your dsh: a zero-dependency launcher (`codsh-cli`) and a dsh *bundle* (`codsh-bundle`) shipping the interactive TTY surface and a coding agent preset. Everything underneath — the agent loop, tools, sessions, sandboxing, model adapters — is the released dsh packages from npm, installed once per machine.

## Install

```sh
npm install -g @deepseek-ai/dsh codsh-cli   # already have dsh? just: npm install -g codsh-cli
codsh
```

[`codsh-cli`](https://www.npmjs.com/package/codsh-cli) is a **zero-dependency launcher, a few kilobytes** — it never bundles the dsh runtime, so a machine carries exactly one dsh however many tools sit on it. The launcher finds your dsh (`DSH_BIN`, a resolvable `@deepseek-ai/dsh`, or `dsh` on PATH), registers the [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) runtime into a dsh `code` profile under `$DSH_HOME` (default `~/.dsh`) on first run — the packaged `code-cli` agent preset installs itself on first boot — and every later run boots straight into the prompt. Profiles install through your pnpm store, so the runtime's packages are shared with everything else dsh on the machine. The model key is read from `DEEPSEEK_API_KEY` (environment or `.env`).

`codsh` is exactly `dsh --profile code` — the launcher only performs the one-time registration (and upgrades the bundle when you upgrade the launcher). Flags after `codsh` reach the app: `codsh --resume <session-id>`, `codsh --continue`, `codsh -p "one-shot task"`.

Prefer no launcher at all? The two lines it wraps work directly, with any profile name:

```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

## What you get

- **A session that is its own space**: codsh takes the alternate screen, so your shell's scrollback is untouched and waiting when you leave. The transcript scrolls in a buffer the session owns — mouse wheel, PgUp/PgDn, Shift+↑/↓ — under an input box that never moves from the bottom; scrolled back, the viewport says how far and new output keeps accumulating without yanking you to it. Every frame paints as one synchronized update, and quitting drops a two-line summary (session id, spend, the `--resume` command) into your shell.
- **From one sentence to shipped — `/ship`**: type `/ship <one-sentence idea>` and the agent researches your repo, grills you one focused question at a time until the design stops moving, writes a spec you confirm, presents a plan you approve, then lands it autonomously — small work in-session, large work through a fresh-agent Ralph loop — until the spec's acceptance criteria pass with green tests.
- **Todos that stay in view**: when the agent writes a todo list, a pinned row holds it over the status row — progress, the item in flight, or what comes next — instead of scrolling away with the write. Ctrl+T opens it into the full list and closes it again; `/todos` prints the list into the transcript, and `--resume` reopens on the list the session left off with.
- **Select to copy**: drag with the mouse and the selection is on your clipboard the moment you release — highlighted in place, sent through OSC 52 and the platform clipboard both (`CODSH_CLIPBOARD=osc52|system|off` narrows it). Long finished blocks — thinking, tool output, and answers past a screenful — collapse to their head lines once you move on; click one to open just that block, click it again anywhere to fold it back, or Ctrl-O to swap every one of them at once. Resting the pointer on a block underlines its head row and names it under the box — `thinking · 42 lines · click to expand` — so what a click will do is known before it lands, and a block taller than the screen still says which one you are in. Resuming a session replays its history as those same folds, so a long output from yesterday still opens. Every block also carries a rule down its left edge — heavy for your own message, light for a tool block, red for a failed one — and a selection that sweeps across one copies the text without it.
- **An input box that owns the keyboard**: multi-line editing (Shift-Enter on kitty-protocol terminals — Ghostty, kitty, WezTerm, iTerm2, foot — and Alt-Enter everywhere), history across sessions, and completion for commands, arguments, and `@`-mentioned files (fuzzy, workspace-wide), opened as you type.
- **Paste an image, even into a text-only model**: Ctrl+V reads your system clipboard and attaches the image behind an `[Image #N]` token (backspace deletes it whole). On an image-capable route it rides the message as a first-class attachment through dsh's durable store — declare `inputModalities: [text, image]` for your model in `$DSH_HOME/settings.yaml` to open that gate. On the default text-only DeepSeek routes the image is saved to a file the agent can work on with its tools, and when `CODSH_VISION_BASE_URL` + `CODSH_VISION_MODEL` (plus optional `CODSH_VISION_API_KEY`) name any OpenAI-compatible multimodal endpoint — GLM-4V, Qwen-VL, a local llava — a description with everything transcribed verbatim rides the same message, standing in for sight.
- **Streaming rendering**: Markdown with code highlighting and table layout, reasoning models' thinking dim under `✻ thinking`, tool calls as presenter-driven cards with diffs, and Ctrl-O to reprint the last clipped output in full.
- **Decisions as selections**: approvals, questions, `/model`, and `/resume` are arrow-key widgets; plan mode toggles on Shift-Tab and tints the box frame.
- **Session flow**: `/clear` starts fresh in place, `/resume` picks from recorded sessions with titles and ages, Escape twice recalls your previous message for editing, and `!cmd` runs in your shell with the outcome injected as model-visible context — no turn spent.
- **Canned prompts**: `/init` drafts an `AGENTS.md`; your own Markdown files under `$DSH_HOME/commands/` or `<workspace>/.dsh/commands/` become slash commands with `$ARGUMENTS` templating.
- Status line (model, preset, permissions, tokens, context left, branch), terminal-title updates, a bell when a decision waits, and a `--print` mode for scripts.

Off a TTY (pipes, scripts) the same surface degrades to a line reader: selections become typed answers, lists replace widgets, and nothing draws.

## From one sentence to shipped

`/ship` drives an idea from 0 to 1 with exactly two approvals and nothing else to babysit:

1. **Interview** — the agent reads your repo first, then asks one focused question at a time (users, success criteria, scope, non-goals, constraints, edge cases) until answers stop changing the design. A pasted mockup or screenshot is requirements material.
2. **Spec (gate 1)** — the agreed design lands as a file in your repo (`docs/specs/<slug>.md` unless your repo has its own convention). Every acceptance criterion names the exact command that proves it, and a `Status:` line makes the file resumable; you confirm it.
3. **Plan (gate 2)** — milestones, tests, and the commands that prove them; you approve it. The approved plan is then written **into the spec** as checkboxes, and the proof commands run once before any code — a baseline that is already red surfaces here, not under the diff.
4. **Landing** — from here it is autonomous, with the spec file as the working memory: re-read before each milestone, checkbox ticked and a commit made when it turns green. Small plans run implement→test→fix→commit in-session under the todo list; large ones run a fresh-agent Ralph loop — bounded, and told to stop and report rather than spin past two rounds of no progress.
5. **Done** — every criterion verified by running its own command and reading the output (after a Ralph loop, the session re-runs them all itself), then a report listing criterion → command → what it printed.

```sh
/ship let long diffs open in a pager instead of scrolling past
```

Run it bare and it first offers to resume any unfinished spec it finds — interruptions lose nothing — then asks for the sentence. Mid-flight decision changes go back into the spec file, so the file always states what is being built.

## Development

```sh
pnpm install
pnpm run dev          # build → sync into .dev-home → boot; seconds per iteration
MOCK=markdown pnpm run dev    # keyless, against the e2e mock model
pnpm run build        # tsdown runtime bundles + tsc declarations into lib/
pnpm run typecheck
pnpm test             # unit suites (pure modules: editor, markdown, transcript, …)
pnpm run test:e2e     # packs this repo, registers it into a dsh profile, and
                      # drives the INSTALLED dsh binary through pipes and a real PTY
```

`pnpm run dev` keeps a repo-local dsh home in `.dev-home`: the first run does a real profile install of the packed tree, and every later run just copies the fresh `lib/` over the profile's unpacked package — so edits reach the running surface in seconds. `MOCK=<write|bash|slow|markdown|reasoning|echo|tall>` swaps in the keyless e2e model for UI work without a key, arguments pass through (`pnpm run dev -- --resume <id>`), and `INSPECT=1` opens the Node inspector on the app process (`chrome://inspect` or a VS Code attach). Off-TTY logic is easiest to step through piped — `printf 'task\n/exit\n' | MOCK=echo pnpm run dev` — where raw mode and the repaint region are out of the picture; keep `console.*` out of debug prints on a TTY (they tear the managed region) and log to a file instead.

The e2e suites test the release artifact: `npm pack` output installed into a real profile, booted by the dsh launcher from npm, with a keyless mock model. What passes there is what a user installs.

### Debugging against dsh sources

Day to day, dsh is an ordinary npm dependency. To step into harness code, clone [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) beside this repo, build it (`pnpm install && pnpm run build`), then point the packages you are debugging at the checkout:

```jsonc
// package.json — remove again when done; keep npm as the default
"pnpm": {
  "overrides": {
    "@deepseek-ai/dsh-agent-loop": "link:../deepseek-harness/packages/core/agent-loop"
  }
}
```

and re-run `pnpm install`. Changes you want upstream go to the harness repo as ordinary PRs; this repository never forks it.

### Keeping up with dsh releases

codsh consumes the harness as published `@deepseek-ai/dsh-*` packages, so "syncing with dsh" means tracking harness **releases**, not merging source. Three layers keep it automatic:

1. **Detect** — [Renovate](renovate.json) watches `@deepseek-ai/dsh-*` (plus co-released cordis packages) and opens dependency PRs; a nightly [sync workflow](.github/workflows/sync-dsh.yml) does the same without third-party services.
2. **Bump** — `pnpm run sync:dsh` rewrites every `@deepseek-ai/dsh-*` range to the latest published release, refreshes the lockfile, writes a changeset, and exits `1` from `--check` when newer versions exist (that is what the nightly job keys on).
3. **Prove** — the same command re-verifies `cordis.patch.yml`: every plugin id it disables or configures must still be declared by an installed dsh bundle, and every package it inserts must resolve. Then it runs typecheck/build/unit (add `--e2e` to boot the real patched bundle), and CI repeats all of that on the resulting PR.

Every dsh package is a prerelease (`0.1.0-rc.N`), and a caret on one **does** float: `^0.1.0-rc.7` admits `0.1.0-rc.8`. The lockfile is what holds this repo still, so an install that has no lockfile — the profile install a user gets, and the one the e2e builds — resolves the newest `rc` instead. Keep the ranges synced rather than trusting them to pin: a runtime and a plugin set from different `rc`s load fine and then fail at the first call whose shape changed. The harness also publishes `rc`s without moving its `latest` tag, so `pnpm run sync:dsh` reads the highest *published* version, and `pnpm update` is never the source of truth.

## License

MIT
