---
'codsh-bundle': minor
---

Show the subagents a session started, the way Grok Build's tasks pane does. A row under the box counts them by state (`subagents 2 · 1 running · 1 done · Ctrl+H`) for as long as the session holds any; Ctrl+H or a click on it opens a numbered list with each child's mark, label, elapsed time, calls, and latest call; Enter or a click on a row enters that child's view, whose status row now names it and ticks with it; Esc returns. A finished child stays listed with its outcome and opens read-only from its persisted log. `/subagents` prints the same list for pipes.
