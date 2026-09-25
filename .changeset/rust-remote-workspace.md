---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust --remote ssh://[user@]host[:port]/abs/path` drives a session on another host over SSH: the client runs `codsh --rust agent --leader stdio` there with public-key auth and a pinned host key (`BatchMode=yes`, `StrictHostKeyChecking=yes`, no agent, X11, or port forwarding, no local environment or keys), and the remote config, credentials, permission policy, and sandbox execute every turn. Local-policy flags, `@file` attachments, and images are refused, and local rules, memory, and MCP servers are not sent. A lost connection keeps the turn running there and `/reconnect` attaches to it without re-running anything; a remote restart is reported as an interrupted turn with unknown effects and is never retried. `/remote` and `codsh --rust remote check <url> [--json]` report what the real remote offers. The official Computer Hub, cloud workspaces, and the Cursor worker stay refused because they need private infrastructure.
