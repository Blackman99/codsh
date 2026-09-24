---
'codsh-cli': minor
'codsh-bundle': minor
---

Run a shell command through dsh's bash tool from the isolated Rust client. The card shows stdout, stderr, and the exit code, including 0. A denied command does not run, and cancelling a running command is reported as aborted rather than success. An interactive terminal session is unavailable: the acp profile does not mount dsh's persistent terminal, and window resize is not a dsh tool.
