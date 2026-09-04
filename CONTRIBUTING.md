# Contributing to codsh

Thanks for helping! codsh is a [dsh](https://github.com/deepseek-ai/deepseek-harness) bundle: this repository owns the terminal surface and the coding-agent preset; everything underneath is the released dsh packages. Changes to the harness itself belong upstream — this repo never forks it.

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
```

- New rendering or input behavior needs a test at the right level: pure modules (editor, markdown, transcript, …) get unit specs; anything about raw mode, repaints, or key timing gets a PTY e2e step.
- Surface work is not done at unit green. Drive the changed keys and chrome on a real TTY — the PTY e2e that paints the frame, or `MOCK=echo pnpm run dev` — before calling the row aligned. This is standard process, not optional.
- The transcript is append-only and the renderer switches on presenter `card` tags, never tool names — keep both invariants.
- Add a changeset (`pnpm changeset`) describing the user-visible change; releases are cut from accumulated changesets by CI. The Version Packages pull request those produce runs typecheck and the unit suites only — its diff is changelogs and a version line, and the end-to-end suite already ran on the commit that added the changeset. Anything else in the diff runs everything.

## Reporting bugs

Terminal bugs are timing- and TTY-shape-sensitive: please include your terminal emulator, `echo $TERM`, whether the run was interactive or piped, and — if you can — a minimal `MOCK=<mode> pnpm run dev` reproduction.
