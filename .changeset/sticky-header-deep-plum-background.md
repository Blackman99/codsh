---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): adopt deep plum background color for sticky turn headers

Replace the generic gray hover background fill (`236` / `253`) on sticky turn headers with a deep plum / eggplant tone (`#1e1326`, 256-color fallback `#53`) in dark mode, and soft lavender (`#f3eaf6`, 256-color fallback `#225`) in light mode:

- Responds to the user prompt's magenta identity (`--user: #d98ce8` / `›`) with distinct brand visual cohesion.
- Provides strong contrast and recognizability so pinned turn prompts stand out cleanly from the scrolling transcript underneath.
- Supports 24-bit TrueColor with graceful fallback to 256-color palette.
