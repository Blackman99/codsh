---
'codsh-cli': minor
'codsh-bundle': minor
---

`codsh --rust` from an installed package: the Rust client's dsh plugins now load harness packages from the running dsh, so `npm install -g @deepseek-ai/dsh codsh-cli` starts sessions outside this workspace. The launcher verifies the prebuilt client for this platform (manifest, SHA-256, executable CPU, and that it belongs to this `codsh-cli` version) and refuses a missing, damaged, wrong-CPU, half-updated client or a too-old dsh with the reinstall/rollback command, never falling back to another runtime. New `codsh --rust install-check [--json]` shows that verdict without starting anything; the Rust Home records the version that last used it and announces an update or rollback once; `codsh update` warns people who use `codsh --rust` when the new package cannot run it here. `build:rust` records the package version and dsh floor in `artifact.json` and accepts `--target`; `check:rust-package` verifies what `npm pack` would ship without publishing.
