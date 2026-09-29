---
'codsh-cli': patch
'codsh-bundle': patch
---

Tables in answers no longer fall apart. They were laid out two columns too wide for the space beside the transcript's rule, so every border and cell row wrapped its last characters onto a row of its own. Tables and todo readouts in the transcript now fit.

Long lines now wrap between words, and a word is only cut when it is wider than a whole row. A break can fall at a space (the space is dropped), inside Chinese text but never just before punctuation such as `，` or `）`, or after the `/` in a path. A wrapped list item or indented line continues under its text instead of at the left edge, and copying the text leaves that indent out.

The blank row above a thought now uses the neutral grey rule. The thought's colour marks only the thought's own row, instead of also running up into the blank above it.
