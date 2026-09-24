# codsh

A terminal coding agent composed on the dsh plugin runtime, whose interaction
design deliberately aligns with the best of today's agent CLIs.

## Parallel rewrite boundary

The language and interaction rules below describe the legacy Launcher/Bundle.
For the separately developed Rust/dsh path, [ADR-0002](docs/adr/0002-frozen-grok-rewrite-reference.md)
selects frozen Grok 1.0.34 behavior instead of Claude-first arbitration and
allows minimal native scrollback alongside fullscreen. It does not change the
legacy Viewport, keybindings, data or tests. The itemized reference register
lives under `docs/rewrite/reference/`; declarations are not parity evidence.

`codsh --rust` is the explicit parallel Rust client. Its locally packed native
client reuses licensed upstream Rust input, welcome layout, and the official
fullscreen/minimal renderers, and submits prompts to released dsh over
ACP/JSON-RPC (`dsh --profile acp`) in the isolated Home. `codsh --rust agent stdio`
exposes that same session to an editor: standard new/load/prompt/config/approval/cancel
are real, `session/load` is dsh resume plus read-only replay (a denied nested
tool result stays failed), model and reasoning changes persist before the next
prompt and are restored on resume even when the advertised model is not a
catalog id, and unadvertised
`x.ai/*` methods return method-not-found. Closing the editor releases the write
owner. dsh remains the only
executing agent core and durable session owner; the Rust process does not link
the official agent runtime or own tools. Protocol mismatch, empty answers,
mid-stream failure, disconnect, and cancellation are reported truthfully.
`Ctrl+C` clears a draft first; an empty draft cancels the running dsh turn. Esc
does not cancel. `--continue` / `--resume <id>` restore the same dsh session and, in both
fullscreen and minimal, keep `[interrupted]`, `[cancelled]`, `[empty answer]`,
and the compaction sentence on the transcript; a finished unknown tool is not
inferred to be interrupted;
`--fork-session`, `/fork`, and `/rewind` copy conversation through dsh
seed/projection without restoring files or replaying tools. A second write
owner is refused. `/minimal` and `/fullscreen` switch render mode
in process: fullscreen uses the alternate screen, minimal writes committed
history to the native terminal buffer, `/rewind` and `/fork` replace that
native buffer instead of appending discarded turns. Official `xai-grok-markdown` renders Markdown, tables, code, mermaid labels, thoughts, and dsh tool cards/diffs, and the session keeps those colors. Pretty paint matches official markdown, so `Vec<T>`, comparisons, fenced Rust, and inline HTML tags stay, keeps a ZWJ cluster in one cell, and shows `failed` plus `[error]` in a failure color. Esc closes full content without leaving the expanded tail on the folded transcript. Tab then `l`/`r`/Enter/`y` fold, expand, show raw markdown, open full content, or copy original bytes. `/expand` reprints the last folded block in minimal; `/transcript` opens the exact transcript in `$PAGER`. Display fold state does not rewrite model history or copied bytes. And the active session,
draft, running turn, and pending approval survive. `--minimal` / `--fullscreen` and
`GROK_SCREEN_MODE` are session-scoped and do not rewrite isolated
`[ui] screen_mode`. Fullscreen `/find`, `/jump`, click-vs-drag selection, Vim
scrollback keys, and mouse-capture toggle follow the frozen Grok contracts;
minimal refuses overlays that do not exist there. `Ctrl+Q` quits. `Ctrl+D`
quits except in fullscreen scrollback, where it half-pages. Prompt editing stays on the official textarea rather than a
second input model: typing `/` in a nonempty draft stashes that draft so the
slash command can run, then restores it. Slash completion starts
from an empty `/`, multiline chords, history search, slash/HISTFILE completion,
prompt Vim (`[ui] simple_mode=false`), paste, and `$VISUAL`/`$EDITOR`/`vi`
round-trips submit the resulting text through dsh. An unsent draft survives
resize. A submit that does not start a turn, including first-run with no
provider, puts the cleared draft back. A narrow screen still shows
`Execution unavailable` beside that draft. `/edit-prompt` requires an
empty composer. Next-prompt AI ghost text is not wired: the host passes no
suggestion, so Tab and Right do not accept ghost text. Suggestion rows stay
blocked. `@` attaches a workspace file. Dotfiles and `.gitignore` matches,
including nested `.gitignore` files, `**` patterns such as `**/*.log`, and
patterns that contain `/` (`logs/*.log`, `/secret.rs`, anchored at the
directory that owns that `.gitignore`),
stay hidden until the query starts with
`!`. A chip can name one line, a line range, or a quoted path with spaces.
Pasting a workspace path is a drop, except a dotfile or `.gitignore` match,
which stays text and is not read. Pasted prose that names a path stays text.
Backspace removes that chip and Ctrl+Z puts it back. Enter during a turn
queues the draft and its chips; Alt+Up restores the oldest queued prompt into
an empty composer. Submit reads the file at that moment. A removed chip is
not sent. A missing file, a file over 256 KiB, a permission failure, or a
change since preview stays in the composer and does not send bytes. dsh
receives the admitted text, and resume shows the same
`@path` mention. `chips=false` means this draft has no attachment. The isolated Home is `~/.codsh-rust/dsh`, Profile `rust`;
inherited legacy configuration/credential files are not imported automatically.
`codsh --rust import --preview` / `--apply` copies selected current dsh
providers and preferences from `$DSH_HOME/settings.yaml`,
`code-cli-thinking.json`, and `code-cli-ui.json` into the isolated Home; it
maps `code-cli-ui.json` density `compact`/`comfortable` to `[ui] compact_mode`
and lists `coding-cli-runner` bell/notify/bang preferences as unsupported.
A multi-model route imports the `agent-default-model` selection; inline `apiKey`
values, missing `apiKeyEnv`, and `headers`/`compat` stay out of the isolated
file. Existing nested settings are preserved. It does not treat outdated `code-cli-settings.json` as a provider source and never
copies tokens, credential files, or original trust/execution grants. Configured
`env_key` values are passed through. Nonessential telemetry, trace upload,
session tracking, and content sharing default off. Opt-in uploads require a
substitute `endpoints.telemetry_url`, `endpoints.feedback_base_url`, or
`endpoints.trace_upload_url`; official grok.com, api.x.ai, and Sentry hosts are
refused by parsed hostname. `/feedback` opens the same Write/Drafts form in
every screen mode; Enter sends, `/feedback <text>` sends immediately, and a
failed submit keeps the draft for edit or delete. Draft text is included only
when `privacy.share_content` is on. `privacy.share_session` attaches the session
id to an enabled trace upload and nothing else. `export` writes one session's
stored transcript as Markdown and does not claim redaction; an extra argument
is rejected before a file is created. A symlink at the sessions root, a
project directory, a session directory, or the log file is not read, so
export and share stay inside the real sessions tree. `share` posts that transcript only to
the explicitly selected substitute over http or https. HTTPS uses the same native-tls
connector as other substitute calls, plus a configured `GROK_EXTRA_CA_BUNDLE` or
`SSL_CERT_FILE` root; an untrusted certificate uploads nothing. It does not follow a redirect. Session
deletion is blocked: released dsh persistence has create, open, flush, stat,
and list, and no deletion operation, so CLI delete, `/delete`, the resume
picker, and the dashboard remove nothing. The picker says that asking to
delete is blocked. `du` reports isolated-home sizes
and deletes nothing. Diagnostic previews and
`GROK_DEBUG_LOG` contain kind/ok/count only. `GROK_LOG_FILE` and
`GROK_HOOKS_LOG` are unwired: the launcher does not pass them, and no Rust
path reads them. Web search and fetch stay off until `$GROK_HOME/config.toml`
names a substitute. Search and fetch are separate. Search calls
`[models] web_search`. `protocol = "responses"` is one OpenAI Responses
request and needs a credential. `protocol = "searxng"` is a keyless GET of
`{base}/search?q=...&format=json`; result URLs are filtered by the configured
domain policy and a model argument cannot widen it. Fetch is a public HTTP read, optionally through
an `http` CONNECT `toolset.web_fetch.proxy_endpoint`. Official hosts are refused.
Domain policy, including an empty fetch allowlist and a path or port on an
allow entry, loads at startup and is checked again on every redirect. A name
with any private address is refused, and the connection uses an approved
address. A disabled side is not registered. Enabled `web_search` and
`web_fetch` are dsh tools and call the configured substitute. Failures do
not invent page text. Cancellation closes the request and drops a late body.
Search citations and fetch status, content type, the page, and truncation
travel as fields. The page is not scraped back out of the CLI text. Model provider traffic is not
telemetry. Requirements pins can force `web_fetch` and `models.web_search`
off. Managed values for those keys are user-overridable, not locks.
User settings enter through `$GROK_HOME/config.toml` and `codsh --rust inspect`;
`[ui] theme`, `auto_dark_theme`, `auto_light_theme`, `compact_mode`,
`show_timestamps`, `screen_mode`, `confirm_before_rewind`,
`ui.fork_secondary_model`, and `[ui.status_line]` use that same file.
`/settings` (`/config`) edits those live appearance and status-line controls;
`/theme` (`/t`) previews fullscreen themes and Escape restores without saving.
Minimal mode uses the terminal palette and refuses `/theme`. Status-line
scripts time out at 10s, clear `BASH_ENV`/`ENV`, and kill leftover process
groups on exit. Locked requirements show their source and cannot be edited.
applicable model/provider fields, including `provider`, `api_backend`, and
reasoning effort, are translated into isolated dsh `settings.yaml` rather than
competing with it. `provider` defaults to the catalog id. Entries that share a
provider and the same key, backend, URL, and headers are one provider with
several models. A reused provider with different credentials or a different
backend is refused, not written as a second YAML key. `/model` and `/effort` change only advertised catalog options; unknown
backends and efforts are refused, never treated as equivalent or silently
swapped. Usage and context stay unknown unless the provider or config actually
supplies them. `/context` and `/compact` are dsh-backed: occupancy is a dsh
estimate, advertised limits follow the selected model's `context_window`, and
compaction mutates the dsh session log rather than a second history. Optional
`/compact` instructions travel only on the summarizer call (`purpose=compaction`)
with a recorded destination. Automatic thresholds and pruning map into dsh
`thresholdRatio` with a compatible `retainRatio` / tool-result pruner
settings; percents that would fail dsh plugin load (`retainRatio >=
thresholdRatio`, including `0`) are warned and remapped; unsupported
Grok-only prune ages stay warnings, not silent no-ops. Managed defaults live in
`$GROK_HOME/managed_config.toml`; `$GROK_HOME/requirements.toml` locks values so
later CLI, environment, overlay, workspace, or user layers cannot bypass them.
Unknown security fields fail closed with diagnostics. Workspace trust is stored
in `$GROK_HOME/trusted_folders.toml`; untrusted project Hooks/plugins/instructions
stay inactive until `--trust` or an interactive grant. The same decision gates
`.grok/sandbox.toml`: naming a custom profile does not trust that file, a
project-only definition refuses startup while the workspace is untrusted, and
a user `$GROK_HOME/sandbox.toml` definition stays usable and still wins. The
untrusted project body is not applied; a malformed, unreadable, or symlinked
untrusted project file does not veto that user definition. A trusted malformed
project file still refuses startup. `devbox` skips only the global
hook/config/trust write protection; a profile extending it keeps its `deny`
list. Deny paths and glob literal prefixes are resolved to the paths Seatbelt
checks, and one that cannot be resolved or expressed refuses startup.
`inspect` does not apply the profile: it reports the resolved name and every
config error. A session launch still refuses a profile the kernel cannot apply. dsh's per-call
Seatbelt cannot nest inside a profile, so while one is applied codsh starts
dsh with its per-call file mode at `danger-full-access` and unchanged
approvals; the kernel policy confines bash children and child agents. A deny
glob's literal prefix is pinned against rename, and so is a directory inside
the glob tail (including one created after launch), because Seatbelt matches
the resolved path. The ancestor walk stops at the resolved write root, so a
workspace under `/tmp` does not pin `/tmp` itself. The launchd escape is
kernel-blocked, matching the reference `mach-lookup` rules. `restrict_network`
is a kernel network deny on macOS (`(deny network*)` for this process and its
children), not a dsh file mode. Linux Landlock network and Windows confinement
are different mechanisms: a profile that asks for network isolation refuses
startup on a platform that cannot apply it. `[shell_environment_policy]`
filters the environment of a shell child this client starts and of the dsh
process. dsh's bash tool is built from that process environment, so it sees
the same filter; a second Seatbelt profile is still not applied inside the
first. The acp profile's persistent terminal tools are not mounted: a patch
cannot add a plugin the profile does not already depend on, so an interactive
terminal session is unavailable. Window resize is not a dsh tool. A one-shot
bash command shows stdout, stderr, and the exit code, including 0. Ctrl+C
cancels it; dsh reports that as an aborted tool, not as success.
 After trust, compatible
