---
'codsh-cli': patch
'codsh-bundle': patch
---

`pnpm run dev` now boots with the machine's custom providers and default model from `~/.dsh`, instead of an empty scratch home. `MOCK=<mode>` still pins the keyless mock.
