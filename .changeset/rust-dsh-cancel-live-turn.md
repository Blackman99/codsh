---
'codsh-cli': minor
'codsh-bundle': minor
---

Cancel a live dsh turn from the isolated Rust client without losing an unrelated draft. Empty-draft Ctrl+C sends ACP session/cancel; Esc never cancels a turn or pending approval. Cancelled tools cannot run from a late allow or reconnect.
