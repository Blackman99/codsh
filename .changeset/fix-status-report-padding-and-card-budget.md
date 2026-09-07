---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): preserve /status column alignment and prevent card headline truncation on tiny screens

Adjust the session elapsed time label in `/status` to `time` so maximum label width does not exceed 11 columns, preserving column alignment. On narrow viewports, ensure short tool card titles avoid premature truncation.
