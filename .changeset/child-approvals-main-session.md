---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust`: an approval request from a subagent or workflow child (for example a deep-research researcher's `web_fetch` in the default ask mode) is now asked in the main interactive session instead of being refused. The status line names the workflow or subagent, the tool, and the target; `y` allows once, `a` remembers it like a main-session grant, `n` returns the refusal to the child. Requests queue, cancelled children close theirs, and headless runs keep the refusal (#220).
