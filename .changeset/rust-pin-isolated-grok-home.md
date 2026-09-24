---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` ignores an inherited `GROK_HOME` again and always uses `~/.codsh-rust/.grok`. A preview launched with `GROK_HOME` pointing at another Home no longer creates that directory or writes prompt history and drafts into it. Web search and fetch settings are read from the isolated `config.toml`.
