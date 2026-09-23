---
'codsh-cli': minor
'codsh-bundle': minor
---

The isolated Rust client discovers compatible project rules, skills, agent definitions, and custom commands after folder trust and includes that context in the dsh prompt. Closer skill directories outrank broader ones. Flat `commands/*.md` files are slash commands. `--rules` appends session rules and `--system-prompt-override` replaces the dsh prompt. Untrusted project assets stay inactive. Collisions, truncation, gitignored files, and invalid extra rule paths are visible in `inspect`. User-invocable skills and custom commands appear in the slash menu; `/reload-assets` rescans an added, removed, or empty directory. `codsh --rust` forwards `GROK_CLAUDE_SKILLS_ENABLED` and `GROK_CURSOR_SKILLS_ENABLED`, so setting either off stops that vendor skill scan.
