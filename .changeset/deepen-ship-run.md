---
'codsh-bundle': patch
---

Move `/ship` chrome and phase injection behind a `ShipRun` module so the runner no longer holds spec polling, chip flash, and Status-driven turns as closures.
