---
'codsh-cli': minor
'codsh-bundle': minor
---

Add first-run compatible `config.toml` mapping into isolated dsh settings, with inspectable origins. `codsh --rust inspect` / `inspect --json` report CLI, environment, overlay, file, and default sources. Invalid files are preserved; old credentials and official login/telemetry are not used.
