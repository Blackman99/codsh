---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): restore bottom margin for thinking summary preceding assistant text

The background-less thinking summary relies on the top margin of the subsequent block for its bottom spacing. When the thinking block was immediately followed by assistant text (which normally omits leading margins if not preceded by a tool run), the text appeared visually attached to the thinking line. Assistant text now correctly prepends an unstyled blank line if its message also contained a reasoning block, ensuring the thinking summary remains perfectly centered.
