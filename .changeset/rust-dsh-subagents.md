---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` runs typed subagents through dsh. `general-purpose`, `explore`, `plan`, `[subagents.roles]`, and agent files set each child's tools and model; children inherit the parent's permissions, `max_concurrent`, `limit_behavior`, and `max_depth` are honored, and `--no-subagents` or `--disallowed-tools Agent(type)` remove them. The tool block and status line follow each child, and `/tasks` (Ctrl+G in fullscreen) lists children, opens a read-only child transcript, and cancels one child.
