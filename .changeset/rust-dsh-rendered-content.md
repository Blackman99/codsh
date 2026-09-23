---
'codsh-cli': minor
'codsh-bundle': minor
---

Render real dsh Markdown, tables, code, mermaid labels, thoughts, and tool cards/diffs through official `xai-grok-markdown` in the isolated Rust client, keeping heading, code, table, and diff colors on the session. Pretty mode hides inline HTML tags and keeps a ZWJ emoji in one cell. Long bodies fold; Tab then expand/raw/full-content/`y` keep original bytes, and Esc closes full content back to the fold. `/transcript` opens them in `$PAGER`. A failed tool paints `failed` and `[error]` in a failure color instead of success.
