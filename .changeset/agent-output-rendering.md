---
'codsh-bundle': minor
---

Reshape agent output around reasoning: a thought streams into a 3-row (compact) or 6-row (comfortable) live preview and settles to the one-line `✻ thought for Xs` fold, while each tool call becomes a single muted row. Consecutive calls merge into one group header that names each kind of work with its count ("Read 3 files, Searched 2 patterns"), reads in the present tense while work is in flight and past once it settles, carries a failure count, and opens to the member calls and real diffs. A destructive command breaks out of the group onto its own `⚠` warning row, and a call waiting for approval is never folded away.
