---
"codsh-cli": patch
"codsh-bundle": patch
---

An update now moves the whole pair in one command: after installing the new launcher, `codsh update` and `/update` also register the matching `codsh-bundle` into the code profile immediately, instead of leaving the runtime to be registered on the next launcher boot. A profile that launches straight through `dsh` is never left behind, and a pinned development runtime is still never clobbered. The boot-time registration stays as the catch for a runtime a bare `npm install -g codsh-cli` upgrade, or a failed move, left behind.