rules, skills, agent definitions, and custom commands are discovered in the
frozen order (closer skill directories outrank broader ones; nested
`SKILL.md` files return only when the walk depth is greater than five, and a
child of a directory that already has `SKILL.md` is still recorded; a
configured `[skills] paths` directory is depth 0, so its children start at
depth 1 and a sixth child is not loaded; flat
`commands/*.md` files are slash commands) and included in the dsh prompt.
A skill or command named `login`, `logout`, or `feedback` does not take the
bare slash: that name stays the built-in, and the asset is `/local:name` (or
`/ancestor:name`, `/repo:name`, `/user:name`).
The launcher forwards `GROK_CLAUDE_SKILLS_ENABLED` and
`GROK_CURSOR_SKILLS_ENABLED`; either set off stops that vendor scan.
`--rules` appends a session `<human_rules>` block; `--system-prompt-override`
replaces file rules and `--rules` while the typed prompt is still sent. `/reload-assets` rescans them.
Global rules still load when the project is untrusted. `paths.extra_skill_dirs`
is not a skill discovery root. Isolated plugin
marketplace add/list/update/remove and plugin install/update/uninstall copy
files into `$GROK_HOME/installed-plugins` with inspectable provenance.
Installation does not enable execution. Official marketplace auto-register is
off unless `GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER` is set. Git marketplace
catalogs are read from `$GROK_HOME/marketplace-cache` after add/update.
Each marketplace plugin installs into its own dest under `installed-plugins`.
Git updates persist the clone HEAD in inspect provenance. `marketplace.require_sha` /
`GROK_MARKETPLACE_REQUIRE_SHA` refuse unpinned remote install and update.
`marketplace remove`
clears trust and enable lists for those plugins. `extra_known_marketplaces`
pins sources with first-pin-wins. A present `strict_known_marketplaces` list
binds catalog load, named install, the catalog entry's clone URL, and later
git update: unlisted git sources are dropped with a warning, local paths are
refused unless an admin `extra_known_marketplaces` pin names that path, and an
empty or malformed list refuses every add and install. Layers are
strictest-wins, so a later user or workspace list cannot widen an earlier
lockdown. Git URL comparison folds scheme and host only, including GitHub,
and strips one trailing `.git`. The repository path stays case-sensitive.
`/plugins` and `/marketplace` open the directory; Ctrl+L is not bound here.
`codsh --rust login` / `logout` / `setup` use configured substitute identity
or management services. Independent API-key use does not require login unless
`GROK_DISABLE_API_KEY_AUTH` or a team pin (`auth.force_login_team_uuid` or
top-level `force_login_team_uuid` in locked `requirements.toml`) requires a matching identity session.
Startup and inspect refresh an expired `auth.json`, or clear it when refresh fails. Clearing an unrefreshable token does not block `login` or independent API-key use. `/login` reloads that session and reapplies settings; it replaces dsh when credentials, readiness, or the settings patch changed, and keeps the live client when the settings write fails. `/new` and a dashboard dispatch start a new dsh session on that same path: the current provider, model, effort, permissions, environment, and settings patch are applied again, and a failed settings write keeps the live client. They do not fall back to another provider. `/cd` then either command reloads trusted workspace config for the new directory before that patch is written. That workspace model and effort replace a saved selection for the new directory. The session memory toggle does not carry across. A usable identity session is handed to the executing dsh child (`GROK_AUTH_PATH`, `GROK_AUTH_ACCESS_TOKEN`, `GROK_AUTH_PROVIDER_COMMAND`); other `GROK_AUTH_*` parent variables are not. `/logout` asks the configured identity provider to revoke the session before deleting `auth.json`. A revocation failure keeps the local session. `/logout` drops the live connection.
Session tokens stay in `$GROK_HOME/auth.json` and are not transferred to model
providers or other services. Official grok.com entitlements are not reproduced.
Unsigned or unverifiable managed policy is refused, including a signature for
another principal, a deployment-key caller with no team, an on-disk sidecar
that does not name this caller, and fail-closed files with no pubkey and no sidecar.
Permission modes, allow/ask/deny rules, and remembered project grants are compiled
into isolated `$DSH_HOME/permission-policy.json` and enforced in the dsh
`tools/pre-execute` plugin before a real tool body runs. Released dsh does not
run Grok lifecycle hooks, so the client plugin runs command hooks at
SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, and SessionEnd.
Exit 2 and `decision: deny` block; other failures are recorded and are not
success. Hook stdout and stderr stay hook output. An allow does not skip
permission checks, and a hook cannot widen a sandbox or permission deny.
Untrusted project hooks stay skipped. Deny and hook blocks have
no side effects; unsplittable shell, including a parameter expansion such as `$x`, `${x}`, `$1`, `"$1"`, `$@`, or `$*`, and Read/Edit path rules on operands cannot be
glob-allowed or auto-approved as read-only. Wrappers, including `sudo`, `nohup`,
and `xargs`, peel to the inner command
without eating the command name; `env -S` prompts. Brace groups and ANSI-C
`bash -c` scripts are inspected, so deny still matches the inner command.
Command basenames match without regard to case, so `RM.EXE` is still `rm`.
Attached or clustered `sort -o` (`sort -oFILE`, `sort -uoFILE`) and unique
long-option prefixes such as
`sort --compress-pro` are not read-only.
Frozen git read-only subcommands auto-allow; git writes do not, including an
attached upstream such as `git branch -uorigin/main`, and a bare `git branch -u`
or `-t` with no operand. A leading word such as `time`, `exec`, or `builtin`
cannot hide a denied command. A shell option that takes the next word, such as
`bash -o errexit -c`, is consumed before the script is read. An unquoted `*`,
`?`, or `[` in a command word is not expanded, so a pathname glob such as
`./r*` is not auto-approved. `git branch --track` and a unique prefix such as
`--tr` are writes even with no operand; literal `git branch` and `sort file`
stay read-only. Claude settings
load from `~/.claude` and every `.claude` from the repo root to the working
directory. Read/Edit deny/ask follow in-path symlink targets. Missing or corrupt
`permission-policy.json` refuses
mutating tools. `y` is once, `a` remembers a path-scoped project grant, and
`/revoke-approvals` forgets those grants.
Plain `codsh` still selects the legacy Launcher/Bundle; this is not the default
cutover. The Viewport language below remains the legacy Surface contract.

