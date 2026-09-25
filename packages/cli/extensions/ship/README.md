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
keeps the bare name) and two command hooks. It adds no key bindings. `/ship
<requirement>` sends the legacy first-turn contract (pre-flight and wayfinder)
to dsh. The hooks keep the legacy records beside the spec:
`docs/specs/<slug>.md` (Status is the phase), `<slug>.ship.json` (the frozen
original requirement), and `<slug>.ship.answers.json` (each human
`ask_user_question` answer, verbatim). A cancelled turn keeps what was written;
a bare `/ship` resumes a spec whose Status is `wayfinding`.

Only pre-flight and wayfinder run here. A spec at `grilling` or later is
refused with a pointer to legacy `codsh`, which reads the same files. There is
no browser graph, goal, or automatic phase continuation in this extension yet.

`hooks/ship-hook.mjs` and `commands/ship.md` are generated from
`packages/bundle/src/ship-extension*.ts` by `scripts/build-ship-extension.mjs`
(run by `pnpm run build:rust`).
