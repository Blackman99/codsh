---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): merge `? shortcuts` hint into bottom status line

- Move `? shortcuts` into MetaBar bottom status line instead of dedicating a standalone row under the input box.
- Make `Prompt.setStatus` support dynamic column-aware formatting, dropping shortcuts first when terminal columns are constrained before cwd and model.
