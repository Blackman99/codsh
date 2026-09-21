---
'codsh-cli': minor
'codsh-bundle': minor
---

Add allow/ask/deny rules, permission modes, and remembered project grants to `codsh --rust`. Explicit deny and hook blocks survive always-approve; `y` is once, `a` remembers this project only, and `/revoke-approvals` forgets those grants.
