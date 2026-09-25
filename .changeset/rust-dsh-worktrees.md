---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust -w [NAME]` (with optional `--worktree-ref`) starts a session in a new git worktree on its own branch, carrying your uncommitted changes without touching the checkout, and `-w -r <id>` continues a session there under a new id. `codsh --rust worktree list|show|apply|rm|gc|db` and `/worktree` manage worktrees; `apply` is explicit and reports conflicts instead of overwriting your edits. Subagents can run with `isolation: "worktree"`, keeping their edits out of your checkout until you apply them.
