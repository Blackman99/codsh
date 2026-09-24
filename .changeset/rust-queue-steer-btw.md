---
'codsh-cli': minor
'codsh-bundle': minor
---

Add queue management, send-now, steer, and `/btw` side questions to `codsh --rust`. Follow-ups typed during a turn are queued and drained one per turn in order (after the turn ends or a Ctrl+C cancel, never during a pending approval or compaction); `Ctrl+;`/`Ctrl+'` or ↑ on an empty prompt opens a pane to edit in place, reorder, delete, or send a row now. `Ctrl+Enter`/`Ctrl+I` (Apple Terminal also `Ctrl+O`, VS Code-family `Ctrl+L`) and Enter on an empty prompt cancel the running turn quietly and run that row next. `[ui] follow_up_behavior = "steer"` injects plain text follow-ups into the running dsh turn through a private, token-checked control socket, and an unclaimed steer returns to the queue. `/btw <question>` (also mid-message) answers from the session context with no tools and never enters the conversation; `/queue` lists the queue; `[ui] combine_queued_prompts` joins adjacent prompts.
