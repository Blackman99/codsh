---
'codsh-cli': minor
'codsh-bundle': minor
---

Enforce network isolation and shell environment filtering for `codsh --rust` sandbox profiles. `restrict_network` (built-in `read-only` and `strict`, or a custom profile) denies network with macOS Seatbelt `(deny network*)` for the client and its children. A profile that asks for network isolation on a platform that cannot apply it, including Linux Landlock and Windows, refuses startup instead of continuing with network open. dsh's per-call file mode is not a network sandbox. `[shell_environment_policy]` filters the environment of a shell child this client starts, and an unknown inherit value or an inexpressible pattern refuses startup. A macOS run does not claim Linux network enforcement. dsh's own bash tool still inherits the dsh process, because a second Seatbelt profile cannot be applied inside the first.
