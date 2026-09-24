---
'codsh-cli': patch
'codsh-bundle': patch
---

The isolated Rust client no longer writes the composer draft to `$GROK_HOME`. A sent prompt and its image are not restored by the next launch in any project, an unsent draft stays in the running process as in the reference, and an exec screen-mode relaunch resumes the session without the draft. `--resume` shows a sent image turn with its `[Image #N]` placeholders, without the text-only `<pasted-image>` path, and sends nothing again. On a text-only model the attach notice says the model cannot see images and gets only the saved path. An empty bracketed paste (Cmd+V on an image-only clipboard) reads the clipboard image on macOS and Windows, whitespace alone inserts nothing, and pasting or dropping the absolute path or `file://` URL of an image file attaches it as an image instead of a binary `@file` mention.
