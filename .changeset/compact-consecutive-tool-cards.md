---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): compact consecutive tool cards into a single shared panel

Intervening non-printing events during multi-step turns (such as `step/start`, `step/end`, and text-free `assistant/message` events) prematurely cleared the active tool card run. This caused consecutive one-line tool cards (such as repeated `read` or `grep` operations) to each render in separate panels with extraneous blank padding lines between them. The active tool run now persists across non-printing events so that consecutive tool cards share a single compact panel without gaps.
