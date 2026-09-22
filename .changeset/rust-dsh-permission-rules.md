---
'codsh-cli': minor
'codsh-bundle': minor
---

Add allow/ask/deny rules, permission modes, and remembered project grants to `codsh --rust`. Explicit deny and hook blocks survive always-approve, including brace groups and ANSI-C `bash -c` scripts. Wrappers peel to the inner command without eating the command name while `env -S` prompts. Unique long-option prefixes such as `sort --compress-pro` are not read-only. Frozen git read-only subcommands auto-allow; git writes do not. Claude settings load from `~/.claude` and walk to the repo root. Read/Edit deny follows in-path symlinks. `y` is once, `a` remembers a path-scoped project grant, and `/revoke-approvals` forgets those grants.
