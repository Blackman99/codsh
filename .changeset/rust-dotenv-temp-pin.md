---
'codsh-cli': patch
'codsh-bundle': patch
---

Stop a workspace deny glob from pinning `/tmp` when the workspace lives under the resolved `/private/tmp` write root. Renaming a workspace directory onto a fresh `/tmp` sibling stays allowed, while a directory inside `secrets/**/*.key` stays pinned.
