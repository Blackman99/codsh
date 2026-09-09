---
'codsh-bundle': patch
---

fix(ship): stop stacking the plan and todo readouts while a Ralph round runs

A `/ship` Ralph loop pinned the spec's plan in chrome *and* repeated `done/total · current ticket` on the working line, so two identical progress rows sat on top of each other. Opening the list could echo the same tickets again as todos. The working line now names the round while one is in flight (the chrome already holds the plan); the expanded panel drops todos that copy a plan ticket and keeps genuine sub-steps.
