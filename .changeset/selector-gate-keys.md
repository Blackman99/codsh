---
"codsh-bundle": patch
---

Selector, GateModal, and FrontierCard now share one key vocabulary: take (Enter, and `y` on a single-select Selector), edit (`e` when a custom answer is offered), back (Esc), abort (`n`, GateModal only). Approvals paint `[enter] take · [esc] back`; a question that can take free text adds `[e] edit`. Gate still paints `[y] confirm · [e] edit · [n] abort`.
