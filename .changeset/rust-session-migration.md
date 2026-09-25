---
'codsh-cli': minor
'codsh-bundle': minor
---

Add `codsh --rust import sessions` to copy selected legacy codsh sessions into the isolated Rust client. Listing and preview write nothing; `--apply` opens the old dsh Home read-only and writes each session (messages, tool calls and results, titles, image and file attachments, subagent sessions) as a new session id in `~/.codsh-rust/dsh`, verified before it counts, with provenance in `session-migrations/<copy id>.json` shown by `/session-info`. The old client keeps resuming its byte-identical originals and never has to read the new format; there is no live sync between the two. Skipped events, undisplayed content, unfinished turns, and missing attachments or subagent logs are reported (missing data needs `--allow-partial`); damaged logs, unsupported formats, and unknown required events are refused; a failed or interrupted copy is removed. Re-importing an unchanged session reports the existing copy, and a legacy session that changed since is a conflict until `--again`.
