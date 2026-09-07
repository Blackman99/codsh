# Reliable Delivery for the /ship Command

Status: shipped
Branch: ship/reliable-ship-delivery
Base-Commit: main
Original-Branch: main

## Requirement

围绕 `/ship` 指令的“可靠交付”（Reliable Delivery）进行系统性架构与工程强化：涵盖前检与特性分支隔离、TDD 红绿取证防作弊、断点续跑级联重验门禁、单 Ticket 3 次自愈熔断求助协议、双层 DoD（业务验收 + 仓库合规守护）及透明 Markdown Schema 扩展。

## Problem Statement

当前 `codsh` 的 `/ship <idea>` 具备了“规格即磁盘记忆”、“两道确认门”和“TDD 红绿”，但在工业级实际交付场景中，依然存在多个脆弱性痛点：
1. **工作区与分支污染风险**：直接在当前分支原地修改并 commit。若用户中途中断或任务因死循环失败，会在用户当前分支残留脏代码、编译报错和半成品提交，且缺乏一键恢复机制。
2. **模型验证“假绿”与作弊幻觉**：完全依赖 Prompt 约束模型自律，缺乏机器级硬性约束。LLM 容易在上下文变长时放水——擅自弱化断言、修改 spec 降低验收门槛、伪造命令输出、或未经测试直接把 ticket 勾选为 `[x]`。
3. **断点续跑一致性缺失**：裸 `/ship` 续跑时，仅按未打钩的 `[ ]` ticket 简单向下执行，未验证已打钩的 `[x]` ticket 是否依然成立。若底层代码已被外部或后续改动破坏，会导致“在红的基础上建绿楼”。
4. **单点故障无限死循环**：单 ticket 遇到棘手报错时，Agent 容易陷入无节制的“修改-报错-再修改”循环，耗尽 token 且代码退化，缺乏及时的停机求助熔断。
5. **发布合规与存量技术债混淆**：交付标准仅依赖 spec criteria，容易遗漏 Changeset 与双语文档；同时若全量回归测试包含项目既有的历史遗留坏用例，容易卡死交付流程。

## Solution

通过建立严格的 5 阶段状态机（含 Phase 0 隔离），实现闭环的可靠交付体系：
1. **Phase 0 (Pre-flight & Isolation)**：执行前检测 dirty 工作区，提供交互式裁决（Stash / Carry over / Abort）；自动创建并检出 `ship/<kebab-case-slug>` 独立分支。
2. **Phase 1 (Grill-Me)**：构建设计决策树，单次批处理 `ask_user_question` 呈报推荐答案，清空前沿。
3. **Phase 2 (to-Spec / Gate 1)**：生成扩展元数据（Branch, Base-Commit）的透明 Markdown Spec，Gate 1 弹窗确认。
4. **Phase 3 (to-Tickets & Baseline / Gate 2)**：拆解垂直切片 ticket，强制注入“Changeset & Docs”收尾 ticket；执行业务验收与全局守卫基线，确立 Zero-New-Failures 差量基准；Gate 2 弹窗批准并落盘 `## Plan`。
5. **Phase 4 (Autonomous Landing & TDD Evidencing)**：
   - `<=3` tickets 走会话内执行，`>=4` tickets 走 `ralph` fresh-agent 循环；
   - 机械化 TDD 取证：先写测试并捕获真实失败非零 Exit Code 证据写入凭证，再写实现直至 Exit Code 0，产生且仅产生一个全绿 Git Commit；
   - 单 ticket 3 轮自愈熔断：连续 3 次不通过立即向主会话求助，弹出交互模态框唤醒人类；
   - 级联重验门禁：续跑时必须先重验已打钩 `[x]` ticket，变红则退火就地自愈。
6. **Phase 5 (Verification & Delivery)**：
   - 双层 DoD 门禁：业务 Acceptance Criteria 退出码全部为 0；全局守卫比对基线零新增错误；
   - 交付交互选项（Post-Ship Modal）：提供合并回原分支 (Squash/FF)、保留分支提 PR、留在特性分支手工审查三选一。

## Grill Decisions

