---
'codsh-bundle': patch
---

fix(transcript): reduce outer margins and add inner padding with background to thought content block

The `thought` summary block previously added unstyled empty outer rows, causing an excessively large gap between adjacent tool blocks while leaving the text without internal background padding. The thought block now removes the extra outer blank lines and renders as a styled panel with its own internal background (`bgThinking`) and symmetric top/bottom inner padding rows, matching the padding behavior of other transcript panels.
