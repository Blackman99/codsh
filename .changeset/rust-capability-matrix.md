---
'codsh-cli': patch
'codsh-bundle': patch
---

`scripts/rust-capability-matrix.py` and the `capability-matrix` job of `rust-platforms.yml` record a three-platform capability matrix for the installed Rust client: OS and terminal versions, keys / cancel / resume, sandbox (with honest refusals), terminal restore and hangup, clipboard and microphone honesty when there is no device, and the Windows ConPTY path. Missing devices and refused features are never reported as a silent pass.
