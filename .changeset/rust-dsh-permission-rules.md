---
'codsh-cli': minor
'codsh-bundle': minor
---

Add allow/ask/deny rules, permission modes, and remembered project grants to `codsh --rust`. Explicit deny and hook blocks survive always-approve; wrappers peel to the inner command without eating the command name while `env -S` prompts; Read/Edit deny follows in-path symlinks; unsplittable shell and path rules on operands cannot bypass deny; always-approve skips grants and non-shell ask; `y` is once, `a` remembers a path-scoped project grant, and `/revoke-approvals` forgets those grants.
