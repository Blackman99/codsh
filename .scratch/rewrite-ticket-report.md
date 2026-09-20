# Ticket 29 / GitHub #161 — 上下文检查与压缩继续 (review fix)

Status: implemented (worker commit after independent review; still needs rereview and integration)

- Ticket: 29
- Issue: https://github.com/Blackman99/codsh/issues/161
- Worktree: `/Users/zhaodongsheng/.grok/worktrees/my-projects-codsh/subagent-01a0c005-72d5-7850-8be3-12d0462d6c52`
- Base SHA: `253b7376f14c2ad2c8955440fbe21e98b24021f0`
- Previous worker SHA: `024102ef5bd525b68e8271bc2545fe7a426c89c7`
- Commit SHA: git HEAD of this worktree after the review-fix commit on `024102e`
- Reviewers of 024102e: `approved:false` with grounded findings. This commit addresses those findings in the same worktree.

## Review findings and fixes

1. **Failed `/compact` tore down ACP**
   - Cause: `followup` returned `compactNow()`; dsh-acp does not await it; unhandled rejection plus missing `turn/end` killed the child (`Execution unavailable: dsh / ACP connection ended`).
   - Fix: never return the `compactNow` promise; catch `ManualCompactionError`/abort; reload `projectSession.compaction[].error` even without a checkpoint turn; map to `Compaction failed: … Original dsh records were not discarded.`
   - Evidence: PTY `/tmp/codsh-rust-compact-p68mncei/compact-fail.txt` stays `Connected to dsh ACP`, shows `Compaction failed: summarizer failed. Original dsh records were not discarded.`, keeps `TOKEN_KEEP_*`, then answers `TOKEN_AFTER_FAIL`. Protocol compact-fail then `TOKEN_AFTER_FAIL` `end_turn`.

2. **Live UI still showed `TOKEN_OLD_*` after compact**
   - Cause: `skipShadowed` missed top-level `surfaceOp` and left runtime-context/orphan assistant text; resume `wait_visible('RUST_ACP_ANSWER')` matched leftover history.
   - Fix: reconstruct live surface seqs (append/replace), skip non-live surface events and tool/calls without a live result, drop empty-user non-compacted turns. TUI omits the huge checkpoint body so later turns stay visible.
   - Evidence: compact.txt has no `TOKEN_OLD_ONE`; resume-compact.txt shows `> compaction summary` plus `> TOKEN_AFTER_COMPACT` / `RUST_ACP_ANSWER turn=3` echoing `<compacted-summary>` / `keep the auth plan`.

3. **Cancel during compact was unwired**
   - Fix: PTY Ctrl+C during delayed summarizer; rust treats user cancel as `Compaction cancelled.` even when dsh records empty-summary; originals kept; following prompt works.
   - Evidence: protocol cancel test; PTY compact-cancel.txt `Compaction cancelled.` then `> TOKEN_AFTER_CANCEL` / `RUST_ACP_ANSWER turn=4`.

4. **Manual instruction unproven**
   - Cause: pending instruction was cleared before `purpose=compaction` stream.
   - Fix: keep instruction until `compactNow` settles; mock summary includes `instruction:`; protocol asserts summary contains `keep the auth plan` and it is not a user turn; PTY session-read helper asserts the same.

5. **Model-switch context limits unverified**
   - Fix: mock adapter registers `cli-mock` and `narrow` (128000 vs 64000). PTY `/context` requires `advertised_context=128000 (config)` then `/model narrow` then `advertised_context=64000 (config`. `/context` still uses `breakdown=None` → `breakdown=unknown` when ACP usage has no buckets.

6. **`thresholdRatio` without compatible `retainRatio`**
   - dsh-compaction-basic default `retainRatio` 0.16 throws when `retainRatio >= thresholdRatio`; percent 0 is not a valid dsh ratio.
   - Fix: emit `retainRatio = min(0.16, threshold/2)`; percent 0 writes `auto: false`. Unit test covers 40→0.16, 10→0.05, 0→auto false.

## Tests

- `cargo fmt --manifest-path rust/Cargo.toml --all`
- `cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets -- -D warnings` — pass
- `TMPDIR=/tmp cargo test --manifest-path rust/Cargo.toml --locked --offline --workspace` — pass
- `pnpm run typecheck` — pass
- `TMPDIR=/tmp pnpm test` — 80 files / 2240 tests pass
- `TMPDIR=/tmp pnpm exec vitest run scripts/rust-acp-protocol.spec.mjs` — 21 pass (compact + cancel cases)
- `pnpm run build:rust` — staged `packages/cli/native/darwin-arm64`
- `python3 scripts/rust-compact-pty-test.py` — pass; output `/tmp/codsh-rust-compact-p68mncei` session `8732f31c-8043-46ad-a44e-94a5dc305910`

## Changed files (this fix)

- `packages/cli/bin/rust-acp-compact.mjs`
- `packages/cli/bin/rust-acp-session-read.mjs`
- `e2e/fixtures/rust-acp-mock-llm.mjs`
- `rust/src/{main,models,config,session_history}.rs`
- `scripts/rust-acp-overlay.mjs`
- `scripts/rust-acp-protocol.spec.mjs`
- `scripts/rust-compact-pty-test.py`
- `README.md`, `README.zh.md`, `CONTEXT.md`, `CONTRIBUTING.md`

## Blockers

None for this slice. Auto-compact still maps threshold/retain into dsh rather than firing a PTY auto-compact (occupancy vs threshold is dsh-owned). Grok `keep_last_n_turns` / `hard_clear_age_turns` remain warnings.

No push, merge, or GitHub mutation.
