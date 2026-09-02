---
"codsh-bundle": patch
---

A workflow round no longer offers to be entered. The event that reports a round names the child session it ran in, so each settled round said `click to enter` — but a workflow's children run in a worker thread and their sessions are never in this process, so clicking one could only ever answer "no longer running". Driven on a real terminal, that is exactly what it answered. The line stands on its own.
