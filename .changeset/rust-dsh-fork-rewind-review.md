---
'codsh-cli': patch
'codsh-bundle': patch
---

Refuse /rewind during a live turn, accept /fork --no-worktree, apply the fork model only on fork, store confirm/fork UI prefs in `$GROK_HOME/config.toml`, and reset minimal native history on rewind/fork.
