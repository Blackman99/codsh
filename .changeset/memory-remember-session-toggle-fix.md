---
'codsh-cli': patch
'codsh-bundle': patch
---

Fix `codsh --rust`: an empty `/remember` (the two-step draft prompt) no longer resets this session's `t` memory toggle back to `config.toml`'s value on save or cancel. Turning memory on with `t` after this session's first prompt was already sent now says it is too late for any prompt here. `/new` drops that toggle and follows `config.toml` again, so the notice does not claim the change carries into the next new session.
