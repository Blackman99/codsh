---
'codsh-bundle': patch
---

Fix drag selection dying at the edges of the transcript.

A drag swept down past the last line and released over the input box copied
nothing: the rows below the transcript are routed to whatever composed them, so
the release never reached the viewport that had anchored the selection — it
neither copied nor cleared. A gesture now belongs to where it began, through
release.

A press on the blank space under the last line started nothing at all, so
sweeping up out of it selected nothing. It anchors at the nearest row now,
while a bare click there still works no block.
