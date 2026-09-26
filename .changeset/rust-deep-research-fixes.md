---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust`: web search and fetch registration now follows the effective settings (`config.toml` with its env overrides, requirements and `--disable-web-search`) instead of launcher environment variables, so a setup configured only in `config.toml` gives the session, `/deep-research` researchers and in-session web search their `web_search`/`web_fetch` tools. A deep-research run that completes with a partial result reads `complete (result: partial)` in the completion notice, the tasks pane and the workflow block, as `/workflow runs` already said. `codsh --rust -p "/deep-research <query>"` runs the built-in workflow in the foreground and prints its result (no query prints the usage), and the `streaming-messages-json` init line lists the session's tools and `deep-research`.
