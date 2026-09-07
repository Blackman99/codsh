---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): remove background color from thinking summary to balance vertical spacing

The collapsed one-line summary for a thinking block now uses the default terminal background instead of `bgThinking`. Removing the background color allows the line to serve as a natural unstyled separator between the padded background blocks of the tools preceding and following it, effectively shrinking the excessive gaps and perfectly centering the clock line.
