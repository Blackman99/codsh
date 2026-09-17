---
'codsh-bundle': patch
'codsh-cli': patch
---

Resolve landing and merge-back conflicts autonomously, including lockfiles and modify/delete conflicts, and retry validation feedback before reporting a blocker. Preserve clean auto-merged files instead of misclassifying them as unrelated edits, and finalize real merge and squash conflicts with the correct non-interactive Git commit. Keep sealed requirements, interruption recovery, and integrated proof checks intact.
