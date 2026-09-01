---
"codsh-bundle": patch
---

Typing stays responsive while a reply streams into a long conversation. Past the scrollback cap, every appended line re-wrapped the entire buffer to drop its first line — measured at about 50ms per line against 0.02ms below the cap, which is the surface going deaf to the keyboard exactly when output is fastest. The trim now cuts the rows the dropped lines owned and leaves the survivors alone.
