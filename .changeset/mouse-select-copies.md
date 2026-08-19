---
"codsh-cli": minor
---

Mouse selection is back on the alternate screen, the way opencode and Claude do it: dragging with the left button highlights transcript text in place, and releasing copies it automatically — through OSC 52 and the platform clipboard both, with a `✓ copied` toast. `CODSH_CLIPBOARD=osc52|system|off` narrows the channel; Shift-drag still reaches the terminal's own selection.
