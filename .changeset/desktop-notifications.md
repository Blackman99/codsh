---
"codsh-bundle": patch
---

Away from the window, the bell's two moments — a decision waiting, a turn over ten seconds ending — also send a desktop notification naming what waits: `waiting for approval: bash: git push origin main`, `finished in 42s`. The terminal is asked first with OSC 9 (iTerm2, WezTerm, Ghostty, kitty, Windows Terminal); Terminal.app, which ignores it, gets `osascript`; an unknown Linux terminal gets `notify-send` beside it. Focused, nothing is sent. `notify` beside `bell` turns it off.
