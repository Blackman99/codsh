---
'codsh-cli': minor
'codsh-bundle': minor
---

The isolated Rust client discovers compatible project rules, skills, agent definitions, and custom commands after folder trust and includes that context in the dsh prompt. Untrusted project assets stay inactive. Collisions, truncation, ignored files, and invalid extra rule paths are visible in `inspect`. User-invocable skills and custom commands appear in the slash menu; `/reload-assets` rescans an added, removed, or empty directory.
