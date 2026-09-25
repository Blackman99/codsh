---
'codsh-cli': minor
'codsh-bundle': minor
---

Show session token usage in `codsh --rust`. `/usage` (alias `/cost`), `/session-info`, the status line command payload, headless `json` / `streaming-json` / `streaming-messages-json` results, and the new `codsh --rust usage <session-id> [turn]` command read one ledger folded from the dsh session log: input with cache reads and writes, output with reasoning, totals, model calls, API time, per-model rows, and subagent sessions folded into the turn that spawned them. The whole log is folded, so a resume never double-counts; a fork keeps its inherited history as in the reference, and a `-p` result reports only its own turns. A call with no reported usage, an interrupted or failed turn, or a missing or running subagent log marks the ledger incomplete instead of adding zeros. Auxiliary calls (session title, compaction summary, `/btw`, memory) are not counted. dsh reports no cost and no price table is used, so cost is shown as not available and headless output says `cost_status: "unknown"`; nothing is estimated and `$0` is never shown. Checked with the keyless mock provider and real dsh on Linux only.
