---
'codsh-bundle': patch
---

fix(transcript): join consecutive diff tool cards into a single shared panel without redundant padding

Tool cards representing diffs (e.g. `Edit`) do not display a pending card while executing. Previously, `renderResult` erroneously assumed pending lines were always printed, preventing consecutive completed diff cards from taking over the preceding card's closing padding. This resulted in redundant double-row padding gaps between consecutive `Edit` cards. `renderResult` now checks if the pending card printed visible lines, allowing consecutive diff cards to stack adjacently in a single compact panel.
