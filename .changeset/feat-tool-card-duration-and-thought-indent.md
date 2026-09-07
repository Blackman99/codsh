---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): show execution duration on completed tool cards

Tool cards now report their start-to-finish execution duration in the headline (e.g., `● Read a.ts +1 -1 · 1.2s ✔`), matching the visibility previously only available for thinking blocks. Additionally, the expanded thinking block now indents its reasoning text to provide breathing room from the background panel border.
