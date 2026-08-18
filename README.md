# codsh

> npm: [`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · command: `codsh`

English | [中文](README.zh.md)

A Claude Code-style coding agent for the terminal, composed on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin runtime. codsh is a dsh *bundle*: it ships the interactive TTY surface and a coding agent preset, and everything underneath — the agent loop, tools, sessions, sandboxing, model adapters — is the released dsh packages from npm.

## Install

```sh
npm install -g codsh-cli
codsh
```

The first run registers this package into a dsh `code` profile under `$DSH_HOME` (default `~/.dsh`) and installs the packaged `code-cli` agent preset; every later run boots straight into the prompt. The model key is read from `DEEPSEEK_API_KEY` (environment or `.env`).

`codsh` is exactly `dsh --profile code` — the wrapper only performs the one-time profile registration. Flags after `codsh` reach the app: `codsh --resume <session-id>`, `codsh --continue`, `codsh -p "one-shot task"`.

## What you get

- **An input box that owns the keyboard**: multi-line editing (Alt-Enter), history across sessions, completion for commands, arguments, and `@`-mentioned files (fuzzy, workspace-wide), opened as you type.
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

## License

MIT
