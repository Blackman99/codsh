---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(screen): accurately hover and select individual tool cards in joined runs

When multiple consecutive tool calls joined a single panel, the preceding fold's closing padding was replaced in the logical buffer without updating the fold's length. This caused earlier folds to overlap subsequent cards, making mouse hover and click always span two or more rows. Screen fold tracking now truncates superseded folds and strips ANSI escapes when measuring effective fold ranges, ensuring each tool card is individually hovered and selected.
