---
'codsh-cli': minor
'codsh-bundle': minor
---

Add isolated `codsh --rust plugin` marketplace add/list/update/remove and plugin install/update/uninstall with inspectable provenance. Failed or untrusted installs leave no success record and do not grant execution. A present `strict_known_marketplaces` list binds catalog load, named install, the catalog entry's clone URL, and later git update. Layers are strictest-wins. Git URL comparison folds scheme and host only, including GitHub, and keeps the repository path case-sensitive.
