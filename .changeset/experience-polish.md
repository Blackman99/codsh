---
"codsh-cli": patch
---

Six field-reported paper cuts, plus the harness that keeps them fixed. The completion menu and every selector now window around the selection instead of pinning their first page, and the selected row is an accent colour rather than barely-visible bold. The mouse wheel scrolls the right way, one line per event, with a gesture's burst coalesced into a single repaint. The working indicator is one continuous clock for the whole turn — it no longer resets at every step or flickers the layout by appearing and disappearing mid-stream. The welcome screen carries the codsh lettermark at the top and returns after `/clear` (which now actually empties the session's own viewport — as does `/resume`, before replaying). Long tool results collapse to a five-line sliver behind "+N lines (Ctrl+O expands)". A new screen-level experience suite asserts all of this the way a person sees it, so the next rendering change fails in CI before it reaches a terminal.
