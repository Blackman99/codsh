---
'codsh-cli': patch
'codsh-bundle': patch
---

Read chunked web responses by chunk size so a payload containing the terminator is not truncated, and finish a zero-size chunk after its trailer fields and blank line. Pass the fetched page as its own JSON field, and label managed-only web settings as managed.
