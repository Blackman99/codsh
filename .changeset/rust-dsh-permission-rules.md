---
'codsh-cli': minor
'codsh-bundle': minor
---

Add allow/ask/deny rules, permission modes, and remembered project grants to `codsh --rust`. Explicit deny and hook blocks survive always-approve; unsplittable shell and Read/Edit path rules on operands cannot bypass deny; always-approve skips grants and non-shell ask; `y` is once, `a` remembers this project only, and `/revoke-approvals` forgets those grants.
