---
'codsh-bundle': patch
---

fix(surface): measure wrapped and truncated text by grapheme cluster, so a `🎙️` cell no longer shears a table

Wrapping and truncation stepped through text one code point at a time, so an emoji carrying a variation selector (`🎙️`), a keycap (`1️⃣`), or a ZWJ family (`👨‍👩‍👧`) was charged the sum of its parts rather than the two columns the terminal paints. A table cell opening with such an emoji came out one column wider than its frame and pushed every rule after it to the right; a truncation could cut a joined emoji between its joiners. Transcript rows, table cells, cut chrome text, and the input box now advance by the same grapheme clusters `string-width` measures, and a pointer on either cell of such an emoji lands before it as a whole.
