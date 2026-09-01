---
"codsh-bundle": minor
---

`CODSH_TRACE=<path>` records every byte the viewport writes, and the size it wrote them at, so a frame that arrives corrupted can be replayed afterwards. A rendering fault is a disagreement between what the surface emitted and what the terminal did with it; without this the emitted half is gone by the time anyone looks. Off unless the variable is set, and a trace that cannot be written never costs the session.
