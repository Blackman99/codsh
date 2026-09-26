---
'codsh-cli': patch
'codsh-bundle': patch
---

Fix `codsh --rust` session titles: a session whose first turn carried local memory (or project rules, agent definitions, or an expanded skill body) was titled `<local-memory> Local memory notes the` or `<human_rules> …`, because the title came from the whole first message codsh sent. `/resume`, `sessions list`, the dashboard, `/rename --auto`, and exports now use the words you typed, dsh's stored fallback title is no longer shown, and resuming such a session shows its first turn instead of dropping it.
