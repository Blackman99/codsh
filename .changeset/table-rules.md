---
"codsh-cli": patch
---

Tables no longer shear apart on screen, and they read like tables. The root cause of the shearing was a one-column budget mismatch: Markdown laid tables out at the full terminal width while the viewport wraps everything at width minus one, so a full-width table row was refolded and its second column dropped to the left margin. Layout now uses the console's single `contentColumns` figure. Styling follows suit: dim `│` rules between columns (wrapped continuation rows carry them too, so they read as part of their column) and one unbroken `─┼─` separator under the whole header instead of a line under the first column only.
