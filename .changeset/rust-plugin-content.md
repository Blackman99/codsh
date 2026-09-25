---
'codsh-cli': patch
'codsh-bundle': patch
---

Enabled plugins now take effect in `codsh --rust`. `plugin enable|disable` (or Space in `/plugins`) adds or withdraws an installed, trusted plugin's rules, skills and commands (`/plugin:name`, plus the bare name when nothing native, built-in, or in another plugin owns it), `plugin:agent` agent types, and command hooks through the existing asset discovery and the dsh hook runner, with `GROK_PLUGIN_ROOT` / `GROK_PLUGIN_DATA` set for hooks. Project plugins also need workspace trust, enabling never grants tool permissions, and a live session picks up a change on its next prompt; update, disable, and uninstall withdraw the old content. `plugin list --json`, `inspect`, and the expanded `/plugins` row show each plugin's state (`active`, `disabled`, `blocked`, `missing`, `shadowed`), contributions, and per-plugin problems, so one broken plugin file does not hide the others. Plugin MCP servers are not started yet.
