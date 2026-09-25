---
'codsh-cli': patch
'codsh-bundle': patch
---

Workflows in the isolated Rust client now run in the background of their session. The `workflow` tool returns as soon as the script starts, each run gets a session-unique display name (`name`, `name-2`, …), and its completion comes back once as a notice turn with the status and result. `/workflow runs` lists the session's runs with phases, agent counts, and elapsed time; `/workflow pause|resume|stop <name>` (and the tool's `pause`, `stop`, and `resume` sources) control one by name. Pause and stop cancel the run's children. Resume replays the run's journal from its original script and args, so finished agents are not run again, but an unfinished step runs again and nothing is exactly-once. A budget stop resumes only with a higher agent budget. Runs resume only in the process that started them: after a restart they are listed and refused, and an active one shows as interrupted. The tasks pane lists workflow runs, the status line counts active ones, and a session runs at most 4 at once. A plain `-p` prompt still waits for its run. Launching a saved workflow by name and `/workflow save` are refused.
