---
'codsh-cli': patch
'codsh-bundle': patch
---

Thought clocks and tool cards now read as one stretch of work, the way Grok CLI lays out a turn. They stack flush together, with one blank row between the stretch and your prompt above it, and one blank row before the answer below it. Before this, the first thought sat directly under your prompt and the answer directly under the last thought.

Tool calls are also greyed out, so the work recedes behind the answer. A card's name is now dim, the same grey as the thought clock, on the running row and the finished one. The green `✔` stays. A failed call keeps its name in your terminal's own colour, so errors still stand out.
