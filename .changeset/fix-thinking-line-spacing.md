---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): vertically center thinking line between consecutive tool runs

The one-line summary for a thinking block now correctly checks if an active tool run preceded it and prepends a blank line if so, preventing the thinking line from appearing visually glued to the bottom padding of the previous tool's output.
