---
'codsh-cli': patch
'codsh-bundle': patch
---

Run Rhai workflows in `codsh --rust`. The model's `workflow` tool runs a reference-format script (inline, or a `<meta.name>.rhai` file in a trusted project or `$GROK_HOME/workflows`) in the vendored reference engine, and every `agent()` / `parallel()` call starts a real dsh subagent with the script's model, effort, agent type, and capability. Args, the cumulative agent budget, phases, logs, and the result follow the reference; syntax errors, invalid metadata, child failures, endless scripts, and Ctrl+C end the run within bounds. The tool block shows the run name, phase, and agent count, and `/tasks` tags its children. Runs are foreground only; named workflows, resume/pause/stop, `output_schema`, scratch files, and `git_diff_since` are refused with explicit errors, and child agents cannot start workflows. The engine limits are not a security sandbox. Only Linux was exercised.
