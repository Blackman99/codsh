---
"codsh-bundle": minor
"codsh-cli": minor
---

A new built-in, `/ship <one-sentence requirement>`, drives an idea from 0 to 1 with exactly two approvals: a research-grounded interview (one ask_user_question at a time) ends in a spec file you confirm, then an implementation plan you approve — and from there the agent lands the feature autonomously, small plans implement→test→fix in-session and large ones through the ralph fresh-agent loop with the spec on disk as cross-round memory, until the spec's acceptance criteria pass with actually-run tests. Run it bare and it asks for the sentence first. `ship` joins the reserved built-in names: a custom `ship.md` command file is now skipped with a startup warning instead of loading.
