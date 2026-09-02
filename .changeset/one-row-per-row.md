---
'codsh-bundle': patch
---

Fix the frame corruption that survived every later repaint.

A row painted with a control character in it does not stay in its row: the
width authority scores a newline zero columns, so the row measures as a fit,
paints its head where it belongs, and drops the rest at column 1 of the row
below — usually a box border the frame diff considers unchanged, so nothing
ever paints over the spill. A bash command that was a heredoc put one there.

Text now flattens to one row wherever it becomes one: the cut does it before it
measures, the wrap breaks a row where a newline asked for one, and the frame
flattens again as it paints. A multi-line command reads as its lines in the
card that ran it, and the one-row summary above names its first line.
