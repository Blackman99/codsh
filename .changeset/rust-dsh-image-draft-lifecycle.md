---
'codsh-cli': patch
'codsh-bundle': patch
---

In the isolated Rust client an unsent composer draft lives only in the running process, as in the reference: it is not written to `$GROK_HOME`, a new launch in any project starts with an empty composer, a sent prompt and its image never come back, and an exec screen-mode relaunch resumes the session without the draft. `--resume` shows a sent image turn with its `[Image #N]` placeholders, without the text-only `<pasted-image>` path, and sends nothing again. On a text-only model the attach notice says the model cannot see images and gets only the saved path, whose attribute is escaped. Rules, session rules, and the first-turn memory note wrap that user text once; they are not copied onto the `<pasted-image>` element or an attached file body. On macOS an empty bracketed paste (Cmd+V on an image-only clipboard) reads the clipboard image; on Windows it and Alt+V say the clipboard image read is not available yet and attach nothing. Whitespace alone inserts nothing, and pasting or dropping the absolute path or `file://` URL of an image file attaches it as an image instead of a binary `@file` mention.
