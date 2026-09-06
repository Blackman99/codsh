---
'codsh-bundle': patch
'codsh-cli': patch
---

feat(theme): add Grok color scheme with distinct background colors for functional output sections

- Adopt Grok Build's color scheme with semantic background differentiation across different output blocks:
  - User prompts: elevated background (`bgUser`, Grok `bg_light`)
  - Tool calls and execution results: surface background (`bgTool`, Grok `bg_dark`)
  - Thinking and reasoning deliberation: subtle violet/purple background (`bgThinking`, Grok `bg_thinking`)
  - Error notices and failed tool calls: wine red background (`bgError`, Grok `toolErrorBg` / `diff_delete_bg`)
  - Markdown fenced code blocks: code background (`bgCode`, Grok `md_code_bg`)
  - Diff additions and deletions: green and red backgrounds (`diffAdd` / `diffDel`, Grok `diff_insert_bg` / `diff_delete_bg`)
  - System and meta events: subtle meta background (`bgMeta`)
- Support 24-bit TrueColor (`COLORTERM=truecolor` / `24bit`), 256-color palette fallback, and adaptive dark/light background switching (`setLight`).
- Ensure graceful degradation: under `NO_COLOR` or off-TTY, output remains completely unstyled plain text.
