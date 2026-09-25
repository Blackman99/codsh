---
'codsh-cli': minor
'codsh-bundle': minor
---

`codsh --rust` starts remote MCP servers (streamable HTTP and legacy SSE) through its own proxy, signs in to OAuth-protected servers with `mcp login <name>` / `/mcps auth <name>` (discovery, dynamic registration, PKCE, refresh, revocation), keeps image results for dsh, and answers MCP elicitations on a TUI card or through editor `x.ai/mcp/elicit`; editors also get `x.ai/mcp/auth_status`, `auth_trigger`, and `read_resource`.
