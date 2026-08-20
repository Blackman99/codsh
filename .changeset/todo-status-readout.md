---
"codsh-bundle": minor
"codsh-cli": minor
---

Todos now have a display that outlives the write that produced them. A pinned readout sits in the chrome directly over the status row for as long as a list is live: progress (`1/3`), the item in flight — or, between items, the one coming next — and `✔ all done` when the list is finished. Ctrl+T opens it into the whole list and closes it again, the way Ctrl+O swaps a fold; `/todos` prints the same list into the transcript, which is how the pipe shape reads it with no chrome and no keys. Both read the session's `todos` projection, so `--resume` reopens on the list it left off with, and one renderer now serves the readout, the transcript card, and `/todos` — the card's header gained the state breakdown (`todos 1/3 · 1 in progress · 1 open`) as a result.