## Language

### Product shape

**Launcher**:
The `codsh-cli` npm package — a zero-dependency command that finds an existing
dsh, registers the Bundle into a profile, and boots it. The found dsh must
meet the harness floor published on the launcher (`codsh.requiresDsh`).
_Avoid_: wrapper, shim, cli package

**Bundle**:
The `codsh-bundle` npm package — the interactive surface and agent preset,
installed into dsh profiles, never globally.
_Avoid_: runtime package, plugin (alone)

**Profile**:
A dsh-owned installation root under `$DSH_HOME/profiles/<name>` holding the
Bundle and its resolved dependencies. The unit a machine installs codsh into.

**Preset**:
The `code-cli` agent composition the Bundle ships; what a session mounts to
decide the model-facing toolset.

### Surface

**Viewport**:
The alternate-screen area the session owns: its own scrollback, wrapping,
scrolling, and frame painting. The terminal's native buffer is never touched.

**Sticky turn header**:
The real user prompt that owns the response currently crossing the top of the
Viewport. Its display-only copy stays pinned until the next real prompt pushes
it away, shrinking from at most three rows to one. Pinned, it is a panel: one
padding row of its fill above the prompt and one below, then the divider that
hands the screen back to the transcript. A prompt longer than three visual rows is a Fold by
default. Clicking the pinned copy expands that floating panel in place;
the inline prompt and the reading position stay where they were. Ctrl+O
on the original still expands the transcript fold, which then does not pin.
Plugin context, tools, and other injected user-role messages never start a
turn, and the copied header is not transcript or clipboard content.
_Avoid_: sticky message, pinned response

**Turn navigation**:
The retained real-user Prompt descriptors exposed as numbered reading anchors.
Shift+Left/Right moves one anchor; `/jump` previews an anchor while its selector
moves, commits on Enter, and restores the exact prior Viewport on Escape.
Plugin-sourced user-role messages never enter this index — including the
template a Canned command expands into, whose echo is the Prompt that enters
in its place. That echo shares the ordinary Prompt's background and text inset,
including the fill on its text rows as well as its surrounding padding.

**Prompt-top anchor**:
Display-only tail space that places a newly submitted real-user Prompt at the
Viewport top while its response streams below. A Canned command's echo is
placed the same way, for the same reason: it spends a turn, so a reply is
about to fill the space. A command that only works the Chrome answers nothing
and is written where it falls. It belongs to the live turn,
not to a reading position: it scrolls with the transcript, so reading back and
returning to the tail lands on the anchored frame again. It ends when the
response fills the Viewport or the next Prompt takes it over, and is never
part of Scrollback, selection, search, replay, folds, or redirected output.

**Conversation timeline**:
The display-only one-column rail in the terminal's reserved rightmost column.
Each visible tick maps to a retained Turn navigation anchor; the current tick
uses the user colour, enabled arrows jump to the nearest Turn anchor above or
below the Viewport top, and tick hover previews up to two real-user Prompt
lines. Rendering and hit-testing share one frame geometry; modal surfaces hide
the rail.

**Content address**:
A stable raw-content address derived from assistant message events: `N` names
the Nth non-empty assistant answer, and `N:C` names its Cth closed fenced code
block. `/copy` selects these newest-first; `/copy N` copies raw Markdown and
`/copy N:C` copies the fence-free source. Tools, images, rendering chrome,
Sticky turn headers, Rules, and ANSI styling never enter this index.
_Avoid_: screen row, rendered block number

**Fullscreen viewer**:
A transient reader over one Content address, opened by `/view`, `/view N`, or
`/view N:C`, and over unified-diff text, opened by `/diff` or by clicking a
Diff card whose body was capped. It replaces transcript and Chrome for the
lifetime of the modal, reflows raw Markdown, fence-free code, or diff text at
the current terminal size, and gives wheel, shifted arrows, Page, Home/End, and
Escape to reading. Diff text is coloured by what each line does to the file,
never by the language it is written in. Closing restores the exact prior
Viewport; the viewer never adds a Prompt, Fold, search hit, session event,
clipboard write, or pipe output. Off a TTY there is no modal: `/diff` writes
its lines and stays a line reader.
_Avoid_: pager process, transcript view

**Reader hand-off**:
The raw text a Fold carries so a click opens the Fullscreen viewer instead of
expanding in place. Only a Diff card that outgrew its 24-line body takes one —
a short diff is already whole on screen. Ctrl+O is unaffected: expanding
everything still expands this block inline, and the collapsed line names both,
so the affordance never promises a gesture the block does not have.
_Avoid_: pager payload, click target

**Resume list**:
What `/resume` offers. The workspace a person is standing in is the list;
every other folder is one row that opens the rest, because the session wanted
is almost always in the folder they are in. Rows are ordered by when the
session was last touched — not when it began — and each names its title, that
age, how many messages it holds, and, only for a session from elsewhere, the
folder it belongs to.
_Avoid_: session picker, history list

**Region pointer**:
A pointer press, release, or move on the rows below the transcript — the
Chrome, and the Overlay drawn just above it. A selection may refuse it
outright (`keyboardOnly`): an approval grants a tool for the rest of the
session and cannot be taken back, so no click may decide it and no Pointer
mark may suggest one could. Those rows belong to whatever
composed them, so a pointer there never reaches the Viewport: a row that
offers something acts on it, a chrome row with text selects the way the box
does, and a row that offers nothing does nothing rather than starting a
Viewport selection. A press commits only where it is released, so
sliding off before letting go takes it back. A gesture nonetheless belongs to
where it began, through release: a drag the Viewport anchored keeps reaching it
once the pointer has left, because sweeping past the last line and letting go
over the input box is how a person selects to the end of what they can see, and
a drag the box or a chrome row anchored keeps selecting the same way, clamped
into its text.
The Viewport keeps press-to-anchor, drag-to-extend, release-to-copy, and the
blank space under the last line anchors there too — a press with nowhere to
land is still where the pointer was resting, though only a press that landed on
a row can work that row's Fold. A press in the box that then moved is a Box
selection, not a Viewport one; a press on a chrome row that then moved is a
Chrome selection.
_Avoid_: click handler, hit area

**List window**:
Where an open list starts showing its rows. It follows the marked row, so the
`❯` is always in view — except while the wheel has moved it, which is the one
state it holds independently. Any key brings it back to the mark: a list
scrolled away from what Enter would take answers a question nobody asked. Only
the wheel moves it, never the keyboard's own scroll, which is why a scroll
carries where it turned and one without a place is left to the transcript.
_Avoid_: scroll offset, viewport

