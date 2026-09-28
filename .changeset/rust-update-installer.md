---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust update` updates (or with `--to`, rolls back) the install with the package manager that installed it — npm, pnpm, Yarn or Bun — and verifies the new Rust client before reporting success; `codsh update` uses the same installer selection. `codsh --rust --version` now reports the `codsh-cli` version, and releases carry the macOS (arm64, Intel) and Linux x64 clients built on their own CI runners.
