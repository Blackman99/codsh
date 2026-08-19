# codsh

> npm: [`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · command: `codsh`

English | [中文](README.zh.md)

A terminal coding agent whose interaction design fuses the best of today's agent CLIs, composed on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin runtime. codsh is a dsh *bundle*: it ships the interactive TTY surface and a coding agent preset, and everything underneath — the agent loop, tools, sessions, sandboxing, model adapters — is the released dsh packages from npm.

## Install

```sh
npm install -g codsh-cli
codsh
```

The first run registers this package into a dsh `code` profile under `$DSH_HOME` (default `~/.dsh`) and installs the packaged `code-cli` agent preset; every later run boots straight into the prompt. The model key is read from `DEEPSEEK_API_KEY` (environment or `.env`).

`codsh` is exactly `dsh --profile code` — the wrapper only performs the one-time profile registration. Flags after `codsh` reach the app: `codsh --resume <session-id>`, `codsh --continue`, `codsh -p "one-shot task"`.

### Already on dsh?

Skip the global package — it bundles its own copy of the dsh runtime (~300MB), which a machine that has dsh doesn't need twice. Add codsh to a profile with the dsh you already have:

```sh
dsh plugin --profile code add codsh-cli
dsh --profile code
```

The profile install resolves against your pnpm store, so on a machine with dsh it downloads next to nothing. The first boot installs the `code-cli` agent preset by itself, and every codsh feature works identically — the `codsh` command is only sugar for the two lines above. Any profile name works; only the wrapper hardcodes `code`.

## What you get

- **A session that is its own space**: codsh takes the alternate screen, so your shell's scrollback is untouched and waiting when you leave. The transcript scrolls in a buffer the session owns — mouse wheel, PgUp/PgDn, Shift+↑/↓ — under an input box that never moves from the bottom; scrolled back, the viewport says how far and new output keeps accumulating without yanking you to it. Every frame paints as one synchronized update, and quitting drops a two-line summary (session id, spend, the `--resume` command) into your shell.
- **Select to copy**: drag with the mouse and the selection is on your clipboard the moment you release — highlighted in place, sent through OSC 52 and the platform clipboard both (`CODSH_CLIPBOARD=osc52|system|off` narrows it). Long finished blocks — thinking, tool output, and answers past a screenful — collapse to their head lines once you move on; Ctrl-O swaps every one of them between summary and full form.
- **An input box that owns the keyboard**: multi-line editing (Alt-Enter), history across sessions, and completion for commands, arguments, and `@`-mentioned files (fuzzy, workspace-wide), opened as you type.
- **Streaming rendering**: Markdown with code highlighting and table layout, reasoning models' thinking dim under `✻ thinking`, tool calls as presenter-driven cards with diffs, and Ctrl-O to reprint the last clipped output in full.
- **Decisions as selections**: approvals, questions, `/model`, and `/resume` are arrow-key widgets; plan mode toggles on Shift-Tab and tints the box frame.
- **Session flow**: `/clear` starts fresh in place, `/resume` picks from recorded sessions with titles and ages, Escape twice recalls your previous message for editing, and `!cmd` runs in your shell with the outcome injected as model-visible context — no turn spent.
- **Canned prompts**: `/init` drafts an `AGENTS.md`; your own Markdown files under `$DSH_HOME/commands/` or `<workspace>/.dsh/commands/` become slash commands with `$ARGUMENTS` templating.
- Status line (model, preset, permissions, tokens, context left, branch), terminal-title updates, a bell when a decision waits, and a `--print` mode for scripts.

Off a TTY (pipes, scripts) the same surface degrades to a line reader: selections become typed answers, lists replace widgets, and nothing draws.

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

Because every dsh package is a prerelease (`0.1.0-rc.N`), plain semver ranges do **not** float across releases — the sync command is the source of truth, not `pnpm update`.

## License

MIT
