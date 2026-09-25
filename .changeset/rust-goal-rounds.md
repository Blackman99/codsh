---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` adds `/goal <objective> [--budget <tokens>]` with `status`, `pause`, `resume`, and `clear`: dsh's own goal driver runs the goal rounds and a dsh extension adds independent verifier subagents for every completion claim (the model's claim alone never completes a goal), a token budget kept apart from workflow agent limits, pause causes, and a visible stop reason, while the Rust client shows goal rounds and progress in the transcript and status line.
