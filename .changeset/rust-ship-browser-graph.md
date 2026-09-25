---
'codsh-cli': patch
'codsh-bundle': patch
---

The optional Ship plugin for `codsh --rust` now has the browser graph: `/ship` prints one `Ship graph · <spec> · Status · 待认领/已认领/已关闭 · N of M decision answers recorded · <url>` line (again only when it changes) whose loopback URL opens the same live Web panorama as legacy `/ship`, joined from the same spec, snapshot, answer, and local wayfinder files on every poll, so the terminal and the page agree and a lost graph cache loses no answer. The server listens on `127.0.0.1` under a random path only, stops when the session ends, dsh exits, or the plugin is uninstalled, and resuming the session reopens the same URL so an open page reconnects. Command hooks can now print a Claude Code-style `systemMessage` and receive `CODSH_HOOK_HOST_PID`. The legacy page fetches `graph.json` relative to itself; legacy `/ship` is otherwise unchanged.
