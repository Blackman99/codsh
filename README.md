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
- `codsh --rust -p "task"` — One plain dsh answer on stdout, then exit
- `codsh --continue` — Continue the last session
- `codsh --resume <id>` — Resume a specific session
- `codsh update` — Update launcher and profile runtime

## Isolated Rust client (local candidates)

`codsh --rust` explicitly selects the parallel Rust client; plain `codsh` keeps
using the existing version. The Rust UI submits prompts over ACP/JSON-RPC to a
real `dsh --profile acp` process in the isolated Home. `codsh --rust agent stdio`
is the editor entry for that same dsh session: ACP version 1, `session/new`,
`session/load` (dsh resume plus read-only history replay), `session/prompt`,
`session/cancel`, `session/set_config_option` (model, reasoning effort, and
`permission_mode`), and approval requests. Model and reasoning changes are
written to `$GROK_HOME/model-selection.toml` before the next prompt and restored
on `session/load` and on a terminal resume, including an advertised model that
is not a `config.toml` catalog id. A model that is neither is refused. Terminal
`/dontAsk` and `/acceptEdits` set the same session modes, and that mode is on
the policy file before dsh starts. Proprietary `x.ai/*` methods,
`session/delete`, `session/fork`, and `session/set_mode` return JSON-RPC
method-not-found. Closing the editor releases the write owner; a second client
is refused while it is held. In Zed, add a custom agent server whose command is
the installed `codsh` with arguments `--rust`, `agent`, `stdio`. This checkout
did not launch Zed or another GUI editor; the repeatable check is an external
ACP client over stdio.

Sharing is opt-in; a plain launch starts no service and opens no port.
`codsh --rust agent serve` serves the same ACP over an authenticated WebSocket
(`/ws`, default `127.0.0.1:2419`). The secret comes from `--secret`,
`GROK_AGENT_SECRET`, or is generated and printed once; clients send
`Authorization: Bearer <secret>` or `?server-key=<secret>`, and a non-loopback
`--bind` prints a warning. `codsh --rust agent leader` runs a per-user leader on
`$GROK_HOME/leader.sock` (mode 0600, same-user peers only). `agent --leader stdio`,
or `[cli] use_leader = true`, starts or reuses it for an editor; `--no-leader`
wins. One dsh process runs each live session. `session/load` of a session the
process already runs attaches without a second executor: saved turns, the
running turn, and a pending approval are sent again. Approval requests reach
every attached client; the first answer wins, and a late one gets
`_codsh/stale_response`. A second prompt during a turn is refused, not queued.
Option changes reach the other clients as `config_option_update`. A client
disconnect never cancels a turn. A dsh exit is reported as
`_codsh/runtime_exited`; the running turn's effects are unknown and nothing is
retried. A sandbox profile other than `off` keeps the session in the editor's own
process instead of the leader, and a leader client cannot bring its own model or
permission flags. `codsh --rust leader list|info|kill` inspects and stops
leaders. `agent headless`, `--remote`, `--grok-ws-url`, and Cursor worker mode
need official services and are refused. The leader is Unix-only; it was checked
on Linux, not on macOS or Windows.

