---
'codsh-cli': minor
'codsh-bundle': minor
---

Drive real dsh turns from the isolated Rust client over ACP/JSON-RPC. Prompts submitted in the Rust UI execute through `dsh --profile acp` in the isolated Home; streamed answers, provider thoughts, empty replies, and failures are shown as dsh reports them. Protocol mismatch is refused. Mock models stay at the dsh provider boundary.
