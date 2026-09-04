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

**`/ship`** takes one sentence to verified code. A terminal coding agent on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

[![The /ship flow](assets/ship-demo.gif)](https://blackman99.github.io/codsh/)

## Install

```sh
npm install -g @deepseek-ai/dsh codsh-cli   # already have dsh? npm i -g codsh-cli
codsh
```

Zero-dependency launcher. `codsh` is `dsh --profile code`. Key: `DEEPSEEK_API_KEY`.

`codsh --resume <id>` · `codsh --continue` · `codsh -p "task"` · `codsh --version` · `codsh update`

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

## `/ship`

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

The [site](https://blackman99.github.io/codsh/) shows each one as a real capture. In brief:

**Reading a long session**

- A submitted prompt takes the viewport top and its reply fills the space beneath it. Read back into history and the way home is the same frame: the wheel and PgDn land on it again.
- Whatever you are reading, the prompt that asked for it pins itself at the top; the next prompt pushes it away.
- A one-column timeline on the right marks the turn you are in — ticks and arrows click-jump, hover previews the real prompt lines. Shift+←/→ does it from the keyboard, and `/jump` is a searchable, reversible preview.
- Thinking and long tool output fold: click one, Ctrl+O all, and what you opened by hand stays open across later turns. A finished answer stays whole.
- `/view 1` opens an answer full screen, `/view 1:1` its first code block; Esc restores the conversation exactly. `/copy` addresses the same targets — raw Markdown, or fence-free code.
- `/diff` reads uncommitted changes in the same reader rather than scrolling them past, and a diff card too long for its own body opens there on click. Piped, it stays lines.

**Working**

- Alternate screen; the box never leaves the bottom; quitting gives your shell back untouched.
- Todos stay in the chrome (Ctrl+T / `/todos`). Markdown, thinking, and tool cards stream in. Drag to copy, in the transcript or the box.
- Ctrl+V pastes images (native vision; DeepSeek text models borrow Vision Exp automatically; other text routes keep the file + optional sidecar fallback).
- `/` commands, `$` skills, `!` shell, `@` files — the menu sits above the box. ⇧Tab is plan mode.
- Approvals, `/model`, and `/resume` are arrow-key widgets; `/clear`, Esc Esc, `/init`, and `/update` round it out. `!cmd` prints in-session and the agent sees it.

Off a TTY it becomes a line reader: no widgets, no drawing.

## Development

```sh
pnpm install
pnpm run dev                 # build → .dev-home → boot
MOCK=markdown pnpm run dev   # keyless, against the e2e mock
pnpm test
pnpm run test:e2e            # pack, install, drive the real binary
CAPTURE_SCREENS=1 pnpm run site:screens   # re-shoot the site's terminals
```

`CODSH_TRACE=<path>` tees every byte the viewport writes, and the size it wrote
them at, into a file. A frame that arrives corrupted is a disagreement between
what the surface emitted and what the terminal did with it, and the emitted
half is gone by the time anyone looks; replaying the file through a terminal
emulator reproduces the screen it drew. Off unless the variable is set.

`pnpm run sync:dsh` tracks published `@deepseek-ai/dsh-*` releases. This repo never forks the harness.

## License

MIT
