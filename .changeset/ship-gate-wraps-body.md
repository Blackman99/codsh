---
'codsh-bundle': patch
---

fix(ship): the gate modal wraps the spec summary and ticket list instead of cutting each line at the frame

The `/ship` confirmation gates showed a single clipped row of the very text they asked you to approve: every body line was truncated at the card's width, so a summary written as one paragraph, or a ticket with what it delivers and what blocks it, lost everything past the first row. Body lines now wrap to the card, with a bullet's continuation hanging under its text, and the body scrolls as before. The `/ship` prompt also asks the model for the full summary and the whole ticket list, one point per line, rather than a paragraph.
