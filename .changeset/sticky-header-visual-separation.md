---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): visually distinguish sticky turn header from agent output with panel background and bottom divider

- Fill pinned sticky header rows with the panel background shade (`FILL_DARK` / `FILL_LIGHT`), adapting to dark or light terminals.
- Add a muted horizontal divider line (`─`) in the gap row between the pinned sticky header and the scrolling transcript content.
- Improves contrast and spatial hierarchy so pinned turn prompts are immediately distinguishable from the response text scrolling underneath.
