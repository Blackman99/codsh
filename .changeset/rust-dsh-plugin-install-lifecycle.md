---
'codsh-cli': minor
'codsh-bundle': minor
---

Add isolated `codsh --rust plugin` marketplace add/list/update/remove and plugin install/update/uninstall with inspectable provenance. Failed or untrusted installs leave no success record and do not grant execution. A present `strict_known_marketplaces` list binds catalog load and named marketplace install, not only marketplace add.
