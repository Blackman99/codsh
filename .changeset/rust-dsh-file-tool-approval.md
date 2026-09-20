---
'codsh-cli': minor
'codsh-bundle': minor
---

Ask once before real dsh file write/edit tools run from the isolated Rust client. The UI shows the pending operation and dsh-supplied diff, allows that call once, and rejects or ends input without writing. Missing files, tool errors, and stale or duplicate approval replies are reported as failures.