1. **Q1 分支隔离**：独立特性分支隔离 (`ship/<slug>`)，交付前不触碰原分支。
2. **Q2 验证防作弊**：机器判定与前置失败捕获 (Red-to-Green Assertion Enforcement)，exit code 为硬指标。
3. **Q3 状态一致性**：级联重验门禁 (Cascading Re-verification Gate)，先验旧地基再建新功能。
4. **Q4 自愈上限**：固定阈值 (<=3 in-session / >=4 ralph) + 单 Ticket 自愈上限 (3 轮) 熔断求助。
5. **Q5 交付标准**：双层 DoD 门禁 (Spec 业务验收 + 仓库合规嗅探)。
6. **Q6 Dirty 判定**：启动前交互裁决门禁（Stash / Carry over / Abort）。
7. **Q7 合流机制**：Phase 5 交互式交付选项（Squash/FF / Keep branch for PR / Stay on branch）。
8. **Q8 提交规范**：运行日志留痕 + 纯绿单提交 (Log-proven Green Commit)。
9. **Q9 降级策略**：级联重验失败时状态退火与就地自愈 (State Degradation & In-place Healing)。
10. **Q10 技术债隔离**：仓库工程守卫采用“零新增失败（Zero-New-Failures）”差量基线机制。
11. **Q11 发版资产**：Changeset 与双语文档显式 Ticket 化 + 双层拦截。
12. **Q12 Ralph 协议**：Ralph 鲜活循环遇阻时向主会话返回 Blocker 诊断，由主会话唤醒用户交互。
13. **Q13 持久存储**：纯 Transparent Markdown 单一可信源，不引入暗状态文件。

## User Stories

1. **US-1 (Dirty Tree Safety)**: As a developer with uncommitted changes typing `/ship`, I want an interactive choice to stash, carry over, or abort, so that my existing work is never silently corrupted or lost.
2. **US-2 (Isolated Feature Branch)**: As a developer running `/ship`, I want all work and commits to happen on an isolated `ship/<slug>` branch, so that my base branch remains completely stable during development.
3. **US-3 (Transparent Spec Metadata)**: As a reviewer or developer inspecting `docs/specs/<slug>.md`, I want to see the branch name, base commit, and verification evidence directly in Markdown, so that the spec is the standalone source of truth.
4. **US-4 (Anti-Cheating TDD Proof)**: As a tech lead, I want every ticket to capture real failure logs before implementation code is written, so that I can be confident new tests actually test the new behavior.
5. **US-5 (Clean Git History)**: As a maintainer running `git log`, I want each ticket to produce exactly one passing, green commit, so that `git bisect` never encounters broken intermediate commits.
6. **US-6 (Cascading Re-verification on Resume)**: As a developer resuming an unfinished `/ship` run, I want the system to re-verify all previously checked tickets first, so that the agent never builds on top of silently broken pre-conditions.
7. **US-7 (3-Strike Circuit Breaker)**: As a developer whose test is stuck on a subtle edge case, I want the agent to stop after 3 failed healing attempts and ask me for guidance, so that it does not burn tokens or churn files endlessly.
8. **US-8 (Automated Release Ticket)**: As a maintainer of a versioned package, I want `/ship` to automatically include a final ticket for Changeset authoring and documentation updates, so that user-facing changes are never released without release notes.
9. **US-9 (Dual-Layer DoD Gate)**: As a team lead, I want Phase 5 to verify both business acceptance criteria and repo-wide health (typecheck/test diffs), so that newly shipped code does not break other unrelated packages.
10. **US-10 (Post-Ship Merge Control)**: As a developer completing a feature, I want to choose whether to merge back locally, keep the branch for a PR, or stay on the branch, so that the tool respects my team's git workflow.

## Implementation Decisions

1. **Spec & Plan Module (`packages/bundle/src/plan.ts`)**:
   - Extend `parsePlan` and `parseShipStatus` to support new headers:
     - `Branch: <branch-name>`
     - `Base-Commit: <commit-sha>`
     - `Original-Branch: <branch-name>`
   - Enhance ticket line parsing to support clean extraction of verification logs and blocker metadata without noisy title truncation.
2. **Ship Prompt Contract (`packages/bundle/src/ship.ts`)**:
   - Restructure `SHIP_PROMPT` into 6 clear lifecycle phases:
     - **Phase 0: Pre-flight & Branch Isolation**: Git status check, interactive stash/carry/abort question, `git checkout -b ship/<slug>`, metadata recording.
     - **Phase 1: Grill-Me**: Frontier decision tree, batch questions, recommended default, empty frontier confirmation.
     - **Phase 2: Automatic to-Spec (Gate 1)**: Transparent Markdown schema with Branch/Commit metadata, proof commands, `ship · gate 1/2` modal.
     - **Phase 3: Automatic to-Tickets & Baseline (Gate 2)**: Tracer-bullet decomposition, automatic injection of Release & Documentation Compliance ticket, capturing baseline for both proof commands and global repo guardrails (`typecheck`, `test`), `ship · gate 2/2` modal.
     - **Phase 4: Autonomous Landing**: In-session (<=3) or Ralph (>=4); Cascading re-verification on resume; TDD red-to-green proof logging in spec; 3-strike circuit breaker with escalation protocol; clean single commit per ticket.
     - **Phase 5: Verification & Delivery**: Dual-layer DoD verification (Criteria exit 0 + zero new failures against baseline); Post-ship modal (`ship · deliver`) for merge / PR / stay options.
