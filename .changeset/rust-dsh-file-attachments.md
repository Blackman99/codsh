---
'codsh-cli': minor
'codsh-bundle': minor
---

The isolated Rust client attaches workspace files from the `@` picker, a single line or line range, or a pasted path. Dotfiles and gitignored files, including nested `.gitignore` files, stay hidden until the query starts with `!`. Pasted prose that only names a path stays text. A prompt sent during a turn is queued with its chips and can be edited with Alt+Up. A removed chip is not sent. A missing file, a file over 256 KiB, a permission failure, or a file that changed after preview stays in the composer and does not send its bytes. dsh receives the admitted text, and a resumed session shows the same `@path` mention.
