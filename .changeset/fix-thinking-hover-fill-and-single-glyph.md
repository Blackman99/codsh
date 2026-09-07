---
'codsh-bundle': patch
---

fix(tui): fill thought background padding rows on hover and center single gutter glyph when collapsed

1. Hover fill now checks whether a visually trimmed row carries an explicit background escape sequence before treating it as an unstyled separator. Padded panel rows (such as thought inner padding) now highlight and transition colors together with the text instead of leaving unstyled two-tone strips.
2. The transcript fold and screen components now support per-line gutter rules. When the thought block is collapsed, only the middle text line displays the `✻` glyph while the padding lines preserve spacing without redundant stacked glyphs.
