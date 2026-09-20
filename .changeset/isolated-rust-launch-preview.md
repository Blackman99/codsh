---
'codsh-cli': minor
'codsh-bundle': minor
---

Add an opt-in `codsh --rust` launch preview beside the unchanged legacy client. Locally packed native candidates reuse licensed upstream Rust welcome/input components with an isolated dsh Home/Profile, offline startup, explicit unavailable-execution feedback, and terminal cleanup. Include source/dependency notices and installed-product PTY verification. Refuse filesystem-resolved legacy Home aliases and ambiguous case-only overlaps with initially absent Homes before any writes; refuse unresolved symlinks in explicit/default legacy Homes, while retaining valid separate legacy links. Interpret `DSH_HOME` with released dsh's blank/tilde/lexical-normalization rules. Preserve literal `GROK_HOME` and conservatively refuse every parent-traversal (`..`) component, including separate Homes, instead of guessing symlink traversal. Protect default Homes even with overrides. Include installed-product path-matrix regressions and separate missing/resolvable-Home controls. This does not enable the dsh adapter, publish native releases, or change the default client.
