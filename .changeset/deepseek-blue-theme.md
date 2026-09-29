---
'codsh-cli': minor
'codsh-bundle': minor
---

The terminal UI is painted in DeepSeek blue (#4D6BFE), and `/theme` switches themes the way Grok CLI does. Arrows preview each theme live, `Enter` saves it and `Esc` reverts. `/theme <name>` sets a theme directly.

Themes:
- `auto` (the default) follows the terminal's light or dark background.
- `deepseek` and `deepseek-light` are the two DeepSeek themes.
- `terminal` paints only your terminal's own sixteen colours, with no backgrounds.

The choice is saved in `$DSH_HOME/code-cli-ui.json` without touching `/ui`'s setting. `CODSH_THEME=<name>` overrides it for one launch.

The cursor takes the theme's accent (OSC 12) and gets its colour back on exit. History already on screen is repainted in the new theme. The accent, the thinking rail, headings, links and the person's message band all change colour. Semantic colours stay red, green and amber.
