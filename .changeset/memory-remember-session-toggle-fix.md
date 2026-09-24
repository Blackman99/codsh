---
'codsh-cli': patch
'codsh-bundle': patch
---

Fix `codsh --rust`: an empty `/remember` (the two-step draft prompt) no longer resets this session's `t` memory toggle back to `config.toml`'s value on save or cancel. Turning memory on with `t` after a session's first prompt was already sent now says it takes effect from the next new session, matching the frozen first-turn-only injection behavior, instead of implying the very next prompt.
