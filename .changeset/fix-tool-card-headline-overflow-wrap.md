---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): prevent tool card headline overflow and unexpected line wrap

Tool card headlines previously truncated against raw terminal columns (`io.console.columns`) rather than viewport content columns (`io.console.contentColumns`). Because content columns account for left gutters and terminal padding, truncated headlines exceeded the screen's wrap boundary by several columns, causing trailing status glyphs (`… ✔`) to wrap onto an unintended second line. Transcript now reads content columns dynamically so card headlines always stay strictly on a single line.
