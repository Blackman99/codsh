---
"codsh-bundle": minor
"codsh-cli": minor
---

A resumed session's history is foldable again. Replay used to write the log out line by line, so a long tool output came back as the summary line that promises `Ctrl+O expands` with no fold behind it — the key answered nothing and the output was unreachable for the rest of the session. Replay now rebuilds the same folds the live turn built: collapsed tool bodies keep their full form behind Ctrl+O, a long answer folds to its head lines and a count, and thinking — which is in the log but not in the transcript's visible text — comes back as the one dim `✻ thought` line it was, with the deliberation behind the key. Live and replayed blocks share one summary builder, so the two paths cannot drift.
