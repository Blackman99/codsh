---
'codsh-cli': minor
'codsh-bundle': minor
---

Add allow/ask/deny rules, permission modes, and remembered project grants to `codsh --rust`. Explicit deny and hook blocks survive always-approve, including brace groups, quoted or backslash-escaped words, `eval`, ANSI-C `bash -c` scripts, and a path-qualified executable matched by basename without regard to case (`/bin/rm`, `./rm`, `RM.EXE`). Wrappers peel to the inner command without eating the command name while `env -S` prompts. `sort -o` (including attached `sort -oFILE` and clustered `sort -uoFILE`), `--output`, and unique `sort --compress-program` prefixes are not read-only. Frozen git read-only subcommands auto-allow; git writes do not, including `git branch <name>`, `-f`/`--force`, `-u`/`--set-upstream-to` (including the attached form `git branch -uorigin/main`), unique prefixes of `branch --delete`/`--move`/`--copy`/`--force`, and `--output` on `diff`, `log`, `show`, `blame`, and `rev-list`, plus `cat-file --filters`. Claude settings load from `~/.claude` and walk to the repo root. Read/Edit deny follows in-path symlinks. `y` is once, `a` remembers a path-scoped project grant, and `/revoke-approvals` forgets those grants.
