---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): replace pending tool call lines in-place on result, align hover bounds, and improve card margins

- Replace pending tool call lines in-place when the completed tool result arrives, eliminating duplicate pending headers while preserving live in-flight commands and PTY interrupt visibility.
- Exclude trailing blank separator rows from fold ranges and hover fills, ensuring hover highlights align precisely with card bounds.
- Add vertical breathing padding to multiline tool results and avoid low-yield folds for 1-2 excess lines.
