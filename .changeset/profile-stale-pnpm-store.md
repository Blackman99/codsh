---
'codsh-cli': patch
'codsh-bundle': patch
---

When `codsh update` (or the next start) cannot register `codsh-bundle` because the code profile's `node_modules` were linked from a different pnpm store, drop those modules and retry. A leftover install from another pnpm major used to leave the launcher upgraded and the profile behind.
