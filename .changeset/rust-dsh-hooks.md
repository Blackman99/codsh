---
'codsh-cli': minor
'codsh-bundle': minor
---

Run Grok-compatible command hooks from `codsh --rust` at SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, and SessionEnd. Exit 2 or `decision: deny` blocks the prompt or tool. A timeout, crash, or other non-zero exit is a recorded failure, not a success. Hook stdout and stderr stay hook output. An allowing hook cannot skip permission checks or widen a sandbox or permission deny. Untrusted project hooks stay skipped.
