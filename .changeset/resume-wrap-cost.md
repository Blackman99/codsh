---
"codsh-bundle": patch
---

Resuming a session no longer freezes the surface. Wrapping a styled line was quadratic in its length, so one long tool-result line — a 50,000-character HTML dump — cost four seconds every time the scrollback was wrapped, and the scrollback was wrapped far more often than it had to be: twice per resize, once more on a resumed session's first frame, and in full whenever a block opened or closed, including the automatic collapse on every submit. Wrapping is linear now, a resize wraps once, a replayed session paints without wrapping again, and a block swaps only its own rows. On the session that exposed it, `/resume` went from 4.2s to 50ms, `--resume` to the first frame from 9s to 0.5s, and a resize from 8.4s to milliseconds.
