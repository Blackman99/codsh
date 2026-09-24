---
'codsh-cli': minor
'codsh-bundle': minor
---

Export a selected session as Markdown and reject extra arguments before writing. Share only to the explicitly selected substitute, without following redirects. A symlink at the sessions root, a project directory, a session directory, or the log is not read or uploaded. Session deletion stays blocked because released dsh persistence has no deletion operation, so no session data is removed. Disk usage still reports the isolated home without deleting files.
