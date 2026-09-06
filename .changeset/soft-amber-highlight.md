---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(theme): replace glaring bright yellow highlights with soft amber on 256-color terminals

- Map `warn`, `tool`, and `pending` highlights to a softer amber shade (`\u001B[38;5;214m` in dark mode, `\u001B[38;5;172m` in light mode) on 256-color terminals.
- Retain standard ANSI yellow in basic 16-color mode for backwards compatibility.
- Eliminates eye strain caused by high-intensity fluorescent yellow on dark terminal themes.
