---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): remove phantom comfortable density idle tip causing status bar multi-line wrapping

Remove the comfortable density idle tip (`⇧Tab plan · Ctrl+T todos`) under the prompt box. The tip rendered as an unexpected extra line on startup and when idle, appearing as a broken multi-line wrap above the MetaBar status line that disappeared upon typing and caused chrome height jumping.
