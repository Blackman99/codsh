---
"codsh-cli": patch
---

The input box is pinned to the bottom of the screen — at session start, after Ctrl-L, and after `/clear` — instead of floating wherever output happened to end. Resizing the terminal no longer leaves ghost copies of the box frame: relative erase math is void once a terminal rewraps, so the recovery now clears the old region's estimated rewrapped footprint from an absolute position and redraws anchored to the bottom.
