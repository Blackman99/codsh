---
'codsh-cli': minor
'codsh-bundle': minor
---

The isolated Rust client attaches workspace files from the `@` picker, a single line or line range, or a pasted path. Dotfiles and gitignored files, including nested `.gitignore` files, `**` patterns such as `**/*.log`, and patterns that contain `/` (`logs/*.log`, `/secret.rs`, anchored at the directory that owns that `.gitignore`), stay hidden until the query starts with `!`. Pasting one of those paths leaves the text in the draft and does not read or send the file. Pasted prose that only names a path stays text. A prompt sent during a turn is queued with its chips, and Alt+Up restores that prompt once. A removed chip is not sent. A missing file, a file over 256 KiB, a permission failure, or a file that changed after preview stays in the composer and does not send its bytes. dsh receives the admitted text, and a resumed session shows the same `@path` mention.
