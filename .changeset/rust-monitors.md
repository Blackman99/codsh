---
'codsh-cli': minor
'codsh-bundle': minor
---

`codsh --rust` adds monitors. The model's `monitor` tool runs a long-lived script as a dsh job (reference limits: `timeout_ms` default and cap 10 hours, `persistent` for the session's lifetime); each line it prints reaches the model as a `<monitor-event>`, batched and rate limited like the reference, and a flooding script is stopped and killed. An idle session wakes with a `◎ Monitor event` turn within dsh's three-wake budget; an event that arrives while the model writes its answer waits for one grouped wake, so events never add model requests beyond that budget. The script's exit is reported once. The status line counts monitors, the Ctrl+G tasks pane lists them and stops the selected one with `x`, and `/new`, session switches, and quitting stop them. Subagents, plain `-p`, editor ACP, and the shared server do not offer the tool.
