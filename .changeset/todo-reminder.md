---
'codsh-bundle': minor
---

Keep the todo readout in step with the work. The readout showed the list exactly as the model last wrote it, and the model often stopped writing: one session pinned an item it had finished 213 tool calls and two compactions earlier. When an agent makes 20 tool calls with an open todo list unchanged, or a compaction drops the list from its context, codsh now shows the model its list again after a tool result and asks it to bring the list up to date. The reminder is context for the model, never a transcript row, and holds while plan mode is on. `CODSH_TODO_REMINDER=<calls>` changes the count for one launch; `off` turns it off.
