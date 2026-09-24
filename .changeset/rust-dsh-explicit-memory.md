---
'codsh-cli': minor
'codsh-bundle': minor
---

Browse, save, search, edit, and forget local memory notes with `/memory`, `/remember`, and `codsh --rust memory clear`. `/remember` appends to the workspace `MEMORY.md` after confirmation. The memory modal highlights the selected row, hides the preview under 80 columns, and cannot delete `MEMORY.md`. `[memory] enabled = false` keeps notes out of the next prompt until the session toggle. `/new`, switch, fork, and rewind drop that toggle. `/cd` then `/new` reads the new workspace. The first turn of a new session injects a bounded global and workspace note, plus keyword session matches. `index.sqlite` is a SQLite FTS5 keyword index rebuilt from the notes; a foreign database is left unchanged. Workspace clear removes `MEMORY.md`, `sessions/`, and `index.sqlite`. A session toggle does not rewrite config, and disabling memory does not delete or upload the files.
