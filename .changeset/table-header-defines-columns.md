---
"codsh-cli": patch
---

Tables no longer grow ghost columns: the header row defines the column count (as GFM reads it), stray trailing pipes on body or delimiter rows are ignored, and columns empty across every row are trimmed — so real columns keep their width instead of wrapping.
