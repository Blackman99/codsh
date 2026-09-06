---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): support GFM task lists and ~~strikethrough~~ in Markdown answers

- Add first-class `Theme.strike` method backed by ANSI SGR 9 (`\u001B[9m`), gracefully degrading under `NO_COLOR` and off-TTY environments.
- Render Markdown task list items natively: unchecked (`- [ ]`, `* [ ]`, `+ [ ]`) render as `○`, checked (`- [x]`, `* [x]`, `+ [X]`) render as `✔` with dimmed, struck-through body text, preserving nested indentation.
- Render double-tilde inline strikethrough (`~~text~~`) in prose and table cells.
