---
"codsh-cli": patch
---

Keep the registered runtime in lockstep when a dsh profile records `codsh-bundle` as an exact registry version. The launcher now upgrades that stale runtime before boot instead of mistaking it for a development pin and repeatedly showing an update notice.
