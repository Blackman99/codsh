---
'codsh-cli': minor
'codsh-bundle': minor
---

Resume the same dsh session after exit and refuse a second write owner. Isolated `codsh --rust --continue` / `--resume <id>` restore persisted conversation, mark interrupted tools as unknown, and do not replay side effects.
