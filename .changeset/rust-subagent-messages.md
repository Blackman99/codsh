---
'codsh-cli': minor
'codsh-bundle': minor
---

`codsh --rust` adds subagent messages and continuation. They are off by default and turned on with `[features] active_agent_messages = true` or `GROK_ACTIVE_AGENT_MESSAGES=1`. With the flag on, the model's `send_subagent_message` tool steers, queues, or interjects a message into a running child. An interject also ends the child's blocking `job_output` wait early. The same tool wakes a completed child as the same identity in a dsh job (`· attempt N`), and a child can message its parent or a sibling. Unknown or foreign ids, cancelled children, oversize text, and spent quotas get the reference refusal text, and the transcript shows `Message sent to …` / `Message rejected · …` rows. The read-only child view shows each message as a `◎ Message from parent` turn. The `subagent` tool's `resume_from` starts a new child that continues a completed child of this session, with its transcript and pinned model (the row reads `continues "…"`). Nothing survives a restart, at most 32 finished children stay resident, and worktree-isolated, workflow, scheduler, and goal-verifier children are excluded.
