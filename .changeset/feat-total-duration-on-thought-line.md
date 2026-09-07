---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): track entire turn duration at the thinking line instead of individual tool calls

Tool card duration statistics have been reverted. The completion time of the entire assistant output turn (from starting execution to final output settling) is now presented collectively as a single unified `· total Y.Ys` suffix appended to the `thought` line itself.
