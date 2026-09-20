---
'codsh-cli': minor
'codsh-bundle': minor
---

Switch the isolated Rust client between official fullscreen alternate-screen and minimal native-history rendering in process. `/minimal` and `/fullscreen` keep the dsh session, draft, running turn, and pending approval; session-scoped `--minimal`/`--fullscreen` do not rewrite `[ui] screen_mode`.
