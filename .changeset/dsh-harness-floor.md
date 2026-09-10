---
'codsh-cli': patch
---

Refuse to boot when the found dsh is older than the harness this runtime was built against, and print the install line, instead of crashing on a missing `expandAssistantStream` export.
