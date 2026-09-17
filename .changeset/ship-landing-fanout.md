---
'codsh-bundle': patch
---

Lay out landing tickets that share a prerequisite side by side, stack only a true wait under that ticket, and dispatch those siblings as parallel worktree children. A numbered `Blocked by: 1, 2` next to `Blocked by: 1` is a fan-out, not a second wait.
