---
'codsh-cli': patch
'codsh-bundle': patch
---

The isolated Rust client can share sessions between clients. `codsh --rust agent serve` serves ACP over an authenticated WebSocket on `127.0.0.1:2419` by default, and `codsh --rust agent leader` runs a per-user leader on a 0600 socket that `agent --leader stdio` (or `[cli] use_leader`) starts or reuses. One dsh process runs each live session: another client attaches with `session/load` and gets saved turns, the running turn, and any pending approval without a second executor. The first approval answer wins and late answers are told they are stale, a concurrent prompt is refused, option changes are broadcast, and a dsh exit is reported without retrying the turn. A client disconnect does not cancel work. A non-off sandbox profile keeps the session out of the leader. `codsh --rust leader list|info|kill` manages leaders. Nothing listens unless one of these commands is run. `agent headless`, `--remote`, and Cursor worker mode need official services and are refused.
