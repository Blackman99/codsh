# Agent Guidelines for codsh

This document defines the core workflows, release requirements, and development standards for AI agents working in this repository.

## 1. Release & Changeset Requirements

This project uses [@changesets/cli](https://github.com/changesets/changesets) for package versioning and releases. Both packages (`codsh-cli` and `codsh-bundle`) are fixed in lockstep versioning.

- **Mandatory Changeset**: Any feature, bug fix, performance improvement, or user-visible change **must** include a corresponding changeset file in `.changeset/` (e.g. `.changeset/<short-topic>.md`).
- **Package Specifiers**: Specify the affected packages in the frontmatter (`'codsh-cli': patch|minor|major` and/or `'codsh-bundle': patch|minor|major`).
- **Release Flow**: Changesets are accumulated on `main`. CI automatically aggregates them into a `Version Packages` pull request that updates changelogs and publishes releases to npm. Do not manually edit package versions or changelogs for feature/fix commits.

## 2. Documentation Updates

Whenever code changes alter user-facing behavior, interfaces, commands, or settings, all relevant documentation must be kept synchronized:

- **Bilingual READMEs**: Update both `README.md` (English) and `README.zh.md` (Chinese) whenever CLI flags, options, provider settings, keybindings, or setup steps change. Keep both languages in parity.
- **Architectural & Design Docs**: Keep `CONTEXT.md` (domain language, surface semantics) and `docs/` updated if interactions, turn structures, or system boundaries are adjusted.
- **Developer Documentation**: If build steps, scripts, test commands, or CI expectations change, update `CONTRIBUTING.md`.

## 3. Testing & Verification Standard

Before declaring any task complete or preparing a commit:

- Run `pnpm run typecheck` to verify TypeScript types across all workspace packages.
- Run `pnpm test` to pass all unit test suites.
- Run relevant e2e tests (`pnpm exec vitest run --config vitest.e2e.config.ts <test-file>`) when touching launcher bootstrapping, PTY, or profile integration.
- For interactive TTY or surface changes, verify behavior on a real terminal via `pnpm run dev` or `MOCK=<mode> pnpm run dev`.

## 4. Architecture & Upstream Discipline

- **No Harness Forking**: codsh is built on the DeepSeek Harness (`@deepseek-ai/dsh-*`). Changes to the harness belong upstream; updates are tracked via `scripts/sync-dsh.mjs`.
- **Package Split**:
  - `packages/cli` (`codsh-cli`): Zero-dependency launcher that finds existing `dsh`, manages profile registration, and launches the runtime.
  - `packages/bundle` (`codsh-bundle`): The interactive TTY surface and agent presets mounted into the `code` profile.
