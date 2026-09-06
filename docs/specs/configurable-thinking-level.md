# Configurable Thinking Level

Status: landing

## Requirement

支持配置思考等级

## Problem Statement

When using reasoning models (such as DeepSeek-Reasoner, R1, or third-party reasoning endpoints), users have varying requirements for deliberation depth depending on the task: quick lightweight coding queries benefit from lower reasoning effort to reduce latency and cost, while complex debugging or algorithmic refactoring demands maximum thinking effort. Furthermore, some users need to disable reasoning entirely (`off`) to get direct answers without delay.

Currently, `codsh` defaults to the model's ambient reasoning effort and only supports provider/model selection via `/model`. There is no command or interface affordance to inspect or adjust the active model's reasoning effort / thinking level, nor does the MetaBar status line indicate whether thinking is enabled, what level is selected, or if reasoning is disabled.

## Solution

1. **Dedicated Command & Alias**: Provide `/thinking` (with `/effort` as an alias) allowing users to inspect and configure the current model's reasoning level.
2. **Interactive Selection & Direct Arguments**:
   - Running bare `/thinking` in an interactive terminal opens a selector listing all levels supported by the current model (e.g., `off`, `low`, `high`, `max`), showing the active level. In non-TTY environments, it prints the current level and supported options.
   - Running `/thinking <level>` (e.g., `/thinking high`) sets the level directly.
   - Shortcut arguments `/thinking off` and `/thinking on` quickly toggle thinking (`off` disables thinking, while `on` activates the model's configured default effort or the recommended non-off level).
   - If the current model does not support reasoning, `/thinking` informs the user and makes no changes.
3. **Per-Model Persistence & Synchronization**:
   - Thinking preferences are persisted per model (`~/.dsh/code-cli-thinking.json`).
   - When switching models via `/model`, the previously selected thinking level for that model is automatically restored (or falls back to model default).
   - Active selections update the live runtime via `installModelSelection` so that subsequent prompts immediately apply the selected reasoning effort on the wire, and sync to `agentDefaultModel` for subsequent sessions.
4. **Glanceable Status & Detailed Report**:
   - MetaBar displays the thinking level beside the model name when applicable (e.g. `deepseek-chat (high)` or `deepseek-chat (off)`). Non-reasoning models omit the tag.
   - `/status` includes a dedicated `thinking` row displaying the active level and available levels.
5. **Command Completion**:
   - Typing `/thinking ` or `/effort ` offers auto-completion for available levels (`on`, `off`, plus model-supported levels).

## Grill Decisions

1. **Command Naming (`/thinking` with `/effort` alias)**:
   - *Reason*: Aligns with `docs/alignment.md` (decided `/thinking on|off`) while supporting `/effort` for users coming from Codex.
2. **Interactive Selector + Direct Args + on/off Shortcuts**:
   - *Reason*: Provides a consistent, discoverable TTY experience identical to `/model` and `/ui`, while giving power users single-command speed via arguments.
3. **Per-Model Persistence**:
   - *Reason*: Reasoning support and level identifiers differ significantly across models and gateways (some models do not support thinking; others have `low`/`high`/`max`; others are binary). A global setting would break when switching models.
4. **Status Line Presentation**:
   - *Reason*: Attaching the level directly to the model segment (e.g. `model (high)` or `model (off)`) maximizes visibility without consuming extra separator width or disrupting the prioritized segment-dropping hierarchy during terminal resizing.
5. **Handling Unsupported Models**:
   - *Reason*: Fails gracefully with a clear message (`model does not support configurable thinking`) rather than misleading the user or sending invalid parameters to the LLM adapter.
6. **`/thinking on` Resolution**:
   - *Reason*: Resolves to the model's advertised `defaultEffort`; if unset or `off`, falls back to `high` or the first available non-off effort.

## User Stories

1. **US-1**: As a developer running `codsh`, I want to run `/thinking` to view and interactively choose from the reasoning levels supported by my current model, so that I can calibrate latency vs. depth of thought.
2. **US-2**: As a developer, I want to run `/thinking <level>` (e.g. `/thinking high`, `/thinking low`) to immediately set my desired reasoning effort without navigating a selector.
3. **US-3**: As a developer, I want to run `/thinking off` and `/thinking on` to quickly toggle reasoning on and off for the active model.
4. **US-4**: As a developer, I want to see the active thinking level in the MetaBar status line (e.g. `model (high)` or `model (off)`) and in `/status`, so that I always know whether my model will deliberate before answering.
5. **US-5**: As a developer, I want my chosen thinking level for each model to be remembered across `/model` switches and CLI restarts, so that I do not need to reconfigure it every time.
6. **US-6**: As a developer using a model that does not support reasoning, running `/thinking` should clearly explain that the model does not support thinking, leaving settings untouched.

## Implementation Decisions

1. **Thinking Domain Module (`packages/bundle/src/thinking.ts`)**:
   - Types: `ThinkingPrefMap` mapping model keys (`${provider}/${model}` or `${model}`) to `ReasoningEffortId`.
   - `resolveEffortChoice(input: string, reasoning: LlmModelReasoningInfo | undefined)`: parses user input (`on`, `off`, or specific level IDs), resolving `on` to `defaultEffort ?? 'high'` (or first non-off level).
   - `loadThinkingPrefs(filePath: string)` and `saveThinkingPref(filePath: string, key: string, effort: string)`: reads/writes JSON preferences file under `$DSH_HOME`.
2. **Status Formatting (`packages/bundle/src/status.ts`)**:
   - Extend `StatusFacts` with optional `reasoningEffort?: string` and optional `reasoningSupported?: boolean`.
   - Update `statusLine`: when `reasoningEffort` is present and `reasoningSupported` is true, format model as `${model} (${reasoningEffort})`.
   - Update `statusReport`: include `thinking: <level>` (and available choices) when supported, or `thinking: not supported`.
3. **Session CLI Wiring (`packages/bundle/src/index.ts`)**:
   - Register `/thinking` and `/effort` commands with description, completion, and interactive prompt selector.
   - Read active model's reasoning capabilities via `llm.resolveModelInfo(current.provider, current.model)`.
   - On change, update `selection.current.reasoningEffort`, persist to `code-cli-thinking.json`, call `agentDefaultModel.saveSelection(...)`, and refresh status.
   - When `/model` switches models, query `code-cli-thinking.json` for any saved preference for the target model; if found, apply it to `selection.current.reasoningEffort`.
   - Add completion for `/thinking` and `/effort` arguments based on the active model's supported levels plus `on`/`off`.

## Testing Decisions

- **Seams**:
  - `packages/bundle/src/thinking.ts`: unit tests covering input resolution (`on`, `off`, custom IDs, unknown values, unsupported reasoning) and preference file persistence.
  - `packages/bundle/src/status.ts`: unit tests for `statusLine` formatting with reasoning effort and `statusReport` output.
  - Command handling and model selection updates tested at the bundle command/prompt seams.
- **Prior Art**:
  - `packages/bundle/tests/status.spec.ts` for status rendering tests.
  - `packages/bundle/tests/density.spec.ts` for preference loading and parsing patterns.

## Out of Scope

- Upstream wire-level modifications to `@deepseek-ai/dsh-llm` or adapter protocols (dsh already supports `reasoningEffort` per request).
- Token-budget thinking parameters (e.g. integer `thinkingBudget: 2048`), as current harness adapters use discrete levels (`off`, `low`, `high`, `max`).

## Acceptance Criteria

1. `pnpm exec vitest run packages/bundle/tests/thinking.spec.ts` passes with all tests green.
2. `pnpm exec vitest run packages/bundle/tests/status.spec.ts` passes with all tests green.
3. `pnpm run typecheck` exits with code 0.
4. `pnpm test` exits with code 0.

## Plan

- [x] Ticket 1: Thinking Domain Module and Persistence — Delivers thinking level parser, level resolver, error handling, and file persistence (Blocked by: none)
- [x] Ticket 2: Status Bar and Report UI Support — Delivers status facts, status line formatting with reasoning effort, and /status report row (Blocked by: Ticket 1)
- [x] Ticket 3: CLI /thinking and /effort Commands, Interactive Selector, and Model Switch Integration — Delivers /thinking & /effort commands, interactive selector, arguments completion, and per-model restore on /model switch (Blocked by: Ticket 2)
- [x] Ticket 4: Changeset, Bilingual Documentation, Alignment Doc, and Verification — Delivers changeset, documentation updates, alignment doc updates, and passes all acceptance criteria (Blocked by: Ticket 3)

## Baseline

- Proof command 1 (`vitest run packages/bundle/tests/thinking.spec.ts`): File does not exist yet (test-first).
- Proof command 2 (`vitest run packages/bundle/tests/status.spec.ts`): 56 tests passed.
- Proof command 3 (`pnpm run typecheck`): Clean exit 0.
- Proof command 4 (`pnpm test`): 42 files passed (1048 tests).
- Working tree: Uncommitted changes in working tree retained per user confirmation.

