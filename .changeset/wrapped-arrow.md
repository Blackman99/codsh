---
"codsh-bundle": patch
---

Up and Down move by the rows you see. A long line wraps across several rows in the box but is one line in the buffer, so Up from its second row decided there was nothing above it and recalled the previous prompt — replacing what was being typed. Movement now wraps at the same width the box draws at; only the top row hands the key to the history.
