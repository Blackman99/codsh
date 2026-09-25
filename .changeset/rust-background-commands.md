---
'codsh-cli': minor
'codsh-bundle': minor
---

`codsh --rust` runs background shell commands through dsh jobs. Ctrl+B moves the running command to the background, a command past `[toolset.bash] foreground_block_budget_ms` moves on its own (or is killed at its timeout with `auto_background_on_timeout = false`), and send-now moves a running command instead of killing it. The status line counts running commands, a message interrupts a blocking `job_output` wait, `/tasks` (Ctrl+G) shows command output and stops one with `x`, and a finished command wakes an idle session with a `◎ Task completed` turn. `/new`, session switches, and quit stop the session's commands; a resumed history never shows them as running. Plain `-p` and editor ACP are unchanged.
