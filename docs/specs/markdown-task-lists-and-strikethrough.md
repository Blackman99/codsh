# Markdown Task Lists and Strikethrough

Status: landing

## Requirement

看看终端 UI 设计上还有什么需要调整的

## Problem Statement

When the assistant outputs GitHub Flavored Markdown (GFM) task lists (`- [ ]`, `- [x]`) or strikethrough (`~~text~~`) during planning, reasoning, or editing, the current transcript markdown renderer leaves `~~` as raw literal delimiters and formats task lists as generic bullet points with literal ASCII brackets (e.g. `• [ ]` and `• [x]`). This creates visual clutter, obscures task progress, and diverges from codsh's established ubiquitous glyph language (`✔`/`▶`/`○`) defined in `todos.ts` and `CONTEXT.md`.

## Solution

Enhance the terminal Markdown rendering pipeline to natively support:
1. **GFM Task Lists**: Unchecked items (`- [ ]`, `* [ ]`, `+ [ ]`) render with codsh's dimmed circle mark (`○`), and checked items (`- [x]`, `* [x]`, `+ [X]`) render with codsh's success checkmark (`✔`) accompanied by dimmed, struck-through body text. Indentation is preserved for nested lists.
2. **Strikethrough Formatting**: Double-tilde spans (`~~strikethrough~~`) render using ANSI SGR 9 (`\u001B[9m`), degrading gracefully to plain text in non-TTY and `NO_COLOR` environments.
3. **Theme System Integration**: Expose `theme.strike(text)` as a first-class styling role on the `Theme` interface, matching existing primitives like `bold`, `dim`, and `accent`.

## Grill Decisions

1. **Task List Glyphs**: Unchecked items render as `theme.dim('○')` and completed items render as `theme.success('✔')`. This maintains strict visual continuity with codsh's existing `todos` component (`todos.ts`) and ADR-0001 alignment guidelines.
2. **Completed Item Text Appearance**: Completed task list items apply both `theme.dim` and `theme.strike` to their text content, aligning with reference implementations in Claude Code and GitHub Markdown.
3. **Theme API Architecture**: Introduce `strike(text: string): string` directly to the `Theme` contract in `theme.ts`, wrapping text in `\u001B[9m` and resetting cleanly with `\u001B[0m`. In `PLAIN` mode or under `NO_COLOR`, it returns text unchanged.
4. **Syntax Support Scope**: Unordered list markers (`-`, `*`, `+`) followed by `[ ]` or `[x]`/`[X]`, with indentation preserved. Inline strikethrough delimited by `~~`. Numbered lists and interactive toggles are explicitly excluded.
5. **Alignment Matrix Reconciliation**: Update row 125 (`Markdown strikethrough / task list`) in `docs/alignment.md` to `aligned`.

## User Stories

1. **US-1**: As a developer reviewing an assistant's proposed plan or step-by-step breakdown, I want pending and completed tasks to be clearly distinguished by `○` and `✔` with struck-through finished items, so that I can understand execution state at a glance.
2. **US-2**: As a developer reading explanations of deprecated APIs or revised code suggestions, I want `~~deleted text~~` to render with a real terminal strikethrough line, so that revisions are legible without reading raw markdown symbols.
3. **US-3**: As a developer redirecting session output to files or running with `NO_COLOR=1`, I want task lists and strikethrough text to degrade cleanly to plain text without ANSI escape artifacts.

## Implementation Decisions

1. **Theme Module (`packages/bundle/src/theme.ts`)**:
   - Add `strike: '\u001B[9m'` to the internal `SGR` dictionary.
   - Add `strike(text: string): string` to the public `Theme` interface.
   - Implement `strike` in `createTheme` via `wrap(SGR.strike)`.
   - Implement `strike` in `PLAIN` as identity (`text => text`).
2. **Markdown Module (`packages/bundle/src/markdown.ts`)**:
   - Add `(~~[^~]+~~)` to `INLINE` regex.
   - In `renderInline`: handle strikethrough matches by invoking `theme.strike(renderInline(inner, theme))`.
   - Add `TASK_ITEM` regex matching `^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$`.
   - In `renderLine`: evaluate `TASK_ITEM` before `BULLET`. If matched:
     - If unchecked (`' '`), emit `${indent}${theme.dim('○')} ${renderInline(body, theme)}`.
     - If checked (`'x'` or `'X'`), emit `${indent}${theme.success('✔')} ${theme.dim(theme.strike(renderInline(body, theme)))}`.
3. **Alignment Tracking (`docs/alignment.md`)**:
   - Change row 125 state from `open` to `aligned`, citing `theme.spec.ts` and `markdown.spec.ts`.

## Testing Decisions

- **Seam**: Public interface of `Theme` (`createTheme`) and Markdown rendering (`renderMarkdown` / `renderMarkdownRows`). Testing occurs at these public API boundaries without inspecting internal regexes or state.
- **Prior Art**: Patterned after existing test suites in `packages/bundle/tests/theme.spec.ts` and `packages/bundle/tests/markdown.spec.ts`.

## Out of Scope

- Interactive clicking to toggle transcript task checkboxes (transcript is append-only).
- Numbered task lists (`1. [ ]`).
- Single-tilde `~subscript~` or footnote notation.

## Acceptance Criteria

1. `pnpm exec vitest run packages/bundle/tests/theme.spec.ts -t "strike"` passes, verifying that `theme.strike` emits ANSI SGR 9 when colored is true and identity string when colored is false.
2. `pnpm exec vitest run packages/bundle/tests/markdown.spec.ts -t "task lists and strikethrough"` passes, verifying rendering of unchecked `○`, checked `✔` with dimmed strike, nested indent, and `~~strikethrough~~` in prose and tables.
3. `pnpm run typecheck` exits with code 0 and zero TypeScript errors across all workspace packages.
4. `pnpm test` exits with code 0 and passes all test suites.

## Plan

- [x] Ticket 1: Theme SGR 9 Strikethrough Support — Delivers strike(text) API and ANSI SGR 9 sequences in Theme (Blocked by: none)
- [x] Ticket 2: Markdown Strikethrough and Task List Rendering — Delivers ~~text~~ strikethrough and GFM task list rendering (Blocked by: Ticket 1)
- [ ] Ticket 3: Alignment Matrix, Changeset, and Verification — Delivers docs/alignment.md row 125 update and changeset (Blocked by: Ticket 1, Ticket 2)

## Baseline

- Proof command 1 (`vitest run packages/bundle/tests/theme.spec.ts -t "strike"`): 23 tests skipped (no tests matched yet).
- Proof command 2 (`vitest run packages/bundle/tests/markdown.spec.ts -t "task lists and strikethrough"`): 35 tests skipped (no tests matched yet).
- Proof command 3 (`pnpm run typecheck`): Clean exit 0.
- Proof command 4 (`pnpm test`): 41 files passed (1020 tests).
- Working tree: Clean (only spec file untracked).
