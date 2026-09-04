---
"codsh-bundle": patch
---

`/rewind` takes the conversation back to before a turn you pick — a searchable picker of your prompts, newest first, or `/rewind 3` — and continues from there. The session log is append-only, so the rewind is a new session seeded with everything up to that point, with the old one as its parent; the old session stays in `/resume`. Esc Esc still recalls the last prompt.
