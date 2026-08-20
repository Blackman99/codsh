---
"codsh-bundle": minor
---

The transcript answers the pointer resting on it. A collapsible block now
marks itself while the pointer is over it — its head row underlined, the way a
hovered link reads — and the chrome row under the box names it: what the block
is, how many lines it holds, and whether a click would open or fold it
(`thinking · 42 lines · click to expand`, `Bash(pnpm test) · 120 lines · click
to fold`). Move off and the row goes back to whatever it was saying.

The readout is what covers the case the mark cannot: a block taller than the
screen has no head row in view, and its name is the only thing that can tell
you which segment you are in. Both appear without a click, so a clickable block
is no longer a target you find by hitting it.

This turns on any-motion mouse reporting (mode 1003) over the button tracking
already in use, keeping the drag that selects on terminals that speak only the
older mode. Motion is a report per cell crossed, so the frame is touched only
when the block under the pointer actually changes.