3. **Gate & Question Interaction (`packages/bundle/src/questions.ts`)**:
   - Ensure `shipGateKind` and question decoders cleanly handle gate headers and frontier headers, keeping non-gate modals on the standard clean selector.

## Testing Decisions

- **Unit Seams**:
  - `packages/bundle/tests/ship.spec.ts`: Verify `SHIP_PROMPT` contains all critical lifecycle tokens, branch isolation instructions, dirty-check question format, TDD proof logging contracts, cascading re-verification rules, 3-strike circuit breaker clauses, dual-layer DoD, and post-ship options.
  - `packages/bundle/tests/plan.spec.ts`: Verify parsing of extended spec markdown schema including `Branch:`, `Base-Commit:`, and `Plan` tickets with verification annotations.
  - `packages/bundle/tests/questions.spec.ts`: Verify gate detection and question encoding across all ship interaction surfaces.
- **Monorepo Seams**:
  - `pnpm run typecheck` across all packages.
  - `pnpm test` verifying 44+ test files and 1138+ unit tests pass.

## Out of Scope

- Implementing remote Git hosting API integrations (e.g. creating GitHub PRs via Octokit/GraphQL directly; prompt instructs user with CLI command).
- Changing the upstream DeepSeek Harness engine internals or modifying `dsh-core`.
- Auto-installing missing external package managers or compilers not present on host.

## Acceptance Criteria

1. `pnpm exec vitest run packages/bundle/tests/ship.spec.ts packages/bundle/tests/plan.spec.ts` passes with code 0, verifying that `SHIP_PROMPT` and `plan.ts` support all reliable delivery lifecycle contracts.
2. `pnpm run typecheck` exits with code 0.
3. `pnpm test` exits with code 0 with zero failing tests.
4. A changeset file exists in `.changeset/` documenting the reliable delivery feature for `codsh-bundle`.

## Plan

- [x] Ticket 1: Spec Schema & Plan Model Extension — Delivers metadata parsing for Branch/Base-Commit and plan verification support in plan.ts (Blocked by: none)
- [x] Ticket 2: Pre-flight Dirty Working Tree Gate & Branch Isolation Contract — Delivers Phase 0 pre-flight and branch isolation in ship.ts (Blocked by: Ticket 1)
- [x] Ticket 3: Cascading Re-verification & State Degradation Engine — Delivers resume re-verification rules and degradation semantics in ship.ts (Blocked by: Ticket 1)
- [x] Ticket 4: Single Ticket TDD Red-to-Green Proof Logging & Clean Commits — Delivers anti-cheating TDD proof logging and single green commit rules in ship.ts (Blocked by: Ticket 1)
- [x] Ticket 5: 3-Strike Auto-Healing Circuit Breaker & Ralph Escalation Protocol — Delivers stall detection and escalation protocol in ship.ts (Blocked by: Ticket 4)
- [x] Ticket 6: Dual-Layer DoD & Zero-New-Failures Guardrails — Delivers Phase 5 dual-layer verification and baseline diff rules in ship.ts (Blocked by: Ticket 2, Ticket 4)
- [x] Ticket 7: Post-Ship Interactive Merge-Back Modal — Delivers post-ship delivery modal options in ship.ts and questions.ts (Blocked by: Ticket 6)
- [x] Ticket 8: Changeset, Bilingual Documentation & End-to-End Verification — Delivers changeset, README/README.zh.md updates, and passes all acceptance criteria (Blocked by: Ticket 2, Ticket 3, Ticket 5, Ticket 7)

## Baseline

- Proof command 1 (`vitest run packages/bundle/tests/ship.spec.ts packages/bundle/tests/plan.spec.ts`): 25 passed (10 in ship.spec.ts, 15 in plan.spec.ts).
- Proof command 2 (`pnpm run typecheck`): Clean exit 0.
- Proof command 3 (`pnpm test`): 44 files passed (1138 tests passed).
- Working tree: Clean (only spec file untracked).
