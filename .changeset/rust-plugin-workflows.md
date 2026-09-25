---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust`: enabled plugins can ship Rhai workflows. `.rhai` files in a plugin's `workflows/` directory join the saved-workflow catalog after project and personal workflows while the plugin is active. They always run as `/<plugin>:<name>`, and as the bare `/<name>` when nothing else owns that name. Plugin listings, `/workflows` and `/workflows <plugin>:<name>` show them with the plugin's version, license, trust and source; installing runs nothing. Disabled or removed plugins' workflows are refused with the reason. A run started from a plugin keeps its launch script and origin, so updating the plugin changes only later launches, and a paused run resumes only while its plugin is active.
