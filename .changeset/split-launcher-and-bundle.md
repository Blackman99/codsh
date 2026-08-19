---
"codsh-cli": minor
"codsh-bundle": minor
---

The package is split so a machine never carries a second dsh. `codsh-cli` is now a zero-dependency launcher a few kilobytes big: it finds the dsh you already have (`DSH_BIN`, a resolvable `@deepseek-ai/dsh`, or `dsh` on PATH), registers the runtime — now published as `codsh-bundle` — into the `code` profile, migrates pre-split profiles off the old fat layout automatically, and upgrades the bundle when the launcher upgrades. Fresh machines install `@deepseek-ai/dsh` alongside; everyone else stops downloading ~300MB they already had.
