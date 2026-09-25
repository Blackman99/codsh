---
'codsh-cli': minor
'codsh-bundle': minor
---

`codsh --rust` adds scheduled prompts. `/loop [interval] <prompt>` asks the model to schedule the prompt through dsh's `scheduler_create` tool (60-second minimum, 50 loops per session, 7-day expiry, overlap skip). Each fire runs as an independent background dsh subagent and reports its final status once, waking an idle session; the next fire starts fresh with that status. The status line counts loops, and the Ctrl+G tasks pane lists them and deletes the selected loop with `x`. Plain `-p`, editor ACP, the shared server, and sessions without subagents offer no scheduler.
