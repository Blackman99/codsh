---
"codsh-bundle": minor
"codsh-cli": minor
---

`/ship` now lands reliably, not just intently. The spec file becomes the
workflow's durable memory instead of the conversation: the approved plan is
written into it as milestone checkboxes, a `Status:` line names the phase, and
a bare `/ship` first offers to resume any unfinished spec it finds — an
interruption, a `/clear`, or a compacted context loses nothing.

Green is grounded rather than asserted. Before any implementation code the
working tree is checked clean and the plan's proof commands run once to record
the baseline — a suite that was already red surfaces at the gate, not under
the diff. Every acceptance criterion must name the exact command that proves
it; each milestone is committed when it turns green; and after a fresh-agent
Ralph loop returns, the session re-runs every proof command itself — the
loop's word is a report, not a verification. The loop is bounded (about three
rounds per milestone) and told to stop and report rather than spin past two
consecutive rounds of no progress.

Pasted images are requirements material now that Ctrl+V exists: a mockup or
screenshot riding the `/ship` message is read and cited in the interview.
