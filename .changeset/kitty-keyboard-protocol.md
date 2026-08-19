---
"codsh-bundle": minor
"codsh-cli": minor
---

codsh speaks the kitty keyboard protocol, the way Claude Code does: the disambiguate flag is pushed on entering the session and popped on leaving, so on capable terminals (Ghostty, kitty, WezTerm, iTerm2, foot) Shift+Enter breaks the line, Esc reports without the ambiguity timer, and control chords arrive unambiguously. Terminals without the protocol are untouched — every legacy sequence still decodes, and Alt+Enter keeps working everywhere.
