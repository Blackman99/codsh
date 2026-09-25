---
'codsh-cli': patch
'codsh-bundle': patch
---

The isolated Rust client supports local MCP servers. `codsh --rust mcp list|add|remove|enable|disable|doctor` manages `[mcp_servers]` in `$GROK_HOME/config.toml`, and trusted folders add `.grok/config.toml` and `.mcp.json` servers (untrusted ones are listed but not started). dsh's own MCP client mounts the servers for each session; a missing program, a startup crash, or a refused `initialize` is reported by name while the session starts with the rest. Tools keep dsh's `mcp__<server>__<tool>` names, and Grok's `search_tool` and `use_tool` are added. Every call runs once through the same permission rules (`server__tool`), Hooks, and cancellation. Output above `[mcp] max_output_bytes` (default 20000) is cut with the full text saved to disk, startup and per-tool timeouts are enforced, and `/mcps` shows state, failures, and tools and can enable, disable, or restart servers. SSE, OAuth, plugin-provided servers, and managed MCP policy are not handled yet.
