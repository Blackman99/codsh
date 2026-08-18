# codsh

English | [中文](README.zh.md)

A Claude Code-style coding agent for the terminal, composed on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin runtime. codsh is a dsh *bundle*: it ships the interactive TTY surface and a coding agent preset, and everything underneath — the agent loop, tools, sessions, sandboxing, model adapters — is the released dsh packages from npm.

## Install

```sh
npm install -g codsh
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
pnpm run build        # tsdown runtime bundles + tsc declarations into lib/
pnpm run typecheck
pnpm test             # unit suites (pure modules: editor, markdown, transcript, …)
pnpm run test:e2e     # packs this repo, registers it into a dsh profile, and
                      # drives the INSTALLED dsh binary through pipes and a real PTY
```

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
