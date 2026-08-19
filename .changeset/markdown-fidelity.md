---
"codsh-cli": patch
---

Markdown fidelity for what models actually write. Bold or emphasis wrapping a code span now renders both (the backticks and stars are consumed, and the bold survives across the embedded span) instead of leaving raw backticks in headings. Tables keep their shape at any width: cells render their inline constructs, widths are computed from the visible text, and a table wider than the terminal wraps inside its cells — proportionally shrinking the wide columns — rather than degrading to raw pipe rows. The keyless mock now streams a torture sample (wide Chinese table, bold-wrapped code) and the experience suite asserts the rendered screen, so fidelity regressions fail in CI first.
