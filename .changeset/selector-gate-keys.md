---
"codsh-bundle": patch
---

Selector, GateModal, and FrontierCard now share one key vocabulary: take (Enter, and `y` on a single-select Selector), edit (`e` when a custom answer is offered), back (Esc), abort (`n`, GateModal only). Approvals paint `[enter] take · [y] take · [esc] back` (take keys green, Esc warn); a question that can take free text adds `[e] edit`. Gate paints `[y] confirm · [e] edit · [n] abort`. Frontier paints `[y] take · [e] edit · [↑↓] pick`.
