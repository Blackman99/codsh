---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): separate intermediate blocks and following text output with a blank line

Ensure a blank line separates intermediate blocks (such as tool cards) and the assistant's text output, preventing text from rendering flush against the preceding block's bottom border.
