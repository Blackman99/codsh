---
"codsh-cli": patch
---

Tables are now bordered grids — outer frame, one space of cell padding, and a rule between every pair of rows — so text never touches an edge and a wrapped continuation can never blur into the record below. And collapsing works the way Claude's does: EVERY collapsed block (tool outputs and thoughts alike) keeps both of its forms in the session's own scrollback; Ctrl+O swaps all of them open in place, Ctrl+O again — or simply moving on with the next submission — folds them back.
