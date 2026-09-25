# codsh-cli

**codsh** is a terminal coding agent for DeepSeek — and any OpenAI-compatible endpoint — built directly on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Its flagship command, **`/ship`**, turns a one-sentence idea into verified code through an autonomous 7-stage engineering pipeline with a real-time task flow panorama across terminal and browser.

```sh
npm install -g @deepseek-ai/dsh codsh-cli
export DEEPSEEK_API_KEY="your-api-key"
codsh
```

## `/ship`

`/ship <one-sentence idea>` automatically drives the complete engineering workflow:
wayfinder → grill → spec → tickets → landing → done.

- **Live Task Flow Panorama**: Real-time TTY teaser row, fullscreen ASCII DAG overlay (`Ctrl+G`), and local interactive Web flowchart (`127.0.0.1:<port>`).
- **Autonomous Conflict Resolution**: Parallel git worktrees with automated merge conflict handling and validation.

## The launcher

`codsh-cli` is a zero-dependency launcher that locates your installed `dsh`, registers the [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) runtime into a `code` profile, and boots `dsh --profile code`.

- `DSH_BIN=/path/to/dsh`: Pin a specific `dsh` executable.
- `CODSH_BUNDLE_SPEC`: Point to an alternate bundle package or local tarball.

## Local Rust candidates