**Caret placement**:
Where a click inside the box puts the cursor. Near misses clamp rather than
miss — a border row takes the nearest content row, a column outside the text
takes the nearest end of it — because the text inside a frame is a narrow
target and "just above the first line" is an ordinary intention. The inverse
reads the same wrapped rows and the same window the box drew, so the cursor
cannot land somewhere the box never showed, and a shell box's hidden `!` is
given back. The press only has to land in the box: the release is the position
it means, because putting a cursor somewhere is not a thing to be undone. A
press that then moved is a Box selection, not this.
_Avoid_: click to focus, text hit test

**Box selection**:
A mouse selection over the text inside the box. Press anchors, drag extends,
release copies — the same gesture the Viewport gives the transcript, because
mouse reporting has taken the terminal's own selection. A press that never
moved is still Caret placement, and sliding off before any drag takes it back.
The span stays marked until the next click or move; typing, paste, and delete
replace it. Escape dismisses it before it means leave.
_Avoid_: input highlight, textarea selection

**Chrome selection**:
A mouse selection over a chrome row's painted text — the teaser, todos,
subagents, working line, shortcuts overlay, empty-box placeholder, or status
row. Press anchors, drag extends, release copies — the same gesture the
Viewport gives the transcript and the box gives its typed text, because mouse
reporting has taken the terminal's own selection. A press that never moved is
still that row's click, if it has one, and copies nothing. The span stays
marked until the next click or Escape; a rewrite of the facts clamps it into
the new line. A selector, a completion, or an open panel row stays a click,
because the mark is what Enter would take.
_Avoid_: footer highlight, metabar selection, Status selection

**Pointer mark**:
The row a Region pointer rests on, shown as a dim `·` in the column `❯` marks
from. One column answering two questions that cannot be confused: `❯` is what
Enter takes, `·` is only where the pointer is. Kept apart on purpose — a
pointer often comes to rest somewhere nobody chose, and moving the mark would
change what Enter does as a side effect of where the mouse is. The completion
menu is why it is the marker column rather than an underline: the label
already underlines the fragment that was typed.
_Avoid_: highlight, focus

**Plan progress**:
How far a `/ship` run has got, read from the spec file's `## Plan` checkboxes
rather than from the conversation — the spec file is the workflow's memory, and
its boxes are the only place the work is counted. The chrome re-reads that
file as tickets tick, and pins it as its own row (`plan k/n · current ticket`).
A Ctrl-C, idle stop, or later typed continue does not freeze that row: the
spec poll keeps following checkboxes until verified delivery retires chrome.
Verified delivery retires the phase chip, plan, Panorama teaser and overlay,
and the old Todo readout. Later session events cannot re-pin that completed
run or apply its Mission Contract to unrelated work. The final graph remains
available in the Web panorama, and its loopback URL stays on the chrome.
Interrupted, blocked, or failed delivery keeps its resumable progress. Explicit Todo and Subagents panels retain history.
The working line names a Workflow round
while one is in flight; it reports `done/total` and the first unticked ticket
only when no round is running, so the two rows never stack the same figure.
_Avoid_: todo list, task count

**Workflow progress**:
What a `tool-workflow/*` record becomes on screen. A run opens with its name,
each round prints one line as it settles, and the stop reason closes it. The
round still running is named in the working line instead, because the
transcript is append-only and cannot unprint a line when it ends. The line is
all a round gets: a workflow's children run in a worker thread, so their
sessions are never in this process and no click could enter one.
_Avoid_: workflow log, progress bar

**Canned command**:
A command whose body is a prompt template rather than a handler: `/ship`,
`/init`, and a person's own `custom-commands` entries. It spends a turn, so
what a person typed is echoed as a Prompt and the template itself never
reaches the transcript.
_Avoid_: macro, alias

**Fold preference**:
An ephemeral, per-Fold choice created by clicking a block or pressing Ctrl+O.
Explicit expanded and collapsed choices survive streaming completion, resize,
scrollback trimming, search, and later turns; moving on collapses only automatic
fresh-output states. Thoughts land folded, so moving on only folds a thought
the person opened without choosing that form by hand. Moving on is a turn
spent, a Prompt or a Canned command; an empty Enter, a command that only works
the Chrome, and a `!` line are not turns and fold nothing. A clear, a session
replacement, or the return from a Child view discards preferences, and replay
creates capable but automatically collapsed Folds from durable events.
_Avoid_: session fold state, global expanded mode

**Chrome**:
The bottom-pinned rows: input box, menus, the Queue and Todo readouts, hint
row, status row. Never scrolls.

**Context readout**:
The status row's `context used/window (N% left)` segment. `used` is the
projected next-request pressure, falling back to the latest provider sample;
it is not cumulative session usage. The session projection supplies both
pressure and capacity, so replay restores them and compaction updates them.
Available figures stay visible at normal pressure; missing figures are `?`,
and no segment appears before either is known. Remaining capacity is muted
above 25%, warning at 25% or below, and error at 10% or below. Narrow rows
omit shortcuts, workspace, and model before context or workflow state, then
shorten context to `N% left` if needed. `/status` retains the detailed counts.

**Row**:
One line of a frame, painted at a position of its own. A row is text and
nothing else: a control character inside one is not a character but a cursor
movement, and the width authority scores it zero columns — so a row carrying a
newline measures as a fit, paints its head where it belongs, and drops the rest
at column 1 of the row below. That row is usually one the frame diff considers
unchanged, so nothing paints over the spill and it outlives every later frame.
Text becomes a row by being cut to fit (Chrome, menus, cards) or wrapped to fit
(transcript); both flatten control characters first — the cut before it
measures, the wrap by breaking a row where a newline asked for one — and the
frame flattens again as it paints, for whatever composes a row next.
_Avoid_: line (a transcript line may occupy several rows)

**Fold**:
A transcript block kept in both a summary and a full form, swappable in place
— a click anywhere in the one under the pointer works it, Ctrl+O works them
all: it opens whatever is folded, and folds everything once nothing is.
Thinking is a Fold that opens folded: a `thinking…` head stands while it
runs — ticking the same Braille frames as the working line, which names
the thought `thinking` — and becomes its clock (`│ thought for 3.2s`)
when it ends. Both heads occupy one row without vertical padding and without
a panel fill — a full-width thinking background on the clock is a black bar
between tool rows. The magenta `│` runs down the clock, the pads, and the
expanded deliberation. Only the expanded form keeps the fill and its
panel inset, behind a click or Ctrl+O. Every tool card is a Fold that opens
folded: one row naming the call, how much it produced (`+n -m`, `N results`,
`· N lines`), and whether it worked, with the body behind it and no panel
fill. The success bullet is dim; the trailing `✔` stays green. A failed
row also names its reason, and a non-zero terminal exit or a kill is a
failure (`✗`), not a green pass. A finished answer is transcript:
it stays whole, a click does not work it, and the pointer resting on it
names nothing.
_Avoid_: collapse block, expandable section

**Child view**:
The nested Viewport of an in-process child's transcript. A Fold that names a
child Session is a view, and so is a row of the Subagents panel: a click or
Enter enters, Esc pops one level, and the child's thinking, text, and tool
cards stream the way they do on the parent. Entering covers the parent's
transcript rather than replaying over it — history, the scroll offset, and
open folds stay on a stack — and Esc uncovers that same buffer, so a person
can still read back. Parent events that land while looking keep writing into
the covered buffer. Its status row is the child's title — the roster's mark,
label, elapsed time, call count, and latest call, then `Esc returns to the
parent`, which is cut last. From inside a view, another panel row swaps the
view rather than stacking it — every open level drops once the door is known
to open — so Esc still returns to the parent.
The view is read-only; typing flashes that Esc returns. Fork views skip the
inherited parent prefix. A runner-dispatched in-process child is a view
without a parent tool call — that Fold is not a `subagent` card, not a
parent-log line, and not in a Card run. A child that has finished and left
the store — every background child, the moment it idles — opens read-only
from its persisted log. Worker-thread Workflow children are not views —
their sessions are never in this process, so the round line never offers
`click to enter`. Off a TTY there is no Fold.
_Avoid_: catalog, inspector, pager, synthetic tool-call, Claim on the card

