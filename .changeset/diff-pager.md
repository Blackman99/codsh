---
"codsh-bundle": minor
---

`/diff` reads uncommitted changes in the fullscreen reader instead of writing them into the transcript, and a diff card too long for its 24-line body opens there on click. The reader colours a diff by what each line does to the file; Ctrl+O still expands a block in place, and off a TTY `/diff` stays a line reader.
