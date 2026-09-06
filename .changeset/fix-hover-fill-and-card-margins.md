---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): fix hover highlight alignment, eliminate duplicate pending headers, and improve card margins

- Keep pending tool calls off-screen across all tool types, letting completed tool cards own the single coherent block and eliminating duplicate pending headers.
- Prevent hover background fill from bleeding into trailing blank block separators, ensuring hover highlights align precisely with card bounds.
- Add vertical breathing padding to multiline tool results and avoid low-yield folds for 1-2 excess lines.
