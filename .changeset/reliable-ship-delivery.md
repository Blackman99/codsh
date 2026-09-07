---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(ship): reliable delivery with branch isolation, TDD proof logging, cascading re-verification, and dual-layer DoD

The `/ship` command workflow now enforces comprehensive reliable delivery:
- Phase 0 pre-flight working tree check (`ship · preflight` prompt) and automatic feature branch isolation (`ship/<slug>`).
- Extended spec Markdown metadata (`Branch:`, `Base-Commit:`, `Original-Branch:`) and verification log parsing.
- Cascading re-verification on resumption, gracefully degrading state when past steps fail before continuing.
- Anti-cheating mechanical TDD proof logging (capturing non-zero exit code failure logs before implementation) and single clean commits per ticket.
- 3-strike circuit breaker per ticket escalating persistent failures to human guidance.
- Phase 5 dual-layer DoD verifying acceptance criteria exit code 0 and zero new repo failures against baseline.
- Post-ship delivery modal (`ship · deliver`) for merging back, generating PR push commands, or remaining on the branch.
