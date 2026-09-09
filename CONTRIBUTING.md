# Contributing to codsh

Thanks for helping! codsh is a [dsh](https://github.com/deepseek-ai/deepseek-harness) bundle: this repository owns the terminal surface and the coding-agent preset; everything underneath is the released dsh packages. Changes to the harness itself belong upstream — this repo never forks it.

Not sending a patch? Open an [issue](https://github.com/Blackman99/codsh/issues) or a [discussion](https://github.com/Blackman99/codsh/discussions). Windows, third-party endpoints, and “I came from Claude Code / Codex” are welcome even as incomplete reports — they tell other people the project is lived in.


## Getting started

```sh
pnpm install
pnpm run dev              # build → sync into .dev-home → boot (seconds per loop)
MOCK=markdown pnpm run dev    # keyless, against the e2e mock model
```

See the README's Development section for the full loop, the `MOCK` modes, and `INSPECT=1` debugging.

## Before you open a PR

```sh
pnpm run typecheck
pnpm test                 # unit suites
pnpm run test:e2e         # drives the installed dsh binary through pipes and a real PTY
pnpm run test:e2e e2e/pty-input.e2e.ts   # one suite; the build still runs first
```

- New rendering or input behavior needs a test at the right level: pure modules (editor, markdown, transcript, …) get unit specs; anything about raw mode, repaints, or key timing gets a PTY e2e step.
- The e2e suites are split by topic because Vitest parallelises by file and a run takes as long as its largest file: `pty-input`, `pty-selectors`, `pty-folds`, `pty-mouse`, `pty-session` for the raw-terminal behaviours, `experience-viewport`, `experience-navigation`, `experience-reading`, `experience-chrome` for the first-five-minutes checklist, plus `pipe`, `images`, and `wrapper`. Put a new step in the file whose topic it belongs to, and split a file that grows past about fifteen steps rather than letting it become the critical path. Shared PTY helpers (keys, `screenAt`, `boxTops`) live in `e2e/pty-helpers.ts`.
- Surface work is not done at unit green. Drive the changed keys and chrome on a real TTY — the PTY e2e that paints the frame, or `MOCK=echo pnpm run dev` — before calling the row aligned. This is standard process, not optional.
- The transcript is append-only and the renderer switches on presenter `card` tags, never tool names — keep both invariants.
- Add a changeset (`pnpm changeset`) describing the user-visible change; releases are cut from accumulated changesets by CI. CI picks the end-to-end suites by what the diff can reach, and the lists are spelled out in `.github/workflows/ci.yml`: changelogs, changesets, a version line, prose, pictures, and unit specs run typecheck and the unit suites only; a diff confined to `packages/cli` runs the wrapper suite, and one confined to the image modules (vision, preview, paste, terminal graphics) runs the images suite; anything else in the diff runs everything. Extend the lists only for a path no other suite can observe.

## Reporting bugs

Terminal bugs are timing- and TTY-shape-sensitive: please include your terminal emulator, `echo $TERM`, whether the run was interactive or piped, and — if you can — a minimal `MOCK=<mode> pnpm run dev` reproduction.
