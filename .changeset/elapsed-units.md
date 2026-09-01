---
"codsh-bundle": patch
---

Elapsed times grow a unit instead of counting seconds forever: a long run reads `1h 37m` rather than `5845s`. The working line, the figure a finished turn reports, and a thinking block's header all share one formatter, which keeps the decimal while a turn is quick and shows the finest unit that still changes visibly.
