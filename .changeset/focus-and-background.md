---
"codsh-bundle": minor
"codsh-cli": minor
---

The session now reads two terminal reports the other agent CLIs read. Focus (mode 1004): the bell rings only while the terminal is unfocused — a person already looking at the screen needs no call-back — and terminals that never report focus keep the always-ring behavior. Background color (OSC 11, asked on entry the way opencode and Codex ask): a light answer swaps the secondary-text gray for a shade that stays readable on white, while base ANSI colors remain the terminal theme's to map.