`codsh --rust` selects the isolated Rust client, which drives real dsh turns
over ACP/JSON-RPC. Plain `codsh` is unchanged. The candidate uses
`~/.codsh-rust/dsh`, Profile `rust`, never automatically imports `~/.dsh` or `~/.grok`
credential files or sessions, and does not start the legacy Bundle or official
agent core. Configure a provider in `~/.codsh-rust/.grok/config.toml` (`$GROK_HOME/config.toml`)
and inspect effective values with `codsh --rust inspect` / `inspect --json`.
`[ui] theme`, compact mode, timestamps, status line, `confirm_before_rewind`,
and `ui.fork_secondary_model` use that same file. `/settings` and `/theme`
edit or preview those live controls; minimal mode keeps the terminal palette.
`codsh --rust import --preview` lists conversions, conflicts, and unsupported items
from current dsh `$DSH_HOME/settings.yaml`, `code-cli-thinking.json`, and
`code-cli-ui.json` (not outdated `code-cli-settings.json`). UI density maps to
`[ui] compact_mode`; legacy bell/notify/bang preferences stay unsupported.
The imported model follows `agent-default-model`. Inline keys are not copied,
a missing `apiKeyEnv` is not invented, and nested settings such as the status
line are kept.
`import --apply` copies selected providers/preferences into the isolated Home without tokens, credential
files, or original trust/execution grants. Preview, cancel, and failed apply leave
source files and existing isolated settings unchanged. Model credentials stay in
the host environment (`--authorize-env`) or must be exported after import.
Compatible
`api_backend` and reasoning-effort fields map into isolated dsh
`settings.yaml`; a hand-edited settings file that disagrees is not overwritten.
`/model` and `/effort` only apply advertised catalog options; unsupported
backends or efforts are refused, and same-named models on different protocols
are not treated as equivalent. Provider usage stays unknown unless supplied;
dsh occupancy is labeled as an estimate. Turns are refused until the advertised
catalog selection is applied. Managed defaults and locked requirements live
beside the user file as `managed_config.toml` and `requirements.toml`. Untrusted
workspaces prompt before project Hooks/plugins/instructions run; `--trust`
saves a grant and `--revoke-trust` withdraws it. `codsh --rust plugin`
marketplace/install/update/uninstall records isolated plugin files and
provenance; install does not grant execution. `plugin enable|disable` (or Space
in `/plugins`) adds or withdraws an installed, trusted plugin's rules, skills and
commands (`/plugin:name`), agents, and command hooks through the normal
discovery and hook runner; project plugins also need workspace trust, enabling
never grants tool permissions, and `plugin list --json` shows each plugin's
state and contributions.
Ship is optional here: `plugin install bundled:ship --trust` then
`plugin enable ship` adds `/ship`, which runs the legacy pre-flight and
wayfinder phase through dsh and keeps the legacy spec, snapshot, and answer
files (a bare `/ship` resumes). It prints a `Ship graph · …` line with a
loopback URL (`127.0.0.1`, random path) for the same live browser graph as
legacy `/ship`, stopped with the session and reopened on resume. Specs past
wayfinding are pointed at legacy `codsh`; nothing Ship-related exists until you
install and enable it.
`/goal <objective> [--budget <tokens>]` keeps dsh working on an objective in
goal rounds until independent verifier subagents agree it is done (the model's
own claim never counts); `/goal status|pause|resume|clear` manage it, the
status line shows progress, budget, and why it stopped, and `[goal] enabled =
false` or `GROK_GOAL=0` turns it off. A present
`strict_known_marketplaces` list binds catalog load, named install, the
catalog clone URL, and later git update. Layers are strictest-wins. URL
comparison folds scheme and host only, including GitHub, and strips one
trailing `.git`. The repository path stays case-sensitive.
Unpinned remote updates are
refused when `GROK_MARKETPLACE_REQUIRE_SHA` is set. Each marketplace plugin has its
own dest. `/plugins` and `/marketplace`
open the directory. `--always-approve`/`--yolo`, `--permission-mode`, and
`--allow`/`--deny` control permission modes and persistent rules; explicit deny
still wins. Unsplittable shell and Read/Edit path rules on operands cannot
bypass deny; wrappers peel to the inner command without eating the command name
while `env -S` prompts; brace groups and ANSI-C `bash -c` cannot hide a denied
command; a leading word such as `time`, `exec`, or `builtin` cannot hide a
denied command, and a shell option that takes the next word (`bash -o errexit -c`)
is consumed before the script; an unquoted `*`, `?`, or `[` in a command word is not expanded, so `./r*` is not auto-approved; a path-qualified executable such as `/bin/rm` or `RM.EXE` matches by
basename without regard to case; `sort -o` (including attached `sort -oFILE`
and clustered `sort -uoFILE`)
/`--output` and unique `sort --compress-program` prefixes
are not read-only, nor are git writes, including `git branch <name>`,
`-f`/`--force`, `-u` (including attached `git branch -uorigin/main` and a bare `-u` or `-t`), `--track` and a unique prefix such as `--tr`, unique `git branch --delete`/`--move`/`--copy` prefixes,
and `--output` on `diff`/`log`/`show`/`blame`/`rev-list`; Claude settings load
from `~/.claude` and walk to the repo root;
Read/Edit deny follows in-path symlinks; remembered file
grants are path-scoped; a corrupt policy file refuses mutating tools. The
model's configured `env_key` (`XAI_API_KEY` and other
`*_API_KEY` values) is passed through to dsh. Missing credentials stay local
(no grok.com login or default telemetry). `codsh --rust feedback` stores local
drafts until an explicit submit or `/feedback <text>` send. Content sharing
redacts the posted draft unless `privacy.share_content` is on. Trace upload and
session tracking post only a counter (plus the session id when
`privacy.share_session` is on) to their own substitute. Official grok.com,
api.x.ai, and Sentry destinations are refused by hostname. Diagnostics contain
kind, ok, and count only and are separate from model `base_url` traffic.
`GROK_LOG_FILE` and `GROK_HOOKS_LOG` are unwired and are not forwarded.
`CODSH_CLIPBOARD_IMAGE` and `GROK_CLIPBOARD_NO_NATIVE_READ` are forwarded so a
packed session reads the controlled clipboard file.
`GROK_CLAUDE_SKILLS_ENABLED` and `GROK_CURSOR_SKILLS_ENABLED` are forwarded;
setting either to `false` stops that vendor's skill and command scan.
`login` / `logout` / `setup` use
configured substitute identity or management services; session tokens in
`$GROK_HOME/auth.json` are not transferred to model keys or other services,
and unsigned managed policy is refused. Independent API keys cannot bypass
`GROK_DISABLE_API_KEY_AUTH` or a locked team pin (`auth.force_login_team_uuid`
or top-level `force_login_team_uuid` in `requirements.toml`). Startup and inspect refresh an expired session or clear it. Clearing an unrefreshable token does not block `login` or an otherwise valid API key. `/login` reloads the session, replaces dsh when credentials, readiness, or the settings patch changed, and keeps the live client when the settings write fails. The executing dsh child receives `GROK_AUTH_PATH`, `GROK_AUTH_ACCESS_TOKEN`, and a configured `GROK_AUTH_PROVIDER_COMMAND`; other parent `GROK_AUTH_*` variables stay out. `/logout` revokes the identity session before clearing `auth.json` and drops that connection; revocation failure keeps the local session. A signature for another principal is refused at setup and when the sidecar is loaded, including a deployment-key caller with no team. Fail-closed policy with no pubkey and no sidecar is refused. Empty Enter on first-run reloads
config and connects when a provider is ready, without submitting a prompt. Filesystem-resolved overlap with `DSH_HOME`/`GROK_HOME`, including case
aliases, is refused before writes; symlinked preview paths remain forbidden.
Device/inode ancestry checks include existing ancestors of missing paths, catching
macOS firmlinks even when native realpath strings differ. Separate aliased Homes
remain supported; unavailable directory identity fails closed before writes.
If either Home is missing, case-only potential overlap is conservatively refused
on every platform without creating probe paths. Any missing non-ASCII path component
is also refused before writes, even for a separate Home; lowercase/normalization
cannot establish its filesystem identity. Use an existing separate Unicode directory
or only ASCII missing components. Existing Unicode ancestors and separate Homes,
including missing ASCII children beneath them, retain native resolution.
Unresolved symlinks in explicit
or default legacy Homes are refused before writes; fix dangling links/cycles first.
Resolvable links to separate legacy Homes remain supported. `DSH_HOME` follows
released dsh: blank is unset, `~`/`~/`/`~\` expand, and relative paths/`..` normalize
lexically. Nonempty `GROK_HOME` stays literal, including tilde and whitespace.
Any `..` component in `GROK_HOME` is intentionally refused, even for a separate
existing Home; use a path without parent traversal instead of relying on guessed
symlink semantics. Default `~/.dsh` and `~/.grok` remain protected with overrides.
Enter submits the draft through dsh when ACP is connected, and otherwise
reports that execution is unavailable. File read/write/edit run through dsh
tools; `y` allows one pending file mutation and `n` rejects it with no write.
`Ctrl+Q` quits. `Ctrl+D` quits except in fullscreen scrollback, where it
half-pages. `Ctrl+C` clears a non-empty draft without cancelling
work; an empty draft cancels a running turn through dsh, or quits when idle
before any turn. Esc never cancels a turn or pending approval.
`--continue` resumes the last dsh session in this directory; `--resume <id>`
loads that session. `--fork-session` copies conversation into a new session id.
`/rewind` and `/fork` are conversation-only; `--restore-code` is refused.
Interrupted tools are shown as unknown and not replayed.
A second client is refused while this process holds write ownership.
`agent serve` and `agent leader` are the opt-in shared forms: several clients
attach to one live session run by one dsh process (see the root README).
`--remote ssh://[user@]host[:port]/abs/path` drives a session on another host
over SSH (public key, pinned host key, nothing forwarded); the remote config,
policy, and sandbox execute, `/reconnect` attaches to a turn still running
there, and `/remote` or `remote check` shows what the remote reports (see the
root README).
A remote host can require an organization identity (`[remote_access]` in its
`requirements.toml`, checked with your own OpenID Connect provider on every
request); the client sends its `login` session only to remotes listed in
`[[remote_identity]]` (see the root README).
`clone [-b BRANCH] [--cone PATH] [--full-history] <URL> [DIR]` clones with git
in place of the reference Grove lazy clone once `GROK_CLONE`, `GROK_GROVE`, or
Grove's `[clone] enabled` turns it on: depth 1 of one branch with blobs on
demand, a missing or empty target only, nothing left after a failure or Ctrl-C,
and `--remote ssh://…` to clone on another host (see the root README).
`mcp list|add|remove|enable|disable|doctor` and `/mcps` manage local MCP
servers that dsh starts for each session; `search_tool`/`use_tool` and every
direct `mcp__*` call go through the same permission, Hook, and cancellation
path (see the root README).
`--minimal` / `--fullscreen` and `/minimal` / `/fullscreen` switch the official
alternate-screen and native-history renderers in the current process without
rewriting isolated `[ui] screen_mode`. Official `xai-grok-markdown` renders Markdown, tables, code, mermaid labels, thoughts, and dsh tool cards/diffs; Tab then `l`/`r`/Enter/`y` fold, expand, show raw markdown, open full content, or copy original bytes. `/expand` reprints the last folded block in minimal; `/transcript` opens the exact transcript in `$PAGER`. `/rewind` and `/fork` in minimal replace
that native buffer. Draft, running turn, and pending approval survive an
in-place switch. Fullscreen `/find` and `/jump` search or preview turns and
restore the prior reading position on Esc; `/find` and `/jump` in minimal
refuse with `/fullscreen`. `/vim-mode` and `/toggle-mouse-reporting` follow
the isolated `$GROK_HOME/config.toml` keys `ui.vim_mode` and
`ui.mouse_reporting_toggle`. `/settings` and `/theme` persist or preview appearance and
status-line choices; Escape cancels a theme preview without writing.
Prompt editing reuses the official textarea: Enter submits,
Shift+Enter/Alt+Enter inserts a newline, `/multiline` (`/ml`) swaps those
chords, `/history` and empty ↑ browse submitted prompts, Tab completes slash
commands and HISTFILE in `!` mode. Typing `/` in a nonempty draft stashes that
draft, runs the slash command, and restores it. `/edit-prompt` requires an empty composer;
Ctrl+G in minimal preserves the current draft. Both open `$VISUAL` then `$EDITOR`
then `vi` without submitting. `[ui] simple_mode=false` is prompt Vim;
`/vim-mode` remains scrollback navigation. Next-prompt ghost text is not wired,
so Tab and Right do not accept it. Suggestion rows stay blocked. `chips=false`
is not an attachment refusal.

Plan mode, `ask_user_question`, and todos are dsh's. `/plan [task|off]` and
Shift+Tab switch plan mode; while it is on, only the session plan file
(`$GROK_HOME/sessions/<encoded cwd>/<session id>/plan.md`) can be edited, in
every permission mode. `exit_plan_mode` opens a review (`a` approve, `s` request
changes, `c` comment, `y` copy, `q` abandon), questions open a card, and
`/view-plan` shows the saved plan. `--no-plan`, `--no-ask-user`, and
`[toolset.ask_user_question]` timeouts apply; plain prompts and editor sessions
get the reference's no-operator answer.

Maintainers run `pnpm run build:rust` before locally packing this package. The
candidate carries its native binary, dependency/license records, and digest;
users of that package need no Rust compiler. Missing/platform-mismatched or
corrupted artifacts fail, without downloading or falling back. No official
account or executable is required. This is not a published replacement release.

Full documentation: [github.com/Blackman99/codsh](https://github.com/Blackman99/codsh)
