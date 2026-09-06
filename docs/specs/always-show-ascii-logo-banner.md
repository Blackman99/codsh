# Always Show ASCII Logo Banner on Fresh Start and Clear

Status: shipped

## Requirement

运行 codsh 开屏的 logo 欢迎内容怎么没了：恢复开屏与 /clear 始终展示 ASCII Logo

## Problem Statement

In commit `f2a6e7c`, an optimization was introduced that automatically suppressed the ASCII Logo banner for returning workspaces (workspaces with prior sessions in `~/.dsh`), showing only a minimalist 2-line header. As a result, users running `codsh` in existing project directories no longer see the brand identity ASCII whale logo and welcome tips. Additionally, `/clear` inside a session hardcoded `welcomeKind: 'returning'`, preventing users from returning to the clean full-brand opening state.

## Solution

1. **Fresh Starts**: Whenever `codsh` boots a new session (not `--resume` or `--continue`), always display the full opening banner with ASCII whale logo and welcome tips (when terminal width is sufficient), regardless of whether the workspace has prior session history.
2. **Clear Action**: When a user enters `/clear` to wipe the viewport, reset the screen with the full ASCII Logo banner (`welcomeKind: 'first'`), giving a true fresh-screen feel.
3. **Resume / Continue**: When recovering or replaying an existing session (`--resume` or `--continue`), keep skipping the welcome banner (`welcomeKind: 'none'`) so replayed history directly takes over the screen without intrusive headers.

## Grill Decisions

1. **Always on Fresh Start**: Every fresh interactive session starts with the full banner (ASCII whale + tips) when terminal width allows. The `priorSessionInWorkspace` check is decoupled from the initial banner decision.
2. **Full Logo on `/clear`**: `/clear` emits `welcomeKind: 'first'` rather than hardcoding `'returning'`.
3. **Session Preservation**: `--resume` / `--continue` remains `welcomeKind: 'none'`.
4. **Clean Code & Deprecations**: The helper `priorSessionInWorkspace` and `resolveWelcomeKind` logic in `banner.ts` and `index.ts` are simplified to cleanly reflect that fresh starts and clear actions use `'first'`.

## User Stories

1. **US-1**: As a developer starting `codsh` in my existing workspace, I want to see the branded ASCII logo whale and welcome shortcuts tips, so that the CLI feels welcoming and familiar.
2. **US-2**: As a developer running `/clear` to start a fresh line of thinking, I want the screen to wipe and redisplay the full ASCII logo banner, so the viewport looks clean and newly booted.
3. **US-3**: As a developer running `codsh --resume` or `codsh --continue`, I want to resume directly into my previous conversation history without a duplicate banner.

## Implementation Decisions

1. **Banner Module (`packages/bundle/src/banner.ts`)**:
   - Update `resolveWelcomeKind(isResume: boolean)`: when `isResume` is true, returns `'none'`; otherwise returns `'first'`.
   - Keep `'returning'` kind in `WelcomeKind` for backward compatibility or future fallback, or keep `returningLines` as fallback for narrow terminals.
2. **Session Entrypoint (`packages/bundle/src/index.ts`)**:
   - At boot: pass `welcomeKind: resolveWelcomeKind(config.resume !== '')`.
   - Remove unused or redundant `priorSessionInWorkspace` query at banner initialization.
   - In `/clear` handler: render `bannerLines` with `welcomeKind: 'first'`.

## Testing Decisions

- **Seams**: Public interface `resolveWelcomeKind` and `bannerLines` in `packages/bundle/src/banner.ts`, tested in `packages/bundle/tests/banner.spec.ts`.
- **E2E / Surface**: Verify with existing unit tests and `pnpm test`.

## Out of Scope

- Modifying the ASCII logo art itself.
- Changing `--resume` history replay behavior.

## Acceptance Criteria

1. `pnpm exec vitest run packages/bundle/tests/banner.spec.ts -t "welcome banner"` passes, verifying that non-resume boots produce ASCII logo and welcome tips regardless of prior sessions, and resume produces empty lines.
2. `pnpm run typecheck` exits with code 0.
3. `pnpm test` exits with code 0.

## Plan

- [x] Ticket 1: Always Produce Full ASCII Logo Banner on Fresh Start and Clear — Delivers full ASCII logo on fresh start and /clear (Blocked by: none)
- [x] Ticket 2: Changeset, Spec Verification, and Regression Testing — Delivers changeset and passes all acceptance criteria (Blocked by: Ticket 1)

## Baseline

- Proof command 1 (`vitest run packages/bundle/tests/banner.spec.ts -t "welcome banner"`): 10 tests passed (existing suite).
- Proof command 2 (`pnpm run typecheck`): Clean exit 0.
- Proof command 3 (`pnpm test`): 41 files passed (1026 tests).
- Working tree: Clean (only spec file untracked).
