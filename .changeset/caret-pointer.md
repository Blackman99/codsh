---
"codsh-bundle": patch
---

Clicking in the input box puts the cursor there. A long line wraps across several rows and a tall one scrolls inside the frame, and the click follows both, because it reads the same wrapped rows and the same window the box drew. Near misses clamp instead of missing: a border row takes the nearest line, a column past the end of a line takes its end. The completion menu closes with the move, since its candidates were computed for the token the cursor just left.