Streamed answers, provider
thoughts, empty replies, and failures are shown as dsh reports them; a protocol
mismatch or missing dsh is refused instead of faked as success. It reuses licensed
Grok Rust UI components, requires no official account, and does not start the
legacy Bundle, official agent core, update check, telemetry, or feedback upload.
Enter submits the draft through dsh when connected, or reports that execution is
unavailable without sending it. File read, write, and edit run through real dsh
tools. A shell command runs through dsh's bash tool: the card shows stdout,
stderr, and the exit code, including 0. A non-zero exit is not shown as
success. Ctrl+C cancels the running command and dsh reports it as aborted.
A denied command does not run. dsh's persistent terminal is not mounted in
the acp profile, and window resize is not a dsh tool, so an interactive
terminal session is unavailable. Background jobs use the same bash tool. `--sandbox <profile>` (`GROK_SANDBOX`, or `[sandbox] profile` in the
isolated `$GROK_HOME/config.toml`) applies Seatbelt on macOS or Landlock on
Linux to this process before dsh starts. `off` is the default and adds no
confinement. `workspace` reads broadly and writes the workspace, `$GROK_HOME`,
and temp directories. `read-only` and `strict` narrow writes. `devbox` does not
write-protect global hook or config files; a custom profile that extends
`devbox` still kernel-enforces its `deny` list. Custom profiles live in
`$GROK_HOME/sandbox.toml` or `.grok/sandbox.toml` (`extends`, `read_only`,
`read_write`, `deny`). A symlink `$GROK_HOME`, a symlink in a `hooks-paths`
target, a missing hook target, a malformed profile, or a kernel that cannot
apply the policy refuses startup instead of continuing unconfined. When
`$GROK_HOME/sandbox.toml` and `.grok/sandbox.toml` define the same custom
profile differently, startup uses the user file, warns, and names both paths.
Identical definitions do not warn. A relative deny glob stays inside the
workspace: `**` matches path segments there and does not deny a sibling
directory or a same-prefix path. `**` is only a whole path segment (`**/`,
`a/**`); an attached form such as `**.pem` or `certs/**.pem` refuses startup.
Seatbelt checks resolved paths, so every deny path and the literal prefix of
every deny glob is resolved through its deepest existing ancestor (for example
`/tmp` to `/private/tmp`, or a symlinked directory to its target) and both
forms are denied. That also covers a denied file created after launch. The
workspace a relative glob is anchored at is literal even when its name
contains `[`, `*`, or `?`. A deny path under a dangling symlink, or one with a
control character, cannot be written as a matching kernel rule and refuses
startup. A deny glob is anchored at its literal prefix, so that prefix
directory and its existing ancestors up to the write root are pinned against
rename or unlink. The walk stops at the resolved write root: `/tmp` and
`/private/tmp` are the same root, so a workspace under `/tmp` does not pin
`/tmp` or `/private/tmp` themselves, and a workspace-anchored glob does not
pin a directory outside that workspace. A directory inside the glob tail, including one created
after launch, is pinned the same way by a directory regex: Seatbelt matches
the resolved path, so renaming that directory onto another write root would
carry a matched file out from under the regex. Seatbelt only sees the source
path, so a rename that stays inside the glob is denied as well.  A sandboxed child cannot use launchd (`launchctl submit`,
`launchctl bootstrap gui/$UID`) to get an unconfined process to read a denied
file: this escape is kernel-blocked under the profile, matching the reference
nono profile's `mach-lookup` rules (a probe confirms it succeeds only when the
sandbox is off).
A `.` or `..` segment anywhere in a deny entry, including `a/./secret`, also
refuses startup. `[!a]` and `[^a]` both negate in the macOS
profile. A POSIX class, an empty `//` segment, a trailing slash, or a caret
that would be literal is refused instead of applied. `codsh --rust inspect` and `inspect --json` do not apply the sandbox. They
print the resolved profile and every config error, including a broken
`fail_closed` file, instead of stopping at the first one. A non-inspect launch
still refuses that file before dsh starts. `[sandbox] profile` is
read by the same config loader as inspect: a signed `requirements.toml` pin
beats `--sandbox`, `GROK_SANDBOX`, `GROK_CONFIG` / `GROK_CONFIG_PATH`, and
every file below it. A managed default does not; those sources override it.
An untrusted project file does not select the profile, and naming a custom
profile with `--sandbox`, `GROK_SANDBOX`, or a requirements pin does not trust
`.grok/sandbox.toml`. A definition that exists only in that untrusted file
refuses startup. A user `$GROK_HOME/sandbox.toml` definition stays usable and
still wins when both files define the name. The untrusted project file is not
applied. A body that parses is compared only so a disagreement can name both
paths; a malformed, unreadable, or symlinked untrusted project file does not
veto the user definition. A trusted project file that is malformed still
refuses startup. `[sandbox]` is a known
policy key in the user config and in a trusted project config, including when
signed `fail_closed` requirements are active. On macOS
every existing ancestor of a protected path up through the write root that
contains it, not only its immediate parent, cannot be renamed onto another
write root. Linux
Landlock cannot deny a path inside a write root, so a profile that needs that
protection refuses startup there instead of applying an allow-only policy.
The status
line names the active profile and its write roots. Protected config and hook
files stay unchanged; a permission-mode change is kept for the session only.
`restrict_network` (built-in `read-only` and `strict`, or a custom profile)
denies network for this process and its children with macOS Seatbelt
`(deny network*)`. A profile that leaves it off still allows network. dsh's
per-call file mode is not this control and is not a network sandbox. Linux
Landlock network blocking is a different mechanism and is not claimed from a
macOS run: a profile that asks for network isolation refuses startup there
instead of continuing with network open. Windows network confinement is not
implemented and refuses the same way. `[shell_environment_policy]` in
`sandbox.toml` (`inherit` `all`/`core`/`none`, `exclude`, `include_only`,
`set`, `ignore_default_excludes`) filters the environment of a shell child
this client starts, including `sh -c`. Names matching `*KEY*`, `*SECRET*`,
or `*TOKEN*` are dropped unless `ignore_default_excludes` is set. An unknown
`inherit` or a pattern that is not a `*`/`?` glob refuses startup. When that
policy is active, the filtered map is the environment of the dsh process
spawned afterwards, so dsh's bash tool sees it too: dsh builds that child
from its own environment and only adds keys. With no policy, dsh keeps the
launch allowlist. A second Seatbelt profile is still not applied inside this one. A process already under
Seatbelt cannot apply another Seatbelt policy, so dsh's own per-call bash
sandbox cannot run inside a codsh profile. While a profile is applied, codsh
starts dsh with its per-call file mode set to `danger-full-access` (written
to `$DSH_HOME/codsh-kernel-sandbox.yml`). Approvals are unchanged, and the
kernel policy confines dsh, its bash children, and child agents instead; a
write is then bounded by the profile's write roots rather than dsh's
workspace-write fence. Linux and Windows are not marked supported by a macOS
run. Allow/ask/deny rules, remembered project grants, and permission modes
(`ask`, `auto`, `always-approve`/`--yolo`, `dontAsk`, `acceptEdits`) are
enforced before a dsh tool runs. Explicit deny, hook blocks, and locked
always-approve survive `--always-approve` and old grants. Released dsh does
not run Grok hooks, so `codsh --rust` runs command hooks from
`$GROK_HOME/hooks/*.json`, trusted `<project>/.grok/hooks/*.json`, and the
`hooks` table in `config.toml` at SessionStart, UserPromptSubmit, PreToolUse,
PostToolUse, Stop, and SessionEnd (Cursor camelCase aliases included). Exit 2
or `{"decision":"deny"}` blocks the prompt or tool; any other non-zero exit,
timeout, or malformed output is a recorded failure and does not look like
success. Hook stdout and stderr are shown as hook output, not as the model
answer. An allowing hook does not skip the permission check, and a hook
cannot widen a sandbox or permission deny. Untrusted project hooks stay
skipped. HTTP hooks are not run. A `updatedInput` rewrite is not applied;
that call is blocked instead of running the original arguments. Unsplittable shell
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
permanent global rule; a failed save still allows once. File search uses dsh `grep` and `glob` (packaged ripgrep, not a shell). A result is capped (`glob` 100 paths, `grep` 250 matches) and says how to read the rest; a larger `grep` keeps the complete list in the spill store when one is mounted. `read` pages with `offset` and `limit` and says the next offset. An empty search says `No matches found` or `No files found` and invents nothing. A binary file is `binary file` / `FS_NOT_TEXT`, not decoded text. A file that changes after it was read fails the edit with `FS_STALE_VERSION` and is left unchanged. Code navigation is dsh `lsp` (`goToDefinition`, `findReferences`, `goToImplementation`, `hover`). With no language server configured the call fails (`no LSP provider handles` the file; dsh code `LSP_UNAVAILABLE`) and returns no location. A Read/Edit deny covers a named search root, every grep/glob hit, and a shell search operand such as `rg`; a denied file is omitted from both the model result and the tool card, and switching to another tool does not reveal it. Missing files, tool
errors, cancelled or duplicate approval replies are shown as failures, never as
success. `Ctrl+C` clears a non-empty draft without cancelling work; an empty
draft cancels the running turn through dsh `session/cancel`. Esc never cancels a
turn or a pending approval — it dismisses selection and reminds you to use
`Ctrl+C`. Cancelled tools cannot run from a late allow or process teardown; unknown
external results are shown as cancelled, not success. After cancel, the prompt
accepts a new turn. Idle empty `Ctrl+C` still quits before any turn exists.
`codsh --rust -p "task"` (or `--single`, `--prompt-file <path>`, `--prompt-json <blocks>`) runs one prompt through the same dsh ACP session and prints only the final answer on stdout. `--verbatim` sends that user content unchanged and does not expand custom slash commands. Rules from files, `--rules`, and `--system-prompt-override`, plus enabled first-turn memory, still apply: they lead as their own block ahead of your exact bytes (dsh joins adjacent text blocks, so the model sees the rules and notes, then your prompt). dsh receives codsh rules as prompt context, not as a separate system prompt. Permission policy stays on the tool channel. A plain turn has no time limit: it ends when dsh finishes or fails, or on a signal. Thoughts, tool cards, and errors stay off stdout; diagnostics go to stderr. `-c`/`--continue` or `-r`/`--resume <id-or-title>` with a plain prompt continues that session, and `--fork-session` copies it. `--max-turns <N>` stops before model step N+1 and says so on stderr. `--tools` and `--disallowed-tools` mask tools before the first model request; public ids such as `read_file` and `Bash` map to dsh names, `Agent` removes every registered subagent spawn tool (`subagent` and `subagent_fork`), and `--disallowed-tools Agent(type)` in any letter case removes those subagent types (see Subagents below); `--tools Agent(type)` and `Agent()` are refused before any provider call, and so is a typed entry in an inherited `CODSH_PLAIN_TOOLS`. Deny wins when both are set, and an unknown name is an error. A `CODSH_PLAIN_TOOLS` or `CODSH_PLAIN_MAX_TURNS` value inherited from a parent process follows the same rules in a plain prompt; interactive sessions ignore both. `--allow`/`--deny` still gate execution and do not remove the tool. `--tools`, `--disallowed-tools`, `--max-turns`, and `--verbatim` are headless flags: without a plain prompt they print a warning and are ignored. `--cwd <path>`, `--sandbox <profile>`, `--no-memory`, `--no-subagents`, and `--disable-web-search` work for plain prompts and interactive sessions alike. `--cwd` is entered before config, trust, and the sandbox are read, so the sandbox write root is that directory. A relative `--prompt-file` is read after `--cwd` is entered, so it names a file inside that directory. A relative `--trust-folder` or sandbox report path still names a file beside where you ran the command. `--no-memory` keeps notes out of the first prompt. `--disable-web-search` turns web search and web fetch off for the process and removes `web_search` and `web_fetch` from the model's tool list. `-m` is `--model` and `-v` is `--version`. A second prompt source is rejected before a provider call. A positional prompt does not start plain mode, and piped stdin is not the prompt. `codsh --rust help` and `-h` print help; `completions bash|zsh|fish|powershell|elvish` prints a script for that shell. `--output-format` is `plain` (the default, final answer only), `json` (one object: `text`, `stopReason`, `sessionId`, `requestId`, and `thought` when dsh sent reasoning), `streaming-json` (one ACP-shaped object per line, last line `end`), or `streaming-messages-json` (`system`/`init`, then `assistant` and `user` messages, last line `result`). `--include-partial-messages` adds `stream_event` deltas and changes only `streaming-messages-json`; other formats print a warning and ignore it. Tool arguments, tool results, and reasoning are copied from the dsh update and are not rewritten. `usage` is copied only from a prompt `_meta.usage` object dsh sent. When that object is absent the terminal object says `usage_absent: true` and does not invent token counts or cost. A partial `message_start` also omits `usage` until dsh sends a ledger. A truncation stop (`max_tokens`), a model error, and SIGINT/SIGTERM (130/143) end the process and do not report `end_turn` success for a turn that failed. A tool approval with no terminal is rejected inside dsh and exits 1; the file is unchanged. `json` and `streaming-json` print `{"type":"error",...}` and `streaming-messages-json` prints `result` with `is_error: true` and a subtype other than `success`. None of them say `end_turn`. The same prompt through `plain` and through `json` uses the same dsh session path, so the file side effects and stored session match. Agent selection, plan, worktrees, `--experimental-memory`, `--memory-flush`, and `--json-schema` name the flag and remain later tickets. `-r`/`--resume` without a value is not the most-recent-session shortcut yet (ticket 159 owns it). Unknown options and missing values exit 2. SIGINT exits 130 and SIGTERM exits 143, also while dsh is still starting, and a dsh or provider error exits 1.
Subagents in `codsh --rust` are created and run by dsh. The model's `subagent` tool takes `subagent_type`: `general-purpose` (every tool the parent has), `explore` and `plan` (read, search, and shell, but no write or edit), a `[subagents.roles.<name>]` role (`description`, `default_capability_mode` = `read-only`, `read-write`, `execute`, or `all`, `model`, and `prompt_file` under `$GROK_HOME`), or an agent file in `.grok/agents/` or `$GROK_HOME/agents/` (its `tools` and `model` front matter). The type's capability becomes a dsh tool allow-list, so a removed tool is missing from the child's tool list and refused if called anyway. A tool dsh cannot classify, such as an MCP tool, is kept only by `all`. A child inherits the parent's permission mode, rules, hooks, and sandbox; it cannot answer an approval itself, so an ask inside a child is rejected. The parent's own approval policy still covers the spawn call. A model from `[subagents.models]`, a role, or an agent file is checked before the child starts; if it is unavailable the spawn is refused and nothing runs. `[subagents] enabled = false`, `GROK_SUBAGENTS=0`, or `--no-subagents` removes the tool. `max_concurrent` or `GROK_MAX_CONCURRENT_SUBAGENTS` (default 32; 0 becomes 1) counts running children per session, and `limit_behavior` or `GROK_SUBAGENT_LIMIT_BEHAVIOR` either queues a spawn until a slot frees (`queue`, the default) or refuses it (`fail`). `max_depth` or `GROK_SUBAGENTS_MAX_DEPTH` (default 1) caps nesting. `[subagents.toggle] <type> = false` hides a type, and with a plain prompt `--disallowed-tools Agent(type)` or `Agent(type, other)` removes those types (an unknown type refuses every spawn; `--tools` cannot allow `Agent` or a type; `Agent()` is an error). `run_in_background: true` returns a dsh job id at once; the model collects the result with `job_output` and it is delivered once. The tool block reads `Subagent running`, `started` (background), or `queued`, then `completed`, `failed`, or `cancelled` with the elapsed time, and the status line counts children that are still running. `/tasks` (or Ctrl+G in fullscreen) opens the task list: ↑/↓ select, Enter or Ctrl+F opens a read-only transcript of that child, `x` cancels it, `h` hides finished ones, and Esc or `q` closes. Ctrl+C in the child view cancels only that child; Ctrl+C on the parent turn cancels its foreground children, while a background child keeps running until it finishes or you cancel it. Child sessions are not listed by `/resume` or `sessions list`. Messaging a child, `resume_from`, worktree isolation, personas, and `--agent` are later tickets; the type validation deadlines of the reference (remote type RPCs) do not apply because types resolve locally. `subagent_fork` is not counted against `max_concurrent`.
`codsh --rust --continue` resumes the last dsh session in this directory;
`--resume <id-or-title>` loads that session. A UUID is always an id. A title matches every workspace, ignoring letter case; one manual `/rename` wins over auto-generated duplicates, and remaining duplicates list their ids. `codsh --rust sessions list` and `sessions search <query>` read the isolated dsh Home across workspaces, then apply `--limit`. Search labels a manual title as `title` and a generated title or conversation text as `content`. An empty result does not invent a session. `codsh --rust export <id> [file]` writes that session as Markdown and keeps the stored user text, assistant text, tool name, tool result, and attachment path. It says the copy is not a redaction. `-c` / `--clipboard` copies the same transcript. `/export [file]` does this for the current session and uses the clipboard when the path is omitted. An extra argument is rejected before any file is created. A symlink used as the sessions root, a project directory, a session directory, or the session log is refused and is not read or uploaded. `codsh --rust share <id>` and `/share` upload only when you run them and only to the selected `endpoints.share_url`, `CODSH_SHARE_URL`, or `--url`. A missing service, a failed post, a redirect, a timeout, an oversized response, an untrusted HTTPS certificate, or an official `grok.com`, `api.x.ai`, or `sentry` host is an error and uploads nothing. HTTPS uses the native TLS connector and a configured `GROK_EXTRA_CA_BUNDLE` or `SSL_CERT_FILE` extra root. Redirects are not followed. `sessions delete <id> --yes`, `/delete`, `/resume` `d` then `y`, and dashboard `Ctrl+X` twice are blocked. Released dsh persistence has create, open, flush, stat, and list, and no deletion operation, so no session directory, log, attachment, or sidecar is removed. `n` or Esc on `/delete` cancels the prompt and also removes nothing. `codsh --rust du` (alias `disk-usage`, `--json`) lists isolated-home directories, largest first, including the isolated dsh tree beside `$GROK_HOME`. It does not delete files and does not measure worktree pools. `--fork-session` with `--resume`/`--continue`
copies that conversation into a new dsh session id. `/rewind` and `/undo` (or idle
empty Esc Esc) fork conversation-only history through dsh; `/fork` copies the
current history into a new session. Disk files are not restored; `--restore-code`
is refused. The UI restores persisted turns from the
dsh log (not a second store). Interrupted or never-finished tools show
`[interrupted]` / unknown and are not replayed. Fullscreen and minimal paint
that marker, `[cancelled]`, `[empty answer]`, and a compaction sentence on the
transcript itself; a finished tool whose status is unknown is not treated as
an interrupted turn. A second client that cannot
take write ownership is refused instead of forking a duplicate executor.
Default fullscreen uses the alternate screen. `/minimal` (or `--minimal`)
switches to native terminal history through the official inline renderer;
`/fullscreen` (alias `/full`) switches back. `/rewind` and `/fork` in minimal
replace that native buffer instead of appending discarded turns. Official `xai-grok-markdown` renders streamed Markdown, tables, code, mermaid labels, thoughts, and dsh tool cards/diffs, and the session keeps those heading, code, table, and diff colors. Pretty mode matches official markdown, so `Vec<T>`, comparisons, fenced Rust, and inline HTML tags stay visible, and it keeps ZWJ emoji in one cell; a failed tool paints `failed` and `[error]` in a failure color instead of success. Esc closes full content and restores the folded transcript. Long bodies fold; Tab then `l`/`→` expands, `r` toggles raw markdown, Enter opens full content, and `y` copies original bytes. `/expand` reprints the last folded block in minimal; `/transcript` (`/log`) opens the exact transcript in `$PAGER`. The switch stays in process, so a
running dsh turn, draft, and pending approval survive. `--minimal` /
`--fullscreen` and `GROK_SCREEN_MODE` are session-scoped and do not rewrite
isolated `[ui] screen_mode`. `/dashboard` (aliases `/agents-dashboard`, `/sessions`) and `codsh --rust dashboard` with `GROK_OPEN_DASHBOARD_AT_STARTUP=1` open the agent dashboard in fullscreen. It lists the same session id, title, activity, and unread mark as `/resume` and `sessions list`. `Ctrl+/` filters, `Ctrl+R` renames the selected row, `Ctrl+T` pins it, and `Ctrl+G` toggles state versus directory grouping. Minimal mode refuses the dashboard and tells you to run `/fullscreen`. `/resume` opens the session picker; typing filters titles and then conversation content under `Extended search results`. Selecting a session resumes that dsh id and does not copy the previous session's output into it. A selection whose directory does not match, or whose write lock is already held, stays on the session this client already owns and shows `occupied`. A same-directory resume that dsh refuses as already active does not close the live session; the open picker or dashboard shows `already active` and stays open. `/rename <title>` (alias `/title <title>`) stores a manual title that automatic generation never overrides. `/rename --auto` and bare `/title` hand the title back to the configured model (`base_url`, model id, and credential). The prompt is sent only to that provider; it is not written into the notice, the URL, or a debug log. A missing model or credential is an error, not a fallback title. `/new` starts a new dsh session and keeps the configured provider, model, effort, permissions, and settings patch. A dashboard dispatch does the same. Neither falls back to another provider. `/cd` reloads trusted workspace config for that next session. `/clear` clears only the visible transcript. `/session-info` (alias `/info`) shows the title, id, directory, model, and activity. `/memory` (alias `/mem`) browses local notes under `$GROK_HOME/memory`. Global notes apply to every project. Workspace notes follow the Git `origin` in `org/repo` form, so clones and worktrees of that repository share one directory and a different project does not. The file list is separate from the generated index. Enter previews a note read-only, `/` filters names and contents, `y` copies the path, `x` then `x` deletes a session note, and `t` toggles memory for this session without rewriting `config.toml`; notes are only sent on a session's first prompt, so once that prompt is already sent, toggling `t` on reaches no prompt in this session, and `/new` drops the toggle and follows `config.toml` again instead of carrying it forward. `MEMORY.md` cannot be deleted from the browser, including a human note and a generated index. The modal keeps the selected file highlighted. Under 80 columns the preview is hidden until Enter. `/remember [text]` asks for confirmation before appending to the workspace `MEMORY.md`; `n` or Esc writes nothing. With no text, the next line is the note. A save confirms `Memory saved to` that `MEMORY.md`. Memory stays off until `[memory] enabled = true` or `GROK_MEMORY=1`. An explicit `[memory] enabled = false` stays off even when `GROK_MEMORY=1`; `/memory` still opens so `t` can turn that session on without rewriting `config.toml`. `/new`, a session switch, `/fork`, and `/rewind` drop that toggle and follow config again. `--no-memory` and `GROK_MEMORY=0` hide `/memory` for the process and do not delete files. On the first turn of a new session, the dsh prompt includes a bounded copy of the global and workspace `MEMORY.md` notes and not a generated index. A keyword in that turn also includes matching session logs. Later turns in the same session do not repeat the block. `/cd` then `/new` reads the new directory's workspace and does not carry the previous project's note. `codsh --rust memory clear` (`--workspace` by default, or `--global` / `--all`) deletes only that scope after `--yes`. Workspace clear removes that scope's `MEMORY.md`, `sessions/`, and `index.sqlite`. Global clear removes only the global `MEMORY.md`. Disabling memory never uploads notes. `index.sqlite` is a SQLite FTS5 keyword index. A damaged index is reported and rebuilt from the notes; it does not overwrite them. A SQLite file that is not this index is left unchanged. Automatic capture, embeddings, and Dream consolidation are not this command. `/cd [path]` sets the directory for the next new agent and leaves the current session's history where it is. A missing path, Escape, or cancel keeps the previous directory. A second client that cannot take the write lock is shown as occupied and does not mutate the other history. Mode-only commands such as `/dashboard` in
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
On macOS, Ctrl+V reads an image from the clipboard. A terminal delivers Cmd+V
as a bracketed paste; an empty one (what an image-only clipboard sends) reads
the clipboard image the same way, and a paste that is only whitespace inserts
nothing. Windows clipboard images are not implemented yet: Alt+V and an empty
paste say so and attach nothing (left to the Windows and cross-platform
tickets #200/#201). Linux reads through `xclip` or `wl-paste` and is likewise
unverified here. Pasting or dropping the
absolute path or `file://` URL of an image file attaches that file as an image;
a relative name, prose, or a mix with other paths keeps the existing text or
`@file` handling. A bracketed paste that starts with `codsh-image:` or
`data:image/...;base64,` also attaches an image. The draft shows an atomic `[Image #N]` chip. While the pointer hovers that
chip, or the cursor rests on it, the notice is `Pasted image #N` plus the
sniffed size (png, gif, jpeg, or webp), the byte length, a short digest, and
the saved path when the text-only route stored one. That is the frozen guide
03 overlay: metadata, not a Kitty, OSC 1337, or half-block picture. Backspace
removes the chip and its bytes together. A model whose
`input_modalities` includes `image` receives an ACP image block (`data` is
canonical base64, `mimeType` is png, jpeg, webp, or gif). A model that omits
`image`, or does not declare modalities, does not receive that block: the
original is saved under the isolated dsh home `attachments/pasted/` and the
prompt carries a `<pasted-image>` path. On that route the attach notice says
the model cannot see images and gets only the saved path. Rules, session
rules, and the first-turn memory note wrap the user's text once; they are not
copied onto that `<pasted-image>` element or an attached file body. No second vision
provider is called. An empty clipboard, a file that is not a png/jpeg/webp/gif,
and a file over 256 KiB stay in the composer with a notice and are not sent.
`GROK_CLIPBOARD_NO_NATIVE_READ` disables the macOS pasteboard read even when
set to `0`; `CODSH_CLIPBOARD_IMAGE` is the controlled file used instead.
The packed launcher forwards both, so an empty fixture is what the session
reads. Switching `/model`, `/minimal`, or `/fullscreen` keeps the same chip
and the parked image bytes, not only the placeholder text. Closing the model
menu puts that draft back. Like the reference, the draft lives only in the
running process: nothing about it is written to disk, the next launch in any
project starts with an empty composer, and a sent prompt never comes back. An
exec relaunch (`GROK_SCREEN_MODE_SWITCH=exec`) resumes the session, not the
draft. `--resume` shows a sent image turn with its `[Image #N]` placeholders,
as the live row did (the text-only `<pasted-image>` path is model input, not
typed text), and sends nothing again. A prompt queued under one model is
rebuilt for the model selected when it sends: a text-only model gets the path,
not the image block that was queued earlier.
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

`codsh --rust web search <query>` and `codsh --rust web fetch <url>` (`--json`)
call the configured substitutes. In a session, dsh's `web_search` and
`web_fetch` call that same command. Search and fetch are enabled separately.
A side that is off is not registered, so the model is not offered it. Search
uses `[models] web_search` or `GROK_WEB_SEARCH_MODEL`, and that model's
`base_url`. `[model.<id>] protocol` selects the wire format. `responses`
(the default) sends one OpenAI Responses request and needs a credential.
`searxng` sends a keyless GET to `{base_url}/search?q=...&format=json` and
reads `results[].url`, `results[].title`, and `results[].content`. No API
key is sent. `supports_backend_search` records that the substitute does the
retrieval. For `responses`, the credential is that model's `env_key` when
the env var is non-empty, otherwise the model's inline `api_key`. An empty
inline key is not configured. `searxng` is configured without either.
`[toolset.web_search] allowed_domains` and
`excluded_domains` are mutually exclusive; if both are set, the allowlist wins
and the blocklist is dropped with a warning. An empty or absent search list is
unbounded. The shipped dsh `web_search` tool has no domain argument; a
configured list is what a `responses` substitute receives in its tool filters.
A `searxng` request does not include that list. Result URLs are kept only
when they match the same allow or deny rules, so a model argument cannot
widen the allowlist. Official hosts stay refused for the instance and for
result URLs. Fetch turns on with
`[features] web_fetch` or `GROK_WEB_FETCH=1`. `GROK_DISABLE_WEB_FETCH` and
`disable_web_search` turn the matching tool off. Guide 26 marks
`features.web_fetch` and `models.web_search` as requirements pins: a
requirements value beats the user file, env, and managed config. The domain
lists and `proxy_endpoint` are requirements `yes` and managed `user`, so the
user file overrides a fleet default and a requirements value. Managed config
is not a lock.
`[toolset.web_fetch] allowed_domains` overrides the built-in public-doc list.
An entry may be `host`, `host:port`, `host/path`, or `host:port/path`. An
explicit empty list blocks every fetch. Every redirect is checked again,
including the path prefix, port, and private-address rule. `proxy_endpoint` /
`GROK_WEB_FETCH_PROXY` is the only egress route when set: proxy failure does
not fall back to a direct connection. The supported proxy is an `http`
CONNECT proxy; an `https` origin is tunneled and then checked with the same
native TLS roots as other HTTPS calls. `allow_local` / `GROK_WEB_FETCH_ALLOW_LOCAL` adds only
explicit loopback hosts. Private, link-local, and cloud-metadata addresses
stay blocked. A name is refused when any resolved address is private, and the
connection uses an address from that check. Cross-host redirects are reported
and not followed. Authentication, rate limits, cancellation, and network
failures return an error and no response body. `--json` carries search
`citations` and fetch `url`, `status`, `contentType`, `content`, and
`truncated` beside the human-readable `text`. `content` is the page itself;
the session uses that field and does not split it out of `text`. A chunked
body is read by chunk size, so a payload that contains the chunk terminator
is not cut off. The message ends at the blank line after the zero-size
chunk, including when that chunk is followed by trailer fields. Cancelling
closes the socket and does not return a late body.
`codsh --rust inspect` names the file that set a web value: a managed-only
list is `managed`, not `config.toml`. Policy is read at startup and does not
change mid-session. Official
hosts are refused. A `responses` search costs that one model request.
`searxng` and fetch have no account charge. The Responses-shaped substitute
is checked with a local fixture. The SearXNG protocol is checked the same
way, and also against one real SearXNG process bound to localhost on this
machine. A public SearXNG host is not part of this check.

User configuration for the preview is `$GROK_HOME/config.toml` (default
`~/.codsh-rust/.grok/config.toml`). `[ui] theme`, compact mode, timestamps,
status line, `confirm_before_rewind`, and `ui.fork_secondary_model` are stored
in that same file. Compatible `[model.<id>]` fields
(`base_url`, `env_key`, `api_key`, `model`, `name`, `provider`, `api_backend`,
`supports_reasoning_effort`, `reasoning_efforts`, `reasoning_effort`,
`context_window`) plus `models.default` / `models.default_reasoning_effort`
map into isolated dsh `settings.yaml`; the two files are not competing sources.
`provider` defaults to the catalog id. Two entries that name the same provider
and share the key, backend, URL, and headers become two models under that one
provider. A second entry that reuses the provider with different credentials
or a different backend is refused instead of writing a duplicate YAML key.
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
Hooks, plugins, and project capabilities do not execute. Trusted folders load
compatible project rules, skills, agent definitions, and custom commands and
send that context to dsh. Home rules (`$GROK_HOME/rules/*.md`, enabled
`~/.claude` and `~/.cursor` rules, and absolute or `~/` `[paths]
extra_rule_dirs`) load in every project. Relative or missing extra directories
load nothing and are diagnosed. Project files load from the git root down to
the working directory: `Agents.md`, `Claude.md`, `CLAUDE.md`,
`CLAUDE.local.md`, `AGENT.md`, and `AGENTS.md`, plus direct `*.md` files in
`.grok/rules/` (and enabled `.claude/rules/` and `.cursor/rules/`). Deeper
files are later in the prompt. Gitignored instruction names such as
`CLAUDE.local.md` are skipped; there is no per-file character cap. Skills come
from `.grok/skills/` and `.agents/skills/` at the working directory, then each
ancestor up to the git root, then the user roots, plus enabled Claude/Cursor
skill roots and `[skills] paths`. A closer directory outranks a broader one;
two skills with the same name in one directory both stay invocable under a
qualified name. Nested `SKILL.md` files use the frozen walk: depth starts
at the first directory under the skill root and returns only when depth is
greater than five, so `.grok/skills/a/b/c/d/e/f/SKILL.md` loads and a seventh
directory does not. A directory that already has `SKILL.md` is still entered,
so its child is recorded. A configured `[skills] paths` directory is
depth 0: its own `SKILL.md` loads, its children start at depth 1, and a sixth
child is not loaded.
`paths.extra_skill_dirs` is not a discovery root. `[skills] ignore` hides a
path. `[skills] disabled` keeps the skill listed, including its body, but not
invocable. `user-invocable` defaults to true; only `false`, `no`, `off`, or
`0` hides it from the menu. A skill body sent to dsh is capped at 25,000
tokens and the truncation is diagnosed. Flat `commands/*.md` files under
`.grok/commands/`, `.agents/commands/`, and enabled `.claude/commands/` are
slash commands, not skills. Skill roots are not filtered by `.gitignore`.
`GROK_CLAUDE_SKILLS_ENABLED` and `GROK_CURSOR_SKILLS_ENABLED` are forwarded by
`codsh --rust` and turn those vendor scans off. `inspect --json` is one JSON
object with top-level `assets.skills` and `assets.commands`. A native candidate
staged before that catalog still returns those arrays: the launcher fills them
from `.grok` skills and commands, and skips `.claude` or `.cursor` when the
matching flag is off. Vendor default names `shell`, `canvas`, and `statusline` are
dropped only under `.claude/` and `.cursor/`. A name that collides with a
built-in keeps the built-in on the bare name (`/compact`, `/login`,
`/logout`, `/feedback`) and offers the asset as `/local:name`,
`/ancestor:name`, `/repo:name`, or `/user:name`. The menu does not list the
bare name for that asset, and submitting the bare name runs the built-in.
`--rules` (alias `--append-system-prompt`) appends a `<human_rules>` block for
this session. `--system-prompt-override` (alias `--system-prompt`) replaces
file rules and `--rules` in the text sent to dsh; the typed prompt is still sent. Gitignored project
instruction files, including `*.local.md` and ignored directories, are skipped.
Disabled or non-user-invocable skills do not appear in the menu.
`/reload-assets` rescans after files are added or removed; an empty project
directory adds no project commands. `inspect` lists each asset's source,
enabled state, collision, and truncation. Untrusted projects still show global
rules but do not inject project rules, skills, commands, or agent definitions.
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
