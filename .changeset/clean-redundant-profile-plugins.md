---
'codsh-cli': patch
'codsh-bundle': patch
---

fix(cli): clean redundant profile plugins and invalidate stale dev-home

- Automatically remove redundant `@deepseek-ai/dsh-llm-pi-ai` entries and directories from `~/.dsh/profiles/code` on startup and update, avoiding version conflicts with `@deepseek-ai/dsh-base`.
- Track `.dev-stamp` in `scripts/dev.mjs` to invalidate and rebuild stale `.dev-home` environments when dsh or bundle dependencies update.
