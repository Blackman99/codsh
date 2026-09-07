---
'codsh-bundle': patch
'codsh-cli': patch
---

fix(tui): restore background border and symmetric inner padding to thinking summary

The collapsed `thought` summary now re-integrates its background block to match other panels but with top and bottom inner padding directly embedded (expanding into a symmetric 3-row block when isolated). This properly isolates the thought text from touching adjacent block borders while still maintaining the intended structural boundary constraints of the user interface.
