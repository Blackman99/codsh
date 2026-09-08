---
'codsh-bundle': patch
---

feat(queue): merge typed-ahead prompts into one message, run queued `!` lines in order, manage the queue on Ctrl+Q, and steer the running turn

Typing while the agent works already queued each line for its own turn, with Escape as the only way to take a line back — which meant Escape could not interrupt while anything was queued, and a free-text `ask_user_question` could swallow the first queued line as its answer. Now adjacent prompts typed during a turn leave as ONE user message, a blank line between them; a `!` shell line or `/` command keeps its place in the order and runs alone. Ctrl+Q (or a click on the `↳ queued:` row) opens a queue panel that lists what is waiting and lets you edit a line back into the box (Enter), delete it (`d`), reorder it (Shift+↑/↓), or steer it into the running turn (`s`); Ctrl+Enter on a kitty-protocol terminal steers straight from the box, and the line shows as `↳ steering:` until the model takes it, then renders as a prompt. Escape now always interrupts, queue and all, and the queue goes as the next message; an interrupt hands an unclaimed steer back to the head of the queue. Questions asked mid-turn read only the keyboard, never the queue. The `steer` mock mode holds a turn for three seconds and reports whether a mid-turn message arrived.