**Subagents readout**:
The chrome row counting the children the live session started, by state —
`subagents 3 · 2 running · 1 done · Ctrl+H` — for as long as the roster holds
any, except settled entries retired from the readout after verified ship
delivery. Those entries remain in the panel and `/subagents` report; running
children stay visible and retire when they settle, while new children appear
normally. The roster is surface state fed by `subagent/start`, each direct
child's own log (its `subagent/descriptor` names it; calls, turn starts,
turn ends), and `subagent/end`, never a query over the store, which forgets
a child that finished; grandchildren belong to the child that started them.
`completed` is done; `error`, `max-tokens`, `refusal`, and a `blocked` turn
(a refusal to the runtime) failed; `aborted` and `interrupted` stopped — an
unfinished child is never `✔`. Its
clocks tick once a second while any child runs, on the roster's own timer.
A click on the row, or Ctrl+H, opens the Subagents panel in its place.
Dropped with the session on `/clear` and `/resume`.
_Avoid_: agent list, task pane

**Subagents panel**:
The roster opened in the readout's place: a header with the readout's counts
and `Ctrl+H closes`, then a numbered list the shape of the Queue panel, one
row per child — a mark (`▶` and `✔` are the todo readout's, `✗` the failed
tool card's, `■` for a stopped child is this row's own), the label the
child's log gave it, its elapsed time, its calls, and the latest one; the
child on screen ends ` · viewing`. ↑/↓, Tab, Home/End, and digits move the
mark; Enter or a click on a row enters that child's view; Esc or Ctrl+H
closes (inside a Ctrl+R search, Ctrl+H cancels the search instead). It
enters and nothing else — stopping a child is the model's own tool. One
open panel at a time with the Todo readout and the Queue panel. `/subagents`
prints the header without its key and the rows without the `❯` cursor.
_Avoid_: dashboard, inspector

**Card run**:
Tool cards that follow one another share one stretch of transcript rather
than each opening a panel of its own. Consecutive cards on a TTY stack
flush — a failed row among them included — so a run reads as one segment,
and the Block gap on either side is what sets it off; piped output still
closes each card with a blank. A door into a child Session is the only
extra row under a head, and a run of similar cards rebuilds as one fold
over the rows already on screen. Any other block printed under a run ends
it and opens one Block gap below it. A runner Child view at the tail is not
in a run.
_Avoid_: card group, merged cards, runner Child view as a tool card

**Block gap**:
The one blank row between any two blocks on a TTY. A block that does not
follow a blank — the first card of a Card run, a runner notice, an answer,
a compaction summary — opens with one under its own rule; an answer still
closes with its own. A thought clock (and the `thinking…` head before it)
is a caption, not a block: it takes no blank of its own, sits flush under
the row before it, and the block after it opens none, so a step reads as
its cards, its clock, and its answer. Rows that continue a block take none
either: the later cards of a run, a card's `click to enter` door, a
workflow's round and stop lines under its head, an approval note under the
pending card it explains. A pipe closes each block with a blank instead.
_Avoid_: margin, padding, spacer

**Rule**:
The connecting `│` drawn down every transcript row, including blank
separators that belong to a block. Colour — not a different character —
says what the row is: cyan for the person's own message, magenta for
thinking, dim for a tool card or runner notice, red for a failed one,
muted for assistant prose and system chrome. Chrome, not content: it
repeats on wrapped rows and never reaches the clipboard.
_Avoid_: border, gutter, sidebar

**Scrollback notice**:
The row that says how far back the reader has gone and takes the click that
ends it. Display-only, drawn over the Viewport's last row — under what is
being read, never over it, and never a chrome row, which would move the input
box while scrolling. A drag that starts on it is a drag, not a click.

