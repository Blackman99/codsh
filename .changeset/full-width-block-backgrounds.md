---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(screen): pad functional background rows across full content width as unified block panels

- Ensure rows carrying functional background colors (user messages, tool execution outputs, thinking blocks, code blocks, and diffs) are padded with spaces across the full content width (`padRowBackground`).
- Replaces text-only background hugging with seamless, solid rectangular card panels for each functional section.
