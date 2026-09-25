---
'codsh-cli': patch
'codsh-bundle': patch
---

Complete the workflow host contracts in `codsh --rust`. `output_schema` asks a workflow child for a ```json answer that matches the schema (validated with the reference `jsonschema` crate), gives a missed answer one correction turn in the same dsh child, and returns the parsed JSON or `success: false`. `write_scratch_file`, `read_scratch_file`, and `git_diff_since` work with the reference limits, with scratch files kept under the session directory. The live-children cap of a run is configurable with `[subagents] workflow_max_concurrent` or `GROK_WORKFLOW_MAX_CONCURRENT_AGENTS` and stays separate from the cumulative `agent_budget`; a panel over the budget is still refused whole. Failed, refused, cancelled, and never-started children are never reported as successful, and every child is closed when the run ends, fails, or is cancelled. `resume_from` stays refused. Only Linux was exercised.
