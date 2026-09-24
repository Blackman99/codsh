<p align="center">
  <a href="https://blackman99.github.io/codsh/">
    <img src="assets/banner.svg" width="900"
         alt="codsh — a terminal coding agent for DeepSeek">
  </a>
</p>

<p align="center">
  <a href="https://blackman99.github.io/codsh/"><b>Site</b></a> ·
  <a href="https://blackman99.github.io/codsh/gallery.html">Gallery</a> ·
  <a href="https://www.npmjs.com/package/codsh-cli">npm</a> ·
  English | <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codsh-cli"><img src="https://img.shields.io/npm/v/codsh-cli.svg" alt="npm version"></a>
  <a href="https://github.com/Blackman99/codsh/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Blackman99/codsh.svg" alt="MIT license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-1f6feb" alt="dsh-plugin topic"></a>
  <a href="https://dshfind.com/en/plugins/Blackman99/codsh?ref=badge"><img src="https://dshfind.com/api/badge/Blackman99/codsh" alt="dshfind"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://cdn.rawgit.com/sindresorhus/awesome/d7305f38d29fed78fa85652e3a63e154dd8e8829/media/badge.svg" alt="Awesome"></a>
</p>

> npm: [`codsh-cli`](https://www.npmjs.com/package/codsh-cli) · command: `codsh`

**codsh** is an autonomous terminal coding agent for DeepSeek — and any OpenAI-compatible endpoint — built directly on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Not a fork.

Its flagship feature, **`/ship`**, turns a one-sentence idea into fully verified code through an autonomous 7-stage engineering pipeline, with a built-in live task flow panorama across terminal and browser.

Want to see what it builds? [Visit the gallery](https://blackman99.github.io/codsh/gallery.html) for real projects, screenshots, and playable results. Every project was built from a **one-sentence request**, with just **one round of interaction** and the **recommended answer selected for every question**.

## Install

```sh
npm install -g @deepseek-ai/dsh codsh-cli
export DEEPSEEK_API_KEY="your-api-key"
codsh
```

Common flags:
- `codsh -p "task"` — Run a non-interactive task directly
- `codsh --continue` — Continue the last session
- `codsh --resume <id>` — Resume a specific session
- `codsh update` — Update launcher and profile runtime

## Isolated Rust client (local candidates)

`codsh --rust` explicitly selects the parallel Rust client; plain `codsh` keeps
using the existing version. The Rust UI submits prompts over ACP/JSON-RPC to a
real `dsh --profile acp` process in the isolated Home. Streamed answers, provider
thoughts, empty replies, and failures are shown as dsh reports them; a protocol
mismatch or missing dsh is refused instead of faked as success. It reuses licensed
Grok Rust UI components, requires no official account, and does not start the
legacy Bundle, official agent core, update check, telemetry, or feedback upload.
Enter submits the draft through dsh when connected, or reports that execution is
unavailable without sending it. File read, write, and edit run through real dsh
tools. Allow/ask/deny rules, remembered project grants, and permission modes
(`ask`, `auto`, `always-approve`/`--yolo`, `dontAsk`, `acceptEdits`) are
enforced before a dsh tool runs. Explicit deny, hook blocks, and locked
always-approve survive `--always-approve` and old grants. Unsplittable shell
(`$(...)`, a parameter expansion such as `$x`, `${x}`, `$1`, `"$1"`, `$@`, or `$*`, control flow) is not glob-allowed as a unit; Read/Edit deny also
covers shell operands; wrappers such as `timeout`, `nice`, `ionice`,
`sudo`, `nohup`, `xargs`, and
`env FOO=1` peel to the inner command (only real duration/priority tokens are
consumed; `sudo -u` and `xargs -n` keep their option values), while `env -S` prompts. Read/Edit deny and ask follow in-path
symlink targets; an unresolved link prompts. Brace groups, quoted or
backslash-escaped command words, `eval`, and ANSI-C `bash -c $'…'` scripts
(including a backslash-newline) cannot hide a denied command. A leading word
that is not itself the denied command, such as `time /bin/rm`, `exec /bin/rm`,
or `builtin rm`, does not hide it either. A shell option that takes the next
word, such as `bash -o errexit -c`, is consumed before the script is read, so
the inner command is still denied. An unquoted `*`, `?`, or `[` in a command
word is not expanded: a pathname glob such as `./r*`, `./*m`, or `./r?` can
become `rm`, including behind `time`, `exec`, `builtin`, `command`, `sudo`, or
`bash -o errexit -c`, so always-approve does not run it. A path-qualified
executable such as `/bin/rm`, `./rm`, or `RM.EXE` is matched by its command
basename without regard to case, so `Bash(rm -rf *)` still denies it under
always-approve. `sort -o`, including attached `sort -oFILE` and a cluster
such as `sort -uoFILE`,
`--output`, and a unique prefix of `sort --compress-program`, are not
read-only. Frozen git inspection commands
(`cat-file`, `ls-tree`, `check-ignore`, `show-ref`, `for-each-ref`, `rev-list`,
`name-rev`, `count-objects`, `check-attr`) auto-allow; git writes do not,
including `git branch <name>`, `-f`/`--force`, `-u`/`--set-upstream-to`
(including the attached form `git branch -uorigin/main` and a bare `-u` or
`-t` with no operand), `git branch --track` and a unique prefix such as
`--tr` (a write even with no operand), unique
prefixes of `git branch --delete`/`--move`/`--copy`/`--force`,
`git diff`/`log`/`show`/`blame`/`rev-list --output`, and `git cat-file --filters`.
Claude rules load from `~/.claude` and walk up to the repo root. Always-approve
skips remembered grants and non-shell `ask`. A missing or corrupt policy file
refuses mutating tools instead of dropping deny. Remembered file grants are
path-scoped; `a` is not all-edits-forever. The UI shows the pending operation
and the dsh-supplied diff, then `y` allows that call once, `a` remembers it for
this project only, and `n` rejects it with no write. `/revoke-approvals` forgets
this project's remembered grants. Remembered grants are never described as a
permanent global rule; a failed save still allows once. Missing files, tool
errors, cancelled or duplicate approval replies are shown as failures, never as
success. `Ctrl+C` clears a non-empty draft without cancelling work; an empty
draft cancels the running turn through dsh `session/cancel`. Esc never cancels a
turn or a pending approval — it dismisses selection and reminds you to use
`Ctrl+C`. Cancelled tools cannot run from a late allow or process teardown; unknown
external results are shown as cancelled, not success. After cancel, the prompt
accepts a new turn. Idle empty `Ctrl+C` still quits before any turn exists.
`codsh --rust --continue` resumes the last dsh session in this directory;
`--resume <id-or-title>` loads that session. A UUID is always an id. A title matches every workspace, ignoring letter case; one manual `/rename` wins over auto-generated duplicates, and remaining duplicates list their ids. `codsh --rust sessions list` and `sessions search <query>` read the isolated dsh Home across workspaces, then apply `--limit`. Search labels a manual title as `title` and a generated title or conversation text as `content`. An empty result does not invent a session. `--fork-session` with `--resume`/`--continue`
copies that conversation into a new dsh session id. `/rewind` and `/undo` (or idle
empty Esc Esc) fork conversation-only history through dsh; `/fork` copies the
current history into a new session. Disk files are not restored; `--restore-code`
is refused. The UI restores persisted turns from the
dsh log (not a second store). Interrupted or never-finished tools show
`[interrupted]` / unknown and are not replayed. A second client that cannot
take write ownership is refused instead of forking a duplicate executor.
Default fullscreen uses the alternate screen. `/minimal` (or `--minimal`)
switches to native terminal history through the official inline renderer;
`/fullscreen` (alias `/full`) switches back. `/rewind` and `/fork` in minimal
replace that native buffer instead of appending discarded turns. Official `xai-grok-markdown` renders streamed Markdown, tables, code, mermaid labels, thoughts, and dsh tool cards/diffs, and the session keeps those heading, code, table, and diff colors. Pretty mode matches official markdown, so `Vec<T>`, comparisons, fenced Rust, and inline HTML tags stay visible, and it keeps ZWJ emoji in one cell; a failed tool paints `failed` and `[error]` in a failure color instead of success. Esc closes full content and restores the folded transcript. Long bodies fold; Tab then `l`/`→` expands, `r` toggles raw markdown, Enter opens full content, and `y` copies original bytes. `/expand` reprints the last folded block in minimal; `/transcript` (`/log`) opens the exact transcript in `$PAGER`. The switch stays in process, so a
running dsh turn, draft, and pending approval survive. `--minimal` /
`--fullscreen` and `GROK_SCREEN_MODE` are session-scoped and do not rewrite
isolated `[ui] screen_mode`. `/dashboard` (aliases `/agents-dashboard`, `/sessions`) and `codsh --rust dashboard` with `GROK_OPEN_DASHBOARD_AT_STARTUP=1` open the agent dashboard in fullscreen. It lists the same session id, title, activity, and unread mark as `/resume` and `sessions list`. `Ctrl+/` filters, `Ctrl+R` renames the selected row, `Ctrl+T` pins it, and `Ctrl+G` toggles state versus directory grouping. Minimal mode refuses the dashboard and tells you to run `/fullscreen`. `/resume` opens the session picker; typing filters titles and then conversation content under `Extended search results`. Selecting a session resumes that dsh id and does not copy the previous session's output into it. A selection whose directory does not match, or whose write lock is already held, stays on the session this client already owns and shows `occupied`. A same-directory resume that dsh refuses as already active does not close the live session; the open picker or dashboard shows `already active` and stays open. `/rename <title>` (alias `/title <title>`) stores a manual title that automatic generation never overrides. `/rename --auto` and bare `/title` hand the title back to the configured model (`base_url`, model id, and credential). The prompt is sent only to that provider; it is not written into the notice, the URL, or a debug log. A missing model or credential is an error, not a fallback title. `/new` starts a new dsh session. `/clear` clears only the visible transcript. `/session-info` (alias `/info`) shows the title, id, directory, model, and activity. `/cd [path]` sets the directory for the next new agent and leaves the current session's history where it is. A missing path, Escape, or cancel keeps the previous directory. A second client that cannot take the write lock is shown as occupied and does not mutate the other history. Mode-only commands such as `/dashboard` in
minimal refuse with the fullscreen remedy. Fullscreen `Tab` focuses the
scrollback when a turn exists; `/find [text]` searches it, `/jump` previews turns, and Esc on
those overlays restores the prior reading position without editing the draft.
A click folds or selects; a drag copies and does not fold. Selection survives
streaming and resize by turn identity. `/vim-mode` toggles
scrollback Vim keys and writes `[ui] vim_mode` without changing `ui.simple_mode`.
With `[ui] mouse_reporting_toggle` (or `GROK_MOUSE_REPORTING_TOGGLE`) enabled,
scrollback `Ctrl+R` or `/toggle-mouse-reporting` flips mouse capture; quit
always disables reporting. `GROK_SCREEN_MODE_SWITCH=exec`
relaunches onto the same session instead of switching in place and does not
preserve an unsaved draft. Typing `/` in a nonempty draft stashes that draft so
the slash command can run, then restores it. Prompt editing reuses the official textarea: Enter
submits, Shift+Enter or Alt+Enter inserts a newline, and `/multiline` (alias
`/ml`, or Ctrl+M when the terminal distinguishes it from Enter) swaps those
chords. `/history` fuzzy-searches submitted prompts; empty ↑/↓ browses them
without sending. Tab completes `/` commands and, in `!` shell mode, HISTFILE
entries; Esc cancels completion and restores the previous draft. `/edit-prompt`
opens `$VISUAL`, then `$EDITOR`, then `vi` for an empty draft; Ctrl+G in
minimal preserves the current text. Saving replaces only the composer; an empty
file clears it and does not submit. `[ui] simple_mode = false` enables prompt
Vim (`i`/`Esc`/`h`/`l`/`x`) independently of `/vim-mode` scrollback keys.
Next-prompt ghost text is not wired: the host passes no suggestion after a
turn, so Tab and Right do not accept ghost text. Suggestion rows stay blocked
(`PARITY-150-suggestions` remains unverified). `@` opens a workspace file
picker. It hides dotfiles and `.gitignore` matches, including nested
`.gitignore` files, `**` patterns such as `**/*.log`, and patterns that
contain `/` (`logs/*.log`, `/secret.rs`, anchored at the directory that
owns that `.gitignore`), until the query
starts with `!`. Enter or Tab attaches
the selected file as a chip. `:10-50` keeps that line range, `:2` keeps that
single line, and a path with spaces uses `@"my file.rs"`. Pasting a workspace
path drops it in, except a dotfile or `.gitignore` match, which stays text
and is not read. Pasted prose that merely names a path stays text. Backspace
on the chip removes it, and Ctrl+Z restores it. Enter while a turn is running
queues the draft and its chips; Alt+Up puts the oldest queued prompt back
into an empty composer. Submit reads the file then: a removed chip is not
sent, and a missing file, a file over 256 KiB, a permission failure, or a
change since preview stays in the composer with an explicit notice and no
file bytes. The admitted text is what dsh and the model receive. Resume shows
the same `@path` mention.
`chips=false` only means the current draft has no attachment. Unicode, large paste, and resize keep an unsent draft. A refused
submit, including first-run with no provider, puts that draft back and still
shows `Execution unavailable` on a narrow screen. Failed
editors keep the draft. `/edit-prompt` opens an empty composer; Ctrl+G in
minimal preserves the current draft. HISTFILE Tab completes with
`GROK_SUGGESTIONS` off; as-you-type completion requires `GROK_SUGGESTIONS=true`.
`GROK_SUGGESTIONS_AI` is not a live AI gate here.

`/voice` starts dictation into the current draft. It does not record at startup
and it does not submit the transcript; Enter still sends. A second `/voice`,
`/voice stop`, or Esc stops or cancels. A slash command typed while recording
parks the draft and puts that same text back when the command finishes or Esc
cancels completion. One Esc while that completion is open leaves the recording
and restores the parked draft; it does not leave the overlay open or replace
the draft with `/`. A late transcript
is dropped only when the draft text itself changed. Ctrl+Space and F8 follow `[ui] voice_capture_mode` (`hold` or
`toggle`) only when `[ui] voice_keybind_enabled` is true. `/voice` still works
when the chords are off. Hold-to-talk needs a terminal that reports key
release; otherwise the client refuses the chord and tells you to use `/voice`
or toggle. `[ui] voice_stt_language` overrides `[voice] language` on the
substitute request (`auto` omits the language field). Audio is posted only to
`[voice] api_base`, or `[endpoints] xai_api_base_url` when that is unset, at
`/audio/transcriptions`. Official `api.x.ai` / `grok.com` hosts are refused.
The bearer token is the named `[voice] env_key` (default `XAI_API_KEY`) and is
not an official-account login. `/voice doctor` and `codsh --rust voice doctor`
(`--json`) list input devices and do not open the microphone. No device is
`voice.no-input-device`. A macOS permission denial that arrives as silence is
not detected by that listing. Opening the live microphone from this process is
unverified; `CODSH_VOICE_FIXTURE` is the supported recording path into a
substitute service. Linux and Windows capture are unverified and are not
reported as working. `GROK_VOICE_MODE` turns the feature off. `GROK_VOICE_CAPTURE`
selects `inprocess` (default) or `helper`; helper without a fixture is refused.

User configuration for the preview is `$GROK_HOME/config.toml` (default
`~/.codsh-rust/.grok/config.toml`). `[ui] theme`, compact mode, timestamps,
status line, `confirm_before_rewind`, and `ui.fork_secondary_model` are stored
in that same file. Compatible `[model.<id>]` fields
(`base_url`, `env_key`, `api_key`, `model`, `name`, `api_backend`,
`supports_reasoning_effort`, `reasoning_efforts`, `reasoning_effort`,
`context_window`) plus `models.default` / `models.default_reasoning_effort`
map into isolated dsh `settings.yaml`; the two files are not competing sources.
Supported backends are Grok `chat_completions`, `responses`, and `messages`
(mapped to dsh `openai-completions`, `openai-responses`, `anthropic-messages`).
The same model id on two backends is two catalog entries, not one capability.
`/model` (alias `/m`) and `/effort`, plus `--model` and `--effort` /
`--reasoning-effort`, select advertised options only. Unsupported backends or
effort levels are refused or shown unavailable; there is no silent provider
fallback. Runtime changes apply to the next turn and persist in
`$GROK_HOME/model-selection.toml`. Usage, cost, and context limits stay
unknown unless the provider or an explicit `context_window` supplies them.
dsh context occupancy is labeled `occupancy=N (dsh estimate)` and is not
treated as provider usage. `/context` shows those dsh facts plus heuristic
system/tools/messages buckets when available; missing values stay unknown and
are never printed as zero. Switching `/model` uses that model's advertised
`context_window`. `/compact [instruction]` runs dsh compaction (progress,
summary, failure, and cancel) instead of a second history store; optional
instructions are sent only on the summarizer request (`purpose=compaction`)
and the destination provider/model is recorded. Automatic compaction maps
`session.auto_compact_threshold_percent` / `GROK_AUTO_COMPACT_THRESHOLD_PERCENT`
into dsh `thresholdRatio` plus a compatible `retainRatio` (values outside
0–100 are ignored; `0` disables auto-compact rather than writing an invalid
ratio that would fail plugin load).
`GROK_COMPACTION_WALL_CLOCK_SECS` bounds the operation; `0` disables that
budget. After compact, resume projects the dsh checkpoint plus retained
tools/todos; a failed compact leaves the original records in the log.
Nonessential telemetry, trace upload, session tracking, and content sharing
default off. Turning `[features] telemetry`, `feedback`, or `trace_upload` on
does nothing until `endpoints.telemetry_url`, `endpoints.feedback_base_url`, or
`endpoints.trace_upload_url` names a substitute. Official `grok.com`,
`api.x.ai`, and Sentry hosts are refused by parsed hostname, not by a substring
in the path or query; only `http` and `https` are accepted. `privacy.share_content`
defaults off and redacts feedback title, details, and area on submit.
`privacy.share_session` adds only the session id to an enabled trace upload.
`codsh --rust feedback` and `/feedback` keep drafts under the isolated dsh Home
(`feedback_drafts.json`) until an explicit send. `/feedback` opens Write and
Drafts (Enter sends, Ctrl+S saves, Escape closes, Drafts can edit, retry, and
delete). `/feedback <text>` sends immediately. A failed submit keeps the draft.
The posted body uses schema 1 `structured_feedback` (`type`, optional
`task_category` and `failure_mode`); `GROK_USER_METADATA` cannot replace that
key. `feedback preview` states the redaction boundary: diagnostics
carry kind, ok, and count only, never prompts, answers, keys, or paths. Model
calls stay on the configured provider `base_url` and are not telemetry. Locked
`requirements.toml` can force these switches off. `GROK_DEBUG_LOG=1` appends
the same counters to `$DSH_HOME/privacy.log` and does not upload them.
`GROK_LOG_FILE` and `GROK_HOOKS_LOG` are not wired: the launcher does not pass
them through, and no Rust path reads them. They do not create a log or change
what is uploaded.
`codsh --rust inspect` and `inspect --json` print each effective value and
origin (CLI `--model`/`--effort`, environment, `GROK_CONFIG` overlay, workspace
`.grok/config.toml`, saved selection, user `config.toml`, `managed_config.toml`,
locked `requirements.toml`, default), including `ui.theme`, compact mode,
timestamps, `[ui.status_line]`, and the privacy switches above. `/settings` (`/config`) edits those live
controls; `/theme` (`/t`) previews fullscreen themes and Escape restores without
saving. Minimal mode uses the terminal palette and refuses `/theme`. A
status-line command times out at 10s, clears `BASH_ENV`/`ENV`, and kills leftover
process groups on exit. Invalid `config.toml` is left unchanged
and the error names the path. Locked requirements cannot be bypassed by later
CLI, environment, overlay, workspace, or user values. Unknown security fields
and invalid policies are diagnosed with valid keys, sources, and limits rather
than ignored. Untrusted workspaces prompt before applying project config, Hooks,
plugins, or instructions; `--trust` / `--trust-folder [path]` saves a grant to
`$GROK_HOME/trusted_folders.toml`, `--revoke-trust` withdraws it, and a
read-only Home reports save failure without claiming a durable grant. Untrusted
Hooks, plugins, and project capabilities do not execute.
`codsh --rust plugin marketplace add|list|update|remove` manages local git/path
catalogs. `plugin install|update|uninstall|list` copies plugin files into the
isolated Home with version, source, and license provenance. Install requires
`--trust` and still does not grant execution; enablement is a later ticket.
Failed download, checksum, conflict, offline, or cancel leaves no success
record. `GROK_MARKETPLACE_REQUIRE_SHA` / `[marketplace] require_sha` also
refuse unpinned remote updates and leave the previous install. Official marketplace auto-register stays off unless
`GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER` is enabled. Each marketplace plugin
installs into its own directory; git updates record the clone HEAD. Managed
`extra_known_marketplaces` pins are first-pin-wins sources. A present
`strict_known_marketplaces` list binds catalog load, named install, the
catalog entry's clone URL, and later git update: unlisted git sources are
dropped, local paths are refused unless an admin pin names that path, and an
empty or malformed list refuses every add and install. A later user or
workspace list cannot widen an earlier lockdown. URL comparison folds scheme
and host only, including GitHub, and strips one trailing `.git`. The repository
path stays case-sensitive, so `ACME/Plugins` and `acme/plugins` are different
sources.
`/plugins` and
`/marketplace` open the plugins directory. Uninstall does not
delete unrelated user files. User and project plugin scopes stay separate. First-run missing
credentials stay local: no grok.com login, no default
official telemetry/upload, and no automatic import of `~/.dsh` or `~/.grok` credentials.
`codsh --rust import --preview` (and `import --json`) lists conversions, conflicts,
and unsupported items from current dsh `$DSH_HOME/settings.yaml` (`llm-pi-ai`
providers, `llm-deepseek`, `agent-default-model`), `$DSH_HOME/code-cli-thinking.json`,
and `$DSH_HOME/code-cli-ui.json`. `density` `compact`/`comfortable` maps to
isolated `[ui] compact_mode`; `bell`, `notify`, and bang limits from
`coding-cli-runner` are listed as unsupported because the new client has no
equivalent control. A route with several models imports the model named by
`agent-default-model`; other models stay in the preview. An inline `apiKey` is
never copied, a missing `apiKeyEnv` is unsupported rather than replaced with
`XAI_API_KEY`, and `headers` / `compat` are listed as unsupported. Existing
nested settings such as `[ui.status_line]` are kept. It does not treat outdated `code-cli-settings.json`
as a provider source. `import --apply` copies selected providers and preferences
into `~/.codsh-rust/.grok/config.toml`. Official tokens, `.credentials.yaml`, `.env`,
and original trust/execution grants are never copied. Preview, cancel, and a failed
apply leave source files and existing isolated settings unchanged. Model credentials
must already be exported (`--authorize-env`) or set after import. Plain `codsh` still
reads the original Home. `codsh --rust login` / `logout` / `setup` (and `/login` `/logout`) talk only to
configured substitute identity or management services. Independent API-key use
does not require login unless `GROK_DISABLE_API_KEY_AUTH` or a team pin
(`GROK_FORCE_LOGIN_TEAM_ID` / `auth.force_login_team_uuid` / top-level
`force_login_team_uuid` in locked `requirements.toml`) requires a matching identity session. Startup and inspect refresh an expired `auth.json` or clear it when refresh fails, so a team pin alone does not keep a stale session ready. A cleared unrefreshable token does not block `login` or an otherwise valid API key. A successful `/login` reloads that session and reapplies settings. It replaces dsh when the credential env, readiness, or settings patch changed, and connects in the same step when no live client remains. A settings write error keeps the existing connection and reports the failure. The replacement dsh process receives the identity session (`GROK_AUTH_PATH`, `GROK_AUTH_ACCESS_TOKEN`, and `GROK_AUTH_PROVIDER_COMMAND` when configured). Other parent `GROK_AUTH_*` variables are not forwarded. `/logout` revokes that session at `GROK_AUTH_REVOKE_URL` or the issuer `revocation_endpoint` before clearing `auth.json`; a revocation failure keeps the file so login can recover, and drops the connection that was using the session. Session tokens live in `$GROK_HOME/auth.json` with
owner-only permissions and are not transferred to model providers, MCP, Grove,
or other services. Official grok.com / auth.x.ai login, subscription billing,
auto-topup, and team entitlements are not reproduced. `GROK_MANAGED_CONFIG_URL`
fetches organization policy only when a substitute pubkey can verify it and
the signature names this caller. A deployment key is itself a caller principal,
including when the response omits `deployment_id` and the session has no team.
A signature for another principal, a signed payload that omits both deployment
and team, the same mismatch already on disk, and fail-closed policy with no
pubkey and no sidecar are refused.
Set the model's `env_key` (for example `XAI_API_KEY`) after writing a provider
with a `base_url`. An empty Enter on first-run reloads that file and connects
when a provider is ready, without submitting a prompt. Inherited parent
`GROK_HOME` is ignored; the preview pins `GROK_HOME` to `~/.codsh-rust/.grok`.

The preview uses `~/.codsh-rust/dsh` and Profile `rust`, ignores inherited
`DSH_HOME` and Grok settings files, and never migrates legacy sessions.
Configured `env_key` values such as `XAI_API_KEY` (and other `*_API_KEY`
variables) are passed through to dsh; `~/.dsh` and `~/.grok` credential files
are not imported automatically. Use `codsh --rust import` for an explicit, reversible copy. A symlinked preview Home/Profile or overlap with `DSH_HOME`/`GROK_HOME`
is refused before writes, including differently cased aliases on case-insensitive
filesystems. Overlap checks compare device/inode ancestry, including existing
ancestors of missing paths, so macOS firmlink aliases cannot hide behind different
realpath strings. Separate Homes reached through those aliases remain supported.
Unavailable directory identity fails closed before writes.
If either Home is missing, a case-only potential overlap is refused
conservatively on every platform, without creating paths to test filesystem rules.
Any missing path component containing non-ASCII characters is also refused before
writes, even for a separate Home: Unicode lowercase/normalization is not a reliable
filesystem-identity test. Use an existing separate Unicode directory or a path with
only ASCII missing components. Existing Unicode ancestors and separate Homes still
use native filesystem resolution; missing ASCII children beneath them are supported.
Unresolved symlinks in explicit or default legacy Home paths are also refused
before writes; repair dangling links or symlink cycles before launching the preview.
Resolvable links to separate legacy Homes remain supported. Isolation checks follow
released dsh rules for `DSH_HOME`: blank means unset; `~`, `~/` and `~\` expand to
the OS Home, then relative paths and `..` normalize lexically. Nonempty `GROK_HOME`
is literal (no tilde expansion or whitespace trimming). The preview conservatively
refuses **any `..` component in `GROK_HOME`**, even for a separate existing Home,
rather than guessing symlink traversal. Use a path without parent traversal.
Default `~/.dsh` and `~/.grok` are protected even when overrides are set.
`Ctrl+Q` quits. `Ctrl+D` quits except in fullscreen scrollback, where it
half-pages. `Ctrl+C` clears a draft, cancels an empty running turn,
or quits when idle before any turn. `--continue` and `--resume <id>` restore
the same dsh session; `--fork-session` copies conversation into a new id;
`/rewind` does not restore files. A second writer is refused. `--minimal` and `--fullscreen`
select the session render mode. Unsupported
arguments fail explicitly. `codsh --rust --help` describes this path. Mock-model
tests inject the fixture at the dsh provider boundary (`CODSH_ACP_PATCH` /
`DSH_CODE_CLI_MOCK_TOOL`); the Rust client and dsh remain real products.

Maintainers stage a native candidate with `pnpm run build:rust`, then locally
pack/install `packages/cli`; the npm entry includes the prebuilt native artifact
and notices, so candidate users do not compile Rust. A package without a native
artifact reports an actionable error, never falls back silently. No published
release or default cutover is implied. See [Contributing](CONTRIBUTING.md) for
build, installed-product verification, and platform limitations.

## `/ship`: One Sentence to Verified Code

```sh
/ship let long diffs open in a pager instead of scrolling past
```

`/ship` automates the complete engineering workflow from idea to delivery:

1. **Pre-flight** — Checks git working tree state and creates an isolated `ship/<slug>` branch.
2. **Wayfinder** — Clarifies core goals, constraints, and trade-offs.
3. **Grill** — Interactive design interview with smart, recommended defaults.
4. **Spec (Gate 1)** — Formulates user stories, public seams, and explicit Out of Scope boundaries.
5. **Tickets (Gate 2)** — Decomposes work into vertical slices structured as an explicit dependency DAG.
6. **Landing** — Dispatches tickets into parallel Git worktrees for TDD implementation and continuous integration.
7. **Done** — Verifies acceptance criteria, ensures zero repo regressions, and merges back cleanly.

### Live Task Flow Panorama
- **Live TTY Teaser**: Pinned status row showing real-time ticket counts (`待认领 n · 已认领 n · 已关闭 n`), in-flight parallel landing worktrees, and the Web flowchart URL.
- **ASCII DAG Overlay (`Ctrl+G`)**: Instant fullscreen terminal visualization of task dependencies and claim states.
- **Local Web Flowchart**: Interactive React Flow map (`127.0.0.1:<port>`) with decision context, recorded Q&As, and landing tickets.

### Autonomous Resilience
- **Automated Conflict Resolution**: Git merge conflicts (including lockfiles and renames) are autonomously resolved by agent sub-tasks with validation retries.
- **Pause & Resume**: `Ctrl+C` safely pauses coordination; running a bare `/ship` resumes unfinished work from where it left off.

## The surface

Designed for high-efficiency, keyboard-driven terminal development:

- **Clean Terminal UI**: Full-screen alternate buffer; input stays pinned at the bottom; restores your shell cleanly on exit.
- **Foldable Reasoning**: Streaming thoughts collapse into a single line (`Ctrl+O` or click to expand/collapse).
- **Subagent Matrix**: Background and parallel subagents run in isolated views (`Ctrl+H` to list, click/enter to inspect, `Esc` to return).
- **Timeline Navigation**: Jump between dialogue turns (`Shift+←/→`, `/jump`) or branch off from an earlier turn (`/rewind`).
- **Shortcuts & Controls**:
  - `Shift+Tab`: Toggle plan mode
  - `Ctrl+Q`: Queue input while the agent is running
  - `Ctrl+C`: Interrupt current execution
  - `Ctrl+V`: Paste images directly from clipboard
  - `/view`, `/diff`, `/copy`: Inspect files, uncommitted changes, or code blocks in a dedicated pager

## Third-party endpoints

Connect to any OpenAI-compatible gateway in `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`):

```yaml
llm-pi-ai:
  providers:
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.acme.example/v1
      compat:
        thinkingFormat: deepseek
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: acme-large
          contextWindow: 65536
          maxTokens: 4096
```

Switch and persist default model:
```sh
/model acme-gateway/acme-large
```

API keys resolve in order: specified environment variable → `$DSH_HOME/.credentials.yaml` → `<cwd>/.env` → `$DSH_HOME/.env`.

## How it works

`codsh` is a zero-dependency launcher that finds your local `dsh`, registers [`codsh-bundle`](https://www.npmjs.com/package/codsh-bundle) into a `code` profile, and boots `dsh --profile code`.

To run directly via dsh:
```sh
dsh plugin --profile code add codsh-bundle
dsh --profile code
```

## Terminals

| Tier | Terminals | Support Level |
|---|---|---|
| First-class | iTerm2, Terminal.app, VS Code, tmux, Windows Terminal + WSL | Release-blocking compatibility |
| Second-class | Ghostty, kitty, Alacritty, Warp | Fully supported; regressions handled as bugs |
| Best-effort | Native Windows (pwsh) | Basic TTY support; persistent PTY unavailable |

Supports Kitty keyboard protocol, focus reporting, OSC 11 color detection, and terminal image rendering where available.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
pnpm run dev          # Start local development surface
pnpm test             # Run unit tests
pnpm run typecheck    # TypeScript typecheck
pnpm run test:e2e     # Run E2E tests
```

## Feedback

Bugs, feature requests, or migrating from Claude Code / Cursor? Open an [issue](https://github.com/Blackman99/codsh/issues) or join the [Discussions](https://github.com/Blackman99/codsh/discussions).

## License

[MIT](LICENSE)
