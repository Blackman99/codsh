---
'codsh-cli': patch
'codsh-bundle': patch
---

Pin directories inside a deny glob, including directories created after launch, so renaming one onto another write root cannot carry a matched file out from under the Seatbelt regex. A rename that stays inside the glob remains denied.
