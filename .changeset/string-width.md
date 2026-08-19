---
"codsh-cli": patch
---

Display widths now come from `string-width` — the same width authority cli-table3, ink, and every maintained terminal renderer sit on — instead of a hand-kept range table. The hand-kept table mis-sized emoji-presentation symbols (`⚡` measured one column, rendered two), which sheared table columns whenever a cell carried one. Wrapping, truncation, table layout, and the input box all measure through the one function, with an ASCII fast path for the per-character hot loops.
