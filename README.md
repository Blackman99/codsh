<p align="center">
  <a href="https://blackman99.github.io/codsh/">
    <img src="assets/banner.svg" width="900"
         alt="codsh — a terminal coding agent on the DeepSeek Harness">
  </a>
</p>

<p align="center">
  <a href="https://blackman99.github.io/codsh/"><b>Site</b></a> ·
  <a href="https://www.npmjs.com/package/codsh-cli">npm</a> ·
  English | <a href="README.zh.md">中文</a>
</p>

> npm: [`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · command: `codsh`

A terminal coding agent on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). **`/ship`** takes one sentence to verified code.

## Install

```sh
npm install -g @deepseek-ai/dsh codsh-cli   # already have dsh? npm i -g codsh-cli
codsh
```

Zero-dependency launcher. `codsh` is `dsh --profile code`. Key: `DEEPSEEK_API_KEY`.

`codsh --resume <id>` · `codsh --continue` · `codsh -p "task"`

Or skip the launcher:

```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

## `/ship`

[![The /ship flow](assets/ship-demo.gif)](https://blackman99.github.io/codsh/)

`/ship <one-sentence idea>` — grill, two approvals, then autonomous:

1. **Grill** — design-tree interview; facts are inspected, each round asks the open frontier with a recommended answer.
2. **Spec** — synthesized automatically (to-spec). You confirm. Each criterion names its proving command.
3. **Tickets** — tracer-bullet slices, written automatically. You approve. Baseline runs before any code.
4. **Landing** — TDD at the spec's seams; each green ticket is a commit.
5. **Done** — every criterion re-run and reported.

Bare `/ship` resumes an unfinished spec.

```sh
/ship let long diffs open in a pager instead of scrolling past
```

## The surface

The [site](https://blackman99.github.io/codsh/) shows each live. In brief:

- Alternate screen; box pinned at the bottom; quit restores your shell.
- User prompts stay at the top as turn headers while you read long replies; the next prompt pushes the previous one away.
- A newly submitted prompt starts at the viewport top while streamed reply rows fill the space beneath it.
- Shift+←/→ jumps between real user turns; `/jump` offers a searchable, reversible preview.
- A one-column timeline on the right tracks the current turn; hover previews real prompt lines, while ticks and enabled arrows click-jump through turns.
- `/copy` searches assistant answers; `/copy N` copies raw Markdown and `/copy N:C` copies exact fence-free code.
- `/view` opens the same answer/code targets in a resize-safe full-screen reader; Esc restores the conversation.
- Long blocks fold; click one or Ctrl+O all, and explicit choices persist across later turns.
- Todos stay in chrome (Ctrl+T / `/todos`).
- Drag to copy. Markdown, thinking, and tool cards stream in.
- Ctrl+V pastes images (native vision; DeepSeek text models borrow Vision Exp automatically; other text routes keep the file + optional sidecar fallback).
- `/` commands, `$` skills, `!` shell, `@` files — menu sits above the box.
- Approvals and `/model` `/resume` are arrow-key widgets. ⇧Tab is plan mode.
- `/clear`, `/resume`, Esc Esc, `/init`. `!cmd` prints in-session and the agent sees it.

Off a TTY it becomes a line reader: no widgets, no drawing.

## Development

```sh
pnpm install
pnpm run dev                 # build → .dev-home → boot
MOCK=markdown pnpm run dev   # keyless, against the e2e mock
pnpm test
pnpm run test:e2e            # pack, install, drive the real binary
```

`pnpm run sync:dsh` tracks published `@deepseek-ai/dsh-*` releases. This repo never forks the harness.

## License

MIT
