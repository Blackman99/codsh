---
'codsh-cli': patch
'codsh-bundle': patch
---

`/new` and a dashboard dispatch keep the configured provider, model, effort, permissions, and settings patch. They do not fall back to another provider. `/cd` reloads trusted workspace config before that next session starts, and that workspace model and effort replace a saved selection. A failed settings write keeps the live client.
