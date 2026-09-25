---
'codsh-cli': minor
'codsh-bundle': minor
---

`codsh --rust`: an enabled, trusted plugin's MCP servers (`.mcp.json` or manifest `mcpServers`) now mount through the same MCP discovery, dsh client, and approval gate as your own servers, below every other source and labelled `plugin: <name>` in `mcp list`, `/mcps`, `/plugins`, and `plugin list --json`. Installing or enabling grants no tool permission; disabling, updating, or uninstalling a plugin forgets its servers' remembered approvals and withdraws their tools before a live session's next prompt.
