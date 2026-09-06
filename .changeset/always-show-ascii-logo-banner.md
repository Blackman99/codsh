---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): always show full ASCII logo banner on fresh start and /clear

- Always display the full ASCII whale logo and welcome tips whenever a fresh session is started in an interactive terminal, regardless of prior sessions in the workspace.
- Redisplay the full ASCII logo banner after a `/clear` command in an ongoing session.
- Keep skipping the welcome banner when resuming or continuing a previous session (`--resume` / `--continue`).
