---
'codsh-cli': minor
'codsh-bundle': minor
---

The isolated Rust client keeps the official textarea for prompt editing. Typing `/` in a nonempty draft stashes that draft so a slash command can run, then restores it. Slash completion starts from an empty `/`. Multiline, undo, history search, slash/HISTFILE completion, prompt Vim (`[ui] simple_mode=false`), paste, and `$VISUAL`/`$EDITOR`/`vi` external editing submit the resulting text through dsh. An unsent draft survives resize, and a submit that does not start a turn puts that draft back. A narrow screen still shows `Execution unavailable` beside that draft. `/edit-prompt` requires an empty composer; Ctrl+G in minimal preserves a draft. Next-prompt ghost text is not wired, so Tab and Right do not accept it. Suggestion rows stay blocked.