**Update check**:
One cached read of the `codsh-cli` dist-tag, behind a two-second budget, that
can only ever add a dim line under the welcome naming the newer version. It is
never a chrome row (the chrome's height is what keeps the box still), never
blocks the boot, and never installs anything on its own. Asking is `/update`
inside a session or `codsh update` outside one; both run
`npm install -g codsh-cli@<latest>` in the open and then move the code
profile's runtime to match, so a profile that launches straight through dsh
never waits for a boot to catch up. The boot's registration remains the catch
for a runtime a bare `npm install -g codsh-cli` upgrade, or a failed move,
left behind. A leftover `node_modules` linked from another pnpm store (another
pnpm major, or a moved store-dir) is dropped and the registration retried,
because `dsh plugin add` is a thin `pnpm add` that otherwise refuses to run.
`CODSH_UPDATE_CHECK=off` silences the automatic check but neither
of those; `CODSH_UPDATE_REGISTRY` points every one of them at another
registry.

**Flash**:
A short-lived notice that borrows the hint row and gives it back (e.g. the
copy toast).

**Hover readout**:
The chrome row naming the fold the pointer rests on — what it is, how many
lines it withholds (the count its own row names; a door names none), whether
a click opens, folds, or enters it — for as long as it rests there. Outranked by a flash, and it outranks the working indicator. It
borrows that chrome row rather than adding one, so the box does not jump.
Paired with a panel fill on every visible row of that block, the way
opencode marks the block under the pointer; the readout is what still
speaks when the head row is off the screen.
_Avoid_: tooltip, status hint

**Pasted image**:
The clipboard image Ctrl+V attaches on macOS behind an `[Image #N]`
token in the box — one backspace removes the token whole, and a deleted token
drops its image. Cmd+V reaches the client as a bracketed paste: on macOS an
empty one (an image-only clipboard) reads the clipboard image the same way, and
whitespace alone inserts nothing. The Windows read (Alt+V, or that empty paste)
is not implemented: it says so and attaches nothing, left to the platform
tickets (#200/#201). A paste that is only absolute
paths or `file://` URLs of image files (a Finder drop) attaches those files;
prose, relative names, and mixed paths keep the text and `@file` rules. At
submit, a model whose `input_modalities` includes `image`
gets an ACP image block. A model that does not declare `image` gets the
original saved under the isolated dsh home `attachments/pasted/` and a
`<pasted-image>` path in the same message, and the attach notice says that
model cannot see images. Rules and the first-turn memory note wrap the user's
text once and are not copied onto that element or an attached file body. The isolated client does not call
a second vision provider. An empty clipboard, a file that is not png, jpeg,
webp, or gif, and a file over 256 KiB stay in the composer with a notice.
`GROK_CLIPBOARD_NO_NATIVE_READ` disables the macOS pasteboard read whenever it
is set. The packed launcher forwards that switch and `CODSH_CLIPBOARD_IMAGE`,
so the session reads the controlled file, including an empty one. A model or
screen-mode switch keeps the same bytes, not only the placeholder. Closing the
model menu puts that draft back. The draft is process state, as in the
reference: nothing of it reaches disk, a new launch in any project starts
empty, a sent prompt never returns, and an exec relaunch resumes the session
without it. Resume shows a sent image turn by its placeholders, never its
`<pasted-image>` path, and sends nothing again.
_Avoid_: upload, embed

**Image preview card**:
The notice shown while the pointer rests on an `[Image #N]` chip, or while the
cursor rests on or just after that chip. It names the chip, the sniffed pixel
size (png, gif, jpeg, and webp), the byte length, a short digest, and the saved
path when one exists. Frozen guide 03 is this metadata line, not a picture.
This client does not speak Kitty graphics, `OSC 1337`, or a half-block mosaic,
and it does not open a platform viewer. Those legacy protocols are not part of
this rewrite. The image bytes stay out of the row text.
_Avoid_: thumbnail, attachment chip

**Todo readout**:
The chrome row that holds the agent's todo list — progress plus the item in
flight — for as long as a list is live, and the `/ship` plan when one is on
disk. A click anywhere in the readout, or Ctrl+T, opens the full list and
closes it again, the way a Fold works. Read from the `todos` projection and
the spec file, never remembered from the write.
_Avoid_: todo panel, task bar, progress bar

**Queue**:
The lines submitted while nothing was asking for one — a turn running, a
question open — held by the Prompt in the order they were typed, each a
Prompt, a `!` line, or a `/` command with the images its tokens claimed.
Adjacent Prompts leave as ONE message, a blank line between them; a `!` or
`/` line is a boundary that keeps its place and leaves alone, so shell output
lands between the thoughts it separated. Shown as the `↳ queued:` chrome row
(count, each line's first line, `Ctrl+Q`). Surface state, never the dsh inbox:
the inbox holds only Steers. An interrupt leaves it alone, and it goes as the
next message; Ctrl-C is always the interrupt. Escape dismisses overlays and
Child views and does not stop the turn.
_Avoid_: inbox, backlog, type-ahead buffer

**Queue panel**:
The Queue opened in its row's place — Ctrl+Q, or a click on the readout — as
a numbered list with the keyboard: Enter edits the marked line back into the
box (its images with it; refused while the box holds text), `d` deletes,
Shift+↑/↓ reorders, `s` Steers a Prompt while a turn runs, digits pick a row,
Escape or Ctrl+Q closes. One open panel at a time with the Todo readout. It
closes itself after an edit or a Steer and when the Queue empties; the box
receives no keys while it is open, and the pointer marks and clicks its rows.
_Avoid_: selector (which replaces the box and settles once), menu

**Steer**:
A Prompt handed to the RUNNING turn instead of the Queue — Ctrl+Enter from
the box on a kitty-protocol terminal, `s` in the Queue panel anywhere — via
the agent's `steer`, which delivers it at the next step boundary. Shown as the
`↳ steering:` chrome row until the agent claims it, when it renders as a
Prompt block like any other. A turn that ends without taking it, an interrupt,
or a session switch reclaims it to the head of the Queue, so nothing typed is
lost. A `!` or `/` line cannot Steer; it joins the Queue.
_Avoid_: inject (dsh's model-facing context), interrupt, follow-up

### Workflows

**Question batch**:
One `ask_user_question` request, owned by `TerminalQuestions`. Each answer is
stored by its position in the request; ← revisits an earlier question and →
returns to the next visited one. Navigation outcomes are separate from answer
data, so literal write-ins such as `back`, `next`, and `edit` remain text.
The append-only Transcript receives one final summary per answered question
when the batch settles, never intermediate revisions. Each summary is drawn
with the tool `│` so the left rule continues through the answers
instead of breaking where the person replied. Esc/dismiss or EOF
ends the remaining batch; cancellation never opens another card. Accepted
answers remain and unanswered questions return empty selections.

`FrontierCard` owns the compact `ship · grill` presentation; ordinary choices
use `Selector`. Both restore all submitted selections and write-ins on a
revisit, retain a write-in draft while moving between options, and use Space
to toggle multi-select choices and Enter to submit (the focused choice if
nothing is checked). ←/→ edits the caret within a write-in before navigating
at its boundary. Frontier uses `❯` for focus and `[x]` for checked choices,
including without color. It wraps question context, the focused option's
explanation, and navigation hints. Explicit write-in labels identify inline
fields; incidental words in descriptions cannot convert concrete options
into text inputs. A grill dismissal does not abort Ship or approve a gate.
_Avoid_: navigation strings encoded as custom answers, per-visit transcript writes

**Ship gates**:
The two approvals in the `/ship` workflow — the confirmed spec file (gate 1)
and the approved ticket breakdown (gate 2). The runner auto-Confirms both with
a transcript notice; interrupt still aborts. Gate 1 Confirm seals the Main Track
and acceptance criteria. After seal there is no Edit modal; a sealed-track
contradiction is a `## Blocker`. Everything after gate 2 is autonomous. Wayfinder
precedes grill as a planning-only contract: destination, named decision map,
dependency-linked decision tickets, and a local-Markdown fallback when no
tracker is configured. Charting no longer drops the person: the same `/ship`
invocation continues after HITL. A named map is always charted; an empty inner
ring is valid. Decision-ticket HITL still wakes the parent one unblocked
non-research ticket at a time. Unresolved work remains `wayfinding`;
explicit confirmation of a clear route advances to `grilling`. A small clear
route records a confirmed no-map handoff. The ledger's `## Wayfinder` section
links the canonical map and its decisions, not a duplicate implementation plan.
Each `/ship` turn injects the bundled contract for that phase. The model must
not look up, read, or invoke a wayfinder, grill-me, to-spec, to-tickets, or
tdd skill. Grill then runs from that injected contract (recon, design tree,
frontier rounds with recommended answers, exhaustion handshake); to-spec and
to-tickets then run from theirs (exhaustive stories, vertical tickets with a
DAG and per-ticket acceptance, `.scratch/` plus tracker when configured)
without another interview. Landing follows the injected TDD contract: one red
test witnessed failing, then minimal green, then the suite. Each `/ship` turn
injects only the phase the spec's `Status:` names, avoiding injection of all
phase instructions at once.
Earlier conversation remains in the parent; fresh-context children keep
independent investigation and implementation output out of that history. `interviewing` still means to-spec for existing files; later
status meanings remain unchanged. The MetaBar chip follows that Status
(`ship · wayfinder` / `grill` / `spec` / `tickets` / `land k/n`). The runtime
binds one spec for phase, goal, UI, and completion; several unfinished specs
open a selector, and a pipe refuses the ambiguity. The spec file is the
workflow's memory, not the conversation: the user's wording lives in
`## Original Requirement`, distinct from the compact Main Track; approved
tickets live as checkboxes; the `Status:` line names the phase; a baseline run
is recorded before any code; each green ticket is committed; and a bare `/ship`
resumes unfinished work without blanking the original requirement. Adjacent
`<spec>.ship.json` is runner-managed persistence of the original requirement
plus sealed Main Track and acceptance criteria at gate 1 when present. Later
phases and resumed runs check that snapshot at phase boundaries; mismatch or
corruption is a stop, not an accepted rewrite. A first snapshot cannot verify
earlier history — limited protection, not a tamper-proof sandbox. Plan mode
writes no snapshots. Coverage is original requirement → Track-N → acceptance →
ticket → evidence. One module owns that memory for a session — Plan progress,
the MetaBar chip, the spec poll, occupancy, the sealed-track snapshot, the
Mission Contract, and the canned phase loop — so the runner only begins, notes a
write, or aborts. Occupancy and dirty-tree preflight still ask on a TTY.
Occupancy is a Selector, not a third gate. Chrome stays
the MetaBar chip, plan row, and Panorama teaser; there is no GoalBar.
_Avoid_: checkpoints, review steps, GoalBar, in-session landing, process-only snapshot

**Original Requirement**:
The user's wording, kept in the spec as its own section. Clarifications refine
the design; they never silently replace the original request. Distinct from
Main Track. A bare `/ship` may omit a new idea; it must not blank this section.
_Avoid_: live rewrite, idea slot as the only memory

**Ship snapshot**:
The adjacent `<spec>.ship.json` the runner owns. It records the original
requirement and, after gate 1 Confirm, the sealed Main Track and acceptance
criteria when those sections exist. The model must not edit, remove, or
regenerate it, and children must not be asked to. Commit it unchanged with
the spec so resumed checkouts retain the comparison baseline. Checks run at phase
boundaries and on resume; field values are compared independently of JSON key
order. A missing, changed, or corrupt snapshot stops the run. A first
snapshot has no earlier history to compare, so protection is limited — not a
security sandbox. Plan mode writes none. Identity, snapshot, and phase checks
plus review and real proofs are the guardrails; semantic zero drift is not
claimed. Distinct from the Mission Contract JSON under `.scratch/<slug>/`,
which compiles richer control-plane ids from the same seal.
_Avoid_: process-only snapshot, live reread, tamper-proof, security sandbox

**Main Track**:
The compact compass `/ship` writes into the spec: the one-sentence idea,
numbered Track-N grill decisions, and Out of Scope — not the full spec and
not the Original Requirement. Gate 1 Confirm freezes it together with
acceptance criteria. Later phase turns and resumed runs are bound to that
sealed content via the runner snapshot, so landing cannot rewrite the design
to match what it already built. A needed contradiction is a blocker, never a
silent spec edit. Progress (Status, checkboxes, proof logs) remains writable.
_Avoid_: live reread, silent rewrite, GoalBar

**Decision ticket**:
A wayfinder child of the named map — a question, not a build slice. Its graph
key is the tracker's native id: `decision:github:owner/repo#n`, or
`decision:local:NN` from `.scratch/<slug>/wayfinder/NN-slug.md` when no
tracker is configured. Existing `decision-NN-slug.md` names resolve to the same
integer identity; duplicate integers across both forms are errors. Status,
Type, and Blocked by accept plain lines or Markdown list labels; `closed`
and `resolved` both close a decision, and `wayfinder:` type prefixes are accepted.
Claim updates replace the existing Status and never reopen a closed decision.
Distinct from a Landing ticket; it does not become a Track-N.
_Avoid_: implementation ticket, graph uuid, plan checkbox

**Landing ticket**:
A Gate 2 tracer-bullet ticket. Its graph key is `landing:N` from the
`Ticket N:` prefix on the spec `## Plan` checkbox. After Gate 2 Confirm, `N`
is never renumbered or reused; checkbox order may still follow the DAG. The
scratch file is `.scratch/<slug>/issues/NN-slug.md` with the same integer `N`;
a published tracker issue is a locator (`Issue: owner/repo#n`), not a second
node.
_Avoid_: plan index, Track-N, Decision ticket

**Track anchor**:
A sealed Main Track decision as a graph node (`track:N`). `REQ-*` is an alias,
not a second key. Landing tickets hang off one or more anchors (many-to-many).
Wayfinder tickets stay a separate inner ring; during wayfinding there are no
Track anchors yet.
_Avoid_: edge label, inner-ring node, Main Track hub

**Ship graph**:
The canonical graph of one bound spec. The TTY projection groups Decision tickets (inner ring),
Landing tickets (outer ring), and Track anchors. Rebuilt from those canonical
sources into adjacent `<spec>.ship.graph.json`; the cache is not identity.
Missing or corrupt cache is discarded and rebuilt; a join failure against
canonical sources stops the run. Ticket nodes carry a derived Claim token;
decision nodes may carry `ticketType`. Edges are `blocked-by` and
`hangs-off` only. Map, spec, Idea, worktree, child, Claim, Blocker,
ACC-*, Panorama overlay, Panorama teaser, and Web panorama are not
nodes. A named-map locator (Canonical map, `[Map]`, `wayfinder:map`) is
not a Decision ticket; local `.scratch/<slug>/wayfinder/NN-*.md` children
still join when that pointer is present, and the named map file's GitHub
children join when listed there. A confirmed no-map route has an empty
inner ring, not a fourth node kind. `NN` in filenames is an integer
(`01-foo.md` → `1`). The join re-runs as soon as a canonical source is
written, so the overlay, teaser, and Web panorama show a new ticket
without waiting for the next phase.
_Avoid_: sidecar as source of truth, title matching, freeze-sidecar stop, fourth node kind

**Ship delegation**:
Fresh-context `subagent` is the default for investigation, research, ticket
implementation, and independent review. Prefer `subagent`, not
`subagent_fork`: copying the parent conversation defeats isolation. The parent
keeps questions, gates, coordination, and independently re-runs final proofs.
Children return at most 20 lines naming the result plus evidence/log paths.
The working tree is shared: read-only work may run in parallel; writers and
git mutations stay serial. Landing is a Landing wave: it dispatches every
currently unblocked, unclaimed ticket in parallel worktrees, including
siblings that share a closed prerequisite; the parent
serial-merges Ready-set then proves. An in-process child the runner dispatched is a Child view
without a parent tool call. Whenever the parent Viewport is shown, one
door per live Session that names the ticket's graph key, at the tail, in
graph-key order. Head is `Ticket N: <title>` or the decision name, with
`· conflict` / `· repair` only when one node has two Sessions, then
`click to enter`. The runner keeps that Session until it releases the
child; a leftover worktree with no Session is panorama 已认领, not a dead
door. Claim does not store a Session id. Decision-ticket HITL still
wakes the parent one unblocked ticket at a time. An unresolved `## Blocker`
stops automatic continuation until archived; there is no landing
turn-budget breaker. Cascading re-verification unticks only tickets whose
proofs failed, plus already-closed DAG dependents of those tickets — never
every later-N. `/ship` never calls Ralph; its tool remains available
outside the workflow for explicit requests. Missing delegation is stated
as a limitation, not claimed as a child that ran.
_Avoid_: in-session landing, fork history, semantic zero drift, subsequent-untick, parent-log door

**Mission Contract**:
The machine-checkable control-plane memory Gate 1 Confirm compiles from the
sealed Main Track, Out of Scope, and acceptance criteria — REQ / NEG / ACC
ids with Track-N aliases — written to `.scratch/<slug>/mission.contract.json`.
Distinct from `<spec>.ship.json`, which snapshots the original wording and
sealed Main Track / acceptance for resume comparison. The Markdown spec stays
the human projection; the runner owns the JSON and prepends a compact summary
on later phases. After seal, write tiers apply: Main Track / Out of Scope /
grill decisions / original requirement / acceptance criteria / contract JSON
are immutable (protected writes are refused; external drift stops the run
and remains on disk for inspection); Implementation Decisions are semi-mutable (blocker required); Status,
Plan, Baseline, and Verification are mutable world state. A land-phase HITL
wake prepends the bound spec and the in-flight / Ready-set set, not a single
Active Ticket line. An Alignment Gate refuses
writes that lack requirement mapping or hit immutable memory. Those denials,
and a Drift Detector flash, are runner notices drawn with the tool `│`
so the left rule continues through them instead of breaking on every
line. While a
Conflict-resolution child is live, that gate does not apply to its
writes — mapping, invented `supports`, and active-ticket Track checks
stay off so marker fills are not refused as unmapped landing work;
immutable control-plane paths are still refused. A Drift
Detector scores plan/action drift against the seal and treats a rewritten
Main Track as a blocker, not an accepted rewrite. An independent
Verifier matches acceptance criteria to recorded evidence and reconciles
premature plan ticks at final verification, not after each ticket write;
delivery and the ship goal do not complete without that evidence.
_Avoid_: hand-authored JSON, prompt-only freeze, GoalBar, wording-snapshot substitute

**Conflict-resolution child**:
A fresh-context child that resolves git-named conflicts in the merge-target
tree during serial landing or delivery Merge-back. Text hunks preserve the
surrounding content; lockfiles/generated artifacts are regenerated, and
modify/delete or binary conflicts use both versions and ticket intent.
Validation failures feed back to a fresh child, up to three attempts per
merge, without aborting between attempts. Already auto-merged files form a
baseline, not an out-of-scope write. Sealed requirements stay protected.
The runner owns staging, non-interactive commit, and rollback (squash uses
`reset --merge`, not `merge --abort`). Unchanged markerless conflicts require
explicit confirmation on retry, not a silent choice of ours. Related staged
additions may be reconciled when Git represents a rename as modify/delete.
Rollback failures are reported without creating a blocker commit in a pending
merge. Success resumes landing and proof.
_Avoid_: merge bot, TDD repair, conflict agent

**Worktree branch**:
The dedicated git ref for a ticket worktree: `wt/<slug>/<directory>`, where
the directory is the filesystem form of the graph key (`landing-N`,
`decision-<github-number>`, `decision-<local-NN>`). Distinct from the feature
branch `ship/<slug>` — git cannot nest `ship/<slug>/landing-N` under
`ship/<slug>`. Never create a parent ref `wt/<slug>`. Resume identity is this
ref, not a detached HEAD. After any merge commit into `ship/<slug>` the
directory and ref are removed; abort keeps both under the same names. Nested
checkouts are ignored in the parent via `.scratch/<slug>/worktrees/.gitignore`.
The land → prove → tick/Blocker protocol applies only to `landing-N`.
_Avoid_: `ship/<slug>/landing-N`, detached worktree HEAD, `wt/<slug>` as a ref

**Worktree commit**:
The runner's one commit on a landing Worktree branch, subject `Ticket N:
<title>`, Track-N in the body. Children never commit. Author is the host
`user.name` / `user.email`. Distinct from the `--no-ff` land merge onto
`ship/<slug>` and from the Tick commit that follows a green proof.
_Avoid_: child-authored commits, synthetic `codsh` author

**Tick commit**:
The commit on `ship/<slug>` after a green parent proof of a serial-merged
ticket: ticks the plan checkbox, appends Verification, leaves Claim. Distinct
from the `--no-ff` merge that landed the worktree (kept even when proof is
red) and from a red-proof commit that only writes `## Blocker`. Interrupt
writes no git commit and no `## Blocker`. A proof sweep that both ticks and
records a Blocker is still one commit — not two.
_Avoid_: amending the merge, ticking inside the merge message, two commits per sweep

**Merge snapshot**:
A timestamped dump of a mid-merge abort — unmerged paths, git output, and
partial hunk fills — at
`.scratch/<slug>/merge-snapshots/<directory>/<utc>/`. Landing uses the
worktree directory name; Merge-back uses `delivery`. Interrupt and
Blocker-class abort share that layout; a later retry does not overwrite.
The directory is gitignored in the parent except that a Blocker-class dump
is force-added with the `## Blocker` commit; an interrupt dump stays
untracked.
_Avoid_: a single overwritten dump, storing the dump inside the worktree

**Claim**:
The panorama bucket of one Decision ticket or Landing ticket: 待认领,
已认领, or 已关闭. Distinct from Occupancy. 已认领 means the ticket is
taken, not that a child is running. Canonical writes stay on the tracker or
scratch file; the Ship graph cache only copies a derived token.
_Avoid_: Occupancy, graph node, fourth bucket, live-child, second claim store

**Landing wave**:
The standing set of in-flight landing worktrees plus the serial merge queue
on `ship/<slug>`. Not a barrier that waits for every child to finish.
Dispatch takes every currently unblocked, unclaimed landing ticket. Siblings
of one closed prerequisite start together; a numbered `Blocked by: 1, 2`
next to `Blocked by: 1` is that fan-out, not a second wait.
_Avoid_: batch barrier, Track-N order, one Active Ticket, numbered chain

**Ready-set**:
Finished 已认领 landing children whose DAG blockers are already 已关闭.
Serial-merge order is lowest `landing:N` in this set. A keep-commit that
stayed `[ ]` does not unblock dependents. Distinct from git conflict and
from `## Blocker`.
_Avoid_: completion order, strict earlier-N wait, Track-N order

**Last proof**:
Scratch field `Proof: green` or `Proof: red` beside `Claim: claimed`. A
green Tick writes green; a failed parent proof writes red; unticking a
still-green dependent does not change it. Omitted until the first parent
proof. Distinct from spec `## Verification`.
_Avoid_: sidecar, Blocker body as identity, parsing Verification prose

**In-place repair**:
A TDD child whose cwd is the parent `ship/<slug>` tree, used when that
landing ticket already has a land-merge commit and no worktree. Distinct
from a worktree TDD child. New worktrees wait until this child is idle.
_Avoid_: second land merge, overlapping drain writers

**Occupancy**:
Before the first `/ship` phase turn, if an unrelated current `/goal` exists,
the runner pauses it then asks a Selector titled `ship · occupancy` —
Replace or Abort. TTY Esc/cancel is Abort: resume the paused stranger and
stop `/ship`. Off a TTY, auto-Replace. A goal is ours when its id matches
the spec `Goal-Id:` or its objective starts with `[ship]`; ours is reused
without asking. Occupancy is not a ship gate and not a ticket row.
_Avoid_: occupancy gate, silent steal, GoalBar, Claim

**Panorama overlay**:
The fullscreen TTY projection of one bound spec's two-ring graph: inner
ring then outer ring, 待认领 / 已认领 / 已关闭 on the ticket row, Track-N
as a suffix. The title row also carries the loopback Web panorama URL when
one is bound. Binding a graph keeps the teaser; Ctrl+G or a click on that
row opens the overlay, and Esc, Ctrl+G, or a click folds it back. Exclusive
with Queue/Todo. Distinct from the Panorama teaser and from the Web
panorama. Not a graph node. An empty inner ring is still this overlay.
_Avoid_: Track-N grouping, hub row, Queue-style window, fourth bucket

**Panorama teaser**:
The one-line TTY chrome of the same graph — `待认领 n · 已认领 n · 已关闭 n`,
plus in-flight when greater than zero, plus the loopback Web panorama URL
when one is bound — above the plan row. In-flight is the live Landing-wave
child count; a graph rebuild must not drop it to zero while a Child view
Fold is still on screen. Distinct from Occupancy, the MetaBar land chip
(closed/total), and the Web panorama itself.
_Avoid_: Occupancy, fourth bucket, land chip, plan row

**Web panorama**:
The loopback React Flow projection of one bound spec's Ship graph. Six
ordered layers: Wayfinder, Grill, Spec (Gate 1), Tickets (Gate 2), Landing,
and Done. Each phase is a parent sub-flow containing descriptive steps;
Decision tickets belong to Wayfinder, Track anchors to Spec, and Landing
tickets to Landing. Original requirement and Ship goal nodes precede Wayfinder;
question/answer nodes belong to the phase in which the user was asked. Context,
answer, phase, and step nodes are view-only, not new graph kinds or Claim buckets.
Graph metadata carries original wording, the overall objective, and recorded
answers without changing canonical ticket identities. The runner saves human
question/answer history in adjacent `<spec>.ship.answers.json`, independently of
the disposable graph cache; resume restores it. Explicit local decision Question
and User answer fields can supply historical answers. Research resolutions and
automatic gate approvals are not user answers. Missing responses stay explicit.
Web interface labels are English; source text remains verbatim, including its
original language. The page title and heading are the typed original requirement
after `/ship`, falling back to Ship Flow when none is recorded. Long text scrolls
within nodes and remains complete in details.
The optional graph `status` comes from the ledger; an absent status stays
unknown, and step descriptions never claim independently observed completion.
Node fills, borders, and labeled badges distinguish current (blue), passed
(green), upcoming (gray), and unrecorded (purple/dashed) phase states. Ticket
claims use gray/amber/green for unclaimed/claimed/closed; Track anchors use
teal, never a ticket claim. The navigation and status legend use the same
palette. Ticket claim colors appear only in the status legend, not as a
duplicate count list in the left sidebar. Descriptive steps remain neutral, without inferred completion.
Compact cards reserve explicit horizontal and vertical connection gaps; ticket
relations are orthogonal. Cross-phase, skipping, reverse, cyclic, and skipped-rank
edges use dedicated lanes outside the node columns, split left or right by the
source column so two prerequisites never share one vertical run. Concurrent exits
from one rank and concurrent entries into one rank use staggered horizontal
channels. Adjacent same-column tickets keep the prerequisite arrow in the ticket
lane; within-phase DAG edges that skip a rank also leave the columns so labels
do not sit on cards. Landing tickets use a ranked DAG with extra column
and rank gaps rather than a dense 3-wide wrap. Each decision ticket sits on the
left of its answers, which stack on the right of that cluster, so the
parent-to-answer edge is a short straight horizontal link at ticket mid-height
even when the answer card is taller. CJK source text sizes cards by display
width, not Latin character count. Unlinked answers stay a vertical sequence;
when they follow ticket columns they join from those columns rather than from
the last workflow step. Sibling dependents of one prerequisite share a rank and
fork sideways instead of stacking. Research tickets do not invent user-answer
cards. A local Wayfinder ticket's answer copy and a captured human response
share one card when they match uniquely: exact question/answer text, or the
same nonempty, non-generic answer when the question was translated or reworded.
The card keeps the ticket identity and the captured question, source, and detail.
Ambiguous matches, short confirmations, changed answers, and separate phases
remain separate; the canonical answer history is never rewritten by this view.
The current phase and its claimed tickets pulse; incoming phase sequence and
within-phase guide edges flow in the arrow direction. Incoming ticket relations
animate only for current-phase claimed targets and closed prerequisites (or Track
anchors). This represents ledger/claim activity, not observed worker or step execution.
Completed, upcoming, and unknown phases stay still; disconnected snapshots and
reduced-motion preferences suppress animation. Collapsing retains aggregate activity.
Flow arrows reverse the cache's relation direction: prerequisite → dependent,
Track → supported ticket. Layers expand/collapse without changing graph keys.
One `127.0.0.1` ephemeral port serves the HTML, bundled browser assets (no CDN),
and `/graph.json` for the TTY session. The page polls the live graph without
rebinding when `/ship` continues or a spec appears; zoom and selection survive
updates. Connection failures retain the last graph with an automatic retry notice.
The URL is pinned on the Panorama teaser and overlay title; `/ship` does not
open a browser. Off a TTY the URL is printed once. On narrow screens, node
details sit below the graph.
Distinct from the Panorama overlay and the Panorama teaser. Not a second store.
_Avoid_: dashboard, hub, site, graph UI, second port per `/ship`

**Hybrid compass**:
The spec stays durable memory; the harness `/goal` is a disarmed session
compass whose objective is `[ship]` plus the Main Track. The `/ship` runner
may auto-continue after HITL and inside landing; `/goal` stays disarmed, so
a generic goal-round cannot fight the current phase. During a run, `/goal`
shows that compass; it stays the ordinary human command, not a canned
`/ship`-style prompt. Missing or throwing goal service degrades: spec+prepend
still binds later phases.
_Avoid_: armed continuation, canned /goal, second scheduler

### Alignment pipeline

**Reference Agent**:
One of the four agent CLIs codsh aligns against: Claude Code, opencode,
Codex CLI, gemini-cli. Claude Code wins ties (ADR-0001).

**Alignment Matrix**:
The in-repo table (`docs/alignment.md`) of every interaction/feature gap and
its state. The pipeline's memory and the definition of done.

**Behavioral Probing**:
Driving a real Reference Agent in a PTY with the VT emulator and diffing its
observable behavior against codsh. Used only when knowledge and source
reading leave a dispute.

**Batch**:
One user-initiated autonomous run of the pipeline: pick open matrix rows,
implement, pin with tests, verify in the real TUI (PTY e2e or
`MOCK=… pnpm run dev`), sync, changeset, report.
