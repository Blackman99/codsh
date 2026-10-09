---
'codsh-cli': patch
'codsh-bundle': patch
---

Settings and view commands take effect at once while the agent works instead of waiting in the queue: `/theme`, `/ui`, `/model`, `/thinking`, `/effort`, `/permission`, bare `/plan` and `/plan off`, `/status`, `/todos`, `/subagents`, `/jump`, `/copy`, `/view`, `/diff`, and `/help`. A model or thinking switch made mid-turn applies from the running turn's next step. Commands that start a turn or swap the session (`/init`, `/ship`, custom commands, `/compact`, `/goal`, `/plan <message>`, `/clear`, `/resume`, `/rewind`, `/update`, `/exit`) still queue. Ctrl-C while such a command's picker is open closes the picker and leaves the turn running. A command of a kind already queued waits behind it so the order typed holds, a queued `/` line says it will run when the turn ends, and `/plan off` is accepted in any case.
