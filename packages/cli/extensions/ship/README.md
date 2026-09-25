# Ship extension for `codsh --rust`

Ship is codsh's staged `/ship` workflow. In the Rust client it is an optional
plugin: nothing Ship-related loads, registers, or writes until you install and
enable it.

```sh
codsh --rust plugin install bundled:ship --trust
codsh --rust plugin enable ship
codsh --rust plugin disable ship     # /ship and its hooks leave the next prompt
codsh --rust plugin uninstall ship --confirm
```

Enabled, it adds `/ship` (also `/ship:ship`; a built-in or native `/ship`
keeps the bare name) and four command hooks. It adds no key bindings. `/ship
<requirement>` sends the legacy first-turn contract (pre-flight and wayfinder)
to dsh. The hooks keep the legacy records beside the spec:
`docs/specs/<slug>.md` (Status is the phase), `<slug>.ship.json` (the frozen
original requirement), and `<slug>.ship.answers.json` (each human
`ask_user_question` answer, verbatim). A cancelled turn keeps what was written;
a bare `/ship` resumes a spec whose Status is `wayfinding`.

Only pre-flight and wayfinder run here. A spec at `grilling` or later is
refused with a pointer to legacy `codsh`, which reads the same files. There is
no goal or automatic phase continuation in this extension yet.

## Browser graph

`/ship` prints one line, and prints it again only when it changes:

```
Ship graph · wayfinder-e2e.md · Status: wayfinding · 待认领 1 · 已认领 1 · 已关闭 2 · 2 of 4 decision answers recorded · http://127.0.0.1:<port>/<token>/
```

The URL opens the legacy Web panorama (the same React Flow page legacy
`/ship` serves). Its graph is joined on every poll from the files above plus
local wayfinder tickets (`.scratch/<slug>/wayfinder/NN-*.md`), never from the
graph cache, so the page and the line agree and a deleted or corrupt
`<slug>.ship.graph.json` loses nothing; the hooks rewrite that cache as the
legacy runner does. The Status is the ledger's, never inferred from tickets.

- `hooks/ship-web.mjs` runs detached, one per workspace, for the dsh process
  that ran `/ship`. It listens on `127.0.0.1` only and answers GET/HEAD only
  under a random 128-bit path; other paths are 404 and a non-loopback `Host`
  is refused.
- It stops when the session ends (SessionEnd), when dsh exits, or when its
  record in the plugin data directory disappears (`uninstall` removes it).
- The record (`web/<key>.json`, mode 0600) keeps the port and token, so
  resuming the session (SessionStart) reopens the same URL and an open page
  reconnects by itself. `/ship` never opens a browser.

`hooks/ship-hook.mjs`, `hooks/ship-web.mjs`, `web/`, and `commands/ship.md` are
generated from `packages/bundle/src/ship-extension*.ts` and `ship-web-app.tsx`
by `scripts/build-ship-extension.mjs` (run by `pnpm run build:rust`).
