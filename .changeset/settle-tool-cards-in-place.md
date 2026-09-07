---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): settle a tool call into one card instead of two

A completed card was only allowed to take the place of its own pending card
when the result happened to be long enough to collapse into a fold. Every
shorter result — most reads, most short commands — took the path that dropped
that link, so the finished card printed underneath the pending one and the
same call appeared twice.

The link itself was fragile too: it removed the last N lines of the transcript
rather than the pending card's own lines, so an approval note or a second
call's card arriving in between was what got removed instead.

A finished card now replaces the exact lines its pending form printed, wherever
they still sit — on the live path, inside a subagent view, and in the replay
that rebuilds a resumed session.
