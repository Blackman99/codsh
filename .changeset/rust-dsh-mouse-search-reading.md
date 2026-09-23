---
'codsh-cli': minor
'codsh-bundle': minor
---

Add fullscreen mouse selection, transcript search, turn jump, and reading-position restore to the isolated Rust client. Selection survives rebuild, hit testing uses the painted gutter, and scrollback Ctrl+D half-pages instead of quitting. `/find` and `/jump` refuse in minimal with the `/fullscreen` remedy.
