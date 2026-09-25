---
'codsh-cli': patch
'codsh-bundle': patch
---

`codsh --rust` can now install Ship as an optional first-party plugin: `codsh --rust plugin install bundled:ship --trust` followed by `plugin enable ship` adds `/ship`, which runs the legacy pre-flight and wayfinder phase through dsh with the legacy contract, keeps the legacy spec, `.ship.json` snapshot, and `.ship.answers.json` records and guards, resumes a cancelled run with a bare `/ship`, and refuses specs past wayfinding with a pointer to legacy `codsh`. Nothing Ship-related is installed, enabled, bound to a key, or written until you opt in, and legacy `codsh` `/ship` is unchanged.
