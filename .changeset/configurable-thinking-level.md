---
'codsh-bundle': minor
'codsh-cli': minor
---

feat(bundle): configurable thinking level via /thinking and /effort commands

- Add `/thinking` command and `/effort` alias to configure reasoning deliberation level.
- Support interactive selector prompt in TTY, non-TTY listing, direct argument input, and `on`/`off` shortcut toggles.
- Add per-model thinking preference persistence (`~/.dsh/code-cli-thinking.json`), restoring chosen levels on `/model` switches.
- Display active thinking level tag in MetaBar status line (`model (effort)`) and detail row in `/status` report.
- Provide auto-completion for `/thinking` and `/effort` arguments based on model capabilities.
