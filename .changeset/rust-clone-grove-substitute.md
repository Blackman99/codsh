---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust clone` clones with plain git in place of the reference Grove lazy clone, behind the reference gates (`GROK_CLONE`, `GROK_GROVE` / `[cli] grove`, Grove's `[clone] enabled`): depth 1 of one branch with blobs on demand, `--full-history`, `--cone`, git credentials or `GROVE_AUTH_TOKEN` (never `codsh --rust login`), a missing or empty target only, nothing left behind after a failure or Ctrl-C, and `--remote ssh://…` to clone on another host. A Grove worktree request (`GROK_WORKTREE_TYPE`, `[cli] grove_worktree`, `GROK_GROVE`) is recorded and falls back to a plain git worktree.
