---
'codsh-cli': minor
'codsh-bundle': minor
---

Plain prompts accept `--output-format plain|json|streaming-json|streaming-messages-json`. `json` prints one object. The streaming formats print one JSON object per line and end with `end` or `result`. `--include-partial-messages` adds `stream_event` deltas and only changes `streaming-messages-json`. Tool arguments, tool results, and reasoning are copied from dsh. Usage and cost are copied only when dsh sends them; otherwise the terminal object says `usage_absent` and does not invent a bill. Interrupt, truncation, and a model error finish without reporting a successful `end_turn`. A tool approval with no terminal is rejected inside dsh and exits 1; the JSON object is an error, not `end_turn`.
