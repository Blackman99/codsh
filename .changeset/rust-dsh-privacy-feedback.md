---
'codsh-cli': minor
'codsh-bundle': minor
---

Keep isolated Rust telemetry, trace upload, session tracking, and content sharing off unless a substitute destination is configured. Feedback draft text is posted only when content sharing is on; trace upload and session tracking send their own redacted counters. `/feedback` uses one Write/Drafts form in every mode. Official hosts are matched by hostname. Diagnostic previews redact prompts and secrets and stay separate from model traffic. `GROK_LOG_FILE` and `GROK_HOOKS_LOG` are not forwarded.
