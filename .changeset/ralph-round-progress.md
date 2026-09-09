---
'codsh-bundle': patch
---

fix(ship): show what a Ralph round is doing while it runs, so a working loop no longer looks hung

A `/ship` Ralph round runs for minutes inside one step of the parent, in a worker thread the surface sees no event from, and for all of that time the working line showed only `Ralph round 1`. People read the stillness as a hang and interrupted rounds that had already landed a ticket. The surface now reads the round's child session log once a second: the working line names the round's call count and its latest call (`Ralph round 1 · 27 calls · bash: python3 -m pytest -v`), the plan row's ticket progress refreshes as the child ticks checkboxes on disk instead of only when the round ends, and the round's end line says what it did (`✓ Ralph round 1 · 48 calls · 2m40s`).
