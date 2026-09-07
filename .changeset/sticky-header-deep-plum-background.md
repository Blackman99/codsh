---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(tui): adopt deep plum background color for user prompt blocks and sticky turn headers

Align the background color of user prompt message blocks (`theme.bgUser`) and sticky turn headers to a unified deep plum / eggplant tone (`#1e1326`, 256-color fallback `#53`) in dark mode, and soft lavender (`#f3eaf6`, 256-color fallback `#225`) in light mode:

- Unifies the visual identity of user prompts in the transcript and when pinned at the top as sticky turn headers, ensuring seamless transition during scrolling.
- Responds to the user prompt's magenta identity (`--user: #d98ce8` / `›`) with distinct brand visual cohesion.
- Provides strong contrast and recognizability so turn prompts stand out cleanly from agent answers and tool execution outputs.
- Supports 24-bit TrueColor with graceful fallback to 256-color palette.
