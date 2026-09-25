mod acp;
mod appearance;
mod assets;
mod attachments;
mod auth;
mod background;
mod config;
mod content;
mod control;
mod dropped_paths;
mod editor_acp;
mod extra_ca;
mod feedback_ui;
mod filesystem_sandbox;
mod goal;
mod headless;
mod images;
mod import;
mod interaction;
mod mcp;
mod mcp_proxy;
mod memory;
mod memory_ui;
mod models;
mod navigation;
mod permission;
mod plugin;
mod privacy;
mod privacy_cmd;
mod prompt_edit;
mod prompt_queue;
mod scheduler;
mod screen_mode;
mod session_catalog;
mod session_data;
mod session_fork;
mod session_history;
mod session_owner;
mod settings_ui;
mod shared_server;
mod status_line;
mod subagents;
mod theme;
mod trust;
mod voice;
mod web;
mod welcome;
mod workflow;
mod workflow_catalog;
mod workflow_host;
mod worktree;
mod ws;

use acp::{AcpClient, AcpEvent, PendingPermission};
use crossterm::cursor::{Hide, Show};
use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode, KeyEventKind, KeyModifiers, KeyboardEnhancementFlags, MouseEventKind,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};

use crossterm::execute;
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use navigation::{Focus, FrameLayout, NavCommand, NavEntry, NavOverlay, NavState};
use prompt_edit::{Action as PromptAction, HostContext, PromptComposer, VoiceGesture};
use ratatui::{TerminalOptions, Viewport, backend::CrosstermBackend};
use screen_mode::{
    GROK_SCREEN_MODE_ENV, MINIMAL_OVERLAY_HEIGHT, NavSlash, SCREEN_MODE_SWITCH_ENV, ScreenMode,
    SlashAction, SwitchPolicy,
};
use serde_json::Value;
use session_fork::{RewindPoint, UiPrefs};
use session_history::{RestoredCompactionRecord, RestoredTurn};
use session_owner::SessionOwner;
use settings_ui::{Overlay as UiOverlay, OverlayAction, SettingsState, ThemeState};
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use xai_ratatui_inline::{
    Terminal, emit_to_scrollback, resize_purge_rerender, with_synchronized_output,
};

const UNAVAILABLE: &str = "Execution unavailable: dsh\nNot connected. Draft kept.";

struct TerminalGuard {
    alt: bool,
    mouse: bool,
}

impl TerminalGuard {
    fn enter(mode: ScreenMode) -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let alt = mode == ScreenMode::Fullscreen;
        if alt {
            execute!(
                io::stdout(),
                EnterAlternateScreen,
                EnableBracketedPaste,
                EnableMouseCapture,
                PushKeyboardEnhancementFlags(
                    KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                        | KeyboardEnhancementFlags::REPORT_EVENT_TYPES,
                ),
                Hide
            )?;
        } else {
            execute!(
                io::stdout(),
                EnableBracketedPaste,
                EnableMouseCapture,
                PushKeyboardEnhancementFlags(
                    KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                        | KeyboardEnhancementFlags::REPORT_EVENT_TYPES,
                ),
                Show
            )?;
        }
        Ok(Self { alt, mouse: false })
    }

    fn set_mouse(&mut self, capture: bool) -> io::Result<()> {
        if capture == self.mouse {
            return Ok(());
        }
        if capture {
            execute!(io::stdout(), EnableMouseCapture)?;
        } else {
            execute!(io::stdout(), DisableMouseCapture)?;
        }
        self.mouse = capture;
        Ok(())
    }

    fn apply(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        mode: ScreenMode,
    ) -> io::Result<()> {
        match mode {
            ScreenMode::Minimal if self.alt => {
                execute!(io::stdout(), LeaveAlternateScreen, Show)?;
                self.alt = false;
                terminal.set_viewport(Viewport::Inline(MINIMAL_OVERLAY_HEIGHT))?;
            }
            ScreenMode::Fullscreen if !self.alt => {
                let _ = terminal.clear();
                execute!(io::stdout(), EnterAlternateScreen, Hide)?;
                self.alt = true;
                terminal.set_viewport(Viewport::Fullscreen)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn suspend(&mut self) -> io::Result<()> {
        let _ = execute!(
            io::stdout(),
            PopKeyboardEnhancementFlags,
            DisableMouseCapture,
            DisableBracketedPaste,
            Show
        );
        if self.alt {
            let _ = execute!(io::stdout(), LeaveAlternateScreen);
            self.alt = false;
        }
        terminal::disable_raw_mode()?;
        io::stdout().flush()?;
        Ok(())
    }

    fn resume(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        mode: ScreenMode,
    ) -> io::Result<()> {
        terminal::enable_raw_mode()?;
        match mode {
            ScreenMode::Fullscreen => {
                execute!(
                    io::stdout(),
                    EnterAlternateScreen,
                    EnableBracketedPaste,
                    EnableMouseCapture,
                    PushKeyboardEnhancementFlags(
                        KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES,
                    ),
                    Hide
                )?;
                self.alt = true;
                terminal.set_viewport(Viewport::Fullscreen)?;
            }
            ScreenMode::Minimal => {
                execute!(
                    io::stdout(),
                    EnableBracketedPaste,
                    EnableMouseCapture,
                    PushKeyboardEnhancementFlags(
                        KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES,
                    ),
                    Show
                )?;
                self.alt = false;
                terminal.set_viewport(Viewport::Inline(MINIMAL_OVERLAY_HEIGHT))?;
            }
        }
        terminal.clear()?;
        Ok(())
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(
            io::stdout(),
            PopKeyboardEnhancementFlags,
            DisableMouseCapture,
            DisableBracketedPaste,
            Show
        );
        let _ = io::stdout().write_all(theme::CURSOR_RESET.as_bytes());
        if self.alt {
            let _ = execute!(io::stdout(), LeaveAlternateScreen);
        }
        let _ = terminal::disable_raw_mode();
        let _ = io::stdout().flush();
    }
}

fn restore_terminal() {
    let _ = execute!(
        io::stdout(),
        PopKeyboardEnhancementFlags,
        DisableMouseCapture,
        DisableBracketedPaste,
        Show,
        LeaveAlternateScreen
    );
    let _ = io::stdout().write_all(theme::CURSOR_RESET.as_bytes());
    let _ = terminal::disable_raw_mode();
    let _ = io::stdout().flush();
}

fn open_terminal(mode: ScreenMode) -> io::Result<Terminal<CrosstermBackend<io::Stdout>>> {
    let backend = CrosstermBackend::new(io::stdout());
    match mode {
        ScreenMode::Fullscreen => Terminal::new(backend),
        ScreenMode::Minimal => Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(MINIMAL_OVERLAY_HEIGHT),
            },
        ),
    }
}

fn profile() -> io::Result<()> {
    let home = PathBuf::from(
        std::env::var_os("HOME")
            .ok_or_else(|| io::Error::other("missing isolated HOME; use codsh --rust"))?,
    );
    let dsh = PathBuf::from(
        std::env::var_os("DSH_HOME")
            .ok_or_else(|| io::Error::other("missing isolated DSH_HOME; use codsh --rust"))?,
    );
    if dsh != home.join("dsh")
        || home.file_name().is_none_or(|name| name != ".codsh-rust")
        || std::env::var("DSH_PROFILE").as_deref() != Ok("rust")
    {
        return Err(io::Error::other(
            "invalid isolated Home/Profile; use codsh --rust",
        ));
    }
    let path = dsh.join("profiles/rust/package.json");
    if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(io::Error::other("refusing symlinked Rust Profile"));
    }
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
    if value["dsh"]["profile"]["bundles"].as_array().is_none() {
        return Err(io::Error::other(
            "invalid Rust Profile: missing dsh.profile.bundles",
        ));
    }
    Ok(())
}

struct ToolRow {
    id: String,
    title: String,
    kind: String,
    status: String,
    diff: String,
    result: String,
    raw_input: Value,
}

struct Turn {
    user: String,
    thought: String,
    answer: String,
    error: Option<String>,
    message_id: Option<String>,
    tools: Vec<ToolRow>,
    permission: Option<PendingPermission>,
    done: bool,
    cancelling: bool,
    cancelled: bool,
    interrupted: bool,
    compacted: bool,
    compaction: Option<session_history::RestoredCompaction>,
    timestamp: Option<String>,
    /// Cancelled by the send-now chord. The reference hides that marker:
    /// the cancel is the silent half of cancel-and-send.
    quiet_cancel: bool,
}

#[derive(Clone, Debug)]
enum LaunchMode {
    Help,
    Version,
    Inspect {
        json: bool,
        help: bool,
        debug: bool,
        debug_file: Option<PathBuf>,
    },
    Import {
        flags: import::ImportFlags,
    },
    Plugin(plugin::PluginCommand),
    Feedback(privacy_cmd::FeedbackCommand),
    Login {
        flags: auth::LoginFlags,
        help: bool,
    },
    Logout {
        debug: bool,
        debug_file: Option<PathBuf>,
        help: bool,
    },
    Setup {
        flags: auth::SetupFlags,
        help: bool,
    },
    Voice {
        json: bool,
        help: bool,
    },
    Web {
        kind: WebCommand,
        json: bool,
        help: bool,
    },
    Completions {
        shell: Option<String>,
        help: bool,
        debug: bool,
        debug_file: Option<PathBuf>,
    },
    New,
    Continue,
    Resume(String),
    Sessions(session_catalog::SessionsCommand),
    Dashboard,
    Export(session_data::ExportRequest),
    Share(session_data::ShareRequest),
    ShareHelp,
    /// `codsh --rust worktree ...` (ticket 174): the words after `worktree`.
    Worktree(Vec<String>),
    DiskUsage {
        json: bool,
    },
    Memory(Vec<String>),
    /// `mcp list|add|remove|enable|disable|doctor`.
    Mcp(mcp::McpInvocation),
    /// Editor ACP agent. dsh still executes; this process only speaks JSON-RPC.
    Agent {
        help: bool,
    },
    /// `agent serve`, `agent leader`, `agent --leader stdio`, and their help.
    AgentShared(shared_server::AgentCommand),
    /// `leader list|info|kill`.
    Leader(shared_server::LeaderCommand),
    /// One non-interactive prompt. dsh executes it; stdout is the final answer.
    Plain {
        prompt: PlainPrompt,
        max_turns: Option<u64>,
        tools: Option<PlainTools>,
        resume: Option<PlainResume>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PlainResume {
    Continue,
    Id(String),
}

/// Where a plain prompt comes from. Stdin is not a prompt source.
#[derive(Clone, Debug, PartialEq, Eq)]
enum PlainPrompt {
    Text(String),
    File(PathBuf),
    Json(String),
}

/// `--tools` keeps named tools. `--disallowed-tools` removes them.
/// Both may be set; deny wins. A name dsh does not register is an error.
#[derive(Clone, Debug, PartialEq, Eq)]
enum PlainTools {
    Filter {
        allow: Option<Vec<String>>,
        deny: Option<Vec<String>>,
    },
}

struct Connection {
    client: AcpClient,
    owner: SessionOwner,
    resumed: bool,
}

#[derive(Clone, Debug)]
enum DeleteReturn {
    Welcome,
    #[allow(dead_code)]
    Picker,
    #[allow(dead_code)]
    Dashboard,
}

enum Overlay {
    None,
    RewindPick {
        points: Vec<RewindPoint>,
        cursor: usize,
    },
    RewindConfirm {
        point: RewindPoint,
    },
    Plugins(plugin::PluginOverlay),
    Feedback(feedback_ui::FeedbackForm),
    SessionPick {
        hits: Vec<session_catalog::SearchHit>,
        cursor: usize,
        query: String,
        /// A refused resume stays on this picker. Empty while the list is clean.
        refusal: String,
        /// `d` then `y` asks to delete the highlighted session. Deletion is
        /// blocked, so nothing is removed. Esc or any other key cancels.
        delete_armed: bool,
    },
    DeleteConfirm {
        session_id: String,
        return_to: DeleteReturn,
    },
    Dashboard(session_catalog::DashboardView),
    Location {
        draft: String,
        previous: PathBuf,
    },
    Memory(memory_ui::Browser),
    Remember {
        draft: String,
        scope: memory::Scope,
    },
}

#[derive(Debug)]
struct Launch {
    mode: LaunchMode,
    model: Option<String>,
    effort: Option<String>,
    trust: bool,
    revoke_trust: bool,
    trust_folder: Option<PathBuf>,
    screen: Option<ScreenMode>,
    fork_session: bool,
    child_id: Option<String>,
    permission_mode: Option<String>,
    always_approve: bool,
    auto: bool,
    allow: Vec<String>,
    deny: Vec<String>,
    /// `--rules` / `--append-system-prompt`. Ignored when override is set.
    session_rules: Option<String>,
    /// `--system-prompt-override` / `--system-prompt` replaces the prompt.
    system_prompt_override: Option<String>,
    /// `--no-memory` hides memory for this process. It does not delete files.
    no_memory: bool,
    sandbox: Option<String>,
    sandbox_report: Option<PathBuf>,
    sandbox_probe: Option<PathBuf>,
    /// A path the probe's caller creates to end the session. Its appearance
    /// kills the probe process group. Absent for an ordinary launch.
    sandbox_cancel: Option<PathBuf>,
    /// `--verbatim`: the admitted user text is not rewritten. System
    /// instructions and permission policy stay on their own channels.
    verbatim: bool,
    /// `--cwd`: the working directory for this process, before config,
    /// sandbox, sessions, and dsh read it. Interactive and plain alike.
    cwd: Option<PathBuf>,
    /// `--disable-web-search`: web_search and web_fetch are off for this process.
    disable_web_search: bool,
    /// `--output-format`. Plain is the default and prints the answer only.
    output_format: headless::OutputFormat,
    /// `--include-partial-messages`. Only streaming-messages-json uses it.
    include_partial_messages: bool,
    /// Headless-only flags given without a plain prompt. The guide prints a
    /// warning and ignores them.
    warnings: Vec<String>,
    /// `--no-subagents` (any mode) and `--disallowed-tools Agent(type)`
    /// (plain prompts only; interactive sessions ignore headless flags).
    subagents: subagents::CliSubagents,
    /// `-w/--worktree [NAME]` and `--worktree-ref/--ref <REF>` (ticket 174).
    worktree: worktree::WorktreeFlags,
    /// `--no-plan`, `--no-ask-user`, `--todo-gate` (session-scoped).
    interaction: interaction::CliInteraction,
}

/// Flags the frozen client accepts, but a later ticket owns their behavior.
fn deferred_plain_flag(arg: &str) -> Option<String> {
    let name = arg.split('=').next().unwrap_or(arg);
    let named = |message: &str| Some(format!("{name}: {message}"));
    match name {
        "--json-schema" => named(
            "structured output schemas are not available in this client; a later ticket owns them",
        ),
        "--agent" | "--agents" | "--agent-profile" => {
            named("agent selection is not available in this client; a later ticket owns it")
        }
        "--fs-read" | "--fs-write" => {
            named("sandbox profiles are not available in this client; a later ticket owns them")
        }
        "--experimental-memory" | "--memory-flush" => {
            named("memory controls are not available in this client; a later ticket owns them")
        }
        "--leader" | "--no-leader" | "--bind" | "--no-exit-on-disconnect" | "--relay-on-demand" => {
            named(
                "shared leader controls apply only to `agent` and `leader` commands; dsh owns execution",
            )
        }
        // `--leader-socket` is global on the reference client. Subcommands that
        // own the flag (completions, inspect, login) parse it themselves and
        // say that name. A bare invocation still has no shared leader.
        "--leader-socket" | "--leader-socket=" => named(
            "shared leader controls apply only to `agent` and `leader` commands; dsh owns execution",
        ),
        "--no-auto-update" => named(
            "this client runs no update checks, so there is nothing to disable; a later ticket owns the flag",
        ),
        "--no-alt-screen" => named(
            "inline rendering without the alternate screen is not available; a later ticket owns the flag. Use --minimal for native terminal history; plain prompts never use the alternate screen",
        ),
        "--compaction-mode" | "--compaction-detail" => {
            named("compaction controls are recognized and not applied; a later ticket owns them")
        }
        _ => None,
    }
}

fn usage_error(message: impl Into<String>) -> io::Error {
    io::Error::other(format!("usage: {}", message.into()))
}

fn missing_flag_value(flag: &str) -> io::Error {
    usage_error(format!(
        "a value is required for '{flag}' but none was supplied\n\nFor more information, try '--help'."
    ))
}

fn unexpected_argument(arg: &str) -> io::Error {
    usage_error(format!(
        "unexpected argument '{arg}' found\n\n  tip: to pass '{arg}' as a value, use '-- {arg}'\n\nUsage: codsh --rust [OPTIONS] [COMMAND]\n\nFor more information, try '--help'."
    ))
}

fn is_subcommand(arg: &str) -> bool {
    matches!(
        arg,
        "inspect"
            | "import"
            | "feedback"
            | "plugin"
            | "login"
            | "logout"
            | "setup"
            | "voice"
            | "web"
            | "sessions"
            | "dashboard"
            | "export"
            | "share"
            | "du"
            | "disk-usage"
            | "memory"
            | "help"
            | "completions"
            | "agent"
            | "leader"
            | "mcp"
            | "worktree"
    )
}

fn take_flag_value(
    args: &[String],
    index: &mut usize,
    flag: &str,
    missing: impl Fn() -> io::Error,
) -> io::Result<Option<String>> {
    let arg = &args[*index];
    if arg == flag {
        *index += 1;
        let Some(value) = args.get(*index) else {
            return Err(missing());
        };
        if value.starts_with('-') {
            return Err(missing());
        }
        return Ok(Some(value.clone()));
    }
    if let Some(value) = arg.strip_prefix(&format!("{flag}=")) {
        if value.is_empty() {
            return Err(missing());
        }
        return Ok(Some(value.to_string()));
    }
    Ok(None)
}

fn plain_flag_value(args: &[String], index: &mut usize, flag: &str) -> io::Result<Option<String>> {
    let canonical = match flag {
        "--allowedTools" => "--allow <RULE>",
        "--disallowedTools" => "--deny <RULE>",
        "--system-prompt" => "--system-prompt-override <PROMPT>",
        "--append-system-prompt" => "--rules <RULES>",
        "--output-format" => "--output-format <OUTPUT_FORMAT>",
        "--compaction-mode" => "--compaction-mode <MODE>",
        "--compaction-detail" => "--compaction-detail <DETAIL>",
        other => other,
    };
    take_flag_value(args, index, flag, || missing_flag_value(canonical))
}

fn split_tool_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

/// Any `agent(` prefix counts, in any letter case, including `Agent()` and the
/// comma-split pieces of `Agent(explore, plan)`.
fn scoped_agent_filter(name: &str) -> bool {
    name.trim()
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("agent("))
}

/// Split one `--tools` / `--disallowed-tools` value into tool names and the
/// subagent types named by `Agent(type, ...)`. The typed entry is rejoined
/// after the comma split, so `Agent(explore, plan)` names two types. Types
/// shape the subagent policy (ticket 172); `--tools` cannot allow a type.
fn plain_tool_list(flag: &str, value: &str) -> io::Result<(Vec<String>, Vec<String>)> {
    let pieces = split_tool_list(value);
    if pieces.is_empty() {
        return Err(usage_error(format!(
            "{flag} requires at least one tool name"
        )));
    }
    let mut names = Vec::new();
    let mut types = Vec::new();
    let mut index = 0;
    while index < pieces.len() {
        if !scoped_agent_filter(&pieces[index]) {
            names.push(pieces[index].clone());
            index += 1;
            continue;
        }
        let mut end = index;
        while !pieces[end].contains(')') && end + 1 < pieces.len() {
            end += 1;
        }
        let entry = pieces[index..=end].join(", ");
        if !entry.ends_with(')') {
            return Err(io::Error::other(format!(
                "plain tool filter cannot parse {entry}; write Agent(type) or Agent(type, other)"
            )));
        }
        if flag == "--tools" {
            return Err(io::Error::other(format!(
                "plain tool filter cannot allow {entry}; --tools cannot allow Agent. Use --disallowed-tools Agent(type) to remove subagent types, or Agent to deny every subagent"
            )));
        }
        let inner = &entry[6..entry.len() - 1];
        let named: Vec<String> = inner
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect();
        if named.is_empty() {
            return Err(io::Error::other(format!(
                "plain tool filter cannot apply {entry}; name at least one subagent type, or use Agent to deny every subagent"
            )));
        }
        types.extend(named);
        index = end + 1;
    }
    Ok((names, types))
}

fn parse_launch(args: &[String]) -> io::Result<Launch> {
    // `mcp` owns everything after its command word, including `-s`, `-e`,
    // and server arguments after `--` that the session parser would claim.
    if let Some(at) = args.iter().position(|arg| arg == "mcp")
        && let Ok(mut launch) = parse_launch_inner(&args[..at])
        && matches!(launch.mode, LaunchMode::New)
    {
        let tail: Vec<&str> = args[at + 1..].iter().map(String::as_str).collect();
        launch.mode = LaunchMode::Mcp(mcp::parse(&tail).map_err(usage_error)?);
        return Ok(launch);
    }
    parse_launch_inner(args)
}

fn parse_launch_inner(args: &[String]) -> io::Result<Launch> {
    if args.iter().any(|flag| flag == "--restore-code") {
        return Err(io::Error::other(session_fork::restore_code_error()));
    }
    let mut model = None;
    let mut effort = None;
    let mut trust = false;
    let mut revoke_trust = false;
    let mut trust_folder = None;
    let mut screen = None;
    let mut rest: Vec<String> = Vec::new();
    let mut fork_session = false;
    let mut child_id = None;
    let mut permission_mode = None;
    let mut always_approve = false;
    let mut auto = false;
    let mut allow = Vec::new();
    let mut deny = Vec::new();
    let mut session_rules = None;
    let mut system_prompt_override = None;
    let mut no_memory = false;
    let mut sandbox = None;
    let mut sandbox_report = None;
    let mut sandbox_probe = None;
    let mut sandbox_cancel = None;
    let mut plain_prompt: Option<PlainPrompt> = None;
    let mut plain_cwd = None;
    let mut warnings = Vec::new();
    let mut max_turns = None;
    let mut plain_allow: Option<Vec<String>> = None;
    let mut plain_deny: Option<Vec<String>> = None;
    let mut plain_deny_types: Vec<String> = Vec::new();
    let mut no_subagents = false;
    let mut verbatim = false;
    let mut disable_web_search = false;
    let mut interaction = interaction::CliInteraction::default();
    let mut output_format = headless::OutputFormat::Plain;
    let mut include_partial_messages = false;
    let mut worktree_flags = worktree::WorktreeFlags::default();
    let mut index = 0;
    let note_prompt = |current: &mut Option<PlainPrompt>, next: PlainPrompt| -> io::Result<()> {
        if current.is_some() {
            return Err(io::Error::other(
                "conflicting prompt sources; pass only one of -p/--single, --prompt-file, or --prompt-json",
            ));
        }
        *current = Some(next);
        Ok(())
    };
    while index < args.len() {
        if let Some(value) = take_flag_value(args, &mut index, "--model", || {
            io::Error::other("missing --model value; use codsh --rust --help")
        })? {
            model = Some(value);
        } else if let Some(value) = take_flag_value(args, &mut index, "-m", || {
            io::Error::other("missing -m/--model value; use codsh --rust --help")
        })? {
            model = Some(value);
        } else if let Some(value) = take_flag_value(args, &mut index, "--effort", || {
            io::Error::other("missing --effort value; use codsh --rust --help")
        })? {
            effort = Some(value);
        } else if let Some(value) = take_flag_value(args, &mut index, "--reasoning-effort", || {
            io::Error::other("missing --reasoning-effort value; use codsh --rust --help")
        })? {
            effort = Some(value);
        } else if let Some(value) = take_flag_value(args, &mut index, "--sandbox", || {
            io::Error::other(
                "missing --sandbox profile; use off, workspace, read-only, strict, devbox, or a sandbox.toml profile",
            )
        })? {
            sandbox = Some(value);
        } else if let Some(value) = take_flag_value(args, &mut index, "--sandbox-report", || {
            io::Error::other("missing --sandbox-report path")
        })? {
            sandbox_report = Some(PathBuf::from(value));
        } else if let Some(value) = take_flag_value(args, &mut index, "--sandbox-probe", || {
            io::Error::other("missing --sandbox-probe script")
        })? {
            sandbox_probe = Some(PathBuf::from(value));
        } else if let Some(value) = take_flag_value(args, &mut index, "--sandbox-cancel", || {
            io::Error::other("missing --sandbox-cancel path")
        })? {
            sandbox_cancel = Some(PathBuf::from(value));
        } else if let Some(value) = take_flag_value(args, &mut index, "--session-id", || {
            io::Error::other("missing session id; --session-id requires --fork-session")
        })? {
            child_id = Some(value);
        } else if let Some(value) = take_flag_value(args, &mut index, "-s", || {
            io::Error::other("missing session id; --session-id requires --fork-session")
        })? {
            child_id = Some(value);
        } else if let Some(value) = plain_flag_value(args, &mut index, "--rules")? {
            session_rules = Some(value);
        } else if let Some(value) = plain_flag_value(args, &mut index, "--append-system-prompt")? {
            session_rules = Some(value);
        } else if let Some(value) = plain_flag_value(args, &mut index, "--system-prompt-override")?
        {
            system_prompt_override = Some(value);
        } else if let Some(value) = plain_flag_value(args, &mut index, "--system-prompt")? {
            system_prompt_override = Some(value);
        } else if let Some(value) = plain_flag_value(args, &mut index, "--single")? {
            note_prompt(&mut plain_prompt, PlainPrompt::Text(value))?;
        } else if let Some(value) = plain_flag_value(args, &mut index, "-p")? {
            note_prompt(&mut plain_prompt, PlainPrompt::Text(value))?;
        } else if let Some(value) = plain_flag_value(args, &mut index, "--prompt-file")? {
            note_prompt(&mut plain_prompt, PlainPrompt::File(PathBuf::from(value)))?;
        } else if let Some(value) = plain_flag_value(args, &mut index, "--prompt-json")? {
            note_prompt(&mut plain_prompt, PlainPrompt::Json(value))?;
        } else if let Some(value) = plain_flag_value(args, &mut index, "--cwd")? {
            plain_cwd = Some(PathBuf::from(value));
        } else if let Some(value) = plain_flag_value(args, &mut index, "--max-turns")? {
            if max_turns.is_some() {
                return Err(io::Error::other(
                    "conflicting --max-turns values; pass the bound once",
                ));
            }
            let parsed = value.parse::<u64>().map_err(|_| {
                usage_error("invalid value for '--max-turns <N>': expected a positive integer")
            })?;
            if parsed == 0 {
                return Err(usage_error(
                    "invalid value for '--max-turns <N>': expected a positive integer",
                ));
            }
            max_turns = Some(parsed);
        } else if let Some(value) = plain_flag_value(args, &mut index, "--tools")? {
            let (names, _) = plain_tool_list("--tools", &value)?;
            plain_allow.get_or_insert_with(Vec::new).extend(names);
        } else if let Some(value) = plain_flag_value(args, &mut index, "--disallowed-tools")? {
            let (names, types) = plain_tool_list("--disallowed-tools", &value)?;
            plain_deny.get_or_insert_with(Vec::new).extend(names);
            plain_deny_types.extend(types);
        } else if !rest.iter().any(|item| is_subcommand(item))
            && (args[index] == "-w"
                || args[index] == "--worktree"
                || args[index].starts_with("--worktree="))
        {
            // `-w [NAME]`: the name is optional, so only a following word
            // that is neither a flag nor a command is taken as the name.
            let name = if let Some(value) = args[index].strip_prefix("--worktree=") {
                value.to_string()
            } else if let Some(next) = args.get(index + 1)
                && !next.starts_with('-')
                && !is_subcommand(next)
            {
                index += 1;
                next.clone()
            } else {
                String::new()
            };
            if worktree_flags.name.is_some() {
                return Err(usage_error(
                    "the argument '--worktree [<NAME>]' cannot be used multiple times",
                ));
            }
            worktree_flags.name = Some(name);
        } else if !rest.iter().any(|item| is_subcommand(item))
            && let Some(value) = plain_flag_value(args, &mut index, "--worktree-ref")?
        {
            worktree_flags.reference = Some(value);
        } else if !rest.iter().any(|item| is_subcommand(item))
            && let Some(value) = plain_flag_value(args, &mut index, "--ref")?
        {
            worktree_flags.reference = Some(value);
        } else if args[index] == "--no-subagents" {
            no_subagents = true;
        } else if args[index] == "--no-plan" {
            interaction.no_plan = true;
        } else if args[index] == "--no-ask-user" {
            interaction.no_ask_user = true;
        } else if args[index] == "--todo-gate" {
            interaction.todo_gate = true;
        } else if args[index] == "--verbatim" {
            verbatim = true;
        } else if args[index] == "--disable-web-search" {
            disable_web_search = true;
        } else if args[index] == "-c" && !rest.iter().any(|item| is_subcommand(item)) {
            // `export <id> -c` keeps its own clipboard short.
            rest.push("--continue".to_string());
        } else if args[index] == "-r" && !rest.iter().any(|item| is_subcommand(item)) {
            rest.push("--resume".to_string());
        } else if let Some(value) = plain_flag_value(args, &mut index, "--output-format")? {
            output_format = headless::OutputFormat::parse(&value).ok_or_else(|| {
                usage_error(format!(
                    "invalid value '{value}' for '--output-format <OUTPUT_FORMAT>'\n  [possible values: {}]\n\nFor more information, try '--help'.",
                    headless::OUTPUT_FORMATS.join(", ")
                ))
            })?;
        } else if args[index] == "--include-partial-messages" {
            include_partial_messages = true;
        } else if let Some(value) = plain_flag_value(args, &mut index, "--compaction-mode")? {
            let _ = value;
            return Err(io::Error::other(
                "--compaction-mode: compaction controls are recognized and not applied; a later ticket owns them",
            ));
        } else if let Some(value) = plain_flag_value(args, &mut index, "--compaction-detail")? {
            let _ = value;
            return Err(io::Error::other(
                "--compaction-detail: compaction controls are recognized and not applied; a later ticket owns them",
            ));
        } else {
            let arg = &args[index];
            // `completions` owns `--leader-socket` and reports that command
            // name. Other invocations still hit `deferred_plain_flag`.
            let completions_owns_leader = (arg == "--leader-socket"
                || arg.starts_with("--leader-socket="))
                && args.iter().any(|item| item == "completions");
            // `agent` and `leader` own the shared-service flags and parse
            // them with their values after the command word.
            let shared_owns = matches!(rest.first().map(String::as_str), Some("agent" | "leader"))
                && matches!(
                    arg.split('=').next().unwrap_or(arg),
                    "--leader"
                        | "--no-leader"
                        | "--bind"
                        | "--no-exit-on-disconnect"
                        | "--relay-on-demand"
                        | "--leader-socket"
                        | "--no-auto-update"
                );
            if !completions_owns_leader
                && !shared_owns
                && let Some(message) = deferred_plain_flag(arg)
            {
                return Err(io::Error::other(message));
            }
            if arg == "--trust" && args.iter().any(|item| item == "plugin") {
                rest.push(arg.clone());
            } else if arg == "--trust" || arg == "--trust-folder" {
                trust = true;
                if arg == "--trust-folder"
                    && let Some(value) = args.get(index + 1)
                    && !value.starts_with('-')
                    && value != "inspect"
                    && value != "--continue"
                    && value != "--resume"
                    && value != "--fork-session"
                    && value != "plugin"
                {
                    index += 1;
                    trust_folder = Some(PathBuf::from(value));
                }
            } else if let Some(value) = arg.strip_prefix("--trust-folder=") {
                trust = true;
                if !value.is_empty() {
                    trust_folder = Some(PathBuf::from(value));
                }
            } else if arg == "--revoke-trust" {
                revoke_trust = true;
            } else if arg == "--minimal" {
                if screen == Some(ScreenMode::Fullscreen) {
                    return Err(io::Error::other(
                        "conflicting screen flags; use only one of --minimal or --fullscreen",
                    ));
                }
                screen = Some(ScreenMode::Minimal);
            } else if arg == "--fullscreen" || arg == "--full" {
                if screen == Some(ScreenMode::Minimal) {
                    return Err(io::Error::other(
                        "conflicting screen flags; use only one of --minimal or --fullscreen",
                    ));
                }
                screen = Some(ScreenMode::Fullscreen);
            } else if arg == "--fork-session" {
                fork_session = true;
            } else if arg == "--no-memory" {
                no_memory = true;
            } else if arg == "--always-approve"
                || arg == "--yolo"
                || arg == "--dangerously-skip-permissions"
            {
                always_approve = true;
            } else if arg == "--auto" {
                auto = true;
            } else if matches!(
                arg.as_str(),
                "--permission-mode" | "--allow" | "--allowedTools" | "--deny" | "--disallowedTools"
            ) || arg.starts_with("--permission-mode=")
                || arg.starts_with("--allow=")
                || arg.starts_with("--allowedTools=")
                || arg.starts_with("--deny=")
                || arg.starts_with("--disallowedTools=")
            {
                if rest.iter().any(|item| is_subcommand(item)) {
                    rest.push(arg.clone());
                } else if arg == "--permission-mode" || arg.starts_with("--permission-mode=") {
                    let value = if let Some(inline) = arg.strip_prefix("--permission-mode=") {
                        inline.to_string()
                    } else {
                        index += 1;
                        args.get(index)
                            .filter(|value| !value.starts_with('-') && !is_subcommand(value))
                            .cloned()
                            .ok_or_else(|| {
                                io::Error::other(
                                    "missing --permission-mode value; use ask, auto, always-approve, dontAsk, or acceptEdits",
                                )
                            })?
                    };
                    permission::PermissionMode::parse(&value).map_err(io::Error::other)?;
                    permission_mode = Some(value);
                } else {
                    let (flag, inline) = arg
                        .split_once('=')
                        .map(|(flag, value)| (flag, Some(value.to_string())))
                        .unwrap_or((arg.as_str(), None));
                    let canonical = if flag == "--allow" || flag == "--allowedTools" {
                        "--allow <RULE>"
                    } else {
                        "--deny <RULE>"
                    };
                    let value = if let Some(value) = inline {
                        value
                    } else {
                        index += 1;
                        args.get(index)
                            .filter(|value| !value.starts_with('-') && !is_subcommand(value))
                            .cloned()
                            .ok_or_else(|| missing_flag_value(canonical))?
                    };
                    if flag == "--allow" || flag == "--allowedTools" {
                        allow.push(value);
                    } else {
                        deny.push(value);
                    }
                }
            } else if arg.starts_with('-')
                && !matches!(
                    arg.as_str(),
                    "--continue"
                        | "--resume"
                        | "-c"
                        | "-r"
                        | "--help"
                        | "-h"
                        | "--version"
                        | "-V"
                        | "-v"
                )
                && !args.iter().any(|item| is_subcommand(item))
            {
                return Err(unexpected_argument(arg));
            } else {
                rest.push(arg.clone());
            }
        }
        index += 1;
    }
    let plain_tools = match (plain_allow, plain_deny) {
        (None, None) => None,
        (allow, deny) => Some(PlainTools::Filter { allow, deny }),
    };
    if child_id.is_some() && !fork_session {
        return Err(io::Error::other(
            "--session-id is only valid together with --fork-session",
        ));
    }
    let rest_flags: Vec<&str> = rest.iter().map(String::as_str).collect();
    let mode = match rest_flags.as_slice() {
        [] => LaunchMode::New,
        ["--help" | "-h"] => LaunchMode::Help,
        ["--version" | "-V" | "-v"] => LaunchMode::Version,
        ["--continue"] => LaunchMode::Continue,
        ["--resume"] => {
            return Err(io::Error::other(
                "missing session id; use codsh --rust --resume <id>",
            ));
        }
        ["--resume", id] if !id.is_empty() && !id.starts_with('-') => {
            LaunchMode::Resume((*id).to_string())
        }
        ["inspect"] => LaunchMode::Inspect {
            json: false,
            help: false,
            debug: false,
            debug_file: None,
        },
        ["inspect", flags @ ..] => parse_inspect(flags)?,
        ["import"] => LaunchMode::Import {
            flags: import::ImportFlags::default(),
        },
        ["import", flags @ ..] => LaunchMode::Import {
            flags: import::parse_flags(flags)?,
        },
        ["feedback"] => LaunchMode::Feedback(privacy_cmd::FeedbackCommand::Help),
        ["feedback", flags @ ..] => LaunchMode::Feedback(
            privacy_cmd::parse_feedback(
                &flags
                    .iter()
                    .map(|flag| (*flag).to_string())
                    .collect::<Vec<_>>(),
            )
            .map_err(|error| io::Error::other(error.to_string()))?,
        ),
        ["plugin"] => LaunchMode::Plugin(plugin::PluginCommand::Help),
        ["plugin", flags @ ..] => LaunchMode::Plugin(
            plugin::parse_command(
                &flags
                    .iter()
                    .map(|flag| (*flag).to_string())
                    .collect::<Vec<_>>(),
            )
            .map_err(|error| io::Error::other(error.message))?,
        ),
        ["login"] => LaunchMode::Login {
            flags: auth::LoginFlags::default(),
            help: false,
        },
        ["login", flags @ ..] => parse_login(flags)?,
        ["logout"] => LaunchMode::Logout {
            debug: false,
            debug_file: None,
            help: false,
        },
        ["logout", flags @ ..] => parse_logout(flags)?,
        ["setup"] => LaunchMode::Setup {
            flags: auth::SetupFlags::default(),
            help: false,
        },
        ["setup", flags @ ..] => parse_setup(flags)?,
        ["voice"] => LaunchMode::Voice {
            json: false,
            help: true,
        },
        ["voice", flags @ ..] => parse_voice(flags)?,
        ["web"] => LaunchMode::Web {
            kind: WebCommand::Help,
            json: false,
            help: true,
        },
        ["web", flags @ ..] => parse_web(flags)?,
        ["sessions"] => LaunchMode::Sessions(session_catalog::SessionsCommand::Help),
        ["sessions", "delete"] => {
            return Err(io::Error::other(
                "missing session id; use codsh --rust sessions delete <ID> --yes",
            ));
        }
        ["sessions", "delete", flags @ ..] => LaunchMode::Sessions(
            session_catalog::SessionsCommand::Delete(session_data::parse_delete(flags)?),
        ),
        ["sessions", flags @ ..] => LaunchMode::Sessions(session_catalog::parse_sessions(flags)?),
        ["export"] => return Err(io::Error::other(session_data::export_help())),
        ["export", flags @ ..] => LaunchMode::Export(session_data::parse_export(flags)?),
        ["share"] => LaunchMode::ShareHelp,
        ["share", flags @ ..] if flags.iter().any(|flag| *flag == "--help" || *flag == "-h") => {
            LaunchMode::ShareHelp
        }
        ["share", flags @ ..] => LaunchMode::Share(session_data::parse_share(flags)?),
        ["worktree", flags @ ..] => {
            LaunchMode::Worktree(flags.iter().map(|flag| (*flag).to_string()).collect())
        }
        ["du"] | ["disk-usage"] => LaunchMode::DiskUsage { json: false },
        ["du", flags @ ..] | ["disk-usage", flags @ ..] => LaunchMode::DiskUsage {
            json: parse_disk_flags(flags)?,
        },
        ["dashboard"] | ["dashboard", "--help" | "-h"] => LaunchMode::Dashboard,
        ["memory"] => LaunchMode::Memory(vec!["help".into()]),
        ["memory", flags @ ..] => {
            LaunchMode::Memory(flags.iter().map(|flag| (*flag).to_string()).collect())
        }
        ["agent"] => {
            return Err(io::Error::other(
                "missing agent command; use codsh --rust agent stdio",
            ));
        }
        ["agent", "stdio"] => LaunchMode::Agent { help: false },
        ["agent", "--help" | "-h"] | ["agent", "stdio", "--help" | "-h"] => {
            LaunchMode::Agent { help: true }
        }
        ["agent", flags @ ..] => {
            match shared_server::parse_agent(flags).map_err(io::Error::other)? {
                shared_server::AgentCommand::Stdio {
                    leader: None,
                    socket: None,
                } => LaunchMode::Agent { help: false },
                shared_server::AgentCommand::Help("stdio" | "agent") => {
                    LaunchMode::Agent { help: true }
                }
                command => LaunchMode::AgentShared(command),
            }
        }
        ["leader", flags @ ..] => {
            LaunchMode::Leader(shared_server::parse_leader(flags).map_err(io::Error::other)?)
        }
        ["help"] | ["help", "--help" | "-h"] => LaunchMode::Help,
        ["help", "completions"] | ["completions", "--help" | "-h"] => LaunchMode::Completions {
            shell: None,
            help: true,
            debug: false,
            debug_file: None,
        },
        ["completions"] => {
            return Err(missing_flag_value("completions <SHELL>"));
        }
        ["completions", flags @ ..] => parse_completions(flags)?,
        ["help", command] => {
            return Err(unexpected_argument(command));
        }
        [prompt] if plain_prompt.is_none() && !prompt.starts_with('-') => {
            return Err(io::Error::other(
                "a positional prompt does not start plain mode; use -p/--single, --prompt-file, or --prompt-json",
            ));
        }
        [unknown, ..] if unknown.starts_with('-') => return Err(unexpected_argument(unknown)),
        _ => {
            return Err(io::Error::other(
                "unsupported preview arguments; use codsh --rust --help",
            ));
        }
    };
    let mode = match plain_prompt {
        Some(prompt) => {
            let resume = match mode {
                LaunchMode::New => None,
                LaunchMode::Continue => Some(PlainResume::Continue),
                LaunchMode::Resume(id) => Some(PlainResume::Id(id)),
                _ => {
                    return Err(io::Error::other(
                        "a plain prompt cannot be combined with that command",
                    ));
                }
            };
            LaunchMode::Plain {
                prompt,
                max_turns,
                tools: plain_tools,
                resume,
            }
        }
        None => {
            // The headless guide: these flags print a warning in the TUI and
            // are ignored. They never change an interactive session.
            let mut ignored = Vec::new();
            if max_turns.is_some() {
                ignored.push("--max-turns");
            }
            if let Some(PlainTools::Filter { allow, deny }) = &plain_tools {
                if allow.is_some() {
                    ignored.push("--tools");
                }
                if deny.is_some() {
                    ignored.push("--disallowed-tools");
                }
            }
            if verbatim {
                ignored.push("--verbatim");
                verbatim = false;
            }
            // Agent(type) rides on --disallowed-tools, a headless flag.
            plain_deny_types.clear();
            if output_format != headless::OutputFormat::Plain {
                ignored.push("--output-format");
                output_format = headless::OutputFormat::Plain;
            }
            if include_partial_messages {
                ignored.push("--include-partial-messages");
                include_partial_messages = false;
            }
            for flag in ignored {
                warnings.push(format!(
                    "warning: {flag} is a headless flag and is ignored without -p/--single, --prompt-file, or --prompt-json"
                ));
            }
            mode
        }
    };
    if include_partial_messages && !output_format.partials() {
        warnings.push(
            "warning: --include-partial-messages only affects --output-format streaming-messages-json; ignored"
                .to_string(),
        );
        include_partial_messages = false;
    }
    if fork_session
        && !matches!(
            mode,
            LaunchMode::Resume(_)
                | LaunchMode::Continue
                | LaunchMode::Help
                | LaunchMode::Version
                | LaunchMode::Plain {
                    resume: Some(_),
                    ..
                }
        )
    {
        return Err(io::Error::other(
            "--fork-session requires --resume or --continue",
        ));
    }
    if matches!(
        mode,
        LaunchMode::Help
            | LaunchMode::Version
            | LaunchMode::Login { .. }
            | LaunchMode::Logout { .. }
            | LaunchMode::Setup { .. }
    ) {
        fork_session = false;
        child_id = None;
    }
    if worktree_flags.reference.is_some() && !worktree_flags.requested() {
        return Err(usage_error(
            "the argument '--worktree-ref <REF>' requires '--worktree [<NAME>]'",
        ));
    }
    if worktree_flags.requested()
        && !matches!(
            mode,
            LaunchMode::New
                | LaunchMode::Resume(_)
                | LaunchMode::Continue
                | LaunchMode::Help
                | LaunchMode::Version
                | LaunchMode::Plain { .. }
        )
    {
        return Err(io::Error::other(
            "-w/--worktree starts an interactive or plain session in a new worktree; it cannot be combined with that command",
        ));
    }
    Ok(Launch {
        mode,
        model,
        effort,
        trust,
        revoke_trust,
        trust_folder,
        screen,
        fork_session,
        child_id,
        permission_mode,
        always_approve,
        auto,
        allow,
        deny,
        session_rules,
        system_prompt_override,
        no_memory,
        sandbox,
        sandbox_report,
        sandbox_probe,
        sandbox_cancel,
        verbatim,
        cwd: plain_cwd,
        disable_web_search,
        output_format,
        include_partial_messages,
        warnings,
        subagents: subagents::CliSubagents {
            disabled: no_subagents,
            denied_types: plain_deny_types,
        },
        worktree: worktree_flags,
        interaction,
    })
}

fn parse_disk_flags(flags: &[&str]) -> io::Result<bool> {
    let mut json = false;
    for flag in flags {
        match *flag {
            "--json" => json = true,
            "--help" | "-h" => return Err(io::Error::other(session_data::disk_help())),
            "--debug" | "--debug-file" | "--leader-socket" => {
                return Err(io::Error::other(format!(
                    "unsupported disk-usage flag {flag}; dsh owns execution. Omit it."
                )));
            }
            other => {
                return Err(io::Error::other(format!(
                    "unsupported disk-usage flag {other}; use codsh --rust du --help"
                )));
            }
        }
    }
    Ok(json)
}

fn share_destination(config: &config::EffectiveConfig, explicit: Option<&str>) -> Option<String> {
    if let Some(url) = explicit.map(str::trim).filter(|url| !url.is_empty()) {
        return Some(url.to_string());
    }
    if let Ok(url) = std::env::var("CODSH_SHARE_URL") {
        let url = url.trim();
        if !url.is_empty() {
            return Some(url.to_string());
        }
    }
    config
        .merged_table
        .get("endpoints")
        .and_then(|endpoints| endpoints.get("share_url"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
}

const COMPLETION_SHELLS: &[&str] = &["bash", "elvish", "fish", "powershell", "zsh"];

fn parse_completions(flags: &[&str]) -> io::Result<LaunchMode> {
    let mut shell = None;
    let mut help = false;
    let mut debug = false;
    let mut debug_file = None;
    let mut index = 0;
    while index < flags.len() {
        match flags[index] {
            "--help" | "-h" => help = true,
            "--debug" => debug = true,
            "--debug-file" => {
                index += 1;
                let path = flags
                    .get(index)
                    .ok_or_else(|| missing_flag_value("--debug-file <FILE>"))?;
                debug_file = Some(PathBuf::from(path));
            }
            "--leader-socket" => {
                index += 1;
                let _path = flags
                    .get(index)
                    .ok_or_else(|| missing_flag_value("--leader-socket <PATH>"))?;
                return Err(io::Error::other(
                    "completions --leader-socket is unused; dsh owns execution. Omit the flag.",
                ));
            }
            other if other.starts_with("--leader-socket=") => {
                return Err(io::Error::other(
                    "completions --leader-socket is unused; dsh owns execution. Omit the flag.",
                ));
            }
            other if other.starts_with("--debug-file=") => {
                let path = &other["--debug-file=".len()..];
                if path.is_empty() {
                    return Err(missing_flag_value("--debug-file <FILE>"));
                }
                debug_file = Some(PathBuf::from(path));
            }
            other if other.starts_with('-') => return Err(unexpected_argument(other)),
            other if COMPLETION_SHELLS.contains(&other) => {
                if shell.is_some() {
                    return Err(io::Error::other(
                        "completions accepts one shell; possible values: bash, elvish, fish, powershell, zsh",
                    ));
                }
                shell = Some((*other).to_string());
            }
            other => {
                return Err(usage_error(format!(
                    "invalid value '{other}' for 'completions <SHELL>'\n  [possible values: bash, elvish, fish, powershell, zsh]\n\nFor more information, try '--help'."
                )));
            }
        }
        index += 1;
    }
    if shell.is_none() && !help {
        return Err(missing_flag_value("completions <SHELL>"));
    }
    Ok(LaunchMode::Completions {
        shell,
        help,
        debug,
        debug_file,
    })
}

fn completions_help() -> &'static str {
    "Generate shell completion scripts (bash, zsh, fish, powershell, elvish)\n\nUsage: codsh --rust completions [OPTIONS] <SHELL>\n\nArguments:\n  <SHELL>  Target shell [possible values: bash, elvish, fish, powershell, zsh]\n\nOptions:\n      --debug                 Enable debug logging\n      --debug-file <FILE>     Write debug logs to FILE\n  -h, --help                  Print help\n      --leader-socket <PATH>  unused; dsh owns execution. Omit the flag.\n\nThe script completes this command's flags and subcommands. It is not a help page."
}

fn completion_script(shell: &str) -> &'static str {
    match shell {
        "bash" => include_str!("completions/bash.sh"),
        "zsh" => include_str!("completions/zsh.sh"),
        "fish" => include_str!("completions/fish.fish"),
        "powershell" => include_str!("completions/powershell.ps1"),
        "elvish" => include_str!("completions/elvish.elv"),
        _ => "",
    }
}

fn parse_voice(flags: &[&str]) -> io::Result<LaunchMode> {
    let mut json = false;
    let mut help = false;
    for flag in flags {
        match *flag {
            "--json" => json = true,
            "--help" | "-h" => help = true,
            "doctor" => {}
            other => {
                return Err(io::Error::other(format!(
                    "unsupported voice option {other}; use codsh --rust voice doctor"
                )));
            }
        }
    }
    Ok(LaunchMode::Voice { json, help })
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum WebCommand {
    Help,
    Search { query: String },
    Fetch { url: String },
}

fn parse_web(flags: &[&str]) -> io::Result<LaunchMode> {
    let mut json = false;
    let mut help = false;
    let mut kind = None;
    let mut index = 0;
    while index < flags.len() {
        match flags[index] {
            "--json" => json = true,
            "--help" | "-h" => help = true,
            "search" => {
                index += 1;
                let query = flags
                    .get(index)
                    .copied()
                    .filter(|value| !value.starts_with('-'));
                let Some(query) = query else {
                    return Err(io::Error::other(
                        "missing search query; use codsh --rust web search <query>",
                    ));
                };
                kind = Some(WebCommand::Search {
                    query: query.to_string(),
                });
            }
            "fetch" => {
                index += 1;
                let url = flags
                    .get(index)
                    .copied()
                    .filter(|value| !value.starts_with('-'));
                let Some(url) = url else {
                    return Err(io::Error::other(
                        "missing fetch URL; use codsh --rust web fetch <url>",
                    ));
                };
                kind = Some(WebCommand::Fetch {
                    url: url.to_string(),
                });
            }
            other => {
                return Err(io::Error::other(format!(
                    "unsupported web option {other}; use codsh --rust web --help"
                )));
            }
        }
        index += 1;
    }
    if help || kind.is_none() {
        return Ok(LaunchMode::Web {
            kind: WebCommand::Help,
            json,
            help: true,
        });
    }
    Ok(LaunchMode::Web {
        kind: kind.unwrap_or(WebCommand::Help),
        json,
        help: false,
    })
}

fn web_help() -> &'static str {
    "Search or fetch through the configured substitute\n\nUsage: codsh --rust web search <query> [--json]\n       codsh --rust web fetch <url> [--json]\n\nSearch uses [models] web_search and that model's base_url. protocol = \"responses\" (default) sends one Responses request and needs a credential. protocol = \"searxng\" is a keyless GET of {base}/search?q=...&format=json. Fetch uses features.web_fetch.\nBoth default off. Official hosts are refused. Domain policy loads at startup and a model argument cannot widen it. SearXNG result URLs are filtered by that same policy.\nDisabled, blocked, authentication, rate-limit, redirect, and network failures return an error and no page text.\nResponses search cost is one model request. SearXNG and fetch have no account charge."
}

fn run_web(kind: &WebCommand, json: bool, loaded: &config::EffectiveConfig) -> io::Result<()> {
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    #[cfg(unix)]
    {
        let hooked = flag.clone();
        // SIGINT and SIGTERM both mark the flag. The request loop closes the
        // socket and joins the worker before it returns, so the body is dropped.
        let _ = unsafe {
            signal_hook::low_level::register(signal_hook::consts::SIGINT, {
                let hooked = hooked.clone();
                move || {
                    hooked.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            })
        };
        let _ = unsafe {
            signal_hook::low_level::register(signal_hook::consts::SIGTERM, move || {
                hooked.store(true, std::sync::atomic::Ordering::Relaxed);
            })
        };
    }
    let cancelled = &*flag;
    let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    let result = match kind {
        WebCommand::Help => {
            println!("{}", web_help());
            return Ok(());
        }
        WebCommand::Search { query } => web::search(
            &loaded.web,
            query,
            env.get(&loaded.web.search.env_key)
                .map(String::as_str)
                .unwrap_or(""),
            cancelled,
        )
        .map(|outcome| {
            (
                web::format_search(&outcome),
                serde_json::json!({
                    "citations": outcome.citations.iter().map(|citation| serde_json::json!({
                        "url": citation.url,
                        "title": citation.title,
                    })).collect::<Vec<_>>(),
                    "truncated": false,
                }),
            )
        }),
        WebCommand::Fetch { url } => web::fetch_url(&loaded.web, url, cancelled).map(|outcome| {
            (
                web::format_fetch(&outcome),
                serde_json::json!({
                    "url": outcome.url,
                    "status": outcome.status_code,
                    "contentType": outcome.content_type,
                    "content": outcome.content,
                    "truncated": outcome.truncated,
                }),
            )
        }),
    };
    match result {
        Ok((text, meta)) => {
            if json {
                let mut value = serde_json::json!({
                    "ok": true,
                    "text": text,
                    "disclosure": web::disclosure(&loaded.web),
                });
                // `use serde_json::Value` is shadowed by the local `Value` enum,
                // so Map::as_object would not see these fields.
                if let Some(object) = value.as_object_mut()
                    && let serde_json::Value::Object(extra) = meta
                {
                    object.extend(extra);
                }
                println!("{value}");
            } else {
                println!("{text}");
            }
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "error": message,
                        "text": "",
                        "disclosure": web::disclosure(&loaded.web),
                    })
                );
            } else {
                eprintln!("{message}");
            }
            Err(io::Error::other(message))
        }
    }
}

fn short_help() -> &'static str {
    "codsh --rust\n\nUsage: codsh --rust [OPTIONS] [COMMAND]\n\nPlain: -p/--single, --prompt-file, --prompt-json. --verbatim sends the prompt as given.\n-c/--continue, -r/--resume <id-or-title>, --fork-session, --max-turns <N>, --tools, --disallowed-tools.\nBoth modes: --cwd, -w/--worktree [NAME], --worktree-ref <REF>, -m/--model, --sandbox, --no-memory, --disable-web-search.\nShells: bash, elvish, fish, powershell, zsh via `completions <SHELL>`.\nCommands: help, completions, inspect, import, feedback, plugin, login, logout, setup, voice, web, sessions, dashboard, export, share, du, memory, worktree.\n-h is this summary. --help prints the full text. Unknown options and missing values exit 2."
}

fn voice_help() -> &'static str {
    "List microphones without recording\n\nUsage: codsh --rust voice doctor [--json]\n\nRecording starts only from /voice or an enabled Ctrl+Space / F8 press inside a session.\nDoctor never opens the microphone. A missing device is voice.no-input-device.\nmacOS permission denials that arrive as silence are not detected here.\nLinux and Windows capture stay unverified until exercised on those hosts."
}

/// What one Esc does while a recording is active.
///
/// The composer always sees the key. Cancelling first, and returning before
/// the composer, left slash completion open with the draft box as "/".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecordingEsc {
    /// Composer closed an overlay or edited the draft; also stop recording.
    ComposerThenCancel,
    /// Composer did not use the key; cancel recording and do not continue.
    CancelOnly,
}

fn recording_esc(composer_handled: bool) -> RecordingEsc {
    if composer_handled {
        RecordingEsc::ComposerThenCancel
    } else {
        RecordingEsc::CancelOnly
    }
}

/// Esc while recording. The composer handles the key first so slash completion
/// can restore a parked draft. Only then is the recording cancelled.
fn handle_recording_esc(
    key: crossterm::event::KeyEvent,
    host: HostContext,
    voice: &mut voice::VoiceSession,
    composer: &mut PromptComposer,
    hint: &mut String,
    last_error: &mut String,
) -> bool {
    let action = composer.handle_key(key, host);
    let composer_handled = !matches!(action, PromptAction::Unhandled);
    if !voice.recording() {
        return composer_handled;
    }
    match recording_esc(composer_handled) {
        RecordingEsc::ComposerThenCancel => {
            *hint = voice.cancel();
            last_error.clear();
            if !composer.footer_notice.is_empty() {
                *hint = std::mem::take(&mut composer.footer_notice);
            }
        }
        RecordingEsc::CancelOnly => {
            *hint = voice.cancel();
            last_error.clear();
        }
    }
    true
}

fn apply_voice_command(
    text: &str,
    voice: &mut voice::VoiceSession,
    composer: &mut PromptComposer,
    hint: &mut String,
    last_error: &mut String,
) {
    let args = text.trim().trim_start_matches("/voice").trim();
    if args == "doctor" || args == "status" {
        let report = voice.device_report();
        *hint = voice::doctor_text(&voice.config, &report);
        last_error.clear();
        return;
    }
    if !args.is_empty() && args != "start" && args != "stop" && args != "cancel" {
        *last_error = format!(
            "unknown /voice argument {args}; use /voice, /voice stop, /voice cancel, or /voice doctor"
        );
        return;
    }
    if args == "cancel" {
        *hint = voice.cancel();
        last_error.clear();
        return;
    }
    if args == "stop" || voice.phase == voice::VoicePhase::Recording {
        match voice.stop() {
            Ok(()) => {
                *hint = voice.status.clone();
                last_error.clear();
            }
            Err(error) => {
                *last_error = error.to_string();
                *hint = last_error.clone();
            }
        }
        return;
    }
    let mode = if args == "start" {
        voice.config.capture_mode
    } else {
        // `/voice` is press-to-toggle even when the key chord is hold-to-talk.
        voice::CaptureMode::Toggle
    };
    match voice.start(&composer.voice_draft(), mode) {
        Ok(message) => {
            *hint = message;
            last_error.clear();
        }
        Err(error) => {
            *last_error = error.to_string();
            *hint = last_error.clone();
        }
    }
}

fn apply_voice_gesture(
    gesture: VoiceGesture,
    voice: &mut voice::VoiceSession,
    composer: &mut PromptComposer,
    hint: &mut String,
    last_error: &mut String,
) {
    if !voice.config.keybind_enabled {
        *hint = "/voice still starts dictation; Ctrl+Space and F8 are disabled".into();
        return;
    }
    match gesture {
        VoiceGesture::UnsupportedRelease => {
            *last_error = voice::VoiceError::UnsupportedKeyRelease.to_string();
            *hint = last_error.clone();
        }
        VoiceGesture::Press if voice.config.capture_mode == voice::CaptureMode::Toggle => {
            if voice.phase == voice::VoicePhase::Recording {
                apply_voice_command("/voice stop", voice, composer, hint, last_error);
            } else if voice.phase == voice::VoicePhase::Idle {
                apply_voice_command("/voice", voice, composer, hint, last_error);
            }
        }
        VoiceGesture::Press => {
            if voice.phase == voice::VoicePhase::Idle {
                apply_voice_command("/voice start", voice, composer, hint, last_error);
            }
        }
        VoiceGesture::Release => {
            if voice.config.capture_mode == voice::CaptureMode::Hold
                && voice.phase == voice::VoicePhase::Recording
            {
                apply_voice_command("/voice stop", voice, composer, hint, last_error);
            }
        }
    }
}

fn parse_inspect(flags: &[&str]) -> io::Result<LaunchMode> {
    let mut json = false;
    let mut help = false;
    let mut debug = false;
    let mut debug_file = None;
    let mut index = 0;
    while index < flags.len() {
        match flags[index] {
            "--json" => json = true,
            "--help" | "-h" => help = true,
            "--debug" => debug = true,
            "--debug-file" => {
                index += 1;
                let path = flags.get(index).ok_or_else(|| {
                    io::Error::other("missing --debug-file path; use codsh --rust inspect --help")
                })?;
                debug_file = Some(PathBuf::from(path));
            }
            "--leader-socket" => {
                return Err(io::Error::other(
                    "inspect --leader-socket is unused; dsh owns execution. Omit the flag.",
                ));
            }
            other if other.starts_with("--debug-file=") => {
                debug_file = Some(PathBuf::from(&other[13..]));
            }
            other => {
                return Err(io::Error::other(format!(
                    "unsupported inspect option {other}; use codsh --rust inspect --help"
                )));
            }
        }
        index += 1;
    }
    Ok(LaunchMode::Inspect {
        json,
        help,
        debug,
        debug_file,
    })
}

fn take_debug_file(flags: &[&str], index: &mut usize, command: &str) -> io::Result<PathBuf> {
    *index += 1;
    flags.get(*index).map(PathBuf::from).ok_or_else(|| {
        io::Error::other(format!(
            "missing --debug-file path; use codsh --rust {command} --help"
        ))
    })
}

fn parse_login(flags: &[&str]) -> io::Result<LaunchMode> {
    let mut parsed = auth::LoginFlags::default();
    let mut help = false;
    let mut index = 0;
    while index < flags.len() {
        match flags[index] {
            "--help" | "-h" => help = true,
            "--oauth" | "--oidc" => {
                if parsed.device_auth {
                    return Err(io::Error::other(
                        "--oauth conflicts with --device-auth; use only one login transport",
                    ));
                }
                parsed.oauth = true;
            }
            "--device-auth" | "--device-code" => {
                if parsed.oauth {
                    return Err(io::Error::other(
                        "--device-auth conflicts with --oauth; use only one login transport",
                    ));
                }
                parsed.device_auth = true;
            }
            "--debug" => parsed.debug = true,
            "--debug-file" => {
                parsed.debug_file = Some(take_debug_file(flags, &mut index, "login")?)
            }
            other if other.starts_with("--debug-file=") => {
                parsed.debug_file = Some(PathBuf::from(&other[13..]));
            }
            "--leader-socket" => {
                return Err(io::Error::other(
                    "login --leader-socket is unused; dsh owns execution. Omit the flag.",
                ));
            }
            other => {
                return Err(io::Error::other(format!(
                    "unsupported login option {other}; use codsh --rust login --help"
                )));
            }
        }
        index += 1;
    }
    Ok(LaunchMode::Login {
        flags: parsed,
        help,
    })
}

fn parse_logout(flags: &[&str]) -> io::Result<LaunchMode> {
    let mut debug = false;
    let mut debug_file = None;
    let mut help = false;
    let mut index = 0;
    while index < flags.len() {
        match flags[index] {
            "--help" | "-h" => help = true,
            "--debug" => debug = true,
            "--debug-file" => debug_file = Some(take_debug_file(flags, &mut index, "logout")?),
            other if other.starts_with("--debug-file=") => {
                debug_file = Some(PathBuf::from(&other[13..]));
            }
            "--leader-socket" => {
                return Err(io::Error::other(
                    "logout --leader-socket is unused; dsh owns execution. Omit the flag.",
                ));
            }
            other => {
                return Err(io::Error::other(format!(
                    "unsupported logout option {other}; use codsh --rust logout --help"
                )));
            }
        }
        index += 1;
    }
    Ok(LaunchMode::Logout {
        debug,
        debug_file,
        help,
    })
}

fn parse_setup(flags: &[&str]) -> io::Result<LaunchMode> {
    let mut parsed = auth::SetupFlags::default();
    let mut help = false;
    let mut index = 0;
    while index < flags.len() {
        match flags[index] {
            "--help" | "-h" => help = true,
            "--json" => parsed.json = true,
            "--debug" => parsed.debug = true,
            "--debug-file" => {
                parsed.debug_file = Some(take_debug_file(flags, &mut index, "setup")?)
            }
            other if other.starts_with("--debug-file=") => {
                parsed.debug_file = Some(PathBuf::from(&other[13..]));
            }
            "--leader-socket" => {
                return Err(io::Error::other(
                    "setup --leader-socket is unused; dsh owns execution. Omit the flag.",
                ));
            }
            other => {
                return Err(io::Error::other(format!(
                    "unsupported setup option {other}; use codsh --rust setup --help"
                )));
            }
        }
        index += 1;
    }
    Ok(LaunchMode::Setup {
        flags: parsed,
        help,
    })
}

fn turn_from_restored(item: RestoredTurn) -> Turn {
    let mut turn = Turn {
        user: item.user,
        thought: item.thought,
        answer: item.answer,
        error: item.error,
        message_id: None,
        tools: item
            .tools
            .into_iter()
            .map(|tool| ToolRow {
                id: tool.id,
                title: tool.title,
                kind: String::new(),
                status: tool.status,
                diff: tool.diff,
                result: tool.result,
                raw_input: Value::Null,
            })
            .collect(),
        permission: None,
        done: true,
        cancelling: false,
        cancelled: item.cancelled,
        interrupted: item.interrupted,
        compacted: item.compacted,
        compaction: item.compaction,
        timestamp: None,
        quiet_cancel: false,
    };
    if turn.interrupted || turn.cancelled {
        mark_unknown_open_tools(&mut turn);
    }
    turn
}

fn mark_unknown_open_tools(turn: &mut Turn) {
    for tool in &mut turn.tools {
        if tool.status == "pending" || tool.status == "in_progress" {
            tool.status = "unknown".into();
            turn.interrupted = true;
        }
    }
}

/// MCP servers this connection should have started but did not.
fn mcp_notices(client: &AcpClient) -> Vec<String> {
    mcp::live_rows(
        client.mcp_plan_path(),
        client.session_id.as_deref(),
        &client.mcp_failed,
    )
    .map(|(rows, _)| mcp::startup_notices(&rows))
    .unwrap_or_default()
}

/// The `/mcps` report for the live connection.
fn mcp_report(client: Option<&AcpClient>) -> String {
    let Some(active) = client else {
        return "MCP: not connected".into();
    };
    match mcp::live_rows(
        active.mcp_plan_path(),
        active.session_id.as_deref(),
        &active.mcp_failed,
    ) {
        Some((rows, max)) => mcp::render_rows(&rows, max),
        None => "MCP: no server plan for this session (config could not be read)".into(),
    }
}

fn drop_connection(client: &mut Option<AcpClient>, owner: &mut Option<SessionOwner>) {
    if let Some(active) = client.as_mut() {
        active.shutdown();
    }
    *client = None;
    *owner = None;
}

/// A plugin enable, disable, update, or removal changes the hooks and agent
/// types dsh read at start. Rescan assets, and when those differ from what
/// the live child was given, drop it; the caller reconnects on the same
/// session with fresh env. Rules, skills, and commands need no restart.
fn replace_if_plugin_runtime_changed(
    client: &mut Option<AcpClient>,
    owner: &mut Option<SessionOwner>,
    effective: &mut config::EffectiveConfig,
    extra_env: &[(String, String)],
) {
    if client.is_none() {
        return;
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| effective.grok_home.clone());
    config::refresh_assets(effective, &home);
    if config::plugin_runtime_changed(effective, extra_env) {
        drop_connection(client, owner);
    }
}

/// Live connection inputs after config reload. The spawned dsh process keeps
/// the env it was given, so a readiness or credential change must replace it.
struct RuntimeApply {
    extra_env: Vec<(String, String)>,
    patch: Option<PathBuf>,
    apply_failed: bool,
    error: String,
}

/// Copy a saved session mode onto the policy and rewrite the file dsh reads.
/// Called before `dsh_spawn_spec` so the child does not start on the previous mode.
pub(crate) fn apply_saved_session_mode(
    effective: &mut config::EffectiveConfig,
    session_id: Option<&str>,
) -> Result<(), String> {
    let Some(session_id) = session_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let Some(saved) = session_owner::read_session_mode(&effective.dsh_home, session_id) else {
        return Ok(());
    };
    let mode = permission::PermissionMode::parse(&saved)?;
    effective.permission.mode = mode;
    effective.permission.mode_source = "session".into();
    permission::write_policy_file(&effective.dsh_home, &effective.permission)
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Session id whose mode file must be on the policy before dsh starts.
/// `--resume` and a same-directory `--continue` are known from disk. A
/// `--continue` that falls through to `session/list` is not, and stays on
/// the policy already written by `runtime_apply`.
fn known_resume_session(mode: &LaunchMode, effective: &config::EffectiveConfig) -> Option<String> {
    match mode {
        LaunchMode::Resume(id) => Some(id.clone()),
        LaunchMode::Continue => session_owner::read_last_session(&effective.dsh_home)
            .filter(|(_, last_cwd)| {
                let last = last_cwd.canonicalize().unwrap_or(last_cwd.clone());
                let now = effective
                    .cwd
                    .canonicalize()
                    .unwrap_or_else(|_| effective.cwd.clone());
                last == now
            })
            .map(|(id, _)| id),
        LaunchMode::Plain {
            resume: Some(PlainResume::Id(id)),
            ..
        } => Some(id.clone()),
        LaunchMode::Plain {
            resume: Some(PlainResume::Continue),
            ..
        } => known_resume_session(&LaunchMode::Continue, effective),
        _ => None,
    }
}

fn runtime_apply(effective: &config::EffectiveConfig) -> RuntimeApply {
    let env = std::env::vars().collect();
    let mut extra_env = config::credential_env(effective, &env);
    extra_env.extend(config::compact_env(effective));
    extra_env.extend(config::permission_env(effective));
    extra_env.extend(config::web_env(effective));
    extra_env.extend(config::subagent_env(effective));
    extra_env.extend(config::interaction_env(effective));
    extra_env.extend(config::plugin_hook_env(effective));
    // A plan that cannot be written leaves the session without MCP servers;
    // /mcps reports the missing plan instead of inventing one.
    if let Ok(pair) = mcp::plan_env(effective, &env, "main") {
        extra_env.push(pair);
    }
    extra_env.extend(worktree::dsh_env(&effective.grok_home));
    extra_env.extend(config::bash_env(effective));
    // Scheduled prompts (ticket 177): the interactive client only. The
    // plain path removes it again.
    extra_env.extend(scheduler::dsh_env());
    extra_env.extend(config::goal_env(effective));
    match config::apply_to_dsh(effective, &env) {
        Ok(patch) => RuntimeApply {
            extra_env,
            patch,
            apply_failed: false,
            error: String::new(),
        },
        Err(error) => RuntimeApply {
            extra_env,
            patch: None,
            apply_failed: true,
            error: error.to_string(),
        },
    }
}

/// Whether a live dsh process must be replaced after slash login/logout.
/// A settings write error is not a reason to drop a process that still has
/// the previous patch: the caller keeps that client and reports the error.
/// Credential env, readiness, and the applied settings patch are delivered to
/// the spawned process only, so any of those changing replaces it.
fn slash_reload_replaces_client(
    previous_env: &[(String, String)],
    previous_ready: bool,
    previous_patch: Option<&str>,
    applied: &RuntimeApply,
    next_ready: bool,
) -> bool {
    if applied.apply_failed {
        return false;
    }
    let next_patch = applied
        .patch
        .as_deref()
        .and_then(|path| std::fs::read_to_string(path).ok());
    previous_env != applied.extra_env.as_slice()
        || previous_ready != next_ready
        || previous_patch != next_patch.as_deref()
}

fn can_execute(effective: &config::EffectiveConfig, apply_failed: bool) -> bool {
    if apply_failed || effective.trust_prompt {
        return false;
    }
    // The ACP mock seam may execute without a provider, but it must not bypass
    // an organization pin that still lacks a matching identity session.
    if auth::usable_identity_session(&effective.auth, effective.auth_session.as_ref()).is_err() {
        return false;
    }
    // Login stays available when locked policy is unverifiable, but that
    // error must not become a reason to execute. An invalid requirements
    // file, including an unknown top-level key, is the same kind of stop.
    if effective.errors.iter().any(|error| {
        error
            .reason
            .contains("Signature/locking requirements cannot be verified")
            || error.reason.contains("unknown security/policy field")
            || error
                .path
                .as_ref()
                .is_some_and(|path| path.ends_with("requirements.toml"))
    }) {
        return false;
    }
    effective.ready || config::is_test_execution_seam()
}

struct LiveSession<'a> {
    client: &'a mut Option<AcpClient>,
    owner: &'a mut Option<SessionOwner>,
    turns: &'a mut Vec<Turn>,
    resumed: &'a mut bool,
    previous_session: &'a mut Option<String>,
    selection_ready: &'a mut bool,
    last_error: &'a mut String,
}

fn open_live_session(
    mode: &LaunchMode,
    extra_env: &[(String, String)],
    patch: Option<&PathBuf>,
    effective: &mut config::EffectiveConfig,
    live: &mut LiveSession<'_>,
) -> Result<(), String> {
    let resume_id = known_resume_session(mode, effective).or_else(|| match mode {
        LaunchMode::New => live.previous_session.clone(),
        _ => None,
    });
    apply_saved_session_mode(effective, resume_id.as_deref())?;
    let (connection, restored) = connect(
        mode,
        live.previous_session.as_deref(),
        extra_env,
        patch,
        false,
        None,
    )?;
    *live.resumed = connection.resumed;
    *live.previous_session = connection.client.session_id.clone();
    *live.owner = Some(connection.owner);
    if live.turns.is_empty() {
        *live.turns = restored;
    }
    let mut connected = connection.client;
    match apply_live_selection(&mut connected, effective) {
        Ok(()) => {
            *live.selection_ready = true;
            live.last_error.clear();
        }
        Err(error) => {
            *live.last_error = error;
            *live.selection_ready = false;
        }
    }
    let notices = mcp_notices(&connected);
    if live.last_error.is_empty() && !notices.is_empty() {
        *live.last_error = notices.join("; ");
    }
    *live.client = Some(connected);
    Ok(())
}

fn session_mode(mode: &LaunchMode) -> LaunchMode {
    match mode {
        LaunchMode::Plain {
            resume: Some(PlainResume::Continue),
            ..
        } => LaunchMode::Continue,
        LaunchMode::Plain {
            resume: Some(PlainResume::Id(id)),
            ..
        } => LaunchMode::Resume(id.clone()),
        other => other.clone(),
    }
}

fn resolve_resume(
    client: &mut AcpClient,
    mode: &LaunchMode,
    cwd: &std::path::Path,
    dsh_home: &std::path::Path,
    previous: Option<&str>,
) -> Result<Option<String>, String> {
    match mode {
        LaunchMode::Resume(id) => {
            if session_catalog::is_uuid(id) {
                return Ok(Some(id.clone()));
            }
            let catalog = session_catalog::load_catalog(dsh_home, cwd);
            match session_catalog::resolve_resume(&catalog.sessions, id, cwd) {
                Ok(found) => Ok(Some(found.session.id)),
                Err(error) => Err(error.message),
            }
        }
        LaunchMode::Continue => {
            if let Some((id, last_cwd)) = session_owner::read_last_session(dsh_home) {
                let last = last_cwd.canonicalize().unwrap_or(last_cwd);
                let now = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
                if last == now {
                    return Ok(Some(id));
                }
            }
            let listed = client
                .list_sessions(cwd, Duration::from_secs(20))
                .map_err(|error| error.message)?;
            listed
                .into_iter()
                .next()
                .map(|(id, _)| id)
                .ok_or_else(|| "no previous session in this directory".into())
                .map(Some)
        }
        LaunchMode::New if previous.is_some() => Ok(previous.map(str::to_string)),
        _ => Ok(None),
    }
}

fn connect(
    mode: &LaunchMode,
    previous: Option<&str>,
    extra_env: &[(String, String)],
    patch: Option<&PathBuf>,
    fork_session: bool,
    child_id: Option<&str>,
) -> Result<(Connection, Vec<Turn>), String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let dsh_home = PathBuf::from(
        std::env::var_os("DSH_HOME").ok_or("missing isolated DSH_HOME; use codsh --rust")?,
    );
    let mut spec = acp::dsh_spawn_spec(cwd.clone(), &dsh_home, extra_env, patch.cloned())
        .map_err(|error| error.message)?;
    // Only the terminal UI has a question card. Plain prompts answer every
    // question as "no operator" and dsh auto-approves a plan review there.
    if !matches!(mode, LaunchMode::Plain { .. }) {
        spec.env.push(("CODSH_INTERACTION".into(), "tui".into()));
    }
    if let Some(overlay) = filesystem_sandbox::dsh_overlay(&cwd) {
        // dsh's per-call Seatbelt cannot nest inside the policy this process
        // already runs under, so its bash would refuse every command.
        let path = dsh_home.join("codsh-kernel-sandbox.yml");
        std::fs::write(&path, overlay)
            .map_err(|error| format!("cannot write {} ({error})", path.display()))?;
        spec.args.push("--patch".into());
        spec.args.push(path.to_string_lossy().into_owned());
    }
    let mut client = AcpClient::spawn(spec).map_err(|error| error.to_string())?;
    client
        .initialize(Duration::from_secs(20))
        .map_err(|error| error.message)?;
    let resume_id = resolve_resume(&mut client, &session_mode(mode), &cwd, &dsh_home, previous)?;
    let resume_id = if fork_session {
        let source = resume_id
            .ok_or_else(|| "--fork-session requires --resume or --continue".to_string())?;
        let forked = session_fork::fork_conversation(&dsh_home, &source, None, child_id)
            .map_err(|error| error.message)?;
        Some(forked.session_id)
    } else {
        resume_id
    };
    let (session_id, resumed, owner) = if let Some(session_id) = resume_id {
        let owner = SessionOwner::acquire(&dsh_home, &session_id).map_err(|error| error.message)?;
        match client.resume_session(&session_id, &cwd, Duration::from_secs(20)) {
            Ok(id) => (id, true, owner),
            Err(error) => return Err(error.message),
        }
    } else {
        let session_id = client
            .new_session(&cwd, Duration::from_secs(20))
            .map_err(|error| error.message)?;
        let owner = SessionOwner::acquire(&dsh_home, &session_id).map_err(|error| error.message)?;
        (session_id, false, owner)
    };
    let _ = session_owner::write_last_session(&dsh_home, &session_id, &cwd);
    let mut turns = Vec::new();
    if resumed {
        match session_history::load_turns(&dsh_home, &session_id) {
            Ok(restored) => {
                turns = restored.into_iter().map(turn_from_restored).collect();
            }
            Err(error) => {
                return Err(if error.damaged && !error.message.contains("damaged") {
                    format!("source data is damaged: {}", error.message)
                } else {
                    error.message
                });
            }
        }
    }
    Ok((
        Connection {
            client,
            owner,
            resumed,
        },
        turns,
    ))
}

fn apply_fork_model(client: &mut AcpClient, prefs: &UiPrefs) -> Result<(), String> {
    let Some(model) = prefs.fork_secondary_model.as_deref() else {
        return Ok(());
    };
    let values = client.model_values();
    let selected = acp::resolve_fork_model_value(&values, model).ok_or_else(|| {
        format!(
            "unavailable fork model {model}; advertised models: {}",
            values.join(", ")
        )
    })?;
    client
        .set_config_option("model", &selected, Duration::from_secs(10))
        .map(|_| ())
        .map_err(|error| format!("unavailable fork model {model}: {}", error.message))
}

fn switch_session(
    client: &mut AcpClient,
    owner: &mut Option<SessionOwner>,
    dsh_home: &Path,
    cwd: &Path,
    session_id: &str,
) -> Result<Vec<Turn>, String> {
    let current = client.session_id.clone();
    if current.as_deref() == Some(session_id) {
        return match session_history::load_turns(dsh_home, session_id) {
            Ok(restored) => Ok(restored.into_iter().map(turn_from_restored).collect()),
            Err(error) => Err(error.message),
        };
    }
    let catalog = session_catalog::load_catalog(dsh_home, cwd);
    let target = catalog
        .sessions
        .iter()
        .find(|session| session.id == session_id && session.foreign.is_none());
    let Some(target) = target else {
        return Err(format!("session is not resumable: {session_id}"));
    };
    if !session_catalog::same_directory(&target.cwd, cwd) {
        return Err(format!(
            "occupied: session cwd does not match: {} stays on {}",
            target.cwd,
            cwd.display()
        ));
    }
    // A stale activity ownerPid is not a lock. Only a held lock file refuses
    // before session/resume; an agent "already active" answer is separate.
    if session_owner::occupied_holder(dsh_home, session_id).is_some() {
        let pid = session_owner::occupied_holder(dsh_home, session_id);
        return Err(match pid {
            Some(pid) if pid != 0 => format!(
                "Write owner refused: session {session_id} is already running (pid {pid}). occupied: {session_id} stays on its current owner"
            ),
            _ => format!(
                "Write owner refused: session {session_id} is already running. occupied: {session_id} stays on its current owner"
            ),
        });
    }
    // Take the next lock before touching the live ACP session. A refused or
    // missing target must leave this client writing the session it already owns.
    let next_owner = SessionOwner::acquire(dsh_home, session_id).map_err(|error| {
        format!(
            "{} occupied: {session_id} stays on its current owner",
            error.message
        )
    })?;
    // Ask to resume before closing. The live session stays open until that
    // reply succeeds. A same-directory refusal (`already active` / `already
    // owned`) never reaches session/close. finish_resume closes the previous
    // id only after the agent has accepted the target.
    match client.prepare_resume(session_id, cwd, Duration::from_secs(20)) {
        Ok(()) => {}
        Err(error) => {
            drop(next_owner);
            let message = if error.message.contains("already active")
                || error.message.contains("already owned")
            {
                format!("already active: session {session_id} stays on its current owner")
            } else {
                error.message
            };
            return Err(message);
        }
    }
    if let Some(previous) = current.clone() {
        if let Err(error) = client.finish_resume(&previous, cwd, Duration::from_secs(20)) {
            let message = error.message;
            // The target is already the ACP session. Closing the previous id
            // failed, so this client still owns the target and must not reopen
            // the session it just left.
            client.abandon_resume();
            return Err(format!(
                "session switch stopped before close finished: {message}"
            ));
        }
    } else if let Err(error) = client.finish_resume("", cwd, Duration::from_secs(20)) {
        drop(next_owner);
        return Err(error.message);
    }
    *owner = Some(next_owner);
    let _ = session_owner::write_last_session(dsh_home, session_id, cwd);
    match session_history::load_turns(dsh_home, session_id) {
        Ok(restored) => Ok(restored.into_iter().map(turn_from_restored).collect()),
        Err(error) => Err(error.message),
    }
}

fn commit_rewind(
    client: &mut AcpClient,
    owner: &mut Option<SessionOwner>,
    turns: &mut Vec<Turn>,
    dsh_home: &Path,
    cwd: &Path,
    point: &RewindPoint,
    resumed: &mut bool,
    previous_session: &mut Option<String>,
    memory_session_on: &mut Option<bool>,
    memory_injected: &mut bool,
) -> Result<String, String> {
    let source = client
        .session_id
        .clone()
        .ok_or_else(|| "ACP session is not ready".to_string())?;
    let forked = session_fork::fork_conversation(dsh_home, &source, Some(point.boundary), None)
        .map_err(|error| error.message)?;
    if forked.files_restored {
        return Err("rewind restored files; conversation-only rewind required".into());
    }
    *turns = switch_session(client, owner, dsh_home, cwd, &forked.session_id)?;
    reset_memory_session(memory_session_on);
    *memory_injected = !turns.is_empty();
    *resumed = true;
    *previous_session = Some(forked.session_id.clone());
    Ok(format!(
        "rewound to turn {} · now on {} · {} stays in /resume",
        point.turn, forked.session_id, forked.parent_session
    ))
}

fn commit_fork(
    client: &mut AcpClient,
    owner: &mut Option<SessionOwner>,
    turns: &mut Vec<Turn>,
    inflight: &mut bool,
    dsh_home: &Path,
    cwd: &Path,
    prefs: &UiPrefs,
    directive: Option<&str>,
    launch: &Launch,
    effective: &config::EffectiveConfig,
    resumed: &mut bool,
    previous_session: &mut Option<String>,
    memory_session_on: &mut Option<bool>,
    memory_injected: &mut bool,
) -> Result<String, String> {
    let source = client
        .session_id
        .clone()
        .ok_or_else(|| "ACP session is not ready".to_string())?;
    let forked = session_fork::fork_conversation(dsh_home, &source, None, None)
        .map_err(|error| error.message)?;
    if forked.files_restored {
        return Err("fork restored files; conversation-only fork required".into());
    }
    *turns = switch_session(client, owner, dsh_home, cwd, &forked.session_id)?;
    reset_memory_session(memory_session_on);
    *memory_injected = !turns.is_empty();
    apply_fork_model(client, prefs)?;
    *resumed = true;
    *previous_session = Some(forked.session_id.clone());
    let mut report = format!(
        "forked · now on {} · {} stays in /resume",
        forked.session_id, forked.parent_session
    );
    if let Some(text) = directive.filter(|value| !value.trim().is_empty()) {
        let prompt = model_prompt(
            launch,
            effective,
            text,
            *memory_session_on,
            !*memory_injected && turns.is_empty(),
        );
        client
            .submit_prompt(&prompt)
            .map_err(|error| error.message)?;
        if let Some(session_id) = client.session_id.clone() {
            let _ = session_catalog::note_turn(dsh_home, &session_id, true);
        }
        turns.push(Turn {
            user: text.to_string(),
            thought: String::new(),
            answer: String::new(),
            error: None,
            message_id: None,
            tools: Vec::new(),
            permission: None,
            done: false,
            cancelling: false,
            cancelled: false,
            interrupted: false,
            compacted: false,
            compaction: None,
            timestamp: Some(clock_stamp()),
            quiet_cancel: false,
        });
        *inflight = true;
        report.push_str(" · submitted fork directive");
    }
    Ok(report)
}

enum CatalogSlash {
    Resume,
    Rename(String),
    RenameAuto,
    New,
    Clear,
    Info,
    Cd(Option<String>),
    Export(String),
    Share,
    Delete,
}

fn session_catalog_slash(text: &str) -> Option<CatalogSlash> {
    let command = text.trim().trim_start_matches('/');
    let (name, rest) = command
        .split_once(char::is_whitespace)
        .unwrap_or((command, ""));
    let rest = rest.trim();
    match name {
        "resume" => Some(CatalogSlash::Resume),
        "rename" | "title" if rest == "--auto" || (name == "title" && rest.is_empty()) => {
            Some(CatalogSlash::RenameAuto)
        }
        "rename" | "title" => {
            if rest.is_empty() {
                Some(CatalogSlash::Rename(String::new()))
            } else {
                Some(CatalogSlash::Rename(rest.to_string()))
            }
        }
        "new" | "clear" if name == "new" => Some(CatalogSlash::New),
        "clear" => Some(CatalogSlash::Clear),
        "session-info" | "info" => Some(CatalogSlash::Info),
        "cd" => Some(CatalogSlash::Cd(
            (!rest.is_empty()).then(|| rest.to_string()),
        )),
        "export" => Some(CatalogSlash::Export(rest.to_string())),
        "share" => Some(CatalogSlash::Share),
        "delete" => Some(CatalogSlash::Delete),
        _ => None,
    }
}

fn apply_session_catalog_slash(
    action: CatalogSlash,
    client: &mut Option<AcpClient>,
    owner: &mut Option<SessionOwner>,
    turns: &mut Vec<Turn>,
    inflight: &mut bool,
    overlay: &mut Overlay,
    hint: &mut String,
    last_error: &mut String,
    effective: &mut config::EffectiveConfig,
    extra_env: &mut Vec<(String, String)>,
    patch: &mut Option<PathBuf>,
    apply_failed: &mut bool,
    selection_ready: &mut bool,
    resumed: &mut bool,
    previous_session: &mut Option<String>,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    screen: ScreenMode,
    committed: &mut usize,
    history: &mut String,
    composer: &mut PromptComposer,
    launch: &Launch,
    memory_session_on: &mut Option<bool>,
    memory_injected: &mut bool,
) -> io::Result<()> {
    if *inflight && !matches!(action, CatalogSlash::Info | CatalogSlash::Export(_)) {
        *last_error = "finish or cancel the running turn before switching sessions".into();
        composer.set_text("");
        return Ok(());
    }
    match action {
        CatalogSlash::Resume => {
            open_session_picker(overlay, effective);
            hint.clear();
            last_error.clear();
            composer.set_text("");
        }
        CatalogSlash::Rename(title) => {
            let Some(session_id) = client.as_ref().and_then(|active| active.session_id.clone())
            else {
                *last_error = "ACP session is not ready".into();
                return Ok(());
            };
            if title.trim().is_empty() {
                *last_error = "rename needs a title; /rename --auto returns the title to the configured model".into();
                composer.set_text("");
                return Ok(());
            }
            match session_catalog::rename_session(&effective.dsh_home, &session_id, &title) {
                Ok(saved) => {
                    *hint = format!("renamed to {saved}");
                    last_error.clear();
                }
                Err(error) => *last_error = error.message,
            }
            composer.set_text("");
        }
        CatalogSlash::RenameAuto => {
            let Some(session_id) = client.as_ref().and_then(|active| active.session_id.clone())
            else {
                *last_error = "ACP session is not ready".into();
                return Ok(());
            };
            let _ = session_catalog::clear_manual_title(&effective.dsh_home, &session_id);
            let prompts: Vec<String> = turns
                .iter()
                .filter(|turn| !background::is_notice_line(&turn.user))
                .map(|turn| turn.user.clone())
                .collect();
            match maybe_title_session(effective, &session_id, &prompts) {
                Ok(message) => {
                    *hint = message;
                    last_error.clear();
                }
                Err(error) => *last_error = error,
            }
            composer.set_text("");
        }
        CatalogSlash::New => {
            let previous = client.as_ref().and_then(|active| active.session_id.clone());
            // Reload the directory first. A settings write error keeps the
            // live client; the transcript stays until the replacement starts.
            sync_effective_cwd(effective, launch);
            if !prepare_retained_apply(effective, extra_env, patch, apply_failed, last_error, hint)
            {
                composer.set_text("");
                return Ok(());
            }
            drop_connection(client, owner);
            *turns = Vec::new();
            *committed = 0;
            history.clear();
            *resumed = false;
            // A new ACP session follows config again. The previous session's
            // `t` toggle does not carry over, including an explicit false.
            *memory_session_on = None;
            *memory_injected = false;
            connect_retained_session(
                client,
                owner,
                previous_session,
                selection_ready,
                last_error,
                hint,
                effective,
                extra_env,
                patch.as_ref(),
                "new session",
                previous.as_deref(),
            );
            if last_error.is_empty() {
                let _ = reset_native_history_after_switch(terminal, screen, committed, history);
            }
            composer.set_text("");
        }
        CatalogSlash::Clear => {
            *turns = Vec::new();
            *committed = 0;
            history.clear();
            *hint = "cleared the visible transcript; the dsh session was not deleted".into();
            last_error.clear();
            composer.set_text("");
            let _ = reset_native_history_after_switch(terminal, screen, committed, history);
        }
        CatalogSlash::Info => {
            let Some(session_id) = client.as_ref().and_then(|active| active.session_id.clone())
            else {
                *last_error = "ACP session is not ready".into();
                return Ok(());
            };
            let catalog = session_catalog::load_catalog(&effective.dsh_home, &effective.cwd);
            let model = effective
                .routing()
                .map(|route| format!("{}/{}", route.provider, route.model))
                .unwrap_or_else(|| "unconfigured".into());
            if let Some(session) = catalog
                .sessions
                .iter()
                .find(|session| session.id == session_id)
            {
                *hint = session_catalog::render_session_info(session, &model);
            } else {
                *hint = format!("Session ID: {session_id}\nModel: {model}");
            }
            last_error.clear();
            composer.set_text("");
        }
        CatalogSlash::Export(path) => {
            let Some(session_id) = client.as_ref().and_then(|active| active.session_id.clone())
            else {
                *last_error = "No active session to export".into();
                composer.set_text("");
                return Ok(());
            };
            let target = if path.trim().is_empty() {
                session_data::ExportTarget::Clipboard
            } else {
                session_data::ExportTarget::File(PathBuf::from(path.trim()))
            };
            let mut sink = Vec::new();
            match session_data::export_session(
                &effective.dsh_home,
                &effective.cwd,
                &session_data::ExportRequest { session_id, target },
                &mut sink,
            ) {
                Ok(outcome) => {
                    *hint = outcome.message;
                    last_error.clear();
                }
                Err(error) => *last_error = error.message,
            }
            composer.set_text("");
        }
        CatalogSlash::Share => {
            let Some(session_id) = client.as_ref().and_then(|active| active.session_id.clone())
            else {
                *last_error = "No active session to share".into();
                composer.set_text("");
                return Ok(());
            };
            let request = session_data::ShareRequest {
                session_id,
                url: share_destination(effective, None),
            };
            match session_data::share_session(&effective.dsh_home, &effective.cwd, &request) {
                Ok(outcome) => {
                    *hint = format!("shared {}", outcome.url);
                    last_error.clear();
                }
                Err(error) => *last_error = error.message,
            }
            composer.set_text("");
        }
        CatalogSlash::Delete => {
            let Some(session_id) = client.as_ref().and_then(|active| active.session_id.clone())
            else {
                *last_error = "No active session to delete".into();
                composer.set_text("");
                return Ok(());
            };
            *overlay = Overlay::DeleteConfirm {
                session_id,
                return_to: DeleteReturn::Welcome,
            };
            *hint = String::new();
            last_error.clear();
            composer.set_text("");
        }
        CatalogSlash::Cd(path) => {
            if screen == ScreenMode::Minimal {
                *hint = "/cd isn't available in minimal mode (the location picker needs fullscreen). Run /fullscreen to switch this session.".into();
                composer.set_text("");
                return Ok(());
            }
            match path {
                Some(raw) => match apply_next_cwd(effective, &raw) {
                    Ok(message) => {
                        *hint = message;
                        last_error.clear();
                    }
                    Err(error) => *last_error = error,
                },
                None => {
                    *overlay = Overlay::Location {
                        draft: String::new(),
                        previous: effective.cwd.clone(),
                    };
                    hint.clear();
                }
            }
            composer.set_text("");
        }
    }
    Ok(())
}

fn dash_key(key: crossterm::event::KeyEvent) -> Option<session_catalog::DashKey> {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        return match key.code {
            KeyCode::Char(ch) => Some(session_catalog::DashKey::Ctrl(ch)),
            _ => None,
        };
    }
    if !key.modifiers.is_empty() {
        return None;
    }
    match key.code {
        KeyCode::Up | KeyCode::Char('k') => Some(session_catalog::DashKey::Up),
        KeyCode::Down | KeyCode::Char('j') => Some(session_catalog::DashKey::Down),
        KeyCode::Enter => Some(session_catalog::DashKey::Enter),
        KeyCode::Esc => Some(session_catalog::DashKey::Esc),
        KeyCode::Tab => Some(session_catalog::DashKey::Tab),
        KeyCode::Backspace => Some(session_catalog::DashKey::Backspace),
        KeyCode::Char(ch) => Some(session_catalog::DashKey::Char(ch)),
        _ => None,
    }
}

fn handle_catalog_overlay_key(
    key: crossterm::event::KeyEvent,
    overlay: &mut Overlay,
    client: &mut Option<AcpClient>,
    owner: &mut Option<SessionOwner>,
    turns: &mut Vec<Turn>,
    committed: &mut usize,
    history: &mut String,
    resumed: &mut bool,
    previous_session: &mut Option<String>,
    effective: &mut config::EffectiveConfig,
    extra_env: &mut Vec<(String, String)>,
    patch: &mut Option<PathBuf>,
    apply_failed: &mut bool,
    selection_ready: &mut bool,
    hint: &mut String,
    last_error: &mut String,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    screen: ScreenMode,
    launch: &Launch,
    memory_session_on: &mut Option<bool>,
    memory_injected: &mut bool,
) -> io::Result<bool> {
    match overlay {
        Overlay::SessionPick {
            hits,
            cursor,
            query,
            refusal,
            delete_armed,
        } => {
            match key.code {
                KeyCode::Esc => {
                    if *delete_armed {
                        *delete_armed = false;
                        *hint = "delete cancelled".into();
                    } else {
                        *overlay = Overlay::None;
                        hint.clear();
                    }
                }
                KeyCode::Char('d') if key.modifiers.is_empty() => {
                    if let Some(hit) = hits.get(*cursor) {
                        *delete_armed = true;
                        *hint = session_data::confirm_delete_prompt(&hit.session.id);
                        refusal.clear();
                    }
                }
                KeyCode::Char('y') if key.modifiers.is_empty() && *delete_armed => {
                    let Some(hit) = hits.get(*cursor).cloned() else {
                        *delete_armed = false;
                        return Ok(true);
                    };
                    match session_data::delete_session(
                        &effective.dsh_home,
                        &effective.cwd,
                        &session_data::DeleteRequest {
                            session_id: hit.session.id.clone(),
                            confirmed: true,
                        },
                    ) {
                        Ok(()) => {
                            *last_error =
                                "blocked: session deletion reported success; nothing was removed"
                                    .into();
                            *refusal = last_error.clone();
                            *delete_armed = false;
                        }
                        Err(error) => {
                            *last_error = error.message.clone();
                            *refusal = error.message;
                            *delete_armed = false;
                        }
                    }
                }
                KeyCode::Char('n') if key.modifiers.is_empty() && *delete_armed => {
                    *delete_armed = false;
                    *hint = "delete cancelled".into();
                }
                KeyCode::Up | KeyCode::Char('k') if key.modifiers.is_empty() && *cursor > 0 => {
                    *cursor -= 1;
                    *delete_armed = false;
                    refusal.clear();
                }
                KeyCode::Down | KeyCode::Char('j')
                    if key.modifiers.is_empty() && *cursor + 1 < hits.len() =>
                {
                    *cursor += 1;
                    *delete_armed = false;
                    refusal.clear();
                }
                KeyCode::Backspace => {
                    query.pop();
                    *delete_armed = false;
                    refusal.clear();
                    refresh_picker(hits, cursor, query, effective);
                }
                KeyCode::Char(ch) if key.modifiers.is_empty() => {
                    query.push(ch);
                    *delete_armed = false;
                    refusal.clear();
                    refresh_picker(hits, cursor, query, effective);
                }
                KeyCode::Enter => {
                    let Some(hit) = hits.get(*cursor).cloned() else {
                        *hint = "No sessions match.".into();
                        *overlay = Overlay::None;
                        return Ok(true);
                    };
                    if let Some(active) = client.as_mut() {
                        match switch_to_catalog_session(
                            active,
                            owner,
                            turns,
                            committed,
                            history,
                            &effective.dsh_home,
                            &effective.cwd,
                            &hit.session.id,
                            resumed,
                            previous_session,
                        ) {
                            Ok(message) => {
                                *hint = message;
                                last_error.clear();
                                *overlay = Overlay::None;
                                reset_memory_session(memory_session_on);
                                *memory_injected = !turns.is_empty();
                                let _ = reset_native_history_after_switch(
                                    terminal, screen, committed, history,
                                );
                            }
                            Err(error) => {
                                let shown = catalog_switch_refusal(&hit.session.id, &error);
                                *last_error = error;
                                *hint = shown.clone();
                                // The picker replaces the status line, so the
                                // refusal has to stay on the open surface.
                                *refusal = shown;
                            }
                        }
                    }
                }
                _ => {}
            }
            Ok(true)
        }
        Overlay::Dashboard(view) => {
            let Some(key) = dash_key(key) else {
                return Ok(true);
            };
            let catalog = session_catalog::load_catalog(&effective.dsh_home, &effective.cwd);
            let action = session_catalog::handle_dashboard_key(view, &catalog.sessions, key);
            if !view.entered {
                *overlay = Overlay::None;
                *hint = "left dashboard; draft kept".into();
                return Ok(true);
            }
            if let Some(action) = action {
                apply_dashboard_action(
                    &action,
                    overlay,
                    client,
                    owner,
                    turns,
                    committed,
                    history,
                    resumed,
                    previous_session,
                    effective,
                    extra_env,
                    patch,
                    apply_failed,
                    selection_ready,
                    hint,
                    last_error,
                    terminal,
                    screen,
                    launch,
                    memory_session_on,
                    memory_injected,
                )?;
            }
            Ok(true)
        }
        Overlay::DeleteConfirm {
            session_id,
            return_to,
        } => {
            match key.code {
                KeyCode::Char('y') if key.modifiers.is_empty() => {
                    let _ = return_to;
                    match session_data::delete_session(
                        &effective.dsh_home,
                        &effective.cwd,
                        &session_data::DeleteRequest {
                            session_id: session_id.clone(),
                            confirmed: true,
                        },
                    ) {
                        Ok(()) => {
                            *last_error =
                                "blocked: session deletion reported success; nothing was removed"
                                    .into();
                        }
                        Err(error) => *last_error = error.message,
                    }
                    *overlay = Overlay::None;
                }
                KeyCode::Char('n') | KeyCode::Esc if key.modifiers.is_empty() => {
                    *hint = "delete cancelled".into();
                    match return_to {
                        DeleteReturn::Dashboard => {
                            let _ = open_dashboard_overlay(overlay, effective, client.as_ref());
                        }
                        DeleteReturn::Picker => open_session_picker(overlay, effective),
                        DeleteReturn::Welcome => *overlay = Overlay::None,
                    }
                }
                _ => {}
            }
            Ok(true)
        }
        Overlay::Memory(browser) => {
            let Some(mapped) = memory_key(key) else {
                return Ok(true);
            };
            if mapped == memory_ui::Key::Char('f') && key.modifiers.contains(KeyModifiers::CONTROL)
            {
                memory_ui::toggle_fullscreen(browser);
                return Ok(true);
            }
            let mapped = match (browser.pane, key.code) {
                (
                    memory_ui::Pane::List
                    | memory_ui::Pane::Preview
                    | memory_ui::Pane::ConfirmDelete,
                    KeyCode::Char('k'),
                ) => memory_ui::Key::Up,
                (
                    memory_ui::Pane::List
                    | memory_ui::Pane::Preview
                    | memory_ui::Pane::ConfirmDelete,
                    KeyCode::Char('j'),
                ) => memory_ui::Key::Down,
                _ => mapped,
            };
            let store = memory_store(effective).map_err(io::Error::other)?;
            match memory_ui::handle_key(browser, &store, mapped) {
                Some(memory_ui::Action::ForceOff) => {
                    *memory_session_on = Some(browser.session_enabled);
                    *hint = "memory is force-disabled for this process".into();
                    *overlay = Overlay::None;
                }
                Some(memory_ui::Action::Copy(path)) => {
                    *hint = match copy_to_clipboard(&path) {
                        Ok(()) => format!("copied {path}"),
                        Err(error) => error,
                    };
                }
                Some(memory_ui::Action::Close) => {
                    *memory_session_on = Some(browser.session_enabled);
                    // A late `t` on (after the first-turn injection window
                    // closed) must not be summarized as "memory on for this
                    // session": no remaining prompt here will see it. Use the
                    // late-toggle flag, not `notice` — a later key can replace
                    // the notice before Esc — and not `memory_injected` alone,
                    // which is also true for a plain close after a normal
                    // first turn. A close without a late toggle still reports
                    // the plain session state.
                    *hint = if browser.session_enabled && browser.late_toggle_on {
                        "memory on, but too late for this session; /new still follows config.toml"
                            .into()
                    } else if browser.session_enabled {
                        "memory on for this session".into()
                    } else {
                        "memory off for this session; files kept".into()
                    };
                    *overlay = Overlay::None;
                }
                Some(memory_ui::Action::Toggled) => {
                    // `t` changes this session only. The modal stays open.
                    *memory_session_on = Some(browser.session_enabled);
                    *hint = browser.notice.clone();
                }
                Some(memory_ui::Action::Confirmed) => {
                    *memory_session_on = Some(browser.session_enabled);
                    *hint = browser.notice.clone();
                    // Save and cancel return to the prompt. The browser does
                    // not keep consuming the next slash command.
                    *overlay = Overlay::None;
                }
                None => {}
            }
            Ok(true)
        }
        Overlay::Remember { draft, scope } => {
            match key.code {
                KeyCode::Esc => {
                    *hint = "memory note cancelled; nothing was written".into();
                    *overlay = Overlay::None;
                }
                KeyCode::Char(ch)
                    if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
                {
                    draft.push(ch);
                }
                KeyCode::Backspace => {
                    draft.pop();
                }
                KeyCode::Enter => {
                    let browser = open_remember_confirmation(
                        effective,
                        *memory_session_on,
                        *memory_injected,
                        draft,
                        *scope,
                    )
                    .map_err(io::Error::other)?;
                    *hint = browser.notice.clone();
                    *overlay = Overlay::Memory(browser);
                }
                _ => {}
            }
            Ok(true)
        }
        Overlay::Location { draft, previous } => {
            match key.code {
                KeyCode::Esc => {
                    *hint = format!("location unchanged: {}", previous.display());
                    *overlay = Overlay::None;
                }
                KeyCode::Char(ch) if key.modifiers.is_empty() => draft.push(ch),
                KeyCode::Backspace => {
                    draft.pop();
                }
                KeyCode::Enter => {
                    let raw = draft.clone();
                    match apply_next_cwd(effective, &raw) {
                        Ok(message) => {
                            *hint = message;
                            last_error.clear();
                            *overlay = Overlay::None;
                        }
                        Err(error) => *last_error = error,
                    }
                }
                _ => {}
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn refresh_picker(
    hits: &mut Vec<session_catalog::SearchHit>,
    cursor: &mut usize,
    query: &str,
    effective: &config::EffectiveConfig,
) {
    let catalog = session_catalog::load_catalog(&effective.dsh_home, &effective.cwd);
    *hits = if query.trim().is_empty() {
        catalog
            .sessions
            .iter()
            .map(|session| session_catalog::SearchHit {
                session: session.clone(),
                extended: false,
                snippet: session.display_title().to_string(),
            })
            .collect()
    } else {
        session_catalog::search(&catalog, query, None)
    };
    if *cursor >= hits.len() {
        *cursor = 0;
    }
}

fn apply_dashboard_action(
    action: &str,
    overlay: &mut Overlay,
    client: &mut Option<AcpClient>,
    owner: &mut Option<SessionOwner>,
    turns: &mut Vec<Turn>,
    committed: &mut usize,
    history: &mut String,
    resumed: &mut bool,
    previous_session: &mut Option<String>,
    effective: &mut config::EffectiveConfig,
    extra_env: &mut Vec<(String, String)>,
    patch: &mut Option<PathBuf>,
    apply_failed: &mut bool,
    selection_ready: &mut bool,
    hint: &mut String,
    last_error: &mut String,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    screen: ScreenMode,
    launch: &Launch,
    memory_session_on: &mut Option<bool>,
    memory_injected: &mut bool,
) -> io::Result<()> {
    if let Some(id) = action.strip_prefix("open ") {
        if let Some(active) = client.as_mut() {
            match switch_to_catalog_session(
                active,
                owner,
                turns,
                committed,
                history,
                &effective.dsh_home,
                &effective.cwd,
                id,
                resumed,
                previous_session,
            ) {
                Ok(message) => {
                    *hint = message;
                    last_error.clear();
                    *overlay = Overlay::None;
                    reset_memory_session(memory_session_on);
                    *memory_injected = !turns.is_empty();
                    let _ = reset_native_history_after_switch(terminal, screen, committed, history);
                }
                Err(error) => {
                    let shown = catalog_switch_refusal(id, &error);
                    *last_error = error;
                    *hint = shown.clone();
                    if let Overlay::Dashboard(view) = overlay {
                        view.notice = shown;
                    }
                }
            }
        }
        return Ok(());
    }
    if let Some(rest) = action.strip_prefix("rename ") {
        let mut parts = rest.splitn(2, ' ');
        let id = parts.next().unwrap_or("");
        let title = parts.next().unwrap_or("");
        match session_catalog::rename_session(&effective.dsh_home, id, title) {
            Ok(saved) => {
                *hint = format!("renamed {id} to {saved}");
                last_error.clear();
            }
            Err(error) => *last_error = error.message,
        }
        return Ok(());
    }
    if let Some(id) = action.strip_prefix("pin ") {
        let catalog = session_catalog::load_catalog(&effective.dsh_home, &effective.cwd);
        let pinned = catalog
            .sessions
            .iter()
            .find(|session| session.id == id)
            .is_some_and(|session| !session.pinned);
        if let Err(error) = session_catalog::toggle_pin(&effective.grok_home, id, pinned) {
            *last_error = error.to_string();
        } else {
            *hint = format!("{} {id}", if pinned { "pinned" } else { "unpinned" });
            last_error.clear();
        }
        return Ok(());
    }
    if action == "group" {
        let prefs = session_catalog::read_dashboard_prefs(&effective.dsh_home);
        let next = match prefs.grouping {
            session_catalog::Grouping::State => session_catalog::Grouping::Directory,
            session_catalog::Grouping::Directory => session_catalog::Grouping::State,
        };
        if let Err(error) = session_catalog::save_grouping(&effective.grok_home, next) {
            *last_error = error.to_string();
        } else {
            *hint = format!("grouping {}", next.as_str());
            last_error.clear();
        }
        return Ok(());
    }
    if let Some(text) = action.strip_prefix("dispatch ") {
        *hint = format!("dispatched a new session; current history was not copied: {text}");
        let previous = client.as_ref().and_then(|active| active.session_id.clone());
        // Same directory and patch as `/new`. A failed settings write leaves
        // the dashboard and the current session in place.
        sync_effective_cwd(effective, launch);
        if !prepare_retained_apply(effective, extra_env, patch, apply_failed, last_error, hint) {
            return Ok(());
        }
        *overlay = Overlay::None;
        drop_connection(client, owner);
        reset_memory_session(memory_session_on);
        *memory_injected = false;
        *turns = Vec::new();
        *committed = 0;
        history.clear();
        *resumed = false;
        connect_retained_session(
            client,
            owner,
            previous_session,
            selection_ready,
            last_error,
            hint,
            effective,
            extra_env,
            patch.as_ref(),
            "dispatched",
            previous.as_deref(),
        );
        if last_error.is_empty() {
            let _ = reset_native_history_after_switch(terminal, screen, committed, history);
        }
        return Ok(());
    }
    if action == "new" {
        *hint = "new agent; previous session history was not copied".into();
        return Ok(());
    }
    if let Some(id) = action.strip_prefix("stop ") {
        *hint = format!("stop requested for {id}; other sessions were not changed");
        return Ok(());
    }
    if let Some(id) = action.strip_prefix("delete ") {
        match session_data::delete_session(
            &effective.dsh_home,
            &effective.cwd,
            &session_data::DeleteRequest {
                session_id: id.to_string(),
                confirmed: true,
            },
        ) {
            Ok(()) => {
                *last_error =
                    "blocked: session deletion reported success; nothing was removed".into();
                if let Overlay::Dashboard(view) = overlay {
                    view.notice = last_error.clone();
                }
            }
            Err(error) => {
                *last_error = error.message.clone();
                if let Overlay::Dashboard(view) = overlay {
                    view.notice = error.message;
                }
            }
        }
        return Ok(());
    }
    Ok(())
}

fn sync_effective_cwd(effective: &mut config::EffectiveConfig, launch: &Launch) {
    // `/cd` changes the process directory. The next ACP session and the memory
    // store both use that directory, and a trusted workspace config.toml has
    // to be loaded again before the settings patch is written.
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let cwd = cwd.canonicalize().unwrap_or(cwd);
    if cwd != effective.cwd {
        *effective = load_runtime_config(launch);
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| effective.grok_home.clone());
        config::refresh_assets(effective, &home);
    }
}

/// Write the same credential env and settings patch startup gives dsh.
/// False leaves the live client where it is: a settings write error is not
/// a reason to drop a process that still has the previous patch.
fn prepare_retained_apply(
    effective: &config::EffectiveConfig,
    extra_env: &mut Vec<(String, String)>,
    patch: &mut Option<PathBuf>,
    apply_failed: &mut bool,
    last_error: &mut String,
    hint: &mut String,
) -> bool {
    let applied = runtime_apply(effective);
    if applied.apply_failed {
        *apply_failed = true;
        *last_error = applied.error;
        *hint = last_error.clone();
        return false;
    }
    *extra_env = applied.extra_env;
    *patch = applied.patch;
    *apply_failed = false;
    true
}

/// `/new` and dashboard dispatch replace dsh only after `prepare_retained_apply`.
/// The new process gets that patch, then the same advertised model and effort
/// as startup. An empty connect would leave dsh on deepseek-official.
fn connect_retained_session(
    client: &mut Option<AcpClient>,
    owner: &mut Option<SessionOwner>,
    previous_session: &mut Option<String>,
    selection_ready: &mut bool,
    last_error: &mut String,
    hint: &mut String,
    effective: &config::EffectiveConfig,
    extra_env: &[(String, String)],
    patch: Option<&PathBuf>,
    verb: &str,
    previous: Option<&str>,
) {
    match connect(&LaunchMode::New, None, extra_env, patch, false, None) {
        Ok((connection, _)) => {
            *previous_session = connection.client.session_id.clone();
            *owner = Some(connection.owner);
            let mut connected = connection.client;
            match apply_live_selection(&mut connected, effective) {
                Ok(()) => {
                    *selection_ready = true;
                    last_error.clear();
                }
                Err(error) => {
                    *selection_ready = false;
                    *last_error = error;
                }
            }
            let session_id = connected.session_id.clone();
            *client = Some(connected);
            *hint = format!(
                "{verb} {}; previous output stayed on {}",
                session_id.as_deref().unwrap_or("unknown"),
                previous.unwrap_or("none")
            );
            if !last_error.is_empty() {
                *hint = format!("{hint}; {last_error}");
            }
        }
        Err(error) => {
            *selection_ready = false;
            *last_error = error;
        }
    }
}

/// A newly started session follows config again. Force-off stays force-off
/// because the prompt gate checks it before this flag. Resume of the same
/// ACP session does not call this.
fn reset_memory_session(session_on: &mut Option<bool>) {
    *session_on = None;
}

fn apply_next_cwd(effective: &config::EffectiveConfig, raw: &str) -> Result<String, String> {
    let path = PathBuf::from(raw);
    if !path.is_dir() {
        return Err(format!(
            "location not applied: {} is missing or unreadable; still {}",
            path.display(),
            effective.cwd.display()
        ));
    }
    let canonical = path.canonicalize().unwrap_or(path);
    std::env::set_current_dir(&canonical).map_err(|error| error.to_string())?;
    Ok(format!(
        "next new agent cwd: {} (existing session stays {})",
        canonical.display(),
        effective.cwd.display()
    ))
}

fn open_dashboard_overlay(
    overlay: &mut Overlay,
    effective: &config::EffectiveConfig,
    client: Option<&AcpClient>,
) -> Result<(), String> {
    let prefs = session_catalog::read_dashboard_prefs(&effective.dsh_home);
    if !prefs.enabled {
        return Err(format!(
            "Agent dashboard is disabled ({}).",
            prefs
                .disabled_reason
                .unwrap_or_else(|| "dashboard.enabled = false".into())
        ));
    }
    let catalog = session_catalog::load_catalog(&effective.dsh_home, &effective.cwd);
    let mut view = session_catalog::DashboardView::open(&catalog.sessions);
    if let Some(id) = client.and_then(|active| active.session_id.clone()) {
        view.selected = Some(id);
    }
    *overlay = Overlay::Dashboard(view);
    Ok(())
}

fn open_session_picker(overlay: &mut Overlay, effective: &config::EffectiveConfig) {
    let catalog = session_catalog::load_catalog(&effective.dsh_home, &effective.cwd);
    let hits = catalog
        .sessions
        .iter()
        .filter(|session| session.foreign.is_none())
        .map(|session| session_catalog::SearchHit {
            session: session.clone(),
            extended: false,
            snippet: session.display_title().to_string(),
        })
        .collect();
    *overlay = Overlay::SessionPick {
        hits,
        cursor: 0,
        query: String::new(),
        refusal: String::new(),
        delete_armed: false,
    };
}

fn catalog_switch_refusal(session_id: &str, error: &str) -> String {
    if error.contains("already active") || error.contains("already owned") {
        format!("already active: session {session_id} stays on its current owner")
    } else if error.contains("Write owner")
        || error.contains("occupied")
        || error.contains("cwd does not match")
    {
        format!("occupied: {session_id} stays on its current owner")
    } else {
        error.to_string()
    }
}

fn adopt_switched_session(
    turns: &mut Vec<Turn>,
    committed: &mut usize,
    history: &mut String,
    resumed: &mut bool,
    previous_session: &mut Option<String>,
    session_id: &str,
    restored: Vec<Turn>,
) {
    *turns = restored;
    *committed = 0;
    history.clear();
    *resumed = true;
    *previous_session = Some(session_id.to_string());
}

fn switch_to_catalog_session(
    client: &mut AcpClient,
    owner: &mut Option<SessionOwner>,
    turns: &mut Vec<Turn>,
    committed: &mut usize,
    history: &mut String,
    dsh_home: &Path,
    cwd: &Path,
    session_id: &str,
    resumed: &mut bool,
    previous_session: &mut Option<String>,
) -> Result<String, String> {
    let previous = client.session_id.clone();
    let restored = switch_session(client, owner, dsh_home, cwd, session_id)?;
    adopt_switched_session(
        turns,
        committed,
        history,
        resumed,
        previous_session,
        session_id,
        restored,
    );
    let _ = session_catalog::mark_read(dsh_home, session_id);
    let kept = previous.unwrap_or_default();
    Ok(format!(
        "resumed {session_id}; previous output stayed on {kept}"
    ))
}

fn maybe_title_session(
    effective: &config::EffectiveConfig,
    session_id: &str,
    prompts: &[String],
) -> Result<String, String> {
    let Some(model) = effective.active_model() else {
        return Err("title generation needs a configured model; no provider fallback".into());
    };
    let Some(base_url) = model.base_url.clone().filter(|url| !url.is_empty()) else {
        return Err("title generation needs a configured model base_url".into());
    };
    if model.unusable_reason.is_some() {
        return Err("configured model is unavailable; title was not generated".into());
    }
    let env = std::env::vars().collect();
    let route = session_catalog::TitleRoute {
        base_url,
        model: model.model.clone(),
        provider: model.provider.clone(),
        api_key: effective.model_api_key(model, &env),
        backend: model.api_backend_raw.clone(),
    };
    let exchange =
        session_catalog::title_request(&route, prompts).map_err(|error| error.message)?;
    // The prompt stays in the provider body. It is not written to the notice,
    // the debug log, or the URL.
    let title = if route.api_key.is_empty() {
        return Err(format!(
            "title generation needs {} for {}; the conversation was not sent",
            model.env_key, model.id
        ));
    } else {
        let response = ureq::post(&exchange.url)
            .set("Authorization", &format!("Bearer {}", route.api_key))
            .set("Content-Type", "application/json")
            .send_string(&exchange.body)
            .map_err(|error| format!("title generation failed: {error}"))?;
        let body = response
            .into_string()
            .map_err(|error| format!("title generation failed: {error}"))?;
        session_catalog::parse_title_response(&body).map_err(|error| error.message)?
    };
    let stored = session_catalog::store_generated_title(
        &effective.dsh_home,
        session_id,
        &title,
        &route.provider,
        &route.model,
    )
    .map_err(|error| error.message)?;
    if stored {
        Ok(format!(
            "title generated by {}/{} (manual /rename still wins)",
            route.provider, route.model
        ))
    } else {
        Ok("manual title kept; automatic generation did not override it".into())
    }
}

fn feedback_session_id(client: Option<&AcpClient>) -> String {
    client
        .and_then(|active| active.session_id.clone())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| "local".into())
}

fn feedback_overlay_text(
    dsh_home: &Path,
    client: Option<&AcpClient>,
    form: &feedback_ui::FeedbackForm,
) -> String {
    let session_id = feedback_session_id(client);
    let drafts = privacy::session_dir(dsh_home, &session_id)
        .map(|dir| privacy::DraftStore::new(&dir))
        .and_then(|store| store.list())
        .unwrap_or_default();
    form.render(&drafts)
}

fn feedback_form_key(key: crossterm::event::KeyEvent) -> Option<feedback_ui::FormKey> {
    if key.modifiers == KeyModifiers::CONTROL && matches!(key.code, KeyCode::Char('s')) {
        return Some(feedback_ui::FormKey::Save);
    }
    if !key.modifiers.is_empty() {
        return None;
    }
    match key.code {
        KeyCode::Enter => Some(feedback_ui::FormKey::Enter),
        KeyCode::Esc => Some(feedback_ui::FormKey::Esc),
        KeyCode::Tab => Some(feedback_ui::FormKey::Tab),
        KeyCode::Backspace => Some(feedback_ui::FormKey::Backspace),
        KeyCode::Up => Some(feedback_ui::FormKey::Up),
        KeyCode::Down => Some(feedback_ui::FormKey::Down),
        KeyCode::Char(ch) => Some(feedback_ui::FormKey::Char(ch)),
        _ => None,
    }
}

fn overlay_hint(overlay: &Overlay, prefs: &UiPrefs) -> String {
    match overlay {
        Overlay::None => String::new(),
        Overlay::RewindPick { points, cursor } => {
            let mut lines =
                vec!["Rewind to turn (conversation only; files stay as they are):".into()];
            for (index, point) in points.iter().enumerate() {
                let mark = if index == *cursor { ">" } else { " " };
                lines.push(format!("{mark} {}. {}", point.turn, point.summary));
            }
            if prefs.confirm_before_rewind {
                lines.push("Enter selects · Esc cancels · then y confirms".into());
            } else {
                lines.push("Enter rewinds now · Esc cancels".into());
            }
            lines.join("\n")
        }
        Overlay::RewindConfirm { point } => format!(
            "Confirm rewind to turn {} ({})? y=yes  a=yes, don't ask again  n=no",
            point.turn, point.summary
        ),
        Overlay::Plugins(_) => String::new(),
        Overlay::Feedback(_) => String::new(),
        Overlay::DeleteConfirm { session_id, .. } => {
            session_data::confirm_delete_prompt(session_id)
        }
        Overlay::SessionPick {
            hits,
            cursor,
            query,
            refusal,
            delete_armed,
        } => session_catalog::with_refusal(
            &format!(
                "{}\n{}",
                session_catalog::render_picker(hits, *cursor, query),
                if *delete_armed {
                    hits.get(*cursor)
                        .map(|hit| session_data::confirm_delete_prompt(&hit.session.id))
                        .unwrap_or_else(|| "delete cancelled".into())
                } else {
                    "d then y asks to delete the highlighted session; deletion is blocked and nothing is removed".into()
                }
            ),
            refusal,
        ),
        Overlay::Dashboard(view) => {
            let home = std::env::var_os("DSH_HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            let cwd = std::env::current_dir().unwrap_or_default();
            let catalog = session_catalog::load_catalog(&home, &cwd);
            session_catalog::render_dashboard(&catalog, view, &cwd)
        }
        Overlay::Location { draft, previous } => format!(
            "Choose directory for the next new agent\ncurrent: {}\ndraft: {draft}\nEnter applies · Esc keeps the previous location",
            previous.display()
        ),
        Overlay::Memory(_) | Overlay::Remember { .. } => String::new(),
    }
}

fn memory_key(key: crossterm::event::KeyEvent) -> Option<memory_ui::Key> {
    if key.modifiers == KeyModifiers::CONTROL && matches!(key.code, KeyCode::Char('f' | 'F')) {
        return Some(memory_ui::Key::Char('f'));
    }
    if !key.modifiers.is_empty() && key.modifiers != KeyModifiers::SHIFT {
        return None;
    }
    match key.code {
        KeyCode::Up => Some(memory_ui::Key::Up),
        KeyCode::Down => Some(memory_ui::Key::Down),
        KeyCode::PageUp => Some(memory_ui::Key::PageUp),
        KeyCode::PageDown => Some(memory_ui::Key::PageDown),
        KeyCode::Home => Some(memory_ui::Key::Home),
        KeyCode::End => Some(memory_ui::Key::End),
        KeyCode::Enter => Some(memory_ui::Key::Enter),
        KeyCode::Esc => Some(memory_ui::Key::Esc),
        KeyCode::Backspace => Some(memory_ui::Key::Backspace),
        KeyCode::Tab => Some(memory_ui::Key::Tab),
        KeyCode::Char(ch) => Some(memory_ui::Key::Char(ch)),
        _ => None,
    }
}

fn copy_to_clipboard(text: &str) -> Result<(), String> {
    // The path is already on screen. A missing clipboard does not delete the note.
    #[cfg(target_os = "macos")]
    {
        let mut child = std::process::Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| format!("clipboard unavailable: {error}"))?;
        if let Some(stdin) = child.stdin.as_mut() {
            use std::io::Write;
            stdin
                .write_all(text.as_bytes())
                .map_err(|error| format!("clipboard unavailable: {error}"))?;
        }
        let status = child
            .wait()
            .map_err(|error| format!("clipboard unavailable: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("clipboard unavailable: pbcopy {status}"))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("clipboard copy is unverified on this platform; the path stays on screen".into())
    }
}

fn memory_slash(text: &str) -> Option<MemorySlash> {
    let command = text.trim().trim_start_matches('/');
    let (name, rest) = command
        .split_once(char::is_whitespace)
        .unwrap_or((command, ""));
    let rest = rest.trim();
    match name {
        "memory" | "mem" => Some(MemorySlash::Browse),
        "remember" if rest.is_empty() => Some(MemorySlash::Remember(None)),
        "remember" => Some(MemorySlash::Remember(Some(rest.to_string()))),
        _ => None,
    }
}

enum MemorySlash {
    Browse,
    Remember(Option<String>),
}

fn memory_store(effective: &config::EffectiveConfig) -> Result<memory::Store, String> {
    memory::open_store(&effective.grok_home, &effective.cwd).map_err(|error| error.message)
}

fn memory_session_enabled(effective: &config::EffectiveConfig, session_on: Option<bool>) -> bool {
    if effective.memory.force_off() {
        return false;
    }
    // Unset or `[memory] enabled = false` starts off. `t` is the only way on
    // for that session, and it does not rewrite config.toml.
    session_on.unwrap_or_else(|| effective.memory.enabled())
}

fn open_memory_browser(
    overlay: &mut Overlay,
    effective: &config::EffectiveConfig,
    session_on: Option<bool>,
    memory_injected: bool,
) -> Result<(), String> {
    if effective.memory.force_off() {
        return Err(
            "memory is hidden for this process (--no-memory or GROK_MEMORY=0); notes were not deleted"
                .into(),
        );
    }
    let store = memory_store(effective)?;
    let enabled = memory_session_enabled(effective, session_on);
    *overlay = Overlay::Memory(memory_ui::Browser::open(
        &store,
        enabled,
        effective.memory.force_off(),
        memory_injected,
    ));
    Ok(())
}

/// Build the `/remember` confirmation modal, carrying forward the current
/// session's memory toggle (`memory_session_on`) rather than falling back to
/// `config.toml`. A `None` here would silently re-derive the config value
/// and, once saved or cancelled, overwrite an explicit `t` toggle for this
/// session (see the regression this guards: an empty `/remember` used to
/// reset the session switch to the config value).
///
/// `memory_injected` must be the host's own gate (the same bool that guards
/// first-turn injection in `submit_composer_prompt`), not a fresh
/// `turns.is_empty()` check: `/clear` empties the visible transcript without
/// reopening the injection window, so deriving it from `turns` would wrongly
/// claim a late `t` toggle still reaches this session.
fn open_remember_confirmation(
    effective: &config::EffectiveConfig,
    memory_session_on: Option<bool>,
    memory_injected: bool,
    draft: &str,
    scope: memory::Scope,
) -> Result<memory_ui::Browser, String> {
    let store = memory_store(effective)?;
    let mut browser = memory_ui::Browser::open(
        &store,
        memory_session_enabled(effective, memory_session_on),
        false,
        memory_injected,
    );
    memory_ui::begin_remember(&mut browser, &store, draft, scope);
    Ok(browser)
}

struct Meter {
    used: Option<u64>,
    size: Option<u64>,
    cost: Option<String>,
}

/// The sandbox status segment, followed by the worktree this session runs in.
fn worktree_header(sandbox: String) -> String {
    match worktree::status_segment() {
        Some(segment) => format!("{sandbox} | {segment}"),
        None => sandbox,
    }
}

/// Record the session that owns this process's worktree (ticket 174).
fn attach_worktree_session(client: &AcpClient) {
    if let (Some(created), Some(session_id)) = (worktree::active(), client.session_id.as_deref()) {
        let pool = worktree::pool(&worktree::early_grok_home());
        let _ = worktree::attach(&pool, &created.id, session_id);
    }
}

struct StatusView<'a> {
    client: Option<&'a AcpClient>,
    inflight: bool,
    last_error: &'a str,
    awaiting_approval: bool,
    cancelling: bool,
    hint: &'a str,
    resumed: bool,
    routing: Option<&'a models::Routing>,
    meter: &'a Meter,
    screen: ScreenMode,
    status_row: &'a str,
    show_timestamps: bool,
}

fn status_line(view: StatusView<'_>) -> String {
    let StatusView {
        client,
        inflight,
        last_error,
        awaiting_approval,
        cancelling,
        hint,
        resumed,
        routing,
        meter,
        screen,
        status_row,
        show_timestamps: _,
    } = view;
    let header = format!(
        "mode={} | {}",
        screen.as_str(),
        worktree_header(filesystem_sandbox::status_line(filesystem_sandbox::active()))
    );
    if !last_error.is_empty() && client.is_none() {
        // A short screen scrolls to the latest notice lines. The unavailable
        // status has to stay among those lines, after the first-run tip.
        return format!("{header}\n{last_error}\n{UNAVAILABLE}");
    }
    let tag = if resumed { " (resumed)" } else { "" };
    let mut body = match client {
        Some(client) if cancelling => format!(
            "Connected to dsh ACP session {}{tag}.\nCancelling turn…",
            client.session_id.as_deref().unwrap_or("unknown")
        ),
        Some(client) if awaiting_approval => format!(
            "Connected to dsh ACP session {}{tag}.\nAllow this dsh file tool? y=allow once  n=reject",
            client.session_id.as_deref().unwrap_or("unknown")
        ),
        Some(client) if inflight => format!(
            "Connected to dsh ACP session {}{tag}.\nStreaming turn… Ctrl+C cancels (empty draft).",
            client.session_id.as_deref().unwrap_or("unknown")
        ),
        Some(client) => format!(
            "Connected to dsh ACP session {}{tag}.\nEnter submits a prompt through dsh.",
            client.session_id.as_deref().unwrap_or("unknown")
        ),
        None => UNAVAILABLE.to_string(),
    };
    body = format!("{header}\n{body}");
    if let Some(routing) = routing {
        body.push('\n');
        body.push_str(&routing.line());
        body.push('\n');
        body.push_str(&models::usage_line(
            meter.used,
            meter.size,
            meter.cost.as_deref(),
            routing.advertised_context,
        ));
    }
    if !hint.is_empty() {
        body.push('\n');
        body.push_str(hint);
    }
    if !status_row.is_empty() {
        body.push('\n');
        body.push_str(status_row);
    }
    if !last_error.is_empty() && client.is_some() {
        body.push('\n');
        body.push_str(last_error);
    }
    // The error is the line a short screen must keep. Pin it first so a hero
    // or stacked notice that clips the top still shows the rejection.
    if !last_error.is_empty() && client.is_some() {
        format!("{last_error}\n{body}")
    } else {
        body
    }
}

fn compact_reload_hint(
    turns: &[Turn],
    records: &[RestoredCompactionRecord],
    cancelled: bool,
) -> String {
    if cancelled {
        return "Compaction cancelled.".into();
    }
    if let Some(record) = records.last() {
        return models::compaction_line(
            record.items,
            record.tokens,
            Some(&record.provider),
            Some(&record.model),
            record.error.as_deref(),
        );
    }
    if let Some(info) = turns.iter().rev().find_map(|turn| turn.compaction.as_ref()) {
        return models::compaction_line(
            info.items,
            info.tokens,
            Some(&info.provider),
            Some(&info.model),
            info.error.as_deref(),
        );
    }
    if cancelled {
        return "Compaction cancelled.".into();
    }
    "No compactable history yet. Original dsh records were not discarded.".into()
}

fn clock_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    format!("{:02}:{:02}", (secs / 3600) % 24, (secs / 60) % 60)
}

fn render_transcript(status: &str, turns: &[Turn], show_timestamps: bool) -> String {
    let views = turn_views(turns);
    let mut rendered =
        content::render_transcript(status, &views, &content::DisplayState::default());
    if show_timestamps {
        for turn in turns {
            if let Some(stamp) = &turn.timestamp {
                let plain = format!("> {}", turn.user.replace('\n', " "));
                let stamped = format!("> {stamp} {}", turn.user.replace('\n', " "));
                if let Some(found) = rendered.find(&plain) {
                    rendered.replace_range(found..found + plain.len(), &stamped);
                }
            }
        }
    }
    rendered
}

/// The turn a message chunk belongs to. A steer claimed mid-turn opens a new
/// transcript turn, so an id already seen routes back to its own turn; a new
/// id goes to the last turn only while that turn has no message yet.
fn message_turn<'a>(turns: &'a mut [Turn], message_id: &str) -> Option<&'a mut Turn> {
    if let Some(index) = turns
        .iter()
        .rposition(|turn| turn.message_id.as_deref() == Some(message_id))
    {
        return turns.get_mut(index);
    }
    turns.last_mut().filter(|turn| turn.message_id.is_none())
}

/// The turn that owns a tool call: the one that already lists it, else the last.
fn tool_turn<'a>(turns: &'a mut [Turn], tool_call_id: &str) -> Option<&'a mut Turn> {
    let index = turns
        .iter()
        .rposition(|turn| turn.tools.iter().any(|tool| tool.id == tool_call_id))
        .or_else(|| turns.len().checked_sub(1))?;
    turns.get_mut(index)
}

fn apply_events(
    turns: &mut [Turn],
    inflight: &mut bool,
    meter: &mut Meter,
    events: Vec<AcpEvent>,
    compacting: bool,
    inspect_auto_compact: &mut bool,
) -> Option<String> {
    let mut disconnect = None;
    for event in events {
        match event {
            AcpEvent::Thought {
                message_id, text, ..
            } => {
                if let Some(turn) = message_turn(turns, &message_id) {
                    turn.message_id = Some(message_id);
                    turn.thought.push_str(&text);
                }
            }
            AcpEvent::Answer {
                message_id,
                text,
                hook,
                ..
            } => {
                if let Some(turn) = message_turn(turns, &message_id) {
                    turn.message_id = Some(message_id);
                    // Hook output stays in the transcript, labeled, and is not
                    // the model answer.
                    if hook {
                        turn.answer.push_str("hook: ");
                    }
                    turn.answer.push_str(&text);
                    if hook && !text.ends_with('\n') {
                        turn.answer.push('\n');
                    }
                }
            }
            AcpEvent::ToolCall {
                tool_call_id,
                title,
                kind,
                status,
                raw_input,
                diff,
                ..
            } => {
                let owner = tool_turn(turns, &tool_call_id);
                if let Some(turn) = owner {
                    if let Some(tool) = turn.tools.iter_mut().find(|tool| tool.id == tool_call_id) {
                        tool.title = title;
                        tool.kind = kind;
                        tool.status = status;
                        if raw_input != Value::Null {
                            tool.raw_input = raw_input;
                        }
                        if !diff.is_empty() {
                            tool.diff = diff;
                        }
                    } else {
                        turn.tools.push(ToolRow {
                            id: tool_call_id,
                            title,
                            kind,
                            status,
                            diff,
                            result: String::new(),
                            raw_input,
                        });
                    }
                }
            }
            AcpEvent::ToolCallUpdate {
                tool_call_id,
                status,
                content,
                ..
            } => {
                let owner = tool_turn(turns, &tool_call_id);
                if let Some(turn) = owner {
                    if let Some(tool) = turn.tools.iter_mut().find(|tool| tool.id == tool_call_id) {
                        tool.status = status.clone();
                        if !content.is_empty() {
                            tool.result = content;
                        }
                    } else {
                        turn.tools.push(ToolRow {
                            id: tool_call_id.clone(),
                            title: "tool".into(),
                            kind: String::new(),
                            status: status.clone(),
                            diff: String::new(),
                            result: content,
                            raw_input: Value::Null,
                        });
                    }
                    if status == "failed" && turn.error.is_none() {
                        turn.error = Some(format!("tool {tool_call_id} failed"));
                    }
                }
            }
            AcpEvent::PromptFinished { stop_reason, .. } => {
                if !compacting && let Some(turn) = turns.last_mut() {
                    turn.done = true;
                    turn.permission = None;
                    turn.cancelling = false;
                    if stop_reason == "cancelled" {
                        turn.cancelled = true;
                        for tool in &mut turn.tools {
                            if tool.status == "pending" || tool.status == "in_progress" {
                                tool.status = "cancelled".into();
                            }
                        }
                    }
                    *inspect_auto_compact = true;
                }
                *inflight = false;
            }
            AcpEvent::RpcError { message, .. } => {
                if !compacting
                    && let Some(turn) = turns.last_mut()
                    && *inflight
                {
                    turn.error = Some(message);
                    turn.done = true;
                    turn.permission = None;
                }
                *inflight = false;
            }
            AcpEvent::ProtocolMismatch { version } => {
                disconnect = Some(format!(
                    "ACP protocol mismatch: client {}, agent {version}",
                    acp::PROTOCOL_VERSION
                ));
                *inflight = false;
            }
            AcpEvent::Disconnected { detail } => {
                if let Some(turn) = turns.last_mut()
                    && !turn.done
                {
                    turn.error = Some(detail.clone());
                    turn.done = true;
                    turn.permission = None;
                    turn.interrupted = true;
                    mark_unknown_open_tools(turn);
                }
                disconnect = Some(detail);
                *inflight = false;
            }
            AcpEvent::PermissionRequest {
                request_id,
                session_id,
                tool_call_id,
                options,
            } => {
                if let Some(turn) = turns.last_mut() {
                    turn.permission = Some(PendingPermission {
                        request_id,
                        session_id,
                        tool_call_id,
                        options,
                    });
                }
            }
            AcpEvent::PermissionCancelled { .. } => {
                if let Some(turn) = turns.last_mut() {
                    turn.permission = None;
                }
            }
            AcpEvent::Stderr { text } => {
                if let Some(turn) = turns.last_mut() {
                    let line = if text.contains("hook") {
                        format!("hook: {text}")
                    } else {
                        text
                    };
                    turn.answer.push_str(&line);
                    if !line.ends_with('\n') {
                        turn.answer.push('\n');
                    }
                }
            }
            AcpEvent::Usage { used, size, cost } => {
                meter.used = used;
                meter.size = size;
                meter.cost = cost;
            }
            // The board owns lifecycle lines; `apply_event_stream` routes them.
            AcpEvent::ConfigOptions { .. }
            | AcpEvent::Subagent { .. }
            | AcpEvent::Job { .. }
            | AcpEvent::Schedule { .. }
            | AcpEvent::Goal { .. } => {}
        }
    }
    disconnect
}

fn overlay_notice(view: StatusView<'_>, turns: &[Turn]) -> String {
    let show_timestamps = view.show_timestamps;
    let mut out = status_line(view);
    if let Some(turn) = turns.last()
        && (!turn.done || turn.permission.is_some())
    {
        out.push_str(&render_transcript(
            "",
            std::slice::from_ref(turn),
            show_timestamps,
        ));
    }
    out
}

fn paint(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    screen: ScreenMode,
    composer: &PromptComposer,
    notice: &str,
    selected: Option<usize>,
    theme: &theme::Theme,
    compact: bool,
    ui_overlay: &mut UiOverlay,
    feedback_open: bool,
    nav: Option<&NavState>,
) -> io::Result<FrameLayout> {
    paint_memory(
        terminal,
        screen,
        composer,
        notice,
        selected,
        theme,
        compact,
        ui_overlay,
        feedback_open,
        nav,
        None,
        None,
        None,
        None,
    )
}

fn paint_memory(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    screen: ScreenMode,
    composer: &PromptComposer,
    notice: &str,
    selected: Option<usize>,
    theme: &theme::Theme,
    compact: bool,
    ui_overlay: &mut UiOverlay,
    feedback_open: bool,
    nav: Option<&NavState>,
    memory: Option<&mut memory_ui::Browser>,
    memory_store: Option<&memory::Store>,
    tasks: Option<(&subagents::Board, &mut subagents::TasksModal)>,
    ask: Option<&mut Interact>,
) -> io::Result<FrameLayout> {
    let title = composer.footer();
    let notice = composer_notice(composer, notice);
    let mut layout = FrameLayout {
        prompt: ratatui::layout::Rect::default(),
        transcript: ratatui::layout::Rect::default(),
        chrome: ratatui::layout::Rect::default(),
    };
    terminal.draw(|frame| {
        if screen == ScreenMode::Minimal || feedback_open || nav.is_none() {
            layout.prompt = if screen == ScreenMode::Minimal {
                welcome::render_minimal(
                    frame,
                    &composer.draft,
                    &notice,
                    selected,
                    theme,
                    feedback_open,
                    &title,
                )
            } else {
                welcome::render(
                    frame,
                    &composer.draft,
                    &notice,
                    selected,
                    theme,
                    compact,
                    feedback_open,
                    &title,
                )
            };
        } else if let Some(nav) = nav {
            layout = welcome::render_session(frame, &composer.draft, &notice, nav, theme, &title);
        }
        settings_ui::render(frame, ui_overlay, theme, screen);
        if let (Some(browser), Some(store)) = (memory, memory_store) {
            browser.set_columns(frame.area().width);
            memory_ui::render_modal(frame, browser, store, theme);
        }
        if let Some(ask) = ask {
            paint_interaction(frame, &layout, screen, ask, theme);
        }
        if let Some((board, modal)) = tasks {
            subagents::render_modal(frame, board, modal, theme);
        }
    })?;
    Ok(layout)
}

/// Question card, plan review, and todos over the transcript (fullscreen)
/// or the rows above the prompt (minimal and the welcome screen).
fn paint_interaction(
    frame: &mut ratatui::Frame,
    layout: &FrameLayout,
    screen: ScreenMode,
    ask: &mut Interact,
    theme: &theme::Theme,
) {
    let full = frame.area();
    let above = if layout.transcript.height > 0 {
        layout.transcript
    } else {
        ratatui::layout::Rect {
            x: full.x,
            y: full.y,
            width: full.width,
            height: layout.prompt.y.saturating_sub(1).saturating_sub(full.y),
        }
    };
    let minimal = screen == ScreenMode::Minimal;
    if let Some(todos) = ask.todos.as_deref()
        && !ask.todos_hidden
        && !(minimal && ask.open())
    {
        interaction::render_todos(frame, above, todos, theme);
    }
    if let Some(review) = ask.review.as_mut() {
        if minimal {
            interaction::render_review_strip(frame, above, review, theme);
        } else {
            interaction::render_review(frame, above, review, theme);
        }
    } else if let Some(card) = ask.card.as_ref() {
        interaction::render_card(frame, above, card, theme);
    }
}

fn copy_selected_original(turns: &[Turn], nav: &NavState, home: &Path, hint: &mut String) {
    let Some(index) = nav.selected else {
        *hint = "no block to copy".into();
        return;
    };
    let Some(turn) = turns.get(index) else {
        *hint = "no block to copy".into();
        return;
    };
    let views = turn_views(std::slice::from_ref(turn));
    let Some(view) = views.first() else {
        *hint = "no block to copy".into();
        return;
    };
    let key = nav.selected_content_key().unwrap_or_default();
    let first = nav.lines.iter().find(|line| line.entry == index);
    let answer_focused = !turn.answer.is_empty()
        && match first {
            None => true,
            Some(line) => {
                line.kind == navigation::LineKind::Answer || line.kind == navigation::LineKind::User
            }
        };
    let (kind, tool) = if answer_focused || (!turn.answer.is_empty() && turn.tools.is_empty()) {
        (content::BlockKind::Answer, 0)
    } else if key.ends_with(":thought") {
        (content::BlockKind::Thought, 0)
    } else if key.contains(":tool:") {
        let title = key.rsplit(':').next().unwrap_or("");
        let tool = view
            .tools
            .iter()
            .position(|tool| tool.title == title)
            .unwrap_or(0);
        (content::BlockKind::Tool, tool)
    } else {
        (content::BlockKind::Answer, 0)
    };
    let original = content::original_block(view, kind, tool);
    match content::copy_original(&original, home) {
        Ok(message) => *hint = message,
        Err(error) => *hint = error,
    }
}

fn compaction_sentence(turn: &Turn) -> Option<String> {
    if !turn.compacted {
        return None;
    }
    Some(turn.compaction.as_ref().map_or_else(
        || "✂ compacted history into a summary · purpose=compaction".into(),
        |info| {
            models::compaction_line(
                info.items,
                info.tokens,
                Some(&info.provider),
                Some(&info.model),
                info.error.as_deref(),
            )
        },
    ))
}

/// The tool body the live card shows. A finished shell gains the exit line
/// dsh omitted; the original result is otherwise unchanged.
fn shell_card_result(tool: &ToolRow) -> String {
    let mut body = tool.result.clone();
    if let Some(exit) = content::shell_exit_line(&tool.title, &tool.result, &tool.status) {
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        body.push_str(&exit);
    }
    body
}

fn nav_entries(turns: &[Turn]) -> Vec<NavEntry> {
    turns
        .iter()
        .map(|turn| {
            let mut entry = NavEntry::from_parts(
                turn.user.clone(),
                turn.thought.clone(),
                turn.answer.clone(),
                turn.tools
                    .iter()
                    .map(|tool| (tool.title.clone(), shell_card_result(tool)))
                    .collect(),
            );
            entry.tool_meta = turn
                .tools
                .iter()
                .map(|tool| (tool.id.clone(), tool.status.clone()))
                .collect();
            if let Some(error) = &turn.error {
                entry.errors.push(error.clone());
            }
            entry.interrupted = turn.interrupted;
            entry.cancelled = turn.cancelled && !turn.quiet_cancel;
            entry.done = turn.done;
            entry.compaction = compaction_sentence(turn);
            entry.diffs = turn
                .tools
                .iter()
                .filter(|tool| !tool.diff.is_empty())
                .map(|tool| tool.diff.clone())
                .collect();
            entry.folded_tools = turn
                .tools
                .iter()
                .any(|tool| tool.result.lines().count() > content::TOOL_PREVIEW_LINES);
            entry.folded_thought = turn.thought.lines().count() > content::TOOL_PREVIEW_LINES;
            entry.folded_answer = turn.answer.lines().count() > content::TOOL_PREVIEW_LINES;
            entry
        })
        .collect()
}

fn turn_views(turns: &[Turn]) -> Vec<content::TurnView> {
    turns
        .iter()
        .map(|turn| content::TurnView {
            user: turn.user.clone(),
            thought: turn.thought.clone(),
            answer: turn.answer.clone(),
            error: turn.error.clone(),
            tools: turn
                .tools
                .iter()
                .map(|tool| content::ToolView {
                    id: tool.id.clone(),
                    title: tool.title.clone(),
                    status: tool.status.clone(),
                    diff: tool.diff.clone(),
                    result: tool.result.clone(),
                })
                .collect(),
            permission: turn.permission.as_ref().map(|permission| {
                let name = turn
                    .tools
                    .iter()
                    .find(|tool| tool.id == permission.tool_call_id)
                    .map(|tool| tool.title.as_str())
                    .unwrap_or("tool");
                format!(
                    "Allow {name} {}? y=allow once  n=reject",
                    permission.tool_call_id
                )
            }),
            done: turn.done,
            cancelled: turn.cancelled && !turn.quiet_cancel,
            interrupted: turn.interrupted,
            compacted: turn.compacted,
            compaction: compaction_sentence(turn),
        })
        .collect()
}

fn sync_nav_viewport(
    nav: &mut NavState,
    turns: &[Turn],
    terminal: &Terminal<CrosstermBackend<io::Stdout>>,
    composer: &PromptComposer,
    notice: &str,
) -> io::Result<()> {
    let size = terminal.size()?;
    let chrome_height = welcome::session_chrome_height(nav);
    let notice_height = welcome::session_notice_height(notice);
    let input_height = welcome::session_input_height(&composer.draft, size.width);
    nav.sync_entries(
        nav_entries(turns),
        size.width
            .saturating_sub(navigation::TRANSCRIPT_GUTTER)
            .max(20),
        welcome::session_transcript_height(size.height, chrome_height, notice_height, input_height)
            .max(3),
    );
    Ok(())
}

fn replace_session_turns(
    turns: &mut Vec<Turn>,
    committed: &mut usize,
    history: &mut String,
    restored: Vec<session_history::RestoredTurn>,
) {
    *turns = restored.into_iter().map(turn_from_restored).collect();
    *committed = 0;
    history.clear();
}

fn reset_native_history_after_switch(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    screen: ScreenMode,
    committed: &mut usize,
    history: &mut String,
) -> io::Result<()> {
    *committed = 0;
    history.clear();
    if screen == ScreenMode::Minimal {
        resize_purge_rerender(terminal, "")?;
    }
    Ok(())
}

fn commit_completed_turns(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    turns: &[Turn],
    committed: &mut usize,
    history: &mut String,
    extra: Option<&str>,
) -> io::Result<()> {
    let mut block = String::new();
    for (index, turn) in turns.iter().enumerate() {
        if index < *committed {
            continue;
        }
        if !turn.done {
            break;
        }
        block.push_str(&render_transcript("", std::slice::from_ref(turn), false));
        block.push('\n');
        *committed = index + 1;
    }
    if let Some(extra) = extra
        && !extra.is_empty()
    {
        block.push_str(extra);
        block.push('\n');
    }
    if block.is_empty() {
        return Ok(());
    }
    history.push_str(&block);
    with_synchronized_output(terminal, |terminal| emit_to_scrollback(terminal, &block))?;
    Ok(())
}

fn relaunch_exec(session_id: &str, target: ScreenMode) -> io::Error {
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            return io::Error::other(screen_mode::exec_failure_message(
                Some(session_id),
                target,
                &error.to_string(),
            ));
        }
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.args(screen_mode::exec_args(session_id, target));
    cmd.env(GROK_SCREEN_MODE_ENV, target.as_str());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = cmd.exec();
        io::Error::other(screen_mode::exec_failure_message(
            Some(session_id),
            target,
            &error.to_string(),
        ))
    }
    #[cfg(not(unix))]
    io::Error::other(screen_mode::exec_failure_message(
        Some(session_id),
        target,
        "exec relaunch is Unix-only",
    ))
}

fn apply_cursor_color(theme: &theme::Theme) {
    if let Some(osc) = theme.cursor_osc() {
        let _ = io::stdout().write_all(osc.as_bytes());
        let _ = io::stdout().flush();
    } else {
        let _ = io::stdout().write_all(theme::CURSOR_RESET.as_bytes());
        let _ = io::stdout().flush();
    }
}

fn persist_appearance(
    effective: &config::EffectiveConfig,
    key: &str,
    encoded: &str,
) -> Result<(), String> {
    appearance::persist(&effective.config_path, &[(key, encoded.to_string())]).map_err(|error| {
        format!("Couldn't save {key}: {error}. Check that $GROK_HOME is writable.")
    })
}

fn apply_overlay_action(
    action: OverlayAction,
    effective: &mut config::EffectiveConfig,
    live_theme_kind: &mut theme::ThemeKind,
    live_theme: &mut theme::Theme,
    screen: ScreenMode,
    hint: &mut String,
    last_error: &mut String,
    status_runtime: &mut status_line::StatusLineRuntime,
    prefs: &mut UiPrefs,
    ui_overlay: &mut UiOverlay,
) {
    match action {
        OverlayAction::None => {}
        OverlayAction::PreviewTheme(kind) => {
            *live_theme_kind = if kind.is_auto() {
                effective.appearance.resolved_kind(screen)
            } else {
                kind
            };
            *live_theme = if screen == ScreenMode::Minimal {
                theme::Theme::terminal_default()
            } else {
                theme::Theme::for_kind(*live_theme_kind).quantized(effective.appearance.color_level)
            };
            apply_cursor_color(live_theme);
        }
        OverlayAction::RestoreTheme(kind) => {
            effective.appearance.theme = kind;
            *live_theme_kind = effective.appearance.resolved_kind(screen);
            *live_theme = effective.appearance.resolved_theme(screen);
            apply_cursor_color(live_theme);
        }
        OverlayAction::ToggleBool { key, value } => {
            match appearance::apply_setting(
                &mut effective.appearance,
                &key,
                if value { "true" } else { "false" },
            ) {
                Ok(encoded) => match persist_appearance(effective, &key, &encoded) {
                    Ok(()) => {
                        if key == "ui.confirm_before_rewind" {
                            prefs.confirm_before_rewind = value;
                        }
                        if let UiOverlay::Settings(state) = ui_overlay {
                            state.refresh(&effective.appearance, screen);
                        }
                        *hint = format!("{} {}", key, if value { "on" } else { "off" });
                        last_error.clear();
                    }
                    Err(error) => *last_error = error,
                },
                Err(error) => *last_error = error,
            }
        }
        OverlayAction::Persist { key, value } => {
            match appearance::apply_setting(&mut effective.appearance, &key, &value) {
                Ok(encoded) => match persist_appearance(effective, &key, &encoded) {
                    Ok(()) => {
                        *live_theme_kind = effective.appearance.resolved_kind(screen);
                        *live_theme = effective.appearance.resolved_theme(screen);
                        apply_cursor_color(live_theme);
                        if key.starts_with("ui.status_line") {
                            status_runtime.shutdown();
                            *status_runtime = status_line::StatusLineRuntime::new(
                                effective.appearance.status_line.clone(),
                            );
                        }
                        if let UiOverlay::Settings(state) = ui_overlay {
                            state.refresh(&effective.appearance, screen);
                        }
                        *hint = format!("{key} = {value}");
                        last_error.clear();
                    }
                    Err(error) => *last_error = error,
                },
                Err(error) => *last_error = error,
            }
        }
    }
}

fn write_debug_file(debug: bool, path: Option<&PathBuf>, command: &str) -> io::Result<()> {
    if !debug && path.is_none() {
        return Ok(());
    }
    let trace = format!("{command} debug log; dsh owns execution. No leader socket.\n");
    eprint!("{trace}");
    if let Some(path) = path {
        std::fs::write(path, trace)?;
    }
    Ok(())
}

fn permission_slash(text: &str) -> Option<permission::PermissionMode> {
    match text.trim() {
        "/always-approve" | "/yolo" => Some(permission::PermissionMode::AlwaysApprove),
        "/auto" => Some(permission::PermissionMode::Auto),
        "/ask" => Some(permission::PermissionMode::Ask),
        "/dontAsk" | "/dont-ask" => Some(permission::PermissionMode::DontAsk),
        "/acceptEdits" | "/accept-edits" => Some(permission::PermissionMode::AcceptEdits),
        _ => None,
    }
}

fn tool_access(tool: &ToolRow) -> permission::AccessKind {
    // Kind is the tool name (`edit`, `bash`). Title is display text and must
    // not win, or a remembered edit is stored as an unmatchable tool grant.
    for name in [tool.kind.as_str(), tool.title.as_str()] {
        if name.is_empty() {
            continue;
        }
        let access = permission::access_from_tool(name, &tool.raw_input);
        if !matches!(access, permission::AccessKind::Tool(_)) {
            return access;
        }
    }
    permission::access_from_tool(
        if tool.kind.is_empty() {
            tool.title.as_str()
        } else {
            tool.kind.as_str()
        },
        &tool.raw_input,
    )
}

fn persistable_grant(access: &permission::AccessKind) -> bool {
    matches!(
        access,
        permission::AccessKind::Bash(_)
            | permission::AccessKind::Mcp { .. }
            | permission::AccessKind::WebFetch(_)
            | permission::AccessKind::Edit(_)
    )
}

fn persist_remembered_grant(
    effective: &mut config::EffectiveConfig,
    turn: &Turn,
    tool_call_id: &str,
) -> Result<String, String> {
    if !effective.permission.remember_tool_approvals {
        return Ok("Allowed once; remembering is disabled.".into());
    }
    let Some(tool) = turn.tools.iter().find(|tool| tool.id == tool_call_id) else {
        return Ok("Allowed once; not saved as a permanent rule.".into());
    };
    let access = tool_access(tool);
    if !persistable_grant(&access) {
        return Ok("Allowed once; not saved as a permanent rule.".into());
    }
    match permission::record_grant(&effective.permission.grants_path, &access, true) {
        Ok(grants) => {
            effective.permission.grants = grants;
            let _ = permission::write_policy_file(&effective.dsh_home, &effective.permission);
            Ok("Remembered for this project only; y would have been once.".into())
        }
        Err(_) => Ok("Couldn't save a permanent rule; this allow is once.".into()),
    }
}

fn revoke_remembered_grants(effective: &mut config::EffectiveConfig) -> Result<String, String> {
    permission::clear_grants(&effective.permission.grants_path)
        .map_err(|error| error.to_string())?;
    effective.permission.grants = permission::GrantStore::default();
    permission::write_policy_file(&effective.dsh_home, &effective.permission)
        .map_err(|error| error.to_string())?;
    Ok("Revoked remembered grants for this project. y remains once.".into())
}

fn apply_session_permission_mode(
    effective: &mut config::EffectiveConfig,
    client: Option<&AcpClient>,
    mode: permission::PermissionMode,
) -> Result<String, String> {
    if mode == permission::PermissionMode::AlwaysApprove
        && effective.permission.always_approve_locked
    {
        return Err(effective
            .permission
            .lock_source
            .clone()
            .unwrap_or_else(|| {
                "always-approve disabled by managed policy ([ui] disable_bypass_permissions_mode = true in requirements.toml)".into()
            }));
    }
    if effective.permission.mode == mode {
        if let Some(session_id) = client.and_then(|client| client.session_id.as_deref()) {
            let _ =
                session_owner::write_session_mode(&effective.dsh_home, session_id, mode.as_str());
        }
        return Ok(format!("Already in {} mode.", mode.as_str()));
    }
    if filesystem_sandbox::session_only_write(&effective.config_path) {
        effective.permission.mode = mode;
        effective.permission.mode_source = "session".into();
        if let Some(session_id) = client.and_then(|client| client.session_id.as_deref()) {
            let _ =
                session_owner::write_session_mode(&effective.dsh_home, session_id, mode.as_str());
        }
        return Ok(format!(
            "Permission mode {} for this session only. Sandbox kept $GROK_HOME/config.toml unchanged.",
            mode.as_str()
        ));
    }
    effective.permission.mode = mode;
    effective.permission.mode_source = "session".into();
    if let Some(session_id) = client.and_then(|client| client.session_id.as_deref()) {
        let _ = session_owner::write_session_mode(&effective.dsh_home, session_id, mode.as_str());
    }
    if let Some(setting) = effective
        .settings
        .iter_mut()
        .find(|setting| setting.key == "ui.permission_mode")
    {
        setting.value = mode.as_str().into();
        setting.source = "session".into();
    }
    let _ = permission::write_policy_file(&effective.dsh_home, &effective.permission);
    Ok(format!(
        "Permission mode {} for this session. Deny rules and hooks still apply.",
        mode.as_str()
    ))
}

fn editor_agent_help() -> &'static str {
    "Run the isolated Rust client as an ACP agent for an editor\n\n\
Usage: codsh --rust agent stdio\n\n\
Speaks ACP/JSON-RPC 1 on stdin/stdout. dsh --profile acp executes turns and owns the session log. \
Zed can launch this command as a custom agent server. session/new, session/load, session/resume, \
session/list, session/prompt, session/cancel, session/close, and session/set_config_option are real. \
session/load resumes through dsh and replays durable history; it does not execute tools again. \
permission_mode is a session config option and writes the same policy file the terminal uses. \
Editor model and reasoning changes are written to $GROK_HOME/model-selection.toml and restored on session/load, \
including an advertised model that is not a config.toml catalog id. An unknown model is refused. \
Terminal /dontAsk and /acceptEdits set the same session modes the editor advertises, and resume writes that mode before dsh starts. \
Proprietary x.ai methods, session/delete, session/fork, and session/set_mode return JSON-RPC \
method-not-found rather than a success stub. Closing the editor releases the write owner. \
A second terminal or editor cannot take the same live session.\n\n\
Shared forms (opt-in; nothing listens otherwise): `agent serve` is an authenticated WebSocket, \
`agent leader` a per-user local socket, and `agent --leader stdio` (or [cli] use_leader) connects this editor to it. \
Other clients attach to a live session with session/load; one dsh process still runs it. \
Run `codsh --rust agent serve --help` or `agent leader --help` for details; `leader list|info|kill` manages leaders.\n\n\
Options before agent are the same model, effort, and permission flags as the terminal. \
--help prints this text and does not connect."
}

fn editor_launch(launch: &Launch) -> editor_acp::EditorLaunch {
    editor_acp::EditorLaunch {
        model: launch.model.clone(),
        effort: launch.effort.clone(),
        permission_mode: launch.permission_mode.clone(),
        always_approve: launch.always_approve,
        auto: launch.auto,
        allow: launch.allow.clone(),
        deny: launch.deny.clone(),
    }
}

/// Execution-policy flags a leader client cannot bring: the leader already
/// runs with its own model and permission policy for every client.
fn leader_client_policy_flags(launch: &Launch) -> Vec<&'static str> {
    let mut flags = Vec::new();
    if launch.model.is_some() {
        flags.push("-m/--model");
    }
    if launch.effort.is_some() {
        flags.push("--effort");
    }
    if launch.permission_mode.is_some() {
        flags.push("--permission-mode");
    }
    if launch.always_approve {
        flags.push("--always-approve");
    }
    if launch.auto {
        flags.push("--auto");
    }
    if !launch.allow.is_empty() {
        flags.push("--allow");
    }
    if !launch.deny.is_empty() {
        flags.push("--deny");
    }
    flags
}

fn run_agent(launch: &Launch, command: shared_server::AgentCommand) -> io::Result<()> {
    use shared_server::AgentCommand;
    let loaded = load_runtime_config(launch);
    let sandbox = serde_json::json!({
        "profile": loaded.sandbox_profile,
        "applied": loaded.sandbox_profile != "off",
        "platform": std::env::consts::OS,
    });
    match command {
        AgentCommand::Help(topic) => {
            print!("{}", shared_server::agent_help(topic));
            Ok(())
        }
        AgentCommand::Serve(options) => {
            shared_server::run_serve(editor_launch(launch), options, sandbox)
        }
        AgentCommand::Leader(options) => {
            shared_server::run_leader(editor_launch(launch), options, &loaded.grok_home, sandbox)
        }
        AgentCommand::Stdio { leader, socket } => {
            let use_leader = loaded
                .merged_table
                .get("cli")
                .and_then(|cli| cli.get("use_leader"))
                .and_then(|value| value.as_bool());
            let explicit = leader.or(socket.as_ref().map(|_| true));
            let (shared, note) =
                shared_server::resolve_leader(explicit, use_leader, &loaded.sandbox_profile);
            if let Some(note) = note {
                eprintln!("{note}");
            }
            if !shared {
                return editor_acp::serve(editor_launch(launch), sandbox);
            }
            let refused = leader_client_policy_flags(launch);
            if !refused.is_empty() {
                return Err(io::Error::other(format!(
                    "{} cannot be used with the shared leader: the leader owns model and permission policy for every client. Pass them to `codsh --rust agent leader`, or use --no-leader",
                    refused.join(", ")
                )));
            }
            let path = shared_server::leader_socket(socket.as_deref(), &loaded.grok_home);
            let code = shared_server::run_proxy(&path)?;
            if code != 0 {
                std::process::exit(code);
            }
            Ok(())
        }
    }
}

fn inspect_help() -> &'static str {
    "Show the configuration this directory resolves\n\nUsage: codsh --rust inspect [OPTIONS]\n\nOptions:\n      --json                  Emit machine-readable JSON output\n      --debug                 Enable debug logging\n      --debug-file <FILE>     Write debug logs to FILE\n  -h, --help                  Print help\n\nReports CLI, environment, overlay, config.toml, workspace, managed, and requirements origins.\nLocked requirements cannot be bypassed. Folder trust, project-asset activity, marketplace sources, and installed plugin provenance are included.\nLeader sockets are unused; dsh owns execution."
}

fn run_import(flags: import::ImportFlags) -> io::Result<()> {
    let isolated_home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let isolated_dsh = PathBuf::from(
        std::env::var_os("DSH_HOME").unwrap_or_else(|| isolated_home.join("dsh").into()),
    );
    let grok_home = PathBuf::from(
        std::env::var_os("GROK_HOME").unwrap_or_else(|| isolated_home.join(".grok").into()),
    );
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    let mut request =
        import::host_request_from_env(&env, isolated_home, isolated_dsh, grok_home, cwd)
            .map_err(io::Error::other)?;
    request.providers = flags.providers.clone();
    request.include_preferences = flags.include_preferences;
    request.authorize_env = flags.authorize_env;
    request.apply = flags.apply && !flags.preview;
    let plan = import::discover(&request);
    if flags.json {
        print!("{}", import::render_preview_json(&plan));
    } else {
        println!("{}", import::render_preview(&plan));
    }
    if flags.preview || !flags.apply {
        if !flags.json {
            println!("No files written. Pass --apply to copy selected providers and preferences.");
        }
        return Ok(());
    }
    match import::apply(&request, &plan) {
        Ok(result) if result.applied => {
            if !flags.json {
                println!(
                    "Imported {} provider(s) into {}. Source files were not changed. Export each model's env_key; secrets and trust grants were not copied.",
                    plan.selected
                        .iter()
                        .filter(|item| {
                            !plan
                                .conflicts
                                .iter()
                                .any(|conflict| conflict.id == item.catalog_id)
                        })
                        .count(),
                    request.grok_home.join("config.toml").display()
                );
            }
            Ok(())
        }
        Ok(_) => Ok(()),
        Err(error) => Err(io::Error::other(format!(
            "import failed: {error}. Source files and existing isolated settings were left unchanged."
        ))),
    }
}

fn load_runtime_config(launch: &Launch) -> config::EffectiveConfig {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let mut input = config::LoadInput {
        home: home.clone(),
        dsh_home: PathBuf::from(
            std::env::var_os("DSH_HOME").unwrap_or_else(|| home.join("dsh").into()),
        ),
        cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        grok_home: std::env::var_os("GROK_HOME").map(PathBuf::from),
        env: std::env::vars().collect(),
        cli_model: launch.model.clone(),
        cli_effort: launch.effort.clone(),
        cli_trust: launch.trust,
        cli_revoke_trust: launch.revoke_trust,
        cli_trust_path: launch.trust_folder.clone(),
        interactive: io::stdin().is_terminal(),
        cli_permission_mode: launch.permission_mode.clone(),
        cli_always_approve: launch.always_approve,
        cli_auto: launch.auto,
        cli_allow: launch.allow.clone(),
        cli_deny: launch.deny.clone(),
        cli_no_memory: launch.no_memory,
        cli_sandbox: launch.sandbox.clone(),
        cli_disable_web_search: launch.disable_web_search,
        cli_subagents: launch.subagents.clone(),
        cli_interaction: launch.interaction.clone(),
    };
    if input.dsh_home.as_os_str().is_empty() {
        input.dsh_home = input.home.join("dsh");
    }
    config::load_from(input)
}

fn attach_clipboard_image(
    composer: &mut PromptComposer,
    hint: &mut String,
    last_error: &mut String,
) {
    match images::read_clipboard_image() {
        Ok(image) => match composer.paste_image_bytes(&image.bytes) {
            Ok(()) => {
                *hint = std::mem::take(&mut composer.footer_notice);
                last_error.clear();
            }
            Err(error) => {
                *hint = error;
                composer.footer_notice.clear();
            }
        },
        Err(error) => {
            *hint = if error.detail.is_empty() {
                error.status.label().to_string()
            } else {
                error.detail
            };
            composer.footer_notice.clear();
        }
    }
}

fn composer_notice(composer: &PromptComposer, hint: &str) -> String {
    // The notice slot keeps its newest lines. The preview has to follow the
    // status, or a tall connection banner scrolls it off the screen.
    let mut out = match composer.image_preview() {
        Some(preview) if hint.is_empty() => preview,
        Some(preview) => format!("{hint}\n{preview}"),
        None => hint.to_string(),
    };
    // The queue sits last, right above the prompt, so it is never the part
    // that scrolls away.
    let queue = composer.queue_panel_text();
    if !queue.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&queue);
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum BtwState {
    Loading,
    Answer(String),
    Failed(String),
}

/// The dismissible side-answer panel above the prompt. Keyed by request id,
/// so a late reply for a dismissed or replaced question is dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BtwPanel {
    id: String,
    question: String,
    state: BtwState,
}

/// Mid-turn intervention state that lives beside the composer queue.
#[derive(Debug, Default)]
struct Intervene {
    btw: Option<BtwPanel>,
    next_btw: u64,
    /// The agent went idle with rows queued. Cleared when the queue empties,
    /// a row cannot run, or the session changes under the queue.
    drain_armed: bool,
    /// Question card, plan review, plan state, and todos (ticket 179).
    ask: Interact,
    /// Ids for background and job-stop control requests.
    next_control: u64,
    /// Ctrl+B asked dsh to move the running command; its reply id.
    background_request: Option<String>,
    /// A send-now moves the running command first and cancels the turn
    /// only after dsh answered (or after a short bound), so the command is
    /// not killed with the turn.
    deferred_cancel: Option<DeferredCancel>,
    /// The tasks pane's answer to its last stop request.
    kill_notice: Option<String>,
    /// `/workflow ...` waits for the run manager's reply under this id.
    workflow_request: Option<String>,
    /// The owner lock handed to dsh for saved loops (ticket 178): dsh
    /// process id, session id, and lock token of the last handover.
    schedule_owner: Option<(u32, String, String)>,
    /// The handover's request id while dsh has not answered.
    schedule_owner_request: Option<String>,
    /// Handovers dsh answered before it had the session (bounded).
    schedule_owner_retries: u8,
}

/// Ticket 179 state beside the composer. dsh owns every decision; this only
/// shows what dsh asked and carries the user's answer back.
#[derive(Debug, Default)]
struct Interact {
    card: Option<interaction::QuestionCard>,
    review: Option<interaction::PlanReview>,
    /// Questions dsh sent while another card was open, oldest first.
    waiting: std::collections::VecDeque<(String, Value, Option<control::Review>)>,
    plan: interaction::PlanState,
    todos: Option<Vec<interaction::TodoItem>>,
    todos_hidden: bool,
    next_id: u64,
    /// `/plan <description>`: the prompt waits for dsh to confirm plan mode.
    plan_prompt: Option<(String, String)>,
    /// The permission mode Shift+Tab returns to after always-approve.
    cycle_base: Option<permission::PermissionMode>,
    /// The id of the last plan-mode request, and the notice to show when
    /// dsh confirms it (Shift+Tab names the mode it moved to).
    last_plan_id: String,
    plan_note: Option<(String, String)>,
}

impl Interact {
    fn open(&self) -> bool {
        self.card.is_some() || self.review.is_some()
    }

    /// Show the next waiting question. Minimal prints a plan into scrollback.
    fn open_next(&mut self, minimal: bool) -> Option<String> {
        if self.open() {
            return None;
        }
        let (id, questions, review) = self.waiting.pop_front()?;
        match review {
            Some(review) => {
                let mut view = interaction::PlanReview::new(id, &review.plan, review.plan_file);
                let printed = minimal.then(|| view.scrollback_text());
                view.committed = minimal;
                self.review = Some(view);
                printed
            }
            None => {
                self.card = Some(interaction::QuestionCard::new(
                    id,
                    interaction::parse_questions(&questions),
                ));
                None
            }
        }
    }

    fn close(&mut self, id: &str) -> bool {
        let before = self.waiting.len();
        self.waiting.retain(|(waiting, _, _)| waiting != id);
        let mut closed = self.waiting.len() != before;
        if self.card.as_ref().is_some_and(|card| card.id == id) {
            self.card = None;
            closed = true;
        }
        if self.review.as_ref().is_some_and(|review| review.id == id) {
            self.review = None;
            closed = true;
        }
        closed
    }
}

/// Apply ticket-179 control events. Returns text for minimal scrollback.
fn apply_interaction_events(
    events: &[control::ControlEvent],
    side: &mut Intervene,
    composer: &mut PromptComposer,
    client: Option<&AcpClient>,
    hint: &mut String,
    minimal: bool,
) -> Option<String> {
    use control::ControlEvent;
    let mut printed = String::new();
    let session = client.and_then(|active| active.session_id.as_deref());
    let ask = &mut side.ask;
    for event in events {
        match event {
            ControlEvent::Question {
                id,
                questions,
                review,
                ..
            } => {
                if review.is_none() && interaction::parse_questions(questions).is_empty() {
                    if let Some(active) = client {
                        let _ = active.send_control(&control::question_dismiss_message(id));
                    }
                    *hint = "dsh sent a question with nothing to answer; it was dismissed".into();
                    continue;
                }
                ask.waiting
                    .push_back((id.clone(), questions.clone(), review.clone()));
                if let Some(text) = ask.open_next(minimal) {
                    printed.push_str(&text);
                }
                *hint = if ask.review.is_some() {
                    "Plan review: a approve · s request changes · q quit plan".into()
                } else {
                    "dsh is asking a question; answer on the card (Shift+X dismisses)".into()
                };
            }
            ControlEvent::QuestionClosed { id, reason } => {
                if ask.close(id) || reason == "stale" {
                    *hint = match reason.as_str() {
                        "timeout" => {
                            "question timed out; the agent continues without an answer".into()
                        }
                        "aborted" => "question closed: the turn was cancelled".into(),
                        "stale" => {
                            "dsh had already closed that question; the late answer was not used"
                                .into()
                        }
                        other => format!("question closed ({other})"),
                    };
                }
                if let Some(text) = ask.open_next(minimal) {
                    printed.push_str(&text);
                }
            }
            ControlEvent::PlanState {
                session_id,
                active,
                pending,
                plan_file,
            } => {
                if session.is_some_and(|live| live != session_id) {
                    continue;
                }
                ask.plan = interaction::PlanState {
                    active: *active,
                    pending: *pending,
                    plan_file: plan_file.clone(),
                };
            }
            ControlEvent::PlanResult {
                id,
                outcome,
                message,
            } => {
                let prompt = ask
                    .plan_prompt
                    .take_if(|(waiting, _)| waiting == id)
                    .map(|(_, text)| text);
                let on = !id.ends_with("-off");
                let note = ask
                    .plan_note
                    .take_if(|(waiting, _)| waiting == id)
                    .map(|(_, text)| text);
                *hint = match outcome.as_str() {
                    "committed" | "queued" | "noop" if note.is_some() => note.unwrap_or_default(),
                    "committed" if on => {
                        "Plan mode on: read-only except the plan file. /plan off leaves.".into()
                    }
                    "committed" => "Plan mode off.".into(),
                    "queued" if on => "Plan mode starts at dsh's next step.".into(),
                    "queued" => "Plan mode ends at dsh's next step.".into(),
                    "cancelled" => "Plan mode change cancelled.".into(),
                    "noop" => "Plan mode already in that state.".into(),
                    _ => format!("plan mode unavailable: {message}"),
                };
                if outcome != "error"
                    && let Some(text) = prompt
                {
                    composer.enqueue_command(&text);
                    composer.footer_notice.clear();
                    side.drain_armed = true;
                    break;
                }
            }
            ControlEvent::Todos { session_id, todos } => {
                if session.is_some_and(|live| live != session_id) {
                    continue;
                }
                ask.todos = todos
                    .as_ref()
                    .and_then(interaction::parse_todos)
                    .filter(|items| !items.is_empty());
            }
            ControlEvent::Closed(_) if ask.open() || !ask.waiting.is_empty() => {
                ask.card = None;
                ask.review = None;
                ask.waiting.clear();
                *hint = "the dsh control channel closed; the open question was dropped".into();
            }
            _ => {}
        }
    }
    (!printed.is_empty()).then_some(printed)
}

/// Copy text for `y` on the card or the plan review.
fn copy_interaction_text(text: &str, home: &Path) -> String {
    let _ = write!(io::stdout(), "{}", navigation::osc52(text));
    let _ = io::stdout().flush();
    match content::copy_original(text, home) {
        Ok(message) => message,
        Err(error) => error,
    }
}

/// Send one answer-side message; on failure the card is dropped with a reason.
fn send_interaction(client: Option<&AcpClient>, message: &Value, hint: &mut String) -> bool {
    match client.map(|active| active.send_control(message)) {
        Some(Ok(())) => true,
        Some(Err(error)) => {
            *hint = format!("answer not delivered: {error}");
            false
        }
        None => {
            *hint = "answer not delivered: no live dsh session".into();
            false
        }
    }
}

/// Keys for the question card and plan review. `true` when the key was used.
fn handle_interaction_key(
    key: crossterm::event::KeyEvent,
    side: &mut Intervene,
    composer: &mut PromptComposer,
    client: Option<&AcpClient>,
    hint: &mut String,
    minimal: bool,
    home: &Path,
) -> (bool, Option<String>) {
    let ctrl_c = key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c');
    if ctrl_c {
        return (false, None);
    }
    let ask = &mut side.ask;
    if let Some(card) = ask.card.as_mut() {
        if card.parked {
            let back = matches!(key.code, KeyCode::Tab | KeyCode::Char(' '))
                && key.modifiers.is_empty()
                && composer.is_empty()
                && composer.overlay == prompt_edit::Overlay::None;
            if back {
                card.parked = false;
                hint.clear();
                return (true, None);
            }
            return (false, None);
        }
        let id = card.id.clone();
        match card.handle_key(key) {
            interaction::CardAction::Submit(answers) => {
                let answers = answers.iter().map(interaction::Answer::to_json).collect();
                if send_interaction(
                    client,
                    &control::question_answer_message(&id, answers, None),
                    hint,
                ) {
                    hint.clear();
                }
                ask.card = None;
            }
            interaction::CardAction::Dismiss => {
                if send_interaction(client, &control::question_dismiss_message(&id), hint) {
                    *hint = "question dismissed; the agent continues without an answer".into();
                }
                ask.card = None;
            }
            interaction::CardAction::Copy(text) => *hint = copy_interaction_text(&text, home),
            interaction::CardAction::Park => {
                *hint = "keyboard parked in the scrollback; Tab or Space returns to the question"
                    .into();
            }
            interaction::CardAction::Hint(text) => *hint = text,
            interaction::CardAction::None => {}
        }
        return (true, ask.open_next(minimal));
    }
    if let Some(review) = ask.review.as_mut() {
        let id = review.id.clone();
        if review.focus == interaction::ReviewFocus::Prompt {
            let plain = composer.overlay == prompt_edit::Overlay::None;
            if key.code == KeyCode::Enter
                && key.modifiers.is_empty()
                && plain
                && !composer.text().trim_start().starts_with('/')
            {
                let notes = review.feedback(composer.text());
                if notes.is_empty() {
                    *hint = "type revision notes first, or Esc to go back to the plan".into();
                    return (true, None);
                }
                let answer = json_answer("plan-review", "Keep planning", Some(&notes));
                if send_interaction(
                    client,
                    &control::question_answer_message(&id, vec![answer], None),
                    hint,
                ) {
                    *hint = "changes requested; the agent keeps planning".into();
                }
                composer.set_text("");
                ask.review = None;
                return (true, ask.open_next(minimal));
            }
            if matches!(key.code, KeyCode::Esc | KeyCode::Tab) && key.modifiers.is_empty() && plain
            {
                review.focus = interaction::ReviewFocus::Preview;
                hint.clear();
                return (true, None);
            }
            return (false, None);
        }
        let pending_command = composer.text().trim_start().starts_with('/');
        match review.handle_key(key, minimal, pending_command) {
            interaction::ReviewAction::Approve { comments } => {
                let answer = json_answer("plan-review", "Approve", None);
                if send_interaction(
                    client,
                    &control::question_answer_message(&id, vec![answer], comments.as_deref()),
                    hint,
                ) {
                    *hint = "plan approved; plan mode ends and the agent implements it".into();
                }
                ask.review = None;
            }
            interaction::ReviewAction::Quit if review.readonly => {
                ask.review = None;
                hint.clear();
            }
            interaction::ReviewAction::Quit => {
                if send_interaction(client, &control::plan_quit_message(&id), hint) {
                    *hint = "plan abandoned; plan mode is off".into();
                }
                ask.review = None;
            }
            interaction::ReviewAction::Copy(text) => *hint = copy_interaction_text(&text, home),
            interaction::ReviewAction::FocusPrompt => {
                *hint =
                    "type revision notes in the prompt; Enter sends them, Esc returns to the plan"
                        .into();
            }
            interaction::ReviewAction::Hint(text) => *hint = text,
            interaction::ReviewAction::None => {}
        }
        return (true, ask.open_next(minimal));
    }
    (false, None)
}

fn json_answer(id: &str, label: &str, custom: Option<&str>) -> Value {
    interaction::Answer {
        id: id.into(),
        selected: vec![label.into()],
        custom: custom.map(str::to_string),
    }
    .to_json()
}

/// `/plan [off|description]`. The description is sent as a prompt once dsh
/// confirms plan mode, so the first model step already plans.
fn plan_command(
    rest: &str,
    side: &mut Intervene,
    client: Option<&AcpClient>,
    effective: &config::EffectiveConfig,
) -> Result<String, String> {
    if effective.interaction_cli.no_plan {
        return Err("plan mode is disabled for this session (--no-plan)".into());
    }
    let Some(active) = client else {
        return Err("/plan needs a live dsh session".into());
    };
    let rest = rest.trim();
    let on = rest != "off";
    side.ask.next_id += 1;
    // The direction rides in the id so the confirmation can name it.
    let id = format!("p{}-{}", side.ask.next_id, if on { "on" } else { "off" });
    active.send_plan_set(&id, on)?;
    side.ask.last_plan_id = id.clone();
    if on && !rest.is_empty() {
        side.ask.plan_prompt = Some((id, rest.to_string()));
        return Ok("Entering plan mode; the description is sent next.".into());
    }
    Ok(if on {
        "Entering plan mode…".into()
    } else {
        "Leaving plan mode…".into()
    })
}

/// Shift+Tab: normal → plan → always-approve → normal. Plan mode is asked
/// of dsh; always-approve uses the same session mode `/always-approve` sets,
/// and is skipped when requirements lock it off.
fn cycle_plan_mode(
    side: &mut Intervene,
    client: Option<&AcpClient>,
    effective: &mut config::EffectiveConfig,
) -> Result<String, String> {
    use permission::PermissionMode;
    let always = effective.permission.mode == PermissionMode::AlwaysApprove;
    if side.ask.plan.effective() {
        plan_command("off", side, client, effective)?;
        if effective.permission.always_approve_locked {
            let note = "Plan mode off (always-approve is locked off).".to_string();
            side.ask.plan_note = Some((side.ask.last_plan_id.clone(), note.clone()));
            return Ok(note);
        }
        let note = apply_session_permission_mode(effective, client, PermissionMode::AlwaysApprove)
            .map(|_| "Plan mode off → always-approve.".to_string())?;
        side.ask.plan_note = Some((side.ask.last_plan_id.clone(), note.clone()));
        Ok(note)
    } else if always {
        let base = side.ask.cycle_base.take().unwrap_or(PermissionMode::Ask);
        let base = if base == PermissionMode::AlwaysApprove {
            PermissionMode::Ask
        } else {
            base
        };
        apply_session_permission_mode(effective, client, base)
            .map(|_| format!("Normal mode ({}).", base.as_str()))
    } else {
        if effective.interaction_cli.no_plan {
            return Err("plan mode is disabled for this session (--no-plan)".into());
        }
        side.ask.cycle_base = Some(effective.permission.mode);
        plan_command("", side, client, effective)
    }
}

/// `/view-plan`: the saved plan for this session.
fn view_plan_text(
    side: &Intervene,
    client: Option<&AcpClient>,
    effective: &config::EffectiveConfig,
) -> Result<String, String> {
    let path = if side.ask.plan.plan_file.is_empty() {
        let session = client
            .and_then(|active| active.session_id.as_deref())
            .ok_or("no session yet; no plan has been written")?;
        interaction::plan_file(&effective.grok_home, &effective.cwd, session)
    } else {
        PathBuf::from(&side.ask.plan.plan_file)
    };
    match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => {
            Ok(format!("── {} ──\n{}", path.display(), text.trim_end()))
        }
        _ => Err(format!(
            "{} (no plan written yet at {})",
            interaction::EMPTY_PLAN,
            path.display()
        )),
    }
}

#[derive(Debug)]
struct DeferredCancel {
    id: String,
    since: Instant,
    answered: bool,
}

/// How long a send-now waits for dsh to move the running command before it
/// cancels the turn anyway.
const DEFERRED_CANCEL_BOUND: Duration = Duration::from_secs(2);

const BTW_PANEL_LINES: usize = 3;

/// The side question: a parked message prefix plus the text after `/btw`.
fn btw_question(parked: &str, rest: &str) -> String {
    [parked.trim(), rest.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn btw_panel_text(panel: &BtwPanel) -> String {
    let question: String = panel.question.chars().take(60).collect();
    match &panel.state {
        BtwState::Loading => format!("btw › {question}  (answering… Esc dismiss)"),
        BtwState::Failed(message) => {
            format!("btw › {question}\nside question failed: {message}  (Esc dismiss)")
        }
        BtwState::Answer(text) => {
            let mut lines: Vec<String> = text
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_string)
                .collect();
            let more = lines.len() > BTW_PANEL_LINES;
            lines.truncate(BTW_PANEL_LINES);
            if more {
                lines.push("…".into());
            }
            format!("btw › {question}  (Esc dismiss)\n{}", lines.join("\n"))
        }
    }
}

/// Minimal mode keeps a finished side answer in native scrollback.
fn btw_scrollback_text(panel: &BtwPanel) -> Option<String> {
    match &panel.state {
        BtwState::Answer(text) => Some(format!("btw › {}\n{}\n", panel.question, text.trim_end())),
        BtwState::Failed(message) => Some(format!(
            "btw › {}\nside question failed: {message}\n",
            panel.question
        )),
        BtwState::Loading => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TermFamily {
    /// macOS Terminal.app: Ctrl+O is send-now there (reference 03).
    AppleTerminal,
    /// VS Code, Cursor, Windsurf, Zed: those editors keep Ctrl+Enter, so
    /// send-now is Ctrl+L only.
    VsCode,
    Other,
}

fn term_family(term_program: Option<&str>) -> TermFamily {
    match term_program.map(str::trim) {
        Some("Apple_Terminal") => TermFamily::AppleTerminal,
        Some(name)
            if name.eq_ignore_ascii_case("vscode")
                || name.eq_ignore_ascii_case("cursor")
                || name.eq_ignore_ascii_case("windsurf")
                || name.eq_ignore_ascii_case("zed") =>
        {
            TermFamily::VsCode
        }
        _ => TermFamily::Other,
    }
}

/// Send-now chord for this terminal. Ctrl+O is claimed only on Apple
/// Terminal; elsewhere it is left unbound. Ctrl+I is only distinct from Tab
/// where the terminal reports it (kitty keyboard protocol).
fn is_send_now_chord(key: &crossterm::event::KeyEvent, family: TermFamily) -> bool {
    if key.modifiers != KeyModifiers::CONTROL {
        return false;
    }
    match family {
        TermFamily::VsCode => key.code == KeyCode::Char('l'),
        TermFamily::AppleTerminal => matches!(
            key.code,
            KeyCode::Char('o') | KeyCode::Enter | KeyCode::Char('i')
        ),
        TermFamily::Other => matches!(key.code, KeyCode::Enter | KeyCode::Char('i')),
    }
}

/// Cancel-and-send: the row moves to the front, alone, and the running turn
/// is cancelled; the drain runs it as the next turn once the cancel lands.
/// Idle, the row simply runs now.
#[allow(clippy::too_many_arguments)]
fn send_queued_now(
    id: u64,
    composer: &mut PromptComposer,
    client: &mut Option<AcpClient>,
    turns: &mut [Turn],
    inflight: bool,
    compacting: bool,
    side: &mut Intervene,
    hint: &mut String,
    last_error: &mut String,
) {
    if composer.queue_edit() == Some(id) {
        composer.cancel_queue_edit();
    }
    let Some(mut item) = composer.remove_queued(id) else {
        return;
    };
    item.solo = true;
    composer.push_front(item);
    composer.queue_pane = None;
    side.drain_armed = true;
    if !inflight {
        hint.clear();
        return;
    }
    if compacting {
        *hint = "compaction is running; this row runs as soon as it finishes".into();
        return;
    }
    if turns.last().is_some_and(|turn| turn.cancelling) || side.deferred_cancel.is_some() {
        *hint = "the turn is already stopping; this row runs next".into();
        return;
    }
    let Some(active) = client.as_mut() else {
        return;
    };
    // A foreground command keeps running: dsh moves it to the background
    // before the turn is cancelled, and the row runs next.
    if foreground_command_running(turns) && active.control_ready() {
        side.next_control += 1;
        let id = format!("g{}", side.next_control);
        if active.send_background(&id, "message").is_ok() {
            side.deferred_cancel = Some(DeferredCancel {
                id,
                since: Instant::now(),
                answered: false,
            });
            *hint = "sending now: moving the running command to the background first".into();
            last_error.clear();
            return;
        }
    }
    cancel_for_send_now(active, turns, hint, last_error);
}

/// The silent cancel half of cancel-and-send.
fn cancel_for_send_now(
    active: &mut AcpClient,
    turns: &mut [Turn],
    hint: &mut String,
    last_error: &mut String,
) {
    match active.cancel_prompt() {
        Ok(()) => {
            if let Some(turn) = turns.last_mut() {
                turn.permission = None;
                turn.cancelling = true;
                turn.quiet_cancel = true;
                for tool in &mut turn.tools {
                    if tool.status == "pending" || tool.status == "in_progress" {
                        tool.status = "cancelled".into();
                    }
                }
            }
            *hint = "sending now: stopping the current turn".into();
            last_error.clear();
        }
        Err(error) => *last_error = error.message,
    }
}

/// Apply steer outcomes and side answers from the control channel. Returns
/// text for native scrollback (a finished side answer in minimal mode).
#[allow(clippy::too_many_arguments)]
fn apply_control_events(
    events: Vec<control::ControlEvent>,
    composer: &mut PromptComposer,
    turns: &mut Vec<Turn>,
    inflight: bool,
    side: &mut Intervene,
    hint: &mut String,
    minimal: bool,
) -> Option<String> {
    use control::ControlEvent;
    let mut scrollback = None;
    for event in events {
        match event {
            ControlEvent::Ready | ControlEvent::SteerAccepted(_) => {}
            ControlEvent::SteerIdle(wire) | ControlEvent::SteerReturned(wire) => {
                if let Some(item) = composer.queue_item_by_wire(&wire) {
                    item.steering = false;
                    if !inflight {
                        side.drain_armed = true;
                    }
                }
            }
            ControlEvent::SteerClaimed(wire) => {
                let Some(id) = composer.queue_item_by_wire(&wire).map(|item| item.id) else {
                    continue;
                };
                let Some(item) = composer.remove_queued(id) else {
                    continue;
                };
                // dsh took the steer into the running turn. The transcript
                // shows it as its own user turn from here on.
                if let Some(previous) = turns.last_mut() {
                    previous.done = true;
                    previous.permission = None;
                }
                turns.push(Turn {
                    user: item.prompt.text.clone(),
                    thought: String::new(),
                    answer: String::new(),
                    error: None,
                    message_id: None,
                    tools: Vec::new(),
                    permission: None,
                    done: !inflight,
                    cancelling: false,
                    cancelled: false,
                    interrupted: false,
                    compacted: false,
                    compaction: None,
                    timestamp: Some(clock_stamp()),
                    quiet_cancel: false,
                });
                composer.record_history(&item.prompt.text);
            }
            ControlEvent::BtwAnswer { id, text } => {
                if let Some(panel) = side.btw.as_mut().filter(|panel| panel.id == id) {
                    panel.state = BtwState::Answer(text);
                }
            }
            ControlEvent::BtwError { id, message } => {
                if let Some(panel) = side.btw.as_mut().filter(|panel| panel.id == id) {
                    panel.state = BtwState::Failed(message);
                }
            }
            ControlEvent::BackgroundResult { id, count } => {
                if let Some(pending) = side
                    .deferred_cancel
                    .as_mut()
                    .filter(|pending| pending.id == id)
                {
                    pending.answered = true;
                }
                if side.background_request.as_deref() == Some(id.as_str()) {
                    side.background_request = None;
                    if count == 0 {
                        *hint = "no foreground command is running (Ctrl+B moves a running command)"
                            .into();
                    } else if !hint.starts_with("command moved to the background") {
                        *hint = "command moved to the background · Ctrl+G or /tasks".into();
                    }
                }
            }
            ControlEvent::ScheduleDeleteResult { task, outcome, .. } => {
                side.kill_notice = Some(match outcome {
                    Ok((true, _)) => {
                        format!("loop {task} deleted; a fire already running still reports")
                    }
                    Ok((false, message)) => message,
                    Err(error) => format!("delete failed for loop {task}: {error}"),
                });
            }
            ControlEvent::WorkflowResult { id, outcome } => {
                // Only the newest request is shown; a late reply is dropped.
                if side.workflow_request.as_deref() == Some(id.as_str()) {
                    side.workflow_request = None;
                    match outcome {
                        Ok(text) => {
                            // A saved run is runnable by name right away.
                            if text.starts_with("Saved workflow '") {
                                composer.refresh_workflow_commands();
                            }
                            *hint = text
                        }
                        Err(error) => *hint = format!("/workflow failed: {error}"),
                    }
                }
            }
            ControlEvent::GoalResult { message, .. } => {
                if !message.is_empty() {
                    *hint = message;
                }
            }
            ControlEvent::ScheduleOwnerResult { id, outcome, .. } => {
                if side.schedule_owner_request.as_deref() == Some(id.as_str()) {
                    side.schedule_owner_request = None;
                    match outcome {
                        Ok(_) => side.schedule_owner_retries = 0,
                        // dsh has not registered the session yet: hand over again.
                        Err(error) if error == "no live dsh session for this owner" => {
                            side.schedule_owner = None;
                            side.schedule_owner_retries += 1;
                        }
                        Err(error) if error == "scheduled prompts are unavailable in this dsh" => {}
                        // A damaged file already has its own hint.
                        Err(_) if hint.starts_with("Saved loops for this session could not") => {}
                        Err(error) => {
                            *hint = format!("Loops in this session are not saved: {error}");
                        }
                    }
                }
            }
            ControlEvent::JobKillResult { job, outcome, .. } => {
                side.kill_notice = Some(match outcome {
                    Ok(outcome) if outcome == "already-finished" => {
                        format!("{job} had already finished")
                    }
                    Ok(_) => {
                        format!("stop requested for {job}; the model is told at its next step")
                    }
                    Err(error) => format!("stop failed for {job}: {error}"),
                });
            }
            ControlEvent::Closed(reason) => {
                side.background_request = None;
                if side.workflow_request.take().is_some() {
                    *hint = format!("/workflow failed: {reason}");
                }
                if let Some(pending) = side.deferred_cancel.as_mut() {
                    pending.answered = true;
                }
                let wires: Vec<String> = composer
                    .queue_items()
                    .iter()
                    .filter(|item| item.steering)
                    .map(|item| item.wire_id())
                    .collect();
                for wire in wires {
                    if let Some(item) = composer.queue_item_by_wire(&wire) {
                        item.steering = false;
                    }
                }
                if let Some(panel) = side.btw.as_mut()
                    && panel.state == BtwState::Loading
                {
                    panel.state = BtwState::Failed(reason);
                }
            }
            // Ticket 179 events are applied by `apply_interaction_events`.
            ControlEvent::Question { .. }
            | ControlEvent::QuestionClosed { .. }
            | ControlEvent::PlanState { .. }
            | ControlEvent::PlanResult { .. }
            | ControlEvent::Todos { .. } => {}
        }
        if minimal
            && let Some(panel) = &side.btw
            && let Some(text) = btw_scrollback_text(panel)
        {
            scrollback = Some(text);
            side.btw = None;
            hint.clear();
        }
    }
    scrollback
}

fn sync_image_route(composer: &mut PromptComposer, effective: &config::EffectiveConfig) {
    let accepts = effective
        .routing()
        .is_some_and(|routing| routing.accepts_images);
    composer.set_image_route(accepts, Some(&effective.dsh_home));
}

fn live_routing(
    client: Option<&AcpClient>,
    effective: &config::EffectiveConfig,
) -> Option<models::Routing> {
    let mut routing = effective.routing()?;
    if let Some(option) = client.and_then(|client| client.config_option("model"))
        && let Some(current) = option.current.as_deref()
        && let Some((provider, model)) = models::parse_acp_model_value(current)
    {
        routing.provider = provider;
        routing.model = model;
        if let Some(choice) = effective
            .catalog()
            .into_iter()
            .find(|choice| choice.acp_value == current)
        {
            routing.catalog_id = choice.id;
            routing.api = choice.api;
            routing.backend = choice.backend;
            routing.advertised_context = choice.advertised_context;
            routing.accepts_images = images::model_accepts_images(Some(&choice.input_modalities));
        } else {
            // The live model is not a catalog entry this client can prove
            // accepts images. Do not keep the previous vision route.
            routing.accepts_images = false;
        }
    }
    if let Some(option) = client.and_then(|client| client.config_option("reasoning_effort")) {
        routing.effort = option.current.clone().filter(|value| !value.is_empty());
    }
    Some(routing)
}

pub(crate) fn apply_live_selection(
    client: &mut AcpClient,
    effective: &config::EffectiveConfig,
) -> Result<(), String> {
    // The mock seam skips catalog pinning, but a saved advertised pair is the
    // editor route the terminal must share. Leaving it unapplied is a silent
    // fallback to the catalog default.
    if config::is_test_execution_seam() && effective.unmatched_saved_model.is_none() {
        return Ok(());
    }
    let catalog = effective.catalog();
    let choice = catalog
        .iter()
        .find(|choice| Some(choice.id.as_str()) == effective.default_model.as_deref());
    let acp_value = if let Some(unmatched) = effective.unmatched_saved_model.as_deref() {
        let overridden = effective.settings.iter().any(|setting| {
            setting.key == "models.default"
                && matches!(setting.source.as_str(), "cli" | "requirements")
        });
        if overridden {
            choice.map(|item| item.acp_value.clone())
        } else {
            match effective.saved_acp_value.clone() {
                Some(saved) => Some(saved),
                None => {
                    return Err(format!(
                        "saved model {unmatched} is not in the catalog and has no advertised value; no silent provider fallback."
                    ));
                }
            }
        }
    } else {
        choice.map(|item| item.acp_value.clone())
    };
    let Some(acp_value) = acp_value else {
        return Ok(());
    };
    let using_saved = effective.unmatched_saved_model.is_some()
        && effective.saved_acp_value.as_deref() == Some(acp_value.as_str());
    if let Some(choice) = choice.filter(|_| !using_saved)
        && !choice.usable
    {
        return Err(choice
            .unavailable
            .clone()
            .unwrap_or_else(|| format!("model {} is unavailable", choice.id)));
    }
    let label = if using_saved {
        effective
            .unmatched_saved_model
            .as_deref()
            .unwrap_or(&acp_value)
    } else {
        effective.default_model.as_deref().unwrap_or(&acp_value)
    };
    let model_option = client.config_option("model").cloned();
    let Some(option) = model_option else {
        return Err(format!(
            "dsh did not advertise model options; configured {label} was not applied. No silent provider fallback."
        ));
    };
    if !option.choices.iter().any(|item| item.value == acp_value) {
        return Err(format!(
            "dsh did not advertise {label} ({acp_value}); no silent provider fallback."
        ));
    }
    if option.current.as_deref() != Some(acp_value.as_str()) {
        client
            .set_config_option("model", &acp_value, Duration::from_secs(20))
            .map_err(|error| error.message)?;
    }
    if let Some(effort) = &effective.default_effort {
        let effort_option = client.config_option("reasoning_effort").cloned();
        let reasoning = choice.is_some_and(|choice| choice.reasoning);
        match effort_option {
            Some(option)
                if option.choices.iter().any(|item| {
                    item.value == *effort || item.name.eq_ignore_ascii_case(effort)
                }) =>
            {
                let value = option
                    .choices
                    .iter()
                    .find(|item| item.value == *effort || item.name.eq_ignore_ascii_case(effort))
                    .map(|item| item.value.clone())
                    .unwrap_or_else(|| effort.clone());
                if option.current.as_deref() != Some(value.as_str()) {
                    client
                        .set_config_option("reasoning_effort", &value, Duration::from_secs(20))
                        .map_err(|error| error.message)?;
                }
            }
            Some(_) => {
                return Err(format!(
                    "dsh did not advertise effort {effort} for {label}; option unavailable."
                ));
            }
            None if reasoning => {
                return Err(format!(
                    "dsh did not advertise reasoning effort for {label}; option unavailable."
                ));
            }
            None => {}
        }
    }
    Ok(())
}

fn turn_allowed(selection_ready: bool) -> bool {
    selection_ready
}

fn persist_selection(effective: &config::EffectiveConfig) -> io::Result<()> {
    models::save_selection(
        &effective.grok_home,
        effective.default_model.as_deref().unwrap_or(""),
        effective.default_effort.as_deref(),
    )
}

fn handle_slash_command(
    command: models::Command,
    effective: &mut config::EffectiveConfig,
    client: Option<&mut AcpClient>,
    inflight: bool,
) -> Result<String, String> {
    let catalog = effective.catalog();
    let current = effective.default_model.clone();
    match command {
        models::Command::Model {
            query: None,
            effort: None,
        } => Ok(models::menu_text(&catalog, current.as_deref())),
        models::Command::Model { query, effort } => {
            let query = query.ok_or_else(|| models::menu_text(&catalog, current.as_deref()))?;
            let choice = models::resolve_model_query(&catalog, &query)?.clone();
            let effort = match effort {
                Some(value) => Some(models::resolve_effort(&choice, &value)?),
                None => effective
                    .default_effort
                    .clone()
                    .filter(|_| choice.reasoning),
            };
            apply_catalog_choice(effective, client, &choice, effort.as_deref(), inflight)
        }
        models::Command::Effort { query: None } => {
            let current_choice = current
                .as_ref()
                .and_then(|id| catalog.iter().find(|choice| choice.id == *id));
            Ok(models::effort_menu_text(
                current_choice,
                effective.default_effort.as_deref(),
            ))
        }
        models::Command::Effort { query: Some(value) } => {
            let choice = current
                .as_ref()
                .and_then(|id| catalog.iter().find(|choice| choice.id == *id))
                .ok_or_else(|| "No active model. Use /model first.".to_string())?
                .clone();
            let effort = models::resolve_effort(&choice, &value)?;
            apply_catalog_choice(effective, client, &choice, Some(&effort), inflight)
        }
        models::Command::Login => {
            let flags = auth::LoginFlags::default();
            auth::run_login(
                &effective.grok_home,
                &std::env::vars().collect(),
                &effective.auth,
                &flags,
                &effective.merged_table,
            )
        }
        models::Command::Logout => auth::run_logout(
            &effective.grok_home,
            &std::env::vars().collect(),
            &effective.dsh_home,
        ),
        models::Command::Context | models::Command::Compact { .. } => Err(
            "internal slash routing: /context and /compact are handled by the live session".into(),
        ),
        models::Command::Feedback { .. } => {
            Err("internal slash routing: /feedback is handled by the live session".into())
        }
    }
}

fn apply_catalog_choice(
    effective: &mut config::EffectiveConfig,
    client: Option<&mut AcpClient>,
    choice: &models::CatalogChoice,
    effort: Option<&str>,
    inflight: bool,
) -> Result<String, String> {
    if let Some(reason) = &choice.unavailable {
        return Err(format!("Model {} is unavailable: {reason}", choice.id));
    }
    effective.default_model = Some(choice.id.clone());
    effective.default_effort = effort.map(str::to_string);
    effective.unmatched_saved_model = None;
    effective.saved_acp_value = Some(choice.acp_value.clone());
    persist_selection(effective).map_err(|error| error.to_string())?;
    if let Some(client) = client {
        let model_option = client.config_option("model").cloned();
        let Some(option) = model_option else {
            return Err(format!(
                "dsh did not advertise model options; {} was saved locally only. No silent provider fallback.",
                choice.id
            ));
        };
        if !option
            .choices
            .iter()
            .any(|item| item.value == choice.acp_value)
        {
            return Err(format!(
                "dsh did not advertise {} ({} / {}, api={}); no silent provider fallback.",
                choice.id, choice.provider, choice.model, choice.api
            ));
        }
        if option.current.as_deref() != Some(choice.acp_value.as_str()) {
            client
                .set_config_option("model", &choice.acp_value, Duration::from_secs(20))
                .map_err(|error| error.message)?;
        }
        if let Some(effort) = effort {
            let effort_option = client.config_option("reasoning_effort").cloned();
            let Some(option) = effort_option else {
                return Err(format!(
                    "Model {} does not advertise reasoning effort; {effort} is unavailable.",
                    choice.id
                ));
            };
            let value = option
                .choices
                .iter()
                .find(|item| item.value == effort || item.name.eq_ignore_ascii_case(effort))
                .map(|item| item.value.clone())
                .ok_or_else(|| {
                    format!(
                        "Unsupported effort {effort} for {}. Available: {}.",
                        choice.id,
                        option
                            .choices
                            .iter()
                            .map(|item| item.value.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })?;
            if option.current.as_deref() != Some(value.as_str()) {
                client
                    .set_config_option("reasoning_effort", &value, Duration::from_secs(20))
                    .map_err(|error| error.message)?;
            }
        }
    }
    let when = if inflight {
        "applies to the next turn"
    } else {
        "saved and active"
    };
    let vision = if images::model_accepts_images(Some(&choice.input_modalities)) {
        "vision=image"
    } else {
        "vision=text-only"
    };
    Ok(format!(
        "Selected {} / {} api={} effort={} {vision} ({when}).",
        choice.provider,
        choice.model,
        choice.api,
        effort.unwrap_or("unavailable")
    ))
}

fn activate_filesystem_sandbox(
    launch: &Launch,
) -> io::Result<Option<filesystem_sandbox::Prepared>> {
    // Same loader as inspect: signed requirements, folder trust, and
    // GROK_CONFIG / GROK_CONFIG_PATH. A line scan of config.toml cannot see
    // those layers. This reads files only; it does not run project code.
    let loaded = load_runtime_config(launch);
    if loaded.errors.iter().any(|error| {
        error
            .path
            .as_ref()
            .is_some_and(|path| path.ends_with("requirements.toml"))
            || error.reason.contains("cannot be verified")
            || error.reason.contains("unknown security")
            || error.reason.contains("`sandbox`")
    }) {
        return Err(io::Error::other(loaded.first_run_message()));
    }
    let requested = loaded.sandbox_profile.clone();
    let dsh_home = std::env::var_os("DSH_HOME").map(PathBuf::from);
    let prepared = filesystem_sandbox::prepare(
        &requested,
        &loaded.cwd,
        &loaded.grok_home,
        dsh_home.as_deref(),
        loaded.workspace_trusted,
    )
    .map_err(|error| io::Error::other(error.message))?;
    // The report is written before the irreversible policy so a report path
    // outside the profile is not itself a confinement failure.
    if let Some(path) = &launch.sandbox_report {
        let body = serde_json::json!({
            "applied": prepared.is_some(),
            "profile": requested,
            "profileSource": loaded.sandbox_profile_source,
            "mechanism": prepared.as_ref().map(|item| item.mechanism.clone()),
            "platform": std::env::consts::OS,
            "summary": filesystem_sandbox::status_line(prepared.as_ref()),
            "writeRoots": prepared.as_ref().map(|item| item.write_roots.clone()).unwrap_or_default(),
            "readDenied": prepared.as_ref().map(|item| item.read_denied.clone()).unwrap_or_default(),
            "readDeniedGlobs": prepared
                .as_ref()
                .map(|item| {
                    item.read_denied_globs
                        .iter()
                        .map(|glob| glob.pattern.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            "writeDenied": prepared.as_ref().map(|item| item.write_denied.clone()).unwrap_or_default(),
            "denyTail": match prepared.as_ref() {
                Some(item) => filesystem_sandbox::deny_tail(item)
                    .map_err(|error| io::Error::other(error.message))?,
                None => String::new(),
            },
            "limits": prepared.as_ref().map(|item| item.limits.clone()).unwrap_or_default(),
            "network": prepared.as_ref().map(|item| item.network_note.clone()),
            "networkRules": prepared.as_ref().map(filesystem_sandbox::network_profile_rules).transpose()
                .map_err(|error| io::Error::other(error.message))?,
            "restrictNetwork": prepared.as_ref().is_some_and(|item| item.restrict_network),
            "shellEnvironmentFiltered": prepared
                .as_ref()
                .is_some_and(|item| item.shell_env.is_some()),
        });
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, format!("{body}\n"))?;
    }
    if let Some(prepared) = &prepared {
        for warning in &prepared.limits {
            if warning.contains("user and project sandbox.toml disagree") {
                eprintln!("codsh: {warning}");
            }
        }
        filesystem_sandbox::apply(prepared).map_err(|error| io::Error::other(error.message))?;
    }
    Ok(prepared)
}

fn plain_blocks(prompt: &PlainPrompt) -> io::Result<Vec<Value>> {
    match prompt {
        PlainPrompt::Text(text) => {
            if text.trim().is_empty() {
                return Err(io::Error::other("plain prompt is empty"));
            }
            Ok(vec![serde_json::json!({ "type": "text", "text": text })])
        }
        PlainPrompt::File(path) => {
            let text = std::fs::read_to_string(path).map_err(|error| {
                io::Error::other(format!(
                    "couldn't read prompt file {}: {error}",
                    path.display()
                ))
            })?;
            if text.trim().is_empty() {
                return Err(io::Error::other(format!(
                    "prompt file {} is empty",
                    path.display()
                )));
            }
            Ok(vec![serde_json::json!({ "type": "text", "text": text })])
        }
        PlainPrompt::Json(raw) => {
            let parsed: Value = serde_json::from_str(raw).map_err(|error| {
                io::Error::other(format!("--prompt-json is not JSON content blocks: {error}"))
            })?;
            let blocks = match parsed {
                Value::Array(items) => items,
                Value::Object(_) => vec![parsed],
                _ => {
                    return Err(io::Error::other(
                        "--prompt-json must be one content block or an array of content blocks",
                    ));
                }
            };
            if blocks.is_empty() {
                return Err(io::Error::other("--prompt-json has no content blocks"));
            }
            for block in &blocks {
                let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
                if kind != "text" || !block.get("text").and_then(Value::as_str).is_some() {
                    return Err(io::Error::other(
                        "--prompt-json only accepts text content blocks on this plain command",
                    ));
                }
            }
            Ok(blocks)
        }
    }
}

fn plain_tool_env(tools: &Option<PlainTools>) -> Option<(String, String)> {
    let Some(PlainTools::Filter { allow, deny }) = tools else {
        return None;
    };
    let mut clauses = Vec::new();
    if let Some(names) = allow.as_ref().filter(|names| !names.is_empty()) {
        clauses.push(format!("allow:{}", names.join(",")));
    }
    if let Some(names) = deny.as_ref().filter(|names| !names.is_empty()) {
        clauses.push(format!("deny:{}", names.join(",")));
    }
    if clauses.is_empty() {
        return None;
    }
    Some(("CODSH_PLAIN_TOOLS".into(), clauses.join(";")))
}

/// The plain mask and step bound for the dsh child. A flag wins over a value
/// inherited from a parent process. Interactive modes pass neither, so a
/// parent's CODSH_PLAIN_TOOLS or CODSH_PLAIN_MAX_TURNS never shapes the TUI.
fn plain_env(mode: &LaunchMode, inherited: &[(String, String)]) -> Vec<(String, String)> {
    let LaunchMode::Plain {
        max_turns, tools, ..
    } = mode
    else {
        return Vec::new();
    };
    let parent = |key: &str| {
        inherited
            .iter()
            .find(|(name, value)| name == key && !value.is_empty())
            .map(|(name, value)| (name.clone(), value.clone()))
    };
    let mut env = Vec::new();
    if let Some(filter) = plain_tool_env(tools).or_else(|| parent("CODSH_PLAIN_TOOLS")) {
        env.push(filter);
    }
    if let Some(bound) = max_turns
        .map(|bound| ("CODSH_PLAIN_MAX_TURNS".to_string(), bound.to_string()))
        .or_else(|| parent("CODSH_PLAIN_MAX_TURNS"))
    {
        env.push(bound);
    }
    env
}

struct PlainStop {
    code: i32,
    message: String,
}

fn plain_failure_message(dsh_home: &Path) -> String {
    let log = dsh_home.join("acp-stderr.log");
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let detail = text
        .lines()
        .rev()
        .find(|line| {
            line.contains("plain tool filter")
                || line.contains("tools.restrict")
                || line.contains("--max-turns")
        })
        .unwrap_or("dsh cancelled the plain turn before producing an answer");
    detail.to_string()
}

fn plain_exit(stop: &PlainStop) -> io::Result<()> {
    if stop.code == 0 {
        return Ok(());
    }
    if !stop.message.is_empty() {
        eprintln!("{}", stop.message);
    }
    std::process::exit(stop.code);
}

/// Paths typed beside the invocation stay there when `--cwd` later moves the
/// process. Upstream `apply_cwd` anchors only the debug file and the leader
/// socket this way. `--prompt-file` is not one of them: it is opened after
/// `set_current_dir`, so a relative path names a file inside `--cwd`.
fn anchor_input_paths(launch: &mut Launch, base: &Path) {
    let anchor = |path: &mut PathBuf| {
        if path.is_relative() {
            *path = base.join(&*path);
        }
    };
    for path in [
        &mut launch.cwd,
        &mut launch.sandbox_report,
        &mut launch.sandbox_probe,
        &mut launch.sandbox_cancel,
        &mut launch.trust_folder,
    ]
    .into_iter()
    .flatten()
    {
        anchor(path);
    }
    match &mut launch.mode {
        LaunchMode::Inspect {
            debug_file: Some(path),
            ..
        }
        | LaunchMode::Logout {
            debug_file: Some(path),
            ..
        }
        | LaunchMode::Completions {
            debug_file: Some(path),
            ..
        } => anchor(path),
        _ => {}
    }
}

fn enter_cwd(path: &Path) -> io::Result<()> {
    let target = path.canonicalize().map_err(|error| {
        io::Error::other(format!("couldn't use --cwd {}: {error}", path.display()))
    })?;
    if !target.is_dir() {
        return Err(io::Error::other(format!(
            "--cwd {} is not a directory",
            path.display()
        )));
    }
    std::env::set_current_dir(&target)
}

/// The exit code a caught signal maps to, or 0. 130 and 143 stay distinct.
fn plain_signal(interrupt: &AtomicBool, terminate: &AtomicBool) -> i32 {
    if terminate.load(Ordering::Relaxed) {
        143
    } else if interrupt.load(Ordering::Relaxed) {
        130
    } else {
        0
    }
}

/// One prompt, one dsh ACP session, then exit. Stdout is the final answer.
/// Tool cards and thoughts stay off stdout. A signal cancels the dsh turn.
fn run_plain(launch: &Launch, plain: &LaunchMode) -> io::Result<()> {
    let interrupt = Arc::new(AtomicBool::new(false));
    let terminate = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        // Registered before config and connect, so a signal during startup
        // still exits 130/143. The launcher also forwards the signal.
        signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&interrupt))?;
        signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&terminate))?;
    }
    let result = run_plain_turn(launch, plain, &interrupt, &terminate);
    // A signal that lands while dsh starts or connects can surface as a
    // connect error. The caller asked to stop; report the signal, not "failed".
    let signal = plain_signal(&interrupt, &terminate);
    if result.is_err() && signal != 0 {
        eprintln!("interrupted by signal {signal}");
        let _ = io::stdout().flush();
        std::process::exit(signal);
    }
    result
}

fn run_plain_turn(
    launch: &Launch,
    plain: &LaunchMode,
    interrupt: &AtomicBool,
    terminate: &AtomicBool,
) -> io::Result<()> {
    let LaunchMode::Plain { prompt, resume, .. } = plain else {
        return Err(io::Error::other("plain mode was not selected"));
    };
    let blocks = plain_blocks(prompt)?;
    let mut effective = load_runtime_config(launch);
    effective.permission.interactive = false;
    if let Some(session_id) = known_resume_session(&session_mode(plain), &effective) {
        apply_saved_session_mode(&mut effective, Some(session_id.as_str()))
            .map_err(io::Error::other)?;
    }
    let applied = runtime_apply(&effective);
    if applied.apply_failed {
        return Err(io::Error::other(applied.error));
    }
    if !can_execute(&effective, applied.apply_failed) {
        return Err(io::Error::other(effective.first_run_message()));
    }
    let mut extra_env = applied.extra_env;
    // A plain turn has no Ctrl+B and nothing to wake: dsh's own foreground
    // path runs each command to its timeout.
    extra_env.retain(|(key, _)| key != "CODSH_BASH_POLICY");
    // Nor anything to fire a scheduled prompt: the turn ends first, so dsh
    // offers no scheduler tools here.
    extra_env.retain(|(key, _)| key != "CODSH_SCHEDULER");
    extra_env.extend(background::dsh_env(&config::bash_policy(&effective), true));
    // Nothing is left to report a background workflow to once the plain turn
    // ends, so the workflow tool waits for its run here (ticket 183).
    extra_env.push(("CODSH_WORKFLOW_FOREGROUND".into(), "1".into()));
    let inherited: Vec<(String, String)> = std::env::vars().collect();
    extra_env.extend(plain_env(plain, &inherited));
    let session_mode = session_mode(plain);
    let (mut connection, _) = connect(
        &session_mode,
        None,
        &extra_env,
        applied.patch.as_ref(),
        launch.fork_session,
        launch.child_id.as_deref(),
    )
    .map_err(io::Error::other)?;
    attach_worktree_session(&connection.client);
    if let Some(created) = worktree::active() {
        eprintln!("{}", worktree::start_notice(created));
    }
    if let Err(error) = apply_live_selection(&mut connection.client, &effective) {
        connection.client.shutdown();
        return Err(io::Error::other(error));
    }
    for notice in mcp_notices(&connection.client) {
        eprintln!("{notice}");
    }
    // A signal that arrived while dsh started or connected is honored before
    // the prompt goes out, so no model request starts for an abandoned turn.
    let signal = plain_signal(interrupt, terminate);
    if signal != 0 {
        connection.client.shutdown();
        eprintln!("interrupted by signal {signal}");
        let _ = io::stdout().flush();
        std::process::exit(signal);
    }
    // Memory joins the first prompt of a new session, as in the TUI.
    let blocks = blocks_with_model_prompt(launch, &effective, blocks, None, resume.is_none());
    if let Err(error) = connection.client.submit_prompt_blocks(&blocks) {
        connection.client.shutdown();
        return Err(io::Error::other(error.message));
    }
    let model = launch
        .model
        .clone()
        .or_else(|| effective.default_model.clone())
        .unwrap_or_default();
    let permission_mode = if launch.always_approve {
        "always-approve".to_string()
    } else {
        launch
            .permission_mode
            .clone()
            .unwrap_or_else(|| "ask".to_string())
    };
    let mut output = headless::HeadlessOutput::new(
        launch.output_format,
        launch.include_partial_messages,
        connection.client.session_id.clone().unwrap_or_default(),
        effective.cwd.display().to_string(),
        model,
        permission_mode,
    );
    let mut stop = PlainStop {
        code: 0,
        message: String::new(),
    };
    // No wall-clock cap: the turn ends when dsh finishes, errors, or
    // disconnects, or when a signal arrives. The reference has no time limit.
    loop {
        let signal = plain_signal(interrupt, terminate);
        if signal != 0 {
            let _ = connection.client.cancel_prompt();
            // One more pump so a cancel settlement can name the stop reason.
            // The process still exits on the signal and does not wait forever.
            let settle = Instant::now() + Duration::from_millis(400);
            while Instant::now() < settle {
                let events = connection.client.pump(Duration::from_millis(50));
                let mut settled = false;
                for event in &events {
                    output.on_event(event);
                    if matches!(
                        event,
                        AcpEvent::PromptFinished { .. } | AcpEvent::Disconnected { .. }
                    ) {
                        settled = true;
                    }
                }
                if settled {
                    break;
                }
            }
            connection.client.shutdown();
            let message = format!("interrupted by signal {signal}");
            output.fail(&message);
            output.finish(true, &message);
            let _ = io::stdout().flush();
            eprintln!("{message}");
            std::process::exit(signal);
        }
        let events = connection.client.pump(Duration::from_millis(50));
        let mut finished = false;
        for event in events {
            output.on_event(&event);
            match event {
                AcpEvent::Answer { .. }
                | AcpEvent::Thought { .. }
                | AcpEvent::ToolCall { .. }
                | AcpEvent::ToolCallUpdate { .. }
                | AcpEvent::Usage { .. }
                | AcpEvent::ConfigOptions { .. }
                | AcpEvent::PermissionCancelled { .. }
                | AcpEvent::Subagent { .. }
                | AcpEvent::Job { .. }
                | AcpEvent::Schedule { .. }
                | AcpEvent::Goal { .. }
                | AcpEvent::Stderr { .. } => {}
                AcpEvent::PermissionRequest {
                    request_id,
                    options,
                    ..
                } => {
                    // No TTY means no approval prompt. Reject stays inside dsh.
                    let option = options
                        .iter()
                        .find(|choice| choice.option_id == "reject-once")
                        .or_else(|| options.first());
                    if let Some(choice) = option {
                        let _ = connection
                            .client
                            .answer_permission(&request_id, &choice.option_id);
                    }
                }
                AcpEvent::PromptFinished { stop_reason, .. } => {
                    finished = true;
                    if stop_reason == "max_tokens" || stop_reason == "max_turn_requests" {
                        stop = PlainStop {
                            code: 1,
                            message: format!("dsh stopped the plain turn: {stop_reason}"),
                        };
                    } else if stop.code == 0 && stop_reason != "end_turn" && stop_reason != "end" {
                        if stop_reason == "cancelled" || stop_reason.is_empty() {
                            let signal = plain_signal(interrupt, terminate);
                            stop = if signal == 0 {
                                PlainStop {
                                    code: 1,
                                    message: plain_failure_message(&effective.dsh_home),
                                }
                            } else {
                                PlainStop {
                                    code: signal,
                                    message: format!("interrupted by signal {signal}"),
                                }
                            };
                        } else {
                            stop = PlainStop {
                                code: 1,
                                message: format!("dsh stopped the plain turn: {stop_reason}"),
                            };
                        }
                    }
                }
                AcpEvent::RpcError { message, .. } => {
                    finished = true;
                    if stop.code == 0 {
                        stop = PlainStop { code: 1, message };
                    }
                }
                AcpEvent::ProtocolMismatch { version } => {
                    finished = true;
                    stop = PlainStop {
                        code: 1,
                        message: format!("ACP protocol mismatch: agent {version}"),
                    };
                }
                AcpEvent::Disconnected { detail } => {
                    finished = true;
                    if stop.code == 0 {
                        stop = PlainStop {
                            code: 1,
                            message: detail,
                        };
                    }
                }
            }
        }
        if finished {
            // An empty answer is a failure on every format. A tool that ran
            // and a model that then said nothing is still an empty answer.
            if stop.code == 0 && output.rejected() {
                stop = PlainStop {
                    code: 1,
                    message: "non-interactive approval rejected the tool call".into(),
                };
            } else if stop.code == 0 {
                // --max-turns cancels inside dsh. The ACP reason can still be
                // end_turn after a tool ran. The stderr line is the stop.
                let detail = plain_failure_message(&effective.dsh_home);
                if detail.contains("--max-turns") {
                    stop = PlainStop {
                        code: 1,
                        message: detail,
                    };
                }
            }
            if stop.code == 0 && output.text().trim().is_empty() && !output.has_tool_call() {
                stop = PlainStop {
                    code: 1,
                    message: plain_failure_message(&effective.dsh_home),
                };
            }
            break;
        }
    }
    connection.client.shutdown();
    let failed = stop.code != 0;
    if failed && stop.message.is_empty() {
        stop.message = plain_failure_message(&effective.dsh_home);
    }
    if stop.message.contains("--max-turns") {
        output.mark_max_turns();
    }
    output.finish(failed, &stop.message);
    plain_exit(&stop)
}

/// Wait for the probe. `cancel` is a path the caller creates to end the
/// session: the probe's process group is killed and this returns an error.
/// The group id is the child's pid because it was spawned with
/// `process_group(0)`. A wait error kills the group before returning.
fn wait_probe(
    child: &mut std::process::Child,
    cancel: Option<&Path>,
) -> io::Result<std::process::ExitStatus> {
    let pid = child.id();
    loop {
        if cancel.is_some_and(|path| path.exists()) {
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other(
                "sandbox probe cancelled; its process group was killed",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(error) => {
                kill_group(pid);
                return Err(error);
            }
        }
    }
}

fn kill_group(pid: u32) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

/// The session id `-w -r/-c` forks, resolved in the source directory.
fn worktree_resume_source(mode: &LaunchMode, dsh_home: &Path) -> io::Result<Option<String>> {
    let cwd = std::env::current_dir()?;
    let wanted = match mode {
        LaunchMode::Resume(id)
        | LaunchMode::Plain {
            resume: Some(PlainResume::Id(id)),
            ..
        } => Some(id.clone()),
        LaunchMode::Continue
        | LaunchMode::Plain {
            resume: Some(PlainResume::Continue),
            ..
        } => {
            let last = session_owner::read_last_session(dsh_home).filter(|(_, last_cwd)| {
                last_cwd.canonicalize().unwrap_or_else(|_| last_cwd.clone())
                    == cwd.canonicalize().unwrap_or_else(|_| cwd.clone())
            });
            return match last {
                Some((id, _)) => Ok(Some(id)),
                None => Err(io::Error::other(
                    "-w --continue found no previous session in this directory; use -w -r <session-id>",
                )),
            };
        }
        _ => None,
    };
    let Some(wanted) = wanted else {
        return Ok(None);
    };
    if session_catalog::is_uuid(&wanted) {
        return Ok(Some(wanted));
    }
    let catalog = session_catalog::load_catalog(dsh_home, &cwd);
    session_catalog::resolve_resume(&catalog.sessions, &wanted, &cwd)
        .map(|found| Some(found.session.id))
        .map_err(|error| io::Error::other(error.message))
}

/// `-w [NAME]` (ticket 174): create the worktree, fork a resumed session
/// into it under a new id, and enter it. Nothing is created when the
/// source is not a git checkout; a failed fork removes the new worktree.
fn enter_worktree(launch: &mut Launch) -> io::Result<()> {
    if matches!(launch.mode, LaunchMode::Help | LaunchMode::Version) {
        return Ok(());
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let dsh_home =
        PathBuf::from(std::env::var_os("DSH_HOME").unwrap_or_else(|| home.join("dsh").into()));
    let source_session = worktree_resume_source(&launch.mode, &dsh_home)?;
    let pool = worktree::pool(&worktree::early_grok_home());
    let source = std::env::current_dir()?;
    let created = worktree::create(&pool, &source, &launch.worktree)
        .map_err(|error| io::Error::other(format!("-w/--worktree: {error}")))?;
    if let Some(source_session) = source_session {
        let forked = session_fork::fork_conversation_in(
            &dsh_home,
            &source_session,
            None,
            launch.child_id.as_deref(),
            Some(&created.session_cwd),
        );
        let forked = match forked {
            Ok(forked) => forked,
            Err(error) => {
                worktree::discard(&pool, &created.id);
                return Err(io::Error::other(format!(
                    "-w/--worktree: cannot fork session {source_session} into the worktree ({}); the new worktree was removed",
                    error.message
                )));
            }
        };
        launch.mode = match std::mem::replace(&mut launch.mode, LaunchMode::New) {
            LaunchMode::Plain {
                prompt,
                max_turns,
                tools,
                ..
            } => LaunchMode::Plain {
                prompt,
                max_turns,
                tools,
                resume: Some(PlainResume::Id(forked.session_id.clone())),
            },
            _ => LaunchMode::Resume(forked.session_id.clone()),
        };
        launch.fork_session = false;
        launch.child_id = None;
    }
    enter_cwd(&created.session_cwd)?;
    worktree::set_active(created);
    Ok(())
}

fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut launch = parse_launch(&args)?;
    // -w moves the process like --cwd, so the same paths stay anchored.
    if launch.cwd.is_some() || launch.worktree.requested() {
        let invoked = std::env::current_dir()?;
        anchor_input_paths(&mut launch, &invoked);
    }
    let mut mode = launch.mode.clone();
    let help_like = matches!(
        mode,
        LaunchMode::Help
            | LaunchMode::Version
            | LaunchMode::Inspect { help: true, .. }
            | LaunchMode::Login { help: true, .. }
            | LaunchMode::Logout { help: true, .. }
            | LaunchMode::Setup { help: true, .. }
            | LaunchMode::Plugin(plugin::PluginCommand::Help)
            | LaunchMode::Feedback(privacy_cmd::FeedbackCommand::Help)
            | LaunchMode::AgentShared(shared_server::AgentCommand::Help(_))
            | LaunchMode::Leader(_)
            | LaunchMode::Mcp(mcp::McpInvocation {
                command: mcp::McpCommand::Help(_),
                ..
            })
    );
    for warning in &launch.warnings {
        eprintln!("{warning}");
    }
    if !help_like {
        // --cwd comes first: config, trust, the sandbox write roots, the
        // session catalog, and dsh all read the process directory.
        if let Some(path) = &launch.cwd {
            enter_cwd(path)?;
        }
        // -w comes next: the worktree is created from the directory the user
        // is in (after --cwd), then entered the same way, so config, trust,
        // the sandbox, sessions, and dsh all see the worktree.
        if launch.worktree.requested() {
            enter_worktree(&mut launch)?;
            mode = launch.mode.clone();
        }
    }
    // inspect reads config and prints every diagnostic. It starts no dsh child
    // and runs no project code, so the sandbox precheck must not replace that
    // report with the first config error.
    if !help_like && !matches!(mode, LaunchMode::Inspect { .. }) {
        activate_filesystem_sandbox(&launch)?;
        // The filter does not need a kernel profile. `off` still gives dsh
        // the filtered map; no policy leaves the launch allowlist.
        let loaded = load_runtime_config(&launch);
        filesystem_sandbox::activate_shell_env(
            &loaded.cwd,
            &loaded.grok_home,
            loaded.workspace_trusted,
        )
        .map_err(|error| io::Error::other(error.message))?;
    }
    if let Some(script) = &launch.sandbox_probe {
        let mut command = std::process::Command::new("python3");
        command.arg(script);
        // The probe is one shell child the profile describes. The same
        // filtered map is what dsh receives at spawn. An unfiltered profile
        // still sees the launch environment.
        if let Some(filtered) = filesystem_sandbox::shell_env() {
            command.env_clear();
            command.envs(filtered);
        }
        // Own group, so a disconnect or a failed wait kills the probe and
        // the grandchildren it started, not only this python pid.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|error| io::Error::other(format!("sandbox probe failed to start: {error}")))?;
        let status = wait_probe(&mut child, launch.sandbox_cancel.as_deref())?;
        if !status.success() {
            return Err(io::Error::other(format!("sandbox probe exited {status}")));
        }
        return Ok(());
    }
    match &mode {
        LaunchMode::Version => {
            println!(
                "codsh-rust {} (dsh ACP; upstream a28ee2b; reference 1.0.34)",
                env!("CARGO_PKG_VERSION")
            );
            return Ok(());
        }
        LaunchMode::Feedback(command) => {
            if matches!(command, privacy_cmd::FeedbackCommand::Help) {
                println!("{}", privacy_cmd::help_text());
                return Ok(());
            }
            let loaded = load_runtime_config(&launch);
            let policy = privacy::PrivacyPolicy::from_config(&loaded);
            let log_path = privacy_cmd::debug_log_path(&loaded.dsh_home);
            match privacy_cmd::run(command, &loaded.dsh_home, &policy, log_path.as_deref()) {
                Ok(message) => {
                    println!("{message}");
                    return Ok(());
                }
                Err(error) => {
                    return Err(io::Error::other(error.to_string()));
                }
            }
        }
        LaunchMode::Voice { help: true, .. } => {
            println!("{}", voice_help());
            return Ok(());
        }
        LaunchMode::Completions {
            help: true,
            debug,
            debug_file,
            ..
        } => {
            let text = completions_help();
            if *debug || debug_file.is_some() {
                eprintln!("completions help");
                if let Some(path) = debug_file {
                    std::fs::write(path, "completions help\n")?;
                }
            }
            println!("{text}");
            return Ok(());
        }
        LaunchMode::Completions {
            shell: Some(shell),
            debug,
            debug_file,
            ..
        } => {
            let script = completion_script(shell);
            if script.is_empty() {
                return Err(usage_error(format!(
                    "invalid value '{shell}' for 'completions <SHELL>'\n  [possible values: bash, elvish, fish, powershell, zsh]"
                )));
            }
            if *debug || debug_file.is_some() {
                let note = format!("completions shell={shell}\n");
                eprint!("{note}");
                if let Some(path) = debug_file {
                    std::fs::write(path, note)?;
                }
            }
            print!("{script}");
            if !script.ends_with('\n') {
                println!();
            }
            return Ok(());
        }
        LaunchMode::Voice { json, .. } => {
            let loaded = load_runtime_config(&launch);
            let report = voice::diagnose(&std::env::vars().collect());
            if *json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report.json_value())
                        .unwrap_or_else(|_| "{}".into())
                );
            } else {
                println!("{}", voice::doctor_text(&loaded.voice, &report));
            }
            return Ok(());
        }
        LaunchMode::Web { help: true, .. } => {
            println!("{}", web_help());
            return Ok(());
        }
        LaunchMode::Web { kind, json, .. } => {
            let loaded = load_runtime_config(&launch);
            return run_web(kind, *json, &loaded);
        }
        LaunchMode::Agent { help: true } => {
            println!("{}", editor_agent_help());
            return Ok(());
        }
        LaunchMode::Agent { help: false } => {
            return run_agent(
                &launch,
                shared_server::AgentCommand::Stdio {
                    leader: None,
                    socket: None,
                },
            );
        }
        LaunchMode::AgentShared(command) => {
            return run_agent(&launch, command.clone());
        }
        LaunchMode::Worktree(words) => {
            let loaded = load_runtime_config(&launch);
            if !worktree::public_command(words.first().map(String::as_str)) {
                return Err(usage_error(format!(
                    "unrecognized subcommand '{}'; use codsh --rust worktree help",
                    words.first().map(String::as_str).unwrap_or_default()
                )));
            }
            let code = worktree::run_cli(&worktree::pool(&loaded.grok_home), words)?;
            if code != 0 {
                std::process::exit(code);
            }
            return Ok(());
        }
        LaunchMode::Leader(command) => {
            let loaded = load_runtime_config(&launch);
            let code = shared_server::run_leader_command(command.clone(), &loaded.grok_home)?;
            if code != 0 {
                std::process::exit(code);
            }
            return Ok(());
        }
        LaunchMode::Help => {
            let summary = args.iter().any(|arg| arg == "-h");
            if summary {
                println!("{}", short_help());
                return Ok(());
            }
            println!(
                "codsh --rust\n\nIsolated Rust client. Real dsh executes turns over ACP/JSON-RPC stdio.\nHome: ~/.codsh-rust/dsh; Profile: rust. Legacy codsh is unchanged.\nUser config: $GROK_HOME/config.toml (default ~/.codsh-rust/.grok/config.toml), mapped into isolated dsh settings.yaml.\nManaged defaults: $GROK_HOME/managed_config.toml. Locked requirements: $GROK_HOME/requirements.toml (cannot be bypassed by later CLI, environment, overlay, workspace, or user values).\n`codsh --rust inspect` / `inspect --json` shows effective values, origins, folder trust, appearance/theme/status-line, marketplace sources, installed plugin provenance, and whether project assets are active. It does not apply a filesystem sandbox, so every config error is printed (including the resolved sandbox profile) instead of stopping at the first one. Invalid config.toml is left unchanged and reports its path. Unknown security fields and invalid policies are diagnosed with valid values, sources, and limits.\n`codsh --rust import --preview` lists conversions, conflicts, and unsupported items from current dsh `$DSH_HOME/settings.yaml`, `code-cli-thinking.json`, and `code-cli-ui.json`. It does not treat outdated `code-cli-settings.json` as a provider source. `--apply` copies selected providers/preferences into the isolated Home. Official tokens, `.credentials.yaml`, `.env`, and original trust/execution grants are never copied. Preview, cancel, and failed apply leave source files and existing isolated settings unchanged. Model credentials stay in the host environment (`--authorize-env`) or must be exported after import.\nWorkspace trust: untrusted folders prompt before applying project config, Hooks, plugins, or instructions; `--trust` / `--trust-folder [path]` saves a grant, `--revoke-trust` withdraws it. A read-only $GROK_HOME reports save failure without pretending the grant is durable. Untrusted Hooks/plugins/project capabilities do not execute.\nPlugin lifecycle: `codsh --rust plugin marketplace add|list|update|remove` and `plugin install|update|uninstall|list` record sources, versions, licenses, and files under the isolated Home. Install does not grant execution. `plugin enable|disable` (or Space in /plugins) adds or withdraws an installed, trusted plugin's rules, skills and commands (`/plugin:name`), agents, and command hooks through the same discovery and hook runner; a project plugin also needs workspace trust, enabling never grants tool permissions, and a live session picks the change up on its next prompt. Plugin MCP servers are not started. Failed download/checksum/conflict/offline/cancel leave no success record. Official marketplace auto-register is off unless GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER is enabled. `/plugins` and `/marketplace` open the plugins directory. Uninstall does not delete unrelated user files.\nFirst-run missing credentials stay local: no grok.com login, no default official telemetry, no automatic import of ~/.dsh or ~/.grok credentials. `login` / `logout` / `setup` use configured substitute identity or management services; official grok.com / auth.x.ai login, subscription billing, auto-topup, and team entitlements are not reproduced. Session tokens stay in $GROK_HOME/auth.json (0600) and are not transferred to model providers, MCP, Grove, or other services. Independent API-key use does not require login unless GROK_DISABLE_API_KEY_AUTH or a team pin (GROK_FORCE_LOGIN_TEAM_ID / requirements force_login_team_uuid) requires a matching identity session. Unsigned or unverifiable managed policy is refused.  /login and /logout reuse that contract.\nFile read/edit/write and other dsh tools honour allow/ask/deny rules, remembered project grants, and permission modes. y allows once; a remembers this project only and is not a permanent global rule; n rejects with no write. /revoke-approvals forgets this project's remembered grants. Deny, hooks, and locked always-approve survive --always-approve/--yolo. Trust prompt: y=allow, n=deny.\nCtrl+Q: quit. Ctrl+D quits except in fullscreen scrollback, where it half-pages. Ctrl+C: clear a draft; empty draft cancels a running turn via dsh, or quits when idle before any turn.\nEsc never cancels a turn or a pending approval; it dismisses selection and reminds you to use Ctrl+C.\nBackground commands: dsh owns every shell job. Ctrl+B moves the running foreground command to the background and the turn goes on. A command still running after [toolset.bash] foreground_block_budget_ms (default 15000; 0 waits for the full timeout) moves on its own; auto_background_on_timeout = false keeps it in the foreground and kills it at its timeout instead. Send-now while a command runs moves it rather than killing it. The status line counts running commands and subagents; while the model blocks on job_output it adds \"send a message to interrupt\", and any message you send ends that wait. Ctrl+G or /tasks lists commands with their latest output; x stops the selected one and the model is told at its next step. A finished command wakes an idle session with a \u{25ce} Task completed turn (dsh allows 3 wakes in a row without a message from you; later notices reach the model with your next prompt). /new, switching sessions, and quitting stop that session's commands; a resumed history says its commands are no longer running. Plain -p and editor ACP keep dsh's own foreground bash.\nScheduled prompts: /loop [interval] <prompt> (e.g. /loop 30m check the deploy) asks the model to call scheduler_create; it derives the interval from your words and asks when none is given. Each fire runs the stored prompt as an independent background subagent (general-purpose type, same permissions and approvals), never in this conversation; its final status comes back once and wakes an idle session like a finished command. Intervals are s/m/h/d with a 60-second minimum; at most 50 loops per session; a loop expires after 7 days; a fire is skipped while the previous one still runs. Each fire starts fresh with the previous fire's final status. Ctrl+G or /tasks lists loops with their next fire and last status; x deletes the selected loop (a fire already running finishes). Loops are saved with their session in $DSH_HOME/codsh-schedules/<session>.json (durable: true is accepted and means the same saved loop; it is refused only when this dsh has no session owner to save it to): quitting, a dsh restart, or a switch stops them, and resuming the session (--continue, --resume, /resume) restores them. A loop whose fires were missed while nothing ran fires once promptly, however many intervals were missed; a loop past its 7-day expiry is removed without firing; a fire that was running when its process ended is shown as outcome unknown and is never replayed, and the next fire is told to check the current state first. Only the client holding the session's owner lock saves and fires its loops, so a second client on the same session is refused and two processes never fire one loop (fires are not exactly-once); a loop that cannot save its deletion or expiry stays paused instead of coming back. Rows show saved, durable, or not saved, paused, the last fire's outcome, and permissions changed when the permission mode differs from the one the loop was created under (fires run under the current mode). With subagents disabled, saved loops are listed as paused and can be deleted, and no new loops are offered. Plain -p, editor ACP, and the shared server offer no scheduler and leave saved loops untouched; a fork or rewind starts without the loops.\nWhile a turn runs, Enter queues the draft (the notice shows Queued N and the next row); Enter on an empty prompt sends the top row now. Ctrl+Enter or Ctrl+I sends the draft (or the selected row) now: the running turn is cancelled through dsh without a [cancelled] marker and that row runs next. Apple Terminal also takes Ctrl+O; VS Code-family terminals (vscode, cursor, windsurf, zed) use Ctrl+L instead; Ctrl+Enter/Ctrl+I need a terminal that reports them distinctly (kitty keyboard protocol). Ctrl+; or Ctrl+' (or ↑ on an empty prompt) opens the queue pane: ↑↓ select, e edits in place (Enter saves, empty save removes, Esc cancels), Enter sends now, x/Del/Backspace deletes, Shift+J/K reorders, Esc closes. Queued rows run in order, one per turn, after the turn ends or is cancelled with Ctrl+C; a pending approval, compaction, or a row being edited keeps them waiting. Slash commands typed while busy queue as their own rows. [ui] follow_up_behavior = \"steer\" sends plain text follow-ups into the running dsh turn at its next model step instead; a steer dsh did not use goes back to the queue. [ui] combine_queued_prompts = true joins consecutive plain rows into one turn. /queue lists the queue. /btw <question> (also typed mid-message) asks a side question from the current session context with no tools; the answer shows in a panel that Esc dismisses (minimal prints it to scrollback), a late answer to a dismissed question is dropped, and nothing enters the conversation.\nEnter: submit prompt. Tab focuses scrollback in fullscreen when turns exist. /find searches the transcript, /jump lists turns, /vim-mode toggles scrollback Vim keys, and /toggle-mouse-reporting flips mouse capture when `[ui] mouse_reporting_toggle` is on in $GROK_HOME/config.toml. Esc closes search/jump/viewer and restores the prior reading position. Click selects or folds; drag copies and does not fold. Fullscreen-only /find and /jump refuse in minimal with the /fullscreen remedy. Shift+Enter or Alt+Enter inserts a newline; /multiline (alias /ml) or Ctrl+M swaps those chords. /history searches submitted prompts; empty ↑ browses them. Tab/Esc drive slash and HISTFILE completion. Typing / in a nonempty draft stashes that draft, runs the slash command, and restores it. /edit-prompt opens $VISUAL then $EDITOR then vi for an empty draft; Ctrl+G in minimal preserves the current draft. Saving an empty file clears without submitting. [ui] simple_mode=false enables prompt Vim (i/Esc/h/l/x). Next-prompt ghost text is not wired: the host does not call a suggestion provider, so Tab/Right do not accept ghost text. Suggestion rows stay blocked (PARITY-150-suggestions). chips=false does not mean an attachment was refused. /memory (alias /mem) browses local notes under $GROK_HOME/memory. Global notes apply to every project; workspace notes follow the Git origin (org/repo), so clones and worktrees of that repository share one directory and a different origin does not. The list is separate from the generated index. Enter previews a note read-only, / filters names and contents, y copies the path, x then x deletes only a session file, and t toggles memory for this session without rewriting config.toml; once this session's first prompt is already sent, toggling on reaches no prompt here, and /new drops the toggle and follows config.toml again rather than carrying it forward. MEMORY.md cannot be deleted, including a human note and a generated index. /new and a dashboard dispatch keep the configured provider, model, effort, permissions, and settings patch; they do not fall back to another provider. /remember [text] asks for confirmation before appending a note; n or Esc writes nothing. Empty /remember takes the next line as the note. Enabled memory injects those human notes into a session's first dsh prompt only. Memory stays off until [memory] enabled = true or GROK_MEMORY=1. --no-memory and GROK_MEMORY=0 hide /memory for the process and do not delete files. `codsh --rust memory clear` (--workspace default, --global, --all) deletes only the selected scope after --yes. Disabling memory never uploads notes. A damaged index is rebuilt from the notes and does not overwrite them. /voice starts dictation into the current draft and never submits it; /voice again, /voice stop, or Esc cancels or stops. Ctrl+Space and F8 follow [ui] voice_capture_mode (hold or toggle) when [ui] voice_keybind_enabled is true; /voice still works when that is false. Hold needs a key-release report. Audio goes only to [voice] api_base (or endpoints.xai_api_base_url) /audio/transcriptions. Official hosts are refused. [ui] voice_stt_language overrides [voice] language. /voice doctor and `codsh --rust voice doctor` list devices without recording. Missing devices report voice.no-input-device. Live microphone open is unverified on this host; CODSH_VOICE_FIXTURE supplies bytes for a real substitute route. Linux and Windows capture are unverified. /always-approve, /auto, /ask, /dontAsk, and /acceptEdits set the session mode unless requirements.toml locks always-approve off. /feedback opens Write and Drafts; Enter on Write sends, Ctrl+S saves locally, and /feedback <text> sends immediately. Draft text is posted only when privacy.share_content is on. /settings (/config) edits appearance, default screen mode, timestamps, compact mode, and status line. /theme (/t) previews fullscreen themes; Escape restores the previous theme without saving. /compact-mode and /timestamps toggle persisted [ui] keys. Minimal mode uses the terminal palette and refuses /theme. Status-line scripts run with a 10s timeout, cleared BASH_ENV/ENV, and process-group cleanup on exit. Locked requirements show their source and cannot be edited.\n/minimal and /fullscreen switch render mode in process without restarting dsh; --minimal/--fullscreen and GROK_SCREEN_MODE are session-scoped and do not rewrite [ui] screen_mode. /model (/m) and /effort select advertised catalog options; unsupported backends/efforts are refused, never treated as equivalent or silently swapped. /context shows dsh occupancy, advertised model limits, and heuristic buckets without fabricating zeros. /compact [instruction] runs dsh compaction (not a second history); optional instructions go only to the summarizer request (purpose=compaction). Automatic compaction uses session.auto_compact_threshold_percent / GROK_AUTO_COMPACT_THRESHOLD_PERCENT mapped to dsh thresholdRatio. GROK_COMPACTION_WALL_CLOCK_SECS bounds the operation; 0 disables that budget. Runtime changes apply to the next turn and persist under $GROK_HOME/model-selection.toml. export <id> [file] writes that session as Markdown and keeps stored messages, tool calls, and attachment paths; it does not claim secrets were removed. -c copies the same transcript. /export [file] does this for the current session. Extra arguments are rejected before any file is written. share <id> and /share post only to the selected endpoints.share_url, CODSH_SHARE_URL, or --url. A missing service, a redirect, a timeout, or an official grok.com, api.x.ai, or sentry host is an error and uploads nothing. Redirects are not followed. sessions delete <id> --yes, /delete, the resume picker, and dashboard Ctrl+X are blocked: released dsh persistence has no deletion operation, so nothing is removed. du and disk-usage report isolated-home sizes, largest first, with --json. They do not delete files. --continue resumes the last session in this directory; --resume <id> loads that dsh session. --fork-session with --resume/--continue copies conversation into a new session id. /rewind and /undo fork conversation-only history through dsh; files are not restored. /fork copies the current history into a new session. Idle empty Esc Esc opens rewind. A second client is refused while this process holds write ownership. Interrupted tools show [interrupted]/unknown and are not replayed.\nSubagents: dsh creates and runs every child. The subagent tool takes subagent_type: general-purpose (every parent tool), explore and plan (read, search, shell; no write or edit), [subagents.roles.<name>] (description, default_capability_mode read-only|read-write|execute|all, model, prompt_file under $GROK_HOME), and .grok/agents or $GROK_HOME/agents files (tools and model front matter). A type's capability becomes a dsh tool allow-list, so a removed tool is absent from the child's schema and refused if called; tools dsh cannot classify stay only in `all`. Children inherit the parent's permission mode, rules, hooks, and sandbox; a child cannot answer an approval, so an ask is rejected. [subagents.models] <type> = \"model\" and a role or agent model are checked before the child starts; a missing model starts nothing. [subagents] enabled / GROK_SUBAGENTS=0 / --no-subagents remove the tool. max_concurrent / GROK_MAX_CONCURRENT_SUBAGENTS (default 32, 0 becomes 1) counts running children per session; limit_behavior / GROK_SUBAGENT_LIMIT_BEHAVIOR queue (default) waits for a slot and fail refuses. max_depth / GROK_SUBAGENTS_MAX_DEPTH (default 1, below 1 becomes 1) caps nesting. [subagents.toggle] <type> = false hides a type. run_in_background returns a dsh job id; the model collects the result with job_output. The block reads Subagent running/started/queued and then completed, failed, or cancelled with the elapsed time; the status line counts children still running. Ctrl+G (fullscreen) or /tasks opens the task list: Enter or Ctrl+F opens a read-only child transcript, x cancels the selected child, h hides finished ones, Esc or q closes. In the child view Ctrl+C cancels that child only. Ctrl+C on the parent turn cancels its foreground children. Child sessions are not listed for resume. isolation: \"worktree\" runs the child in its own git worktree (see Worktrees); nothing is applied to the checkout. Messaging, resume_from, and --agent stay with later tickets. Workflows: the model's workflow tool runs a Rhai workflow script (inline, a <meta.name>.rhai file in this trusted project or $GROK_HOME/workflows, or a saved workflow by name) whose agent() and parallel() calls start dsh subagents with the script's model, effort, agent type, and capability; a run goes on in the background after the tool call returns, gets a session-unique display name (a repeated name becomes name-2, name-3), and its completion reaches the owning session once as a notice turn. Its block shows the run name, status, phase, and agent count; /tasks tags its children with the workflow name and lists the session's runs; the status line counts active workflows. /workflow [runs] lists runs with phases, agents, and results; /workflow pause|resume|stop <name> (or <name> pause) controls one by display name, and the model can do the same with the tool. A session holds at most 4 active runs. Pause and stop cancel the run's children; resume replays the run's journal (finished agent results are reused; a cancelled or failed step runs again, so side effects of an unfinished step are not exactly-once) from the original script and args, and a budget stop resumes only with a higher agent_budget. Runs resume only in the codsh process that started them: after a restart a run that was active is interrupted and none can be resumed. A plain -p prompt waits for its workflow run and returns the run's result block instead (no notice turn). Ctrl+C cancels the turn, not a background run. output_schema asks the child for a JSON block, validates it against the schema, and resumes the same child once to correct a miss; scratch files live under the session directory and git_diff_since runs git diff in it. A run keeps at most [subagents] workflow_max_concurrent (or GROK_WORKFLOW_MAX_CONCURRENT_AGENTS; default 32, clamped to the machine) children live, separately from its agent_budget. Saved workflows: /workflows lists the <meta.name>.rhai files of this trusted project's .grok/workflows (a project workflow hides a same-named personal one) and $GROK_HOME/workflows, with hidden, ambiguous, and skipped invalid files (/workflows <name> shows one workflow or why its file is not loaded); listing reads files and never runs them, and built-in and plugin workflows are not part of this catalog. /workflow <name> [--agent-budget N] [--effort LEVEL] [text or JSON args], or /<name> when no command or skill owns the name (slash completion offers it), launches one; the model sees the same list and can launch by name. A run keeps the script it read at launch, so editing the file changes only later launches and resume never switches to the edited copy. /workflow save <name> writes a run's script to the trusted project's .grok/workflows/<meta.name>.rhai and never replaces an existing file; an untrusted folder or an unwritable project is refused and names where the run's script is. resume_from is refused. The engine's operation and size limits bound a script; they are not a security sandbox.\nOptions: --help, -v/--version, --continue, --resume <id>, --fork-session, --session-id <id>, --minimal, --fullscreen, -m/--model <id>, --effort/--reasoning-effort <level>, --cwd <path>, -w/--worktree [NAME], --worktree-ref/--ref <REF>, --no-memory, --no-subagents, --disable-web-search, --trust, --trust-folder [path], --revoke-trust, --always-approve/--yolo, --auto, --permission-mode <mode>, --allow/--deny <RULE>, --sandbox <profile>, --rules/--append-system-prompt <text>, --system-prompt-override/--system-prompt <text>, inspect, import, plugin, feedback, memory clear, voice doctor, login, logout, setup, export, share, sessions delete, worktree list|show|apply|rm|gc|db, du, disk-usage, agent stdio, agent serve, agent leader, leader list|info|kill, mcp list|add|remove|enable|disable|doctor. `mcp` manages local MCP servers from [mcp_servers] in $GROK_HOME/config.toml plus, in a trusted folder, .grok/config.toml and .mcp.json; dsh starts them for each session, and /mcps (alias /mcp) lists state, failures, and tools, and enables, disables, or restarts them. `agent stdio` is the editor ACP entry; unsupported x.ai methods are refused. `agent serve` (authenticated WebSocket, default 127.0.0.1:2419) and `agent leader` (0600 per-user socket; `agent --leader stdio` or [cli] use_leader) share live sessions between clients with one dsh executor per session; nothing listens unless one of them runs. --rules appends a <human_rules> block for this session. --system-prompt-override replaces file rules and --rules for the text sent to dsh; the typed prompt is still sent. GROK_CLAUDE_SKILLS_ENABLED and GROK_CURSOR_SKILLS_ENABLED turn those vendor skill scans off. --restore-code is refused.\nFilesystem sandbox: off by default. --sandbox or GROK_SANDBOX or [sandbox] profile selects workspace, read-only, strict, devbox, or a sandbox.toml profile. Naming a custom profile does not trust an untrusted workspace's .grok/sandbox.toml; a definition that exists only there refuses startup, and a user $GROK_HOME/sandbox.toml definition still wins. A non-off profile is applied to this process with Seatbelt (macOS) or Landlock (Linux) before dsh starts, and children inherit it. If that kernel policy cannot be applied, startup is refused. The status line names the active profile and write roots. Linux and Windows are not claimed from a macOS run. A devbox-based profile keeps its deny list. Deny paths and glob prefixes are resolved through symlinks such as /tmp; one under a dangling symlink or with a control character refuses startup. dsh's own per-call bash sandbox cannot nest inside the kernel policy, so while a profile is applied dsh runs with its per-call file mode at danger-full-access ($DSH_HOME/codsh-kernel-sandbox.yml) and unchanged approvals; the kernel policy confines bash children and child agents. A deny glob's literal-prefix directory is pinned against rename. The launchd escape (launchctl submit / bootstrap gui/$UID) is kernel-blocked under a profile, matching the reference mach-lookup rules. restrict_network (read-only, strict, or a custom profile) denies network with macOS Seatbelt `(deny network*)` for this process and its children. A profile that asks for network isolation where it cannot be applied, including Linux Landlock and Windows, refuses startup. dsh's per-call file mode is not a network sandbox. [shell_environment_policy] in sandbox.toml, when active, is the environment of a shell child this client starts and of the dsh process spawned afterwards. dsh's bash tool is built from that process and only adds keys. A second Seatbelt profile is not applied inside this one.\nPlain: -p/--single <prompt>, --prompt-file <path>, or --prompt-json <blocks> runs one dsh turn. --output-format plain (the default) prints the final answer on stdout. json prints one object with text, stopReason, sessionId, and requestId. streaming-json prints one ACP-shaped object per line and ends with end. streaming-messages-json prints system/init, assistant and user messages, and a terminal result. --include-partial-messages adds stream_event deltas and only changes streaming-messages-json; other formats warn and ignore it. Tool arguments, tool results, and reasoning are copied from dsh. usage is copied only from a prompt _meta.usage object dsh sent; when that object is absent the terminal line says usage_absent and does not invent tokens or cost. A truncation stop (max_tokens) and a model error exit 1 and do not report end_turn. A tool approval with no terminal is rejected inside dsh and exits 1; the JSON object is an error, not end_turn. streaming-messages-json init tools and slash_commands stay empty unless dsh advertised them. Diagnostics stay on stderr. --verbatim sends that user content unchanged and does not expand custom slash commands. Rules from files, --rules, and --system-prompt-override, plus enabled first-turn memory, still apply: they lead as their own block ahead of the exact user bytes, because dsh receives codsh rules as prompt context, not as a separate system prompt. Permission policy stays on the tool channel. A plain turn has no time limit; it ends when dsh finishes or fails, or on a signal. -c/--continue and -r/--resume <id-or-title> with a plain prompt resume that session; --fork-session copies it. --max-turns <N> stops before model step N+1. --tools and --disallowed-tools filter tools before the first model request; public ids such as read_file and Bash map to dsh names, Agent removes every subagent spawn tool (subagent and subagent_fork) and the workflow tool, Agent(type) or Agent(type, other) in --disallowed-tools removes those subagent types (an unknown type refuses every spawn), --tools cannot allow Agent or a type, deny wins when both are set, and an unknown name is an error. An inherited CODSH_PLAIN_TOOLS or CODSH_PLAIN_MAX_TURNS value follows the same rules in a plain prompt and is ignored by interactive sessions. --tools, --disallowed-tools, --max-turns, and --verbatim are headless flags: without a plain prompt they print a warning and are ignored. --cwd <path>, --sandbox <profile>, --no-memory, and --disable-web-search work for plain prompts and interactive sessions; --cwd is entered before config, trust, and the sandbox are read. A relative --prompt-file is opened after that, so it names a file inside --cwd. A relative --trust-folder or sandbox report path still names a file beside the invocation. --disable-web-search removes web_search and web_fetch for the process. A positional prompt is not plain mode. Piped stdin is not the prompt. Repeated prompt sources are rejected before a provider call. `help` prints this text. `completions <shell>` prints a bash, zsh, fish, powershell, or elvish script. Agent selection, --experimental-memory, --memory-flush, and --json-schema name the flag and stay owned by later tickets. Plan mode, questions, and todos: dsh owns plan mode (ctx.planMode), ask_user_question, and the todo list; this client shows what dsh asks and sends the answer back. /plan enters plan mode, /plan <task> enters it and sends the task, /plan off leaves, and Shift+Tab cycles normal, plan, and always-approve (skipped when requirements lock it off). In plan mode every edit is refused, even under always-approve or --yolo, except the session plan file $GROK_HOME/sessions/<encoded cwd>/<session id>/plan.md; bash is not inspected and subagents are not covered. The status line leads with plan. exit_plan_mode opens the plan review: a approves (comments ride along), s requests changes from the prompt, c comments on a line or Shift+arrow range, y copies, q abandons the plan and leaves plan mode, Tab switches preview and prompt; minimal prints the plan to scrollback and keeps a strip. /view-plan (/show-plan, /plan-view) shows the saved plan. The question card: arrows or j/k move, Tab/Shift+Tab wrap, left/right or h/l or [ ] change question, 1-9 then a-f pick, z types an answer, Space toggles a multi-select row, Enter selects or submits, Esc unselects then parks the keyboard (Tab or Space returns), y copies, Shift+X dismisses, Ctrl+F expands. A pending approval is answered first. [features] ask_user_question / GROK_ASK_USER_QUESTION and --no-ask-user remove the tool; --no-plan removes plan mode. [toolset.ask_user_question] timeout_enabled / timeout_secs (default 1800) and GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED / _SECS close an unanswered card. A plain prompt or an editor session has no card: a question returns the no-operator text and a plan review is approved. Ctrl+T hides the todos pane. --todo-gate reminds dsh about unfinished todos at most twice per prompt. Unknown options and missing values exit 2. SIGINT exits 130 and SIGTERM exits 143, also during startup. A missing credential or dsh error exits 1.\nWorktrees: -w/--worktree [NAME] starts the session (interactive or plain) in a new git worktree at $GROK_HOME/worktrees/<repo>/<name> on branch codsh/<name>, created from the directory you are in (after --cwd) before config, trust, and the sandbox are read. Without --worktree-ref (alias --ref) the worktree starts from HEAD plus your uncommitted and untracked (not ignored) files, committed there as one snapshot; your checkout, index, and branch are not changed. With a ref it is a clean checkout. A name that is already a directory or branch gets a -2, -3 suffix; an existing branch is never reused or reset. A directory outside git is refused and nothing is created. -w -r <id> (or -w -c) copies that session under a new id into the new worktree and resumes the copy; the original session keeps its directory. The status line names the worktree and branch. The worktree is a separate workspace for folder trust and remembered grants, so both are asked again there. `codsh --rust worktree list|ls [--repo R] [--type session|subagent|untracked] [--all] [--json]`, `show <id>`, `apply <id> [--overwrite] [--dry-run]`, `rm <id>... [-f] [--dry-run]`, `gc|prune [--max-age 7d] [--dry-run] [-f]`, and `db path|stats|rebuild` manage them; /worktree [list|show|apply|rm|gc] does the same inside a session. apply merges by default: a file is written only when the checkout still holds what the worktree started from; anything else is reported as a conflict and left untouched, and --overwrite takes the worktree version. apply never commits or stages. rm refuses a worktree with uncommitted work unless -f and keeps the branch when it holds commits. gc expires nothing without --max-age and keeps worktrees with uncommitted, untracked, or non-cache ignored files, commits no branch holds, or a live owner. detach, salvage, and clean-artifacts are refused: there is no Grove projection. /fork --worktree is refused inside a running session; use -w -r. The new-session/fork worktree prompts (hints.*_worktree_mode) and automatic gc are not implemented. Under a filesystem sandbox, git in a worktree and subagent isolation can write only where the profile's write roots reach ($GROK_HOME/worktrees and the source repository's .git); otherwise git's own error is reported and nothing is applied.\nNonessential telemetry, trace upload, session tracking, and content sharing default off. Opt-in requires a substitute endpoints.telemetry_url / feedback_base_url / trace_upload_url; official grok.com, api.x.ai, and sentry hosts are refused. Diagnostic previews list kind/ok/count only and never prompts or keys. Model calls stay on the configured provider and are not telemetry. Locked requirements can force these switches off."
            );
            return Ok(());
        }
        LaunchMode::Inspect { help: true, .. } => {
            println!("{}", inspect_help());
            return Ok(());
        }
        LaunchMode::Inspect {
            json,
            debug,
            debug_file,
            ..
        } => {
            let loaded = load_runtime_config(&launch);
            if *debug || debug_file.is_some() {
                let trace = format!(
                    "config.toml={} status={}\n",
                    loaded.config_path.display(),
                    loaded
                        .files
                        .iter()
                        .find(|file| file.role == "config.toml")
                        .map(|file| file.status.as_str())
                        .unwrap_or("unknown")
                );
                eprint!("{trace}");
                if let Some(path) = debug_file {
                    std::fs::write(path, trace)?;
                }
            }
            if *json {
                print!("{}", config::inspect_json(&loaded));
            } else {
                println!("{}", config::inspect_text(&loaded));
            }
            if !loaded.errors.is_empty() {
                return Err(io::Error::other(loaded.first_run_message()));
            }
            return Ok(());
        }
        LaunchMode::Import { flags } => {
            if flags.help {
                println!("{}", import::import_help());
                return Ok(());
            }
            return run_import(flags.clone());
        }
        LaunchMode::Plugin(command) => {
            let loaded = load_runtime_config(&launch);
            let env = std::env::vars().collect();
            match plugin::run(
                &loaded.grok_home,
                &loaded.cwd,
                &env,
                loaded.workspace_trusted,
                command,
            ) {
                Ok(output) => {
                    println!("{output}");
                    return Ok(());
                }
                Err(error) => {
                    eprintln!("{}", error.message);
                    std::process::exit(error.code);
                }
            }
        }
        LaunchMode::Login { help: true, .. } => {
            println!("{}", auth::login_help());
            return Ok(());
        }
        LaunchMode::Login { flags, .. } => {
            let loaded = load_runtime_config(&launch);
            write_debug_file(flags.debug, flags.debug_file.as_ref(), "login")?;
            if loaded.blocks_auth_command() {
                return Err(io::Error::other(loaded.first_run_message()));
            }
            match auth::run_login(
                &loaded.grok_home,
                &std::env::vars().collect(),
                &loaded.auth,
                flags,
                &loaded.merged_table,
            ) {
                Ok(message) => {
                    println!("{message}");
                    return Ok(());
                }
                Err(error) => return Err(io::Error::other(error)),
            }
        }
        LaunchMode::Logout { help: true, .. } => {
            println!("{}", auth::logout_help());
            return Ok(());
        }
        LaunchMode::Logout {
            debug, debug_file, ..
        } => {
            let loaded = load_runtime_config(&launch);
            write_debug_file(*debug, debug_file.as_ref(), "logout")?;
            match auth::run_logout(
                &loaded.grok_home,
                &std::env::vars().collect(),
                &loaded.dsh_home,
            ) {
                Ok(message) => {
                    println!("{message}");
                    return Ok(());
                }
                Err(error) => return Err(io::Error::other(error)),
            }
        }
        LaunchMode::Setup { help: true, .. } => {
            println!("{}", auth::setup_help());
            return Ok(());
        }
        LaunchMode::Sessions(command) => {
            let loaded = load_runtime_config(&launch);
            match session_catalog::run_sessions(command, &loaded.dsh_home, &loaded.cwd) {
                Ok(message) => {
                    println!("{message}");
                    return Ok(());
                }
                Err(error) => return Err(io::Error::other(error.message)),
            }
        }
        LaunchMode::Export(request) => {
            let loaded = load_runtime_config(&launch);
            let mut stdout = io::stdout().lock();
            return match session_data::export_session(
                &loaded.dsh_home,
                &loaded.cwd,
                request,
                &mut stdout,
            ) {
                Ok(_) => Ok(()),
                Err(error) => Err(io::Error::other(error.message)),
            };
        }
        LaunchMode::ShareHelp => {
            let loaded = load_runtime_config(&launch);
            let visible = share_destination(&loaded, None);
            println!("{}", session_data::share_help_visible(visible.as_deref()));
            return Ok(());
        }
        LaunchMode::Share(request) => {
            let loaded = load_runtime_config(&launch);
            let mut request = request.clone();
            request.url = share_destination(&loaded, request.url.as_deref());
            return match session_data::share_session(&loaded.dsh_home, &loaded.cwd, &request) {
                Ok(outcome) => {
                    println!("{}", outcome.url);
                    Ok(())
                }
                Err(error) => Err(io::Error::other(error.message)),
            };
        }
        LaunchMode::DiskUsage { json } => {
            let loaded = load_runtime_config(&launch);
            let report = session_data::collect_disk(&loaded.grok_home, &loaded.dsh_home)
                .map_err(|error| io::Error::other(error.message))?;
            if *json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into())
                );
            } else {
                println!("{}", session_data::format_disk(&report));
            }
            return Ok(());
        }
        LaunchMode::Mcp(invocation) => {
            let loaded = load_runtime_config(&launch);
            let code = run_mcp(invocation, &loaded)?;
            if code != 0 {
                std::process::exit(code);
            }
            return Ok(());
        }
        LaunchMode::Memory(args) => {
            if args
                .first()
                .is_some_and(|arg| arg == "help" || arg == "--help" || arg == "-h")
                && args.len() == 1
            {
                println!("{}", memory::memory_help());
                return Ok(());
            }
            let command = args.first().map(String::as_str).unwrap_or("help");
            if command != "clear" {
                return Err(io::Error::other(format!(
                    "unsupported memory command {command}; {}",
                    memory::memory_help()
                )));
            }
            let (scope, yes, help) =
                memory::parse_clear(&args[1..]).map_err(|error| io::Error::other(error.message))?;
            if help {
                println!("{}", memory::clear_help());
                return Ok(());
            }
            if !yes {
                return Err(io::Error::other(
                    "memory clear needs confirmation; rerun with --yes. Nothing was deleted.",
                ));
            }
            let loaded = load_runtime_config(&launch);
            let store = memory::open_store(&loaded.grok_home, &loaded.cwd)
                .map_err(|error| io::Error::other(error.message))?;
            let removed = memory::clear_scope(&store, scope)
                .map_err(|error| io::Error::other(error.message))?;
            if removed.is_empty() {
                println!("memory clear: no notes in that scope; other files were kept");
            } else {
                println!(
                    "memory clear removed {} note(s). Other scopes were kept. Nothing was uploaded.",
                    removed.len()
                );
            }
            return Ok(());
        }
        LaunchMode::Dashboard => {
            // Interactive dashboard is the TUI. The subcommand only opens it
            // when the marker says so; other values stay a normal session.
            let marker = std::env::var("GROK_OPEN_DASHBOARD_AT_STARTUP").unwrap_or_default();
            if marker != "1" {
                println!(
                    "codsh --rust dashboard opens the agent dashboard inside fullscreen.\nSet GROK_OPEN_DASHBOARD_AT_STARTUP=1 or run /dashboard from a session.\nMinimal mode refuses the dashboard; use /fullscreen first."
                );
                return Ok(());
            }
        }
        LaunchMode::Setup { flags, .. } => {
            let loaded = load_runtime_config(&launch);
            write_debug_file(flags.debug, flags.debug_file.as_ref(), "setup")?;
            if loaded.blocks_auth_command() {
                return Err(io::Error::other(loaded.first_run_message()));
            }
            match auth::run_setup(
                &loaded.grok_home,
                &std::env::vars().collect(),
                &loaded.auth,
                flags,
                loaded.fail_closed,
            ) {
                Ok(result) => {
                    println!("{}", result.message);
                    return Ok(());
                }
                Err(error) => return Err(io::Error::other(error)),
            }
        }
        LaunchMode::Plain { .. } => return run_plain(&launch, &mode),
        _ => {}
    }
    if let LaunchMode::Resume(id) = &mode {
        let loaded = load_runtime_config(&launch);
        if !session_catalog::is_uuid(id) {
            let catalog = session_catalog::load_catalog(&loaded.dsh_home, &loaded.cwd);
            session_catalog::resolve_resume(&catalog.sessions, id, &loaded.cwd)
                .map_err(|error| io::Error::other(error.message))?;
        } else if session_catalog::load_catalog(&loaded.dsh_home, &loaded.cwd)
            .sessions
            .iter()
            .all(|session| !session.id.eq_ignore_ascii_case(id))
        {
            return Err(io::Error::other(format!("session is not resumable: {id}")));
        }
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(io::Error::other(
            "Rust preview requires an interactive terminal",
        ));
    }
    let home = PathBuf::from(
        std::env::var_os("HOME")
            .ok_or_else(|| io::Error::other("missing isolated HOME; use codsh --rust"))?,
    );
    let persisted = screen_mode::read_persisted_mode(&home).map_err(io::Error::other)?;
    let env_mode = std::env::var(GROK_SCREEN_MODE_ENV).ok();
    let mut screen = screen_mode::resolve_mode(launch.screen, env_mode.as_deref(), persisted)
        .map_err(io::Error::other)?;
    let policy =
        screen_mode::switch_policy_from_env(std::env::var(SCREEN_MODE_SWITCH_ENV).ok().as_deref());
    let stopping = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    for signal in [
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
        signal_hook::consts::SIGINT,
    ] {
        signal_hook::flag::register(signal, Arc::clone(&stopping))?;
    }
    let mut guard = TerminalGuard::enter(screen)?;
    profile()?;
    let mut terminal = open_terminal(screen)?;
    let mut effective = load_runtime_config(&launch);
    let env_pairs: Vec<(String, String)> = std::env::vars().collect();
    let mut composer = PromptComposer::load(&effective.grok_home, &env_pairs);
    composer.asset_commands = assets::menu_entries(&effective.assets);
    sync_workflow_scope(&mut composer, &effective);
    let mut voice = voice::VoiceSession::new(effective.voice.clone());
    // Kitty event types are requested. A terminal that never emits a release
    // still cannot stop hold-to-talk; the first release flips this on.
    let mut voice_release_supported = false;
    composer.set_workspace(&effective.cwd);
    // The composer starts empty. Like the reference, an unsent draft lives
    // in this process only: a sent prompt must never come back on the next
    // launch, and a draft is not carried into another project.
    sync_image_route(&mut composer, &effective);
    composer.simple_mode = effective.simple_mode;
    composer.prompt_suggestions = effective.prompt_suggestions;
    composer.vim = if composer.simple_mode {
        prompt_edit::VimPrompt::Insert
    } else {
        prompt_edit::VimPrompt::Normal
    };
    let connecting = format!(
        "mode={} | {}\nConnecting to dsh ACP…",
        screen.as_str(),
        worktree_header(filesystem_sandbox::status_line(filesystem_sandbox::active()))
    );
    let env_map: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    let mut nav = NavState::new(
        navigation::load_prefs(&effective.grok_home, &env_map),
        screen == ScreenMode::Fullscreen,
    );
    #[allow(unused_assignments)]
    let mut nav_layout = paint(
        &mut terminal,
        screen,
        &composer,
        &connecting,
        None,
        &theme::Theme::offline(),
        false,
        &mut UiOverlay::None,
        false,
        None,
    )?;
    let mut selected = None;
    let mut turns: Vec<Turn> = Vec::new();
    let mut inflight = false;
    let mut compacting = false;
    let mut side = Intervene::default();
    let term = term_family(std::env::var("TERM_PROGRAM").ok().as_deref());
    // Session the queued rows were typed in. A switch holds them.
    let mut queue_session: Option<String> = None;
    let mut compact_cancelled = false;
    let mut last_compaction_count = 0usize;
    // Typed subagents (ticket 172): one board per process and the tasks modal.
    let mut board = subagents::Board::default();
    let mut tasks: Option<subagents::TasksModal> = None;
    // Background commands (ticket 175): a turn dsh opened on its own and the
    // time of the last dsh event, which a wake turn waits out before closing.
    let mut wake: Option<Wake> = None;
    let mut last_acp_event = Instant::now();
    let mut inspect_auto_compact;
    let mut last_error = String::new();
    let mut hint = String::new();
    let mut owner: Option<SessionOwner> = None;
    let mut resumed = false;
    let mut previous_session: Option<String> = None;
    let mut overlay = Overlay::None;
    let mut ui_overlay = UiOverlay::None;
    let mut last_esc: Option<Instant> = None;
    let mut committed = 0usize;
    let mut history = String::new();
    let mut prefs = session_fork::load_prefs(&effective.grok_home);
    let mut open_dashboard_at_start = matches!(mode, LaunchMode::Dashboard)
        && std::env::var("GROK_OPEN_DASHBOARD_AT_STARTUP")
            .ok()
            .as_deref()
            == Some("1");
    let mut previous_ready = effective.ready;
    // The mode file is known before the child exists. runtime_apply writes
    // that policy; applying it afterward leaves dsh on the previous mode.
    if can_execute(&effective, false) {
        let startup_session = known_resume_session(&mode, &effective);
        if let Err(error) = apply_saved_session_mode(&mut effective, startup_session.as_deref()) {
            last_error = error;
        }
    }
    let startup = runtime_apply(&effective);
    let mut extra_env = startup.extra_env;
    let mut live_theme_kind = effective.appearance.resolved_kind(screen);
    let mut live_theme = effective.appearance.resolved_theme(screen);
    apply_cursor_color(&live_theme);
    let mut status_runtime =
        status_line::StatusLineRuntime::new(effective.appearance.status_line.clone());
    let mut turn_started: Option<Instant> = None;
    let mut last_status_key = String::new();
    let mut apply_failed = startup.apply_failed;
    let mut patch = startup.patch;
    if apply_failed {
        last_error = startup.error;
    }
    let startup_can_execute = can_execute(&effective, apply_failed);
    if !startup_can_execute && last_error.is_empty() {
        last_error = effective.first_run_message();
    }
    if last_error.is_empty() && !effective.trust_message.is_empty() {
        last_error = effective.trust_message.clone();
    }
    let mut meter = Meter {
        used: None,
        size: None,
        cost: None,
    };
    let mut selection_ready = config::is_test_execution_seam();
    let mut memory_session_on: Option<bool> = None;
    // A resumed or forked transcript already had its first turn. `/new`
    // clears `turns`, so the next prompt is that session's first turn.
    let mut memory_injected: bool = resumed && !turns.is_empty();
    let mut client = if startup_can_execute {
        match connect(
            &mode,
            None,
            &extra_env,
            patch.as_ref(),
            launch.fork_session,
            launch.child_id.as_deref(),
        ) {
            Ok((connection, restored)) => {
                resumed = connection.resumed;
                previous_session = connection.client.session_id.clone();
                owner = Some(connection.owner);
                turns = restored;
                let mut client = connection.client;
                attach_worktree_session(&client);
                if let Some(created) = worktree::active() {
                    hint = worktree::short_notice(created);
                }
                match apply_live_selection(&mut client, &effective) {
                    Ok(()) => selection_ready = true,
                    Err(error) => {
                        last_error = error;
                        selection_ready = false;
                    }
                }
                let notices = mcp_notices(&client);
                if last_error.is_empty() && !notices.is_empty() {
                    last_error = notices.join("; ");
                }
                Some(client)
            }
            Err(error) => {
                last_error = error;
                None
            }
        }
    } else {
        None
    };
    if launch.fork_session
        && let Some(active) = client.as_mut()
        && let Err(error) = apply_fork_model(active, &prefs)
    {
        last_error = error;
    }
    while !stopping.load(Ordering::Relaxed) {
        let was_compacting = compacting;
        let was_inflight = inflight;
        inspect_auto_compact = false;
        let disconnect = client.as_mut().and_then(|active| {
            let events = active.pump(Duration::ZERO);
            if !events.is_empty() {
                last_acp_event = Instant::now();
            }
            apply_event_stream(
                &mut turns,
                &mut inflight,
                &mut meter,
                &mut board,
                &mut wake,
                &mut hint,
                events,
                compacting,
                &mut inspect_auto_compact,
            )
        });
        settle_wake(&mut turns, &mut inflight, &mut wake, last_acp_event);
        // dsh ends a session's commands when it closes that session (a
        // switch, /new, a fork) and all of them when its process goes away.
        let live_board_session = client.as_ref().and_then(|active| active.session_id.clone());
        if live_board_session != board.session {
            let ended: usize = board
                .jobs
                .entries
                .iter()
                .filter(|job| {
                    job.status == background::Status::Running
                        && Some(job.session.as_str()) != live_board_session.as_deref()
                })
                .map(|job| job.session.clone())
                .collect::<std::collections::BTreeSet<_>>()
                .iter()
                .map(|session| {
                    board
                        .jobs
                        .end_session(session, "stopped when its dsh session closed")
                })
                .sum();
            if ended > 0 {
                hint = format!("{ended} background command(s) stopped with the previous session");
            } else if live_board_session.is_some()
                && let Some(text) = restored_background_hint(&turns)
            {
                hint = text.into();
            }
            // Scheduled loops run in one dsh process and session: a switch
            // or a restarted dsh process stopped them. Saved ones come back
            // when their session is resumed (ticket 178); the user is told.
            let (saved, unsaved) = board.schedules.end_all();
            if let Some(text) =
                scheduler::ended_hint(saved, unsaved, "with the previous dsh session")
            {
                hint = text;
            }
            side.schedule_owner_retries = 0;
            if live_board_session.is_none() {
                wake = None;
            }
            board.session = live_board_session;
        }
        // Saved loops (ticket 178): once this client holds the session's
        // owner lock, hand its token to dsh, which then restores the saved
        // loops and saves new ones. dsh re-reads the lock before every save
        // and fire, so a lost lock stops them instead of doubling fires.
        match (client.as_ref(), owner.as_ref()) {
            (Some(active), Some(held))
                if active.session_id.as_deref() == Some(held.session_id.as_str()) =>
            {
                let key = (active.pid(), held.session_id.clone(), held.token.clone());
                if active.control_ready()
                    && side.schedule_owner.as_ref() != Some(&key)
                    && side.schedule_owner_request.is_none()
                    && side.schedule_owner_retries < 40
                {
                    side.next_control += 1;
                    let id = format!("owner-{}", side.next_control);
                    if active.send_schedule_owner(&id, &held.token).is_ok() {
                        side.schedule_owner = Some(key);
                        side.schedule_owner_request = Some(id);
                    }
                }
            }
            _ => {
                side.schedule_owner = None;
                side.schedule_owner_request = None;
            }
        }
        if let Some(active) = client.as_mut() {
            // Give dsh time to stop live commands before its process group
            // is killed; nothing else waits on this.
            active.set_linger(board.jobs.running() > 0);
        }
        decorate_subagent_blocks(&mut turns, &board);
        if let Some(modal) = tasks.as_mut() {
            modal.clamp(&board);
            refresh_child_view(modal, &board, &effective);
        }
        match voice.poll() {
            Ok(Some(insert)) => {
                let current = composer.voice_draft();
                if voice.accepts_late(insert.generation, &current, &insert.draft_at_start) {
                    if let Some(next) =
                        voice::apply_insert(&current, &insert.draft_at_start, &insert.text)
                    {
                        composer.set_text(&next);
                        hint = voice.status.clone();
                        last_error.clear();
                    } else {
                        hint = "late voice result ignored; draft changed".into();
                    }
                } else {
                    hint = "late voice result ignored; draft changed".into();
                }
            }
            Ok(None) => {}
            Err(error) => {
                last_error = error.to_string();
                hint = last_error.clone();
            }
        }
        if was_inflight && !inflight && !compacting {
            // No suggestion provider is connected. Passing Some here would
            // paint ghost text that Tab/Right could accept without a real row.
            composer.on_turn_finished(None);
            if let Some(session_id) = client.as_ref().and_then(|active| active.session_id.clone()) {
                let _ = session_catalog::note_turn(&effective.dsh_home, &session_id, false);
            }
            // The catalog route is what the next submit uses. Refresh it from
            // the model dsh is actually advertising before rebuilding blocks.
            if let Some(routing) = live_routing(client.as_ref(), &effective) {
                composer.set_image_route(routing.accepts_images, Some(&effective.dsh_home));
            }
            // Reference: a cancelled turn also lets the front row run next.
            side.drain_armed = composer.queue_count() > 0;
        }
        if was_compacting && !inflight {
            compacting = false;
            side.drain_armed = composer.queue_count() > 0;
            if let Some(session_id) = client.as_ref().and_then(|active| active.session_id.clone()) {
                match session_history::load_session(&effective.dsh_home, &session_id) {
                    Ok(restored) => {
                        last_compaction_count = restored.compaction.len();
                        replace_session_turns(
                            &mut turns,
                            &mut committed,
                            &mut history,
                            restored.turns,
                        );
                        if screen == ScreenMode::Minimal {
                            resize_purge_rerender(&mut terminal, "")?;
                        }
                        hint = compact_reload_hint(&turns, &restored.compaction, compact_cancelled);
                        if hint.starts_with("Compaction failed") || hint == "Compaction cancelled."
                        {
                            // The transcript already paints this sentence.
                            // Keep it as the error, not a second hint copy.
                            last_error = hint.clone();
                            hint.clear();
                        } else {
                            last_error.clear();
                        }
                    }
                    Err(error) => last_error = error.to_string(),
                }
            } else if compact_cancelled {
                hint = "Compaction cancelled.".into();
            }
            compact_cancelled = false;
        } else if inspect_auto_compact
            && let Some(session_id) = client.as_ref().and_then(|active| active.session_id.clone())
        {
            match session_history::load_session(&effective.dsh_home, &session_id) {
                Ok(restored) if restored.compaction.len() > last_compaction_count => {
                    last_compaction_count = restored.compaction.len();
                    replace_session_turns(&mut turns, &mut committed, &mut history, restored.turns);
                    if screen == ScreenMode::Minimal {
                        resize_purge_rerender(&mut terminal, "")?;
                    }
                    hint = compact_reload_hint(&turns, &restored.compaction, false);
                    last_error.clear();
                }
                Ok(_) => {}
                Err(error) => last_error = error.to_string(),
            }
        }
        if let Some(detail) = disconnect {
            last_error = detail;
            drop_connection(&mut client, &mut owner);
            wake = None;
            let ended = board.jobs.end_all("stopped when dsh exited");
            if ended > 0 {
                hint = format!("{ended} background command(s) stopped when dsh exited");
            }
            let (saved, unsaved) = board.schedules.end_all();
            if let Some(text) = scheduler::ended_hint(saved, unsaved, "when dsh exited") {
                hint = text;
            }
        }
        let control_events = client
            .as_mut()
            .map(AcpClient::poll_control)
            .unwrap_or_default();
        if !control_events.is_empty()
            && let Some(text) = apply_interaction_events(
                &control_events,
                &mut side,
                &mut composer,
                client.as_ref(),
                &mut hint,
                screen == ScreenMode::Minimal,
            )
        {
            history.push_str(&text);
            let _ = with_synchronized_output(&mut terminal, |terminal| {
                emit_to_scrollback(terminal, &text)
            });
        }
        if !control_events.is_empty()
            && let Some(text) = apply_control_events(
                control_events,
                &mut composer,
                &mut turns,
                inflight,
                &mut side,
                &mut hint,
                screen == ScreenMode::Minimal,
            )
        {
            history.push_str(&text);
            let _ = with_synchronized_output(&mut terminal, |terminal| {
                emit_to_scrollback(terminal, &text)
            });
        }
        if let Some(notice) = side.kill_notice.take() {
            match tasks.as_mut() {
                Some(modal) => modal.notice = notice,
                None => hint = notice,
            }
        }
        // A send-now that asked dsh to move the running command cancels the
        // turn once dsh answered, or after the bound if it never does.
        if side.deferred_cancel.as_ref().is_some_and(|pending| {
            pending.answered || pending.since.elapsed() >= DEFERRED_CANCEL_BOUND
        }) {
            side.deferred_cancel = None;
            if inflight
                && !turns.last().is_some_and(|turn| turn.cancelling)
                && let Some(active) = client.as_mut()
            {
                cancel_for_send_now(active, &mut turns, &mut hint, &mut last_error);
            }
        }
        // "Queued N" was true when it was set; a drained queue makes it stale.
        if composer.queue_count() == 0 && prompt_edit::is_queue_notice(&hint) {
            hint.clear();
        }
        // `[ui].follow_up_behavior = "steer"`: the row just queued goes to
        // the running agent now and stays listed until dsh claims it.
        let enqueued = composer.take_last_enqueued();
        // While the model is blocked waiting on a background command, a new
        // message interrupts the wait: the turn stops (the command keeps
        // running) and the message runs next.
        if let Some(queued_id) = enqueued
            && inflight
            && !compacting
            && board.jobs.is_waiting(board.session.as_deref())
        {
            send_queued_now(
                queued_id,
                &mut composer,
                &mut client,
                &mut turns,
                inflight,
                compacting,
                &mut side,
                &mut hint,
                &mut last_error,
            );
        } else if let Some(queued_id) = enqueued
            && effective.appearance.follow_up_steer
            && inflight
            && !compacting
        {
            let candidate = composer
                .queue_items()
                .iter()
                .find(|item| item.id == queued_id)
                .map(|item| {
                    (
                        item.steer_eligible(),
                        item.wire_id(),
                        item.prompt.text.clone(),
                    )
                });
            match (candidate, client.as_ref()) {
                (Some((true, wire, text)), Some(active)) if active.control_ready() => {
                    match active.send_steer(&wire, &text) {
                        Ok(()) => {
                            if let Some(item) = composer.queue_item_mut(queued_id) {
                                item.steering = true;
                            }
                        }
                        Err(error) => {
                            hint = format!("steer unavailable ({error}); the row stays queued");
                        }
                    }
                }
                (Some((true, _, _)), Some(active)) => {
                    hint = format!(
                        "steer unavailable ({}); the row stays queued",
                        active.control_unavailable()
                    );
                }
                (Some((false, _, _)), _) => {
                    hint =
                        "this row waits for the turn to end (steer takes plain text only)".into();
                }
                _ => {}
            }
        }
        if side.drain_armed && !inflight && !compacting {
            let combine = effective.appearance.combine_queued_prompts;
            let mut relaunch: Option<io::Error> = None;
            let stop = prompt_queue::drain(
                &mut composer,
                |composer| {
                    // A queued command dispatches through the slash path,
                    // which parks the draft behind an open completion list.
                    if composer.overlay != prompt_edit::Overlay::None
                        && composer
                            .queue_items()
                            .first()
                            .is_some_and(|item| item.kind == prompt_queue::QueueKind::Command)
                    {
                        return prompt_queue::Release::HeldForEdit;
                    }
                    composer.next_release(combine)
                },
                |composer, item| {
                    if item.kind == prompt_queue::QueueKind::Command {
                        let text = item.prompt.text.clone();
                        let result = dispatch_composer_command(
                            &text,
                            &mut client,
                            &mut owner,
                            &mut turns,
                            &mut inflight,
                            &mut compacting,
                            &mut overlay,
                            &mut ui_overlay,
                            &mut hint,
                            &mut last_error,
                            &mut effective,
                            &mut extra_env,
                            &mut patch,
                            &mut apply_failed,
                            &mut previous_ready,
                            &mut selection_ready,
                            &mut resumed,
                            &mut previous_session,
                            &mut terminal,
                            &mut guard,
                            screen,
                            &mut committed,
                            &mut history,
                            &launch,
                            &mode,
                            &mut prefs,
                            &meter,
                            policy,
                            &mut nav,
                            &mut live_theme_kind,
                            &mut live_theme,
                            &mut status_runtime,
                            composer,
                            &mut voice,
                            &mut memory_session_on,
                            &mut memory_injected,
                            &mut side,
                        );
                        if let Err(error) = result {
                            relaunch = Some(error);
                            return prompt_queue::Step::Hold;
                        }
                        return if inflight {
                            prompt_queue::Step::Started
                        } else {
                            prompt_queue::Step::Local
                        };
                    }
                    match composer.blocks_for_route(&item.prompt) {
                        Ok(blocks) => {
                            let mut prepared = item.prompt.clone();
                            prepared.blocks = blocks;
                            composer.stage_prepared_submit(prepared);
                        }
                        Err(error) => {
                            // The route or the bytes no longer admit this image.
                            // Put this prompt back in the composer and keep the
                            // rest queued. Do not send the vision block.
                            last_error = error.clone();
                            hint = error;
                            composer.push_front(item);
                            let _ = composer.restore_refused_queue_head();
                            return prompt_queue::Step::Hold;
                        }
                    }
                    let text = item.prompt.text.clone();
                    submit_composer_prompt(
                        &text,
                        &mut client,
                        &mut owner,
                        &mut turns,
                        &mut inflight,
                        &mut last_error,
                        &mut effective,
                        &mut extra_env,
                        &mut patch,
                        &mut apply_failed,
                        &mut previous_ready,
                        &mut selection_ready,
                        &mut resumed,
                        &mut previous_session,
                        &launch,
                        &mode,
                        composer,
                        &mut memory_session_on,
                        &mut memory_injected,
                    );
                    if inflight {
                        prompt_queue::Step::Started
                    } else {
                        // Not sent (no connection, refused route): it stays
                        // at the front and the queue holds.
                        let _ = composer.take_prepared_submit();
                        composer.push_front(item);
                        prompt_queue::Step::Hold
                    }
                },
            );
            match stop {
                prompt_queue::DrainStop::HeldForEdit | prompt_queue::DrainStop::Steering => {}
                prompt_queue::DrainStop::Empty
                | prompt_queue::DrainStop::Started
                | prompt_queue::DrainStop::Hold => side.drain_armed = false,
            }
            queue_session = client.as_ref().and_then(|active| active.session_id.clone());
            if let Some(error) = relaunch {
                if let Some(rest) = error.to_string().strip_prefix("CODSH_SCREEN_RELAUNCH:") {
                    let mut parts = rest.splitn(2, ':');
                    let session_id = parts.next().unwrap_or("");
                    let target = screen_mode::ScreenMode::parse(parts.next().unwrap_or("minimal"))
                        .unwrap_or(screen_mode::ScreenMode::Minimal);
                    drop(terminal);
                    drop(guard);
                    restore_terminal();
                    return Err(relaunch_exec(session_id, target));
                }
                return Err(error);
            }
            screen = if guard.alt {
                ScreenMode::Fullscreen
            } else {
                ScreenMode::Minimal
            };
            live_theme_kind = effective.appearance.resolved_kind(screen);
            live_theme = effective.appearance.resolved_theme(screen);
        }
        let live_session = client.as_ref().and_then(|active| active.session_id.clone());
        if live_session != queue_session {
            if queue_session.is_some() && composer.queue_count() > 0 {
                // Rows typed for another session do not run here on their own.
                side.drain_armed = false;
                hint = format!(
                    "{} queued row(s) kept from the previous session; Ctrl+; to send, edit, or delete",
                    composer.queue_count()
                );
            }
            queue_session = live_session;
        }
        if let Some(panel) = &side.btw
            && client.is_none()
            && panel.state == BtwState::Loading
        {
            side.btw = Some(BtwPanel {
                state: BtwState::Failed("dsh disconnected".into()),
                ..panel.clone()
            });
        }
        let awaiting = turns.last().is_some_and(|turn| turn.permission.is_some());
        let cancelling = turns.last().is_some_and(|turn| turn.cancelling);
        let shown_hint = match &overlay {
            Overlay::None => hint.clone(),
            Overlay::Feedback(form) => {
                feedback_overlay_text(&effective.dsh_home, client.as_ref(), form)
            }
            Overlay::Memory(browser) => {
                if browser.force_off {
                    memory_store(&effective)
                        .map(|store| memory_ui::render(browser, &store))
                        .unwrap_or_else(|error| error)
                } else {
                    // The modal owns the file list and preview. The notice is
                    // one status line so a narrow screen cannot reprint a note.
                    let status = if browser.notice.is_empty() {
                        String::new()
                    } else {
                        format!(" {}", browser.notice.lines().next().unwrap_or(""))
                    };
                    format!(
                        "Memory modal  session={}{}",
                        if browser.session_enabled { "on" } else { "off" },
                        status
                    )
                }
            }
            Overlay::Remember { draft, scope } => format!(
                "Remember ({})\nNext line becomes the note. Enter reviews it; nothing is written yet.\n{draft}",
                scope.as_str()
            ),
            Overlay::Plugins(plugin_overlay) => {
                let env = std::env::vars().collect();
                let snapshot = plugin::inspect(
                    &effective.grok_home,
                    &effective.cwd,
                    &env,
                    effective.workspace_trusted,
                );
                plugin::overlay_text(plugin_overlay, &snapshot, Some(&effective.grok_home))
            }
            _ => overlay_hint(&overlay, &prefs),
        };
        let routing = live_routing(client.as_ref(), &effective);
        if inflight {
            if turn_started.is_none() {
                turn_started = Some(Instant::now());
            }
        } else {
            turn_started = None;
        }
        let status_snap = status_line::StatusSnapshot::from_session(
            &effective.cwd,
            client
                .as_ref()
                .and_then(|active| active.session_id.as_deref()),
            routing.as_ref(),
            meter.used,
            meter.size,
            meter.cost.as_deref(),
            effective.compact_threshold_percent,
            turn_started,
        );
        let status_key = format!(
            "{:?}|{:?}|{:?}|{}|{}",
            status_snap.session_id,
            status_snap.model_id,
            status_snap.used_percentage,
            inflight,
            screen.as_str()
        );
        let changed = status_runtime.poll();
        if status_key != last_status_key {
            last_status_key = status_key;
            status_runtime.request_state(&status_snap, 80, 1);
        } else if status_runtime.due_refresh(Instant::now()) {
            status_runtime.request_refresh(&status_snap, 80, 1);
        }
        let _ = changed;
        let status_row = status_runtime.current();
        if screen == ScreenMode::Minimal {
            commit_completed_turns(&mut terminal, &turns, &mut committed, &mut history, None)?;
        }
        let view = StatusView {
            client: client.as_ref(),
            inflight,
            last_error: &last_error,
            awaiting_approval: awaiting,
            cancelling,
            hint: &shown_hint,
            resumed,
            routing: routing.as_ref(),
            meter: &meter,
            screen,
            status_row: &status_row.text,
            show_timestamps: effective.appearance.show_timestamps,
        };
        let mut notice = if screen == ScreenMode::Minimal {
            overlay_notice(view, &turns)
        } else {
            status_line(view)
        };
        if screen == ScreenMode::Fullscreen
            && let Some(sentence) = turns.iter().rev().find_map(compaction_sentence)
        {
            // The transcript paints this sentence. Repeating it in the
            // six-row notice pushes the session id off the screen.
            notice = notice
                .lines()
                .filter(|line| *line != sentence)
                .collect::<Vec<_>>()
                .join("\n");
        }
        let still_running = board.status_text();
        if !still_running.is_empty() {
            notice.push('\n');
            notice.push_str(&still_running);
        }
        let goal_line = board.goal.status_text(board.session.as_deref());
        if !goal_line.is_empty() {
            notice.push('\n');
            notice.push_str(&goal_line);
        }
        // Plan mode is dsh's state; the flag leads the status notice.
        if let Some(flag) = side.ask.plan.flag() {
            notice = format!("{flag} | {notice}");
        }
        if let Overlay::Feedback(form) = &overlay {
            notice = feedback_overlay_text(&effective.dsh_home, client.as_ref(), form);
        }
        if let Some(panel) = &side.btw {
            notice.push('\n');
            notice.push_str(&btw_panel_text(panel));
        }
        if composer.overlay != prompt_edit::Overlay::None {
            let rows = composer.overlay_text();
            let mut lines: Vec<&str> = rows.lines().collect();
            // The notice keeps three rows. A file picker uses the last of
            // them for the selected file's preview instead of a fourth match.
            if composer.overlay == prompt_edit::Overlay::FilePick && lines.len() > 3 {
                let preview = lines[lines.len() - 1];
                lines.truncate(2);
                lines.push(preview);
            } else {
                lines.truncate(3);
            }
            notice.push('\n');
            notice.push_str(&lines.join("\n"));
        }
        if screen == ScreenMode::Minimal && !shown_hint.is_empty() {
            notice.push('\n');
            notice.push_str(&shown_hint);
        }
        if screen == ScreenMode::Fullscreen && !matches!(overlay, Overlay::Feedback(_)) {
            sync_nav_viewport(&mut nav, &turns, &terminal, &composer, &notice)?;
            if nav.prefs.dock_enabled
                && matches!(nav.overlay, NavOverlay::None)
                && hint != navigation::dock_message(true)
            {
                hint = navigation::dock_message(true).into();
            }
        }
        let _ = guard.set_mouse(screen == ScreenMode::Fullscreen && nav.mouse_captured);
        let memory_store = memory_store(&effective).ok();
        let feedback_open = matches!(overlay, Overlay::Feedback(_));
        let session_nav = (screen == ScreenMode::Fullscreen && !feedback_open).then_some(&nav);
        let mut memory_browser = match &mut overlay {
            Overlay::Memory(browser) if !browser.force_off => Some(std::mem::take(browser)),
            _ => None,
        };
        nav_layout = if let (Some(browser), Some(store)) =
            (memory_browser.as_mut(), memory_store.as_ref())
        {
            paint_memory(
                &mut terminal,
                screen,
                &composer,
                &notice,
                selected,
                &live_theme,
                effective.appearance.compact_mode,
                &mut ui_overlay,
                feedback_open,
                session_nav,
                Some(browser),
                Some(store),
                tasks.as_mut().map(|modal| (&board, modal)),
                Some(&mut side.ask),
            )?
        } else {
            paint_memory(
                &mut terminal,
                screen,
                &composer,
                &notice,
                selected,
                &live_theme,
                effective.appearance.compact_mode,
                &mut ui_overlay,
                feedback_open,
                session_nav,
                None,
                None,
                tasks.as_mut().map(|modal| (&board, modal)),
                Some(&mut side.ask),
            )?
        };
        if let (Some(browser), Overlay::Memory(slot)) = (memory_browser, &mut overlay) {
            *slot = browser;
        }
        if open_dashboard_at_start && matches!(overlay, Overlay::None) && client.is_some() {
            open_dashboard_at_start = false;
            if screen == ScreenMode::Minimal {
                hint = session_catalog::minimal_dashboard_refusal().into();
            } else if let Err(error) =
                open_dashboard_overlay(&mut overlay, &effective, client.as_ref())
            {
                last_error = error;
            }
            continue;
        }
        if !event::poll(Duration::from_millis(80))? {
            continue;
        }
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Release => {
                voice_release_supported = true;
                if matches!(overlay, Overlay::None)
                    && ui_overlay.is_none()
                    && matches!(nav.overlay, NavOverlay::None)
                {
                    let host = HostContext {
                        inflight,
                        minimal: screen == ScreenMode::Minimal,
                        voice_release: true,
                    };
                    if let PromptAction::Voice(VoiceGesture::Release) =
                        composer.handle_key(key, host)
                    {
                        apply_voice_gesture(
                            VoiceGesture::Release,
                            &mut voice,
                            &mut composer,
                            &mut hint,
                            &mut last_error,
                        );
                    }
                }
                continue;
            }
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('q') {
                    if let (Some(turn), Some(active)) = (turns.last_mut(), client.as_mut())
                        && let Some(permission) = turn.permission.take()
                    {
                        let _ = active.cancel_permission(&permission.request_id);
                    }
                    break;
                }
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('d')
                    && !(screen == ScreenMode::Fullscreen
                        && matches!(overlay, Overlay::None)
                        && nav.focus == Focus::Scrollback)
                {
                    if let (Some(turn), Some(active)) = (turns.last_mut(), client.as_mut())
                        && let Some(permission) = turn.permission.take()
                    {
                        let _ = active.cancel_permission(&permission.request_id);
                    }
                    break;
                }
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('p')
                    && matches!(overlay, Overlay::None)
                    && matches!(nav.overlay, NavOverlay::None)
                {
                    hint = navigation::PALETTE_UNSUPPORTED.into();
                    continue;
                }
                if !ui_overlay.is_none() {
                    let action = settings_ui::handle_key(
                        &mut ui_overlay,
                        key,
                        &effective.appearance,
                        screen,
                    );
                    apply_overlay_action(
                        action,
                        &mut effective,
                        &mut live_theme_kind,
                        &mut live_theme,
                        screen,
                        &mut hint,
                        &mut last_error,
                        &mut status_runtime,
                        &mut prefs,
                        &mut ui_overlay,
                    );
                    continue;
                }
                if let Some(modal) = tasks.as_mut() {
                    if handle_tasks_key(
                        key,
                        modal,
                        &mut board,
                        &effective.dsh_home,
                        client.as_ref(),
                        &mut side,
                    ) {
                        tasks = None;
                    }
                    continue;
                }
                // Ctrl+B: move the running foreground command to the
                // background. dsh keeps the same process; the model gets its
                // job id and is told when it finishes.
                if key.modifiers == KeyModifiers::CONTROL
                    && matches!(key.code, KeyCode::Char('b'))
                    && matches!(overlay, Overlay::None)
                    && matches!(nav.overlay, NavOverlay::None)
                {
                    hint = if !inflight || compacting {
                        "no foreground command is running (Ctrl+B moves a running command)".into()
                    } else {
                        match client.as_ref() {
                            Some(active) if active.control_ready() => {
                                side.next_control += 1;
                                let id = format!("g{}", side.next_control);
                                match active.send_background(&id, "user") {
                                    Ok(()) => {
                                        side.background_request = Some(id);
                                        "moving the running command to the background…".into()
                                    }
                                    Err(error) => format!("Ctrl+B unavailable: {error}"),
                                }
                            }
                            Some(active) => {
                                format!("Ctrl+B unavailable: {}", active.control_unavailable())
                            }
                            None => "Ctrl+B unavailable: dsh is not connected".into(),
                        }
                    };
                    continue;
                }
                if screen == ScreenMode::Fullscreen
                    && key.modifiers == KeyModifiers::CONTROL
                    && matches!(key.code, KeyCode::Char('g'))
                    && matches!(overlay, Overlay::None)
                    && matches!(nav.overlay, NavOverlay::None)
                {
                    tasks = Some(subagents::TasksModal::default());
                    continue;
                }
                // Ticket 179: a pending approval outranks the question card
                // and the plan review; both wait until it is answered.
                let permission_pending = turns.last().is_some_and(|turn| turn.permission.is_some());
                if !permission_pending
                    && matches!(overlay, Overlay::None)
                    && matches!(nav.overlay, NavOverlay::None)
                {
                    if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('t') {
                        side.ask.todos_hidden = !side.ask.todos_hidden;
                        hint = if side.ask.todos.is_none() {
                            "no todos in this turn".into()
                        } else if side.ask.todos_hidden {
                            "todos hidden (Ctrl+T shows them)".into()
                        } else {
                            String::new()
                        };
                        continue;
                    }
                    if key.code == KeyCode::BackTab && !side.ask.open() {
                        hint = match cycle_plan_mode(&mut side, client.as_ref(), &mut effective) {
                            Ok(message) | Err(message) => message,
                        };
                        continue;
                    }
                    let (used, printed) = handle_interaction_key(
                        key,
                        &mut side,
                        &mut composer,
                        client.as_ref(),
                        &mut hint,
                        screen == ScreenMode::Minimal,
                        &effective.grok_home,
                    );
                    if let Some(text) = printed {
                        history.push_str(&text);
                        let _ = with_synchronized_output(&mut terminal, |terminal| {
                            emit_to_scrollback(terminal, &text)
                        });
                    }
                    if used {
                        continue;
                    }
                }
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && matches!(key.code, KeyCode::Char('c'))
                {
                    if composer.queue_pane.is_some() {
                        composer.queue_pane = None;
                        continue;
                    }
                    if composer.cancel_queue_edit() {
                        hint = std::mem::take(&mut composer.footer_notice);
                        continue;
                    }
                    if !composer.is_empty() {
                        if !composer.text().is_empty() {
                            let discarded = composer.text().to_string();
                            composer.record_history(&discarded);
                        }
                        composer.set_text("");
                        composer.slash_stash.clear();
                        composer.stash.clear();
                        composer.overlay = prompt_edit::Overlay::None;
                        selected = None;
                        hint.clear();
                        continue;
                    }
                    if turns.last().is_some_and(|turn| turn.cancelling) {
                        break;
                    }
                    if inflight {
                        if let Some(active) = client.as_mut() {
                            match active.cancel_prompt() {
                                Ok(()) => {
                                    if compacting {
                                        compact_cancelled = true;
                                    }
                                    if let Some(turn) = turns.last_mut() {
                                        turn.permission = None;
                                        turn.cancelling = true;
                                        for tool in &mut turn.tools {
                                            if tool.status == "pending"
                                                || tool.status == "in_progress"
                                            {
                                                tool.status = "cancelled".into();
                                            }
                                        }
                                    }
                                    last_error.clear();
                                    hint.clear();
                                }
                                Err(error) => last_error = error.message,
                            }
                        }
                        continue;
                    }
                    if turns.is_empty() {
                        break;
                    }
                    continue;
                }

                if let Overlay::Feedback(_) = &overlay
                    && let Some(form_key) = feedback_form_key(key)
                {
                    let session_id = feedback_session_id(client.as_ref());
                    let policy = privacy::PrivacyPolicy::from_config(&effective);
                    let slash_log = privacy_cmd::debug_log_path(&effective.dsh_home);
                    let store = match privacy::session_dir(&effective.dsh_home, &session_id)
                        .map(|dir| privacy::DraftStore::new(&dir))
                    {
                        Ok(store) => store,
                        Err(error) => {
                            last_error = error.to_string();
                            continue;
                        }
                    };
                    let mut submit = |id: &str| {
                        privacy_cmd::run(
                            &privacy_cmd::FeedbackCommand::Submit {
                                session: session_id.clone(),
                                id: id.to_string(),
                            },
                            &effective.dsh_home,
                            &policy,
                            slash_log.as_deref(),
                        )
                    };
                    if let Overlay::Feedback(form) = &mut overlay {
                        match form.handle(form_key, &store, &mut submit) {
                            feedback_ui::FeedbackAction::Close => {
                                overlay = Overlay::None;
                                hint.clear();
                            }
                            feedback_ui::FeedbackAction::None => {}
                            feedback_ui::FeedbackAction::Saved(message)
                            | feedback_ui::FeedbackAction::Sent(message) => {
                                hint = message;
                                last_error.clear();
                            }
                            feedback_ui::FeedbackAction::Failed(message) => {
                                last_error = message;
                            }
                        }
                    }
                    continue;
                }
                if matches!(overlay, Overlay::Feedback(_)) {
                    continue;
                }
                if matches!(
                    overlay,
                    Overlay::SessionPick { .. }
                        | Overlay::Dashboard(_)
                        | Overlay::Location { .. }
                        | Overlay::DeleteConfirm { .. }
                        | Overlay::Memory(_)
                        | Overlay::Remember { .. }
                ) && handle_catalog_overlay_key(
                    key,
                    &mut overlay,
                    &mut client,
                    &mut owner,
                    &mut turns,
                    &mut committed,
                    &mut history,
                    &mut resumed,
                    &mut previous_session,
                    &mut effective,
                    &mut extra_env,
                    &mut patch,
                    &mut apply_failed,
                    &mut selection_ready,
                    &mut hint,
                    &mut last_error,
                    &mut terminal,
                    screen,
                    &launch,
                    &mut memory_session_on,
                    &mut memory_injected,
                )? {
                    continue;
                }

                if matches!(overlay, Overlay::None) && ui_overlay.is_none() {
                    let tab_for_composer = composer.overlay != prompt_edit::Overlay::None
                        || composer.text().starts_with('/')
                        || composer.text().starts_with('!')
                        || composer.text().contains('@');
                    match nav.handle_key_with_prompt(
                        key,
                        screen == ScreenMode::Fullscreen,
                        composer.is_empty() || !tab_for_composer,
                    ) {
                        NavCommand::Consume | NavCommand::ToggleMouse => {
                            match &nav.overlay {
                                NavOverlay::Search(_) | NavOverlay::Jump(_) => {
                                    hint = nav.overlay_text();
                                }
                                // The viewer body is the transcript. Putting it in the
                                // notice paints the tail a second time under the slot.
                                NavOverlay::Viewer(_) => {
                                    hint.clear();
                                }
                                NavOverlay::None
                                    if hint.starts_with("Find:")
                                        || hint.contains("Jump to which turn")
                                        || hint.starts_with("Viewer")
                                        || hint.starts_with("full content") =>
                                {
                                    hint.clear();
                                }
                                NavOverlay::None => {}
                            }
                            continue;
                        }
                        NavCommand::CopyBlock => {
                            if nav.focus == Focus::Scrollback && nav.copy_target().is_none() {
                                copy_selected_original(
                                    &turns,
                                    &nav,
                                    &effective.grok_home,
                                    &mut hint,
                                );
                            } else if let Some(text) = nav.copy_target() {
                                hint = format!("Copied {} bytes.", text.len());
                                let _ = write!(io::stdout(), "{}", navigation::osc52(&text));
                                let _ = io::stdout().flush();
                            }
                            continue;
                        }
                        NavCommand::TypePrompt | NavCommand::None => {}
                    }
                }

                if effective.trust_prompt
                    && client.is_none()
                    && key.modifiers.is_empty()
                    && matches!(key.code, KeyCode::Char('y') | KeyCode::Char('n'))
                {
                    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
                    let grok_home = effective.grok_home.clone();
                    let key_path = trust::workspace_key(&effective.cwd, &home);
                    if key.code == KeyCode::Char('y') {
                        let outcome =
                            trust::grant_folder_trust_key(Some(&grok_home), &home, &key_path);
                        if matches!(
                            outcome,
                            trust::GrantOutcome::Granted {
                                persist: trust::PersistStatus::ProcessLocalOnly { .. },
                                ..
                            }
                        ) {
                            last_error = outcome.to_string();
                        }
                    } else {
                        trust::remember_process_decision(&key_path, false);
                    }
                    effective = load_runtime_config(&launch);
                    let applied = runtime_apply(&effective);
                    extra_env = applied.extra_env;
                    if applied.apply_failed {
                        last_error = applied.error;
                        apply_failed = true;
                    } else {
                        patch = applied.patch;
                        apply_failed = false;
                    }
                    previous_ready = effective.ready;
                    if can_execute(&effective, apply_failed) {
                        let mut live = LiveSession {
                            client: &mut client,
                            owner: &mut owner,
                            turns: &mut turns,
                            resumed: &mut resumed,
                            previous_session: &mut previous_session,
                            selection_ready: &mut selection_ready,
                            last_error: &mut last_error,
                        };
                        if let Err(error) = open_live_session(
                            &mode,
                            &extra_env,
                            patch.as_ref(),
                            &mut effective,
                            &mut live,
                        ) {
                            last_error = error;
                        }
                    } else if last_error.is_empty() {
                        last_error = effective.first_run_message();
                        if last_error.is_empty() {
                            last_error = effective.trust_message.clone();
                        }
                    }
                    continue;
                }

                if key.modifiers.is_empty() || key.modifiers == KeyModifiers::CONTROL {
                    if let Overlay::Plugins(plugin_overlay) = &mut overlay {
                        let env = std::env::vars().collect();
                        let snapshot = plugin::inspect(
                            &effective.grok_home,
                            &effective.cwd,
                            &env,
                            effective.workspace_trusted,
                        );
                        let tab = key.code == KeyCode::Tab;
                        let enter = key.code == KeyCode::Enter;
                        let esc = key.code == KeyCode::Esc;
                        let ch = match key.code {
                            KeyCode::Char(value) => value,
                            KeyCode::Down => 'j',
                            KeyCode::Up => 'k',
                            _ => '\0',
                        };
                        let action = plugin::handle_overlay_key_with_home(
                            plugin_overlay,
                            &snapshot,
                            Some(&effective.grok_home),
                            ch,
                            enter,
                            tab,
                            esc,
                        );
                        match action {
                            plugin::OverlayAction::Close => {
                                // Opening /plugins clears the hint, so what is left
                                // is the last enable/disable/uninstall result.
                                overlay = Overlay::None;
                            }
                            plugin::OverlayAction::Continue => {}
                            plugin::OverlayAction::Run(command) => {
                                match plugin::run(
                                    &effective.grok_home,
                                    &effective.cwd,
                                    &env,
                                    effective.workspace_trusted,
                                    &command,
                                ) {
                                    Ok(message) => {
                                        hint = message;
                                        last_error.clear();
                                        // The slash menu and the next prompt see the
                                        // plugin's skills and commands right away.
                                        let home = std::env::var_os("HOME")
                                            .map(PathBuf::from)
                                            .unwrap_or_else(|| effective.grok_home.clone());
                                        config::refresh_assets(&mut effective, &home);
                                        composer.asset_commands =
                                            assets::menu_entries(&effective.assets);
                                        sync_workflow_scope(&mut composer, &effective);
                                    }
                                    Err(error) => last_error = error.message,
                                }
                            }
                        }
                        continue;
                    }
                    match &overlay {
                        Overlay::RewindPick { points, cursor } => match key.code {
                            KeyCode::Up | KeyCode::Char('k') => {
                                if *cursor > 0
                                    && let Overlay::RewindPick { cursor, .. } = &mut overlay
                                {
                                    *cursor -= 1;
                                }
                                continue;
                            }
                            KeyCode::Down | KeyCode::Char('j') => {
                                if *cursor + 1 < points.len()
                                    && let Overlay::RewindPick { cursor, .. } = &mut overlay
                                {
                                    *cursor += 1;
                                }
                                continue;
                            }
                            KeyCode::Enter => {
                                let Some(point) = points.get(*cursor).cloned() else {
                                    overlay = Overlay::None;
                                    continue;
                                };
                                if prefs.confirm_before_rewind {
                                    overlay = Overlay::RewindConfirm { point };
                                } else if let Some(active) = client.as_mut() {
                                    match commit_rewind(
                                        active,
                                        &mut owner,
                                        &mut turns,
                                        &effective.dsh_home,
                                        &effective.cwd,
                                        &point,
                                        &mut resumed,
                                        &mut previous_session,
                                        &mut memory_session_on,
                                        &mut memory_injected,
                                    ) {
                                        Ok(message) => {
                                            overlay = Overlay::None;
                                            hint = message;
                                            last_error.clear();
                                            composer.set_text("");
                                            if let Err(error) = reset_native_history_after_switch(
                                                &mut terminal,
                                                screen,
                                                &mut committed,
                                                &mut history,
                                            ) {
                                                last_error = error.to_string();
                                            }
                                        }
                                        Err(error) => last_error = error,
                                    }
                                }
                                continue;
                            }
                            KeyCode::Esc => {
                                overlay = Overlay::None;
                                hint.clear();
                                last_esc = None;
                                continue;
                            }
                            _ => {}
                        },
                        Overlay::RewindConfirm { point } => match key.code {
                            KeyCode::Char('y') | KeyCode::Enter => {
                                let point = point.clone();
                                if let Some(active) = client.as_mut() {
                                    match commit_rewind(
                                        active,
                                        &mut owner,
                                        &mut turns,
                                        &effective.dsh_home,
                                        &effective.cwd,
                                        &point,
                                        &mut resumed,
                                        &mut previous_session,
                                        &mut memory_session_on,
                                        &mut memory_injected,
                                    ) {
                                        Ok(message) => {
                                            overlay = Overlay::None;
                                            hint = message;
                                            last_error.clear();
                                            composer.set_text("");
                                            if let Err(error) = reset_native_history_after_switch(
                                                &mut terminal,
                                                screen,
                                                &mut committed,
                                                &mut history,
                                            ) {
                                                last_error = error.to_string();
                                            }
                                        }
                                        Err(error) => last_error = error,
                                    }
                                }
                                continue;
                            }
                            KeyCode::Char('a') => {
                                prefs.confirm_before_rewind = false;
                                effective.appearance.confirm_before_rewind = false;
                                let _ = session_fork::save_confirm_before_rewind(
                                    &effective.grok_home,
                                    false,
                                );
                                let point = point.clone();
                                if let Some(active) = client.as_mut() {
                                    match commit_rewind(
                                        active,
                                        &mut owner,
                                        &mut turns,
                                        &effective.dsh_home,
                                        &effective.cwd,
                                        &point,
                                        &mut resumed,
                                        &mut previous_session,
                                        &mut memory_session_on,
                                        &mut memory_injected,
                                    ) {
                                        Ok(message) => {
                                            overlay = Overlay::None;
                                            hint = message;
                                            last_error.clear();
                                            composer.set_text("");
                                            if let Err(error) = reset_native_history_after_switch(
                                                &mut terminal,
                                                screen,
                                                &mut committed,
                                                &mut history,
                                            ) {
                                                last_error = error.to_string();
                                            }
                                        }
                                        Err(error) => last_error = error,
                                    }
                                }
                                continue;
                            }
                            KeyCode::Char('n') | KeyCode::Esc => {
                                overlay = Overlay::None;
                                hint = "nothing rewound".into();
                                continue;
                            }
                            _ => {}
                        },
                        Overlay::None | Overlay::Plugins(_) | Overlay::Feedback(_) => {}
                        Overlay::SessionPick { .. }
                        | Overlay::Dashboard(_)
                        | Overlay::Location { .. }
                        | Overlay::DeleteConfirm { .. }
                        | Overlay::Memory(_)
                        | Overlay::Remember { .. } => {}
                    }
                }

                if key.modifiers.is_empty()
                    && key.code == KeyCode::Char('y')
                    && composer.is_empty()
                    && !turns.last().is_some_and(|turn| turn.permission.is_some())
                    && screen == ScreenMode::Minimal
                {
                    if let Some(index) = turns.len().checked_sub(1) {
                        nav.selected = Some(index);
                        nav.focus = Focus::Scrollback;
                        copy_selected_original(&turns, &nav, &effective.grok_home, &mut hint);
                        nav.focus = Focus::Prompt;
                    }
                    continue;
                }
                if let (Some(turn), Some(active)) = (turns.last_mut(), client.as_mut())
                    && let Some(permission) = turn.permission.clone()
                    && key.modifiers.is_empty()
                    && composer.is_empty()
                {
                    let option = match key.code {
                        KeyCode::Char('y') | KeyCode::Enter => Some(("allow-once", false)),
                        KeyCode::Char('a') => Some(("allow-once", true)),
                        KeyCode::Char('n') => Some(("reject-once", false)),
                        _ => None,
                    };
                    if let Some((option_id, remember)) = option {
                        match active.answer_permission(&permission.request_id, option_id) {
                            Ok(()) => {
                                last_error.clear();
                                if option_id == "allow-once" && remember {
                                    hint = persist_remembered_grant(
                                        &mut effective,
                                        turn,
                                        &permission.tool_call_id,
                                    )
                                    .unwrap_or_else(|error| error);
                                } else if option_id == "allow-once" {
                                    hint = "Allowed once; not saved as a permanent rule.".into();
                                }
                                turn.permission = None;
                            }
                            Err(error) => last_error = error.message,
                        }
                        continue;
                    }
                }
                if matches!(overlay, Overlay::None)
                    && composer.overlay == prompt_edit::Overlay::None
                    && composer.queue_edit().is_none()
                {
                    let chord = is_send_now_chord(&key, term);
                    // Reference: Enter on an emptied composer sends the top
                    // queued row now (double-Enter).
                    let double_enter = key.code == KeyCode::Enter
                        && key.modifiers.is_empty()
                        && inflight
                        && composer.is_empty()
                        && composer.queue_pane.is_none()
                        && composer.queue_count() > 0;
                    if (chord && (inflight || composer.queue_pane.is_some())) || double_enter {
                        let target = if let Some(id) = composer.selected_queue_id() {
                            Some(id)
                        } else if !composer.is_empty() {
                            composer.enqueue_draft_for_send_now()
                        } else {
                            composer.queue_items().first().map(|item| item.id)
                        };
                        match target {
                            Some(id) => send_queued_now(
                                id,
                                &mut composer,
                                &mut client,
                                &mut turns,
                                inflight,
                                compacting,
                                &mut side,
                                &mut hint,
                                &mut last_error,
                            ),
                            None => {
                                if !composer.footer_notice.is_empty() {
                                    hint = std::mem::take(&mut composer.footer_notice);
                                }
                            }
                        }
                        continue;
                    }
                }
                match key.code {
                    KeyCode::Esc => {
                        if let Some(panel) = side.btw.take_if(|_| {
                            composer.overlay == prompt_edit::Overlay::None
                                && composer.queue_pane.is_none()
                                && composer.queue_edit().is_none()
                        }) {
                            // A late answer for this id is dropped from now on.
                            if panel.state == BtwState::Loading
                                && let Some(active) = client.as_ref()
                            {
                                active.cancel_btw(&panel.id);
                            }
                            hint = "side answer dismissed".into();
                            continue;
                        }
                        let host = HostContext {
                            inflight,
                            minimal: screen == ScreenMode::Minimal,
                            voice_release: voice_release_supported,
                        };
                        if voice.recording() {
                            handle_recording_esc(
                                key,
                                host,
                                &mut voice,
                                &mut composer,
                                &mut hint,
                                &mut last_error,
                            );
                            continue;
                        }
                        let action = composer.handle_key(key, host);
                        let composer_handled = !matches!(action, PromptAction::Unhandled);
                        if composer_handled {
                            if !composer.footer_notice.is_empty() {
                                hint = std::mem::take(&mut composer.footer_notice);
                            }
                            continue;
                        }
                        selected = None;
                        if !matches!(nav.overlay, NavOverlay::None) {
                            nav.dismiss_overlay();
                            hint.clear();
                            continue;
                        }
                        if inflight && !turns.last().is_some_and(|turn| turn.cancelling) {
                            hint = "Press Ctrl+C to cancel the turn".into();
                            last_esc = None;
                        } else if !inflight
                            && composer.is_empty()
                            && !turns.is_empty()
                            && last_esc.is_some_and(|at| at.elapsed() <= Duration::from_millis(800))
                        {
                            last_esc = None;
                            if let Some(session_id) =
                                client.as_ref().and_then(|active| active.session_id.clone())
                            {
                                match session_fork::list_points(&effective.dsh_home, &session_id) {
                                    Ok(points) if points.is_empty() => {
                                        hint = "no turns to rewind yet".into();
                                    }
                                    Ok(mut points) => {
                                        points.reverse();
                                        overlay = Overlay::RewindPick { points, cursor: 0 };
                                        hint.clear();
                                    }
                                    Err(error) => last_error = error.message,
                                }
                            }
                        } else {
                            last_esc = Some(Instant::now());
                        }
                    }
                    KeyCode::Tab => {
                        let host = HostContext {
                            inflight,
                            minimal: screen == ScreenMode::Minimal,
                            voice_release: voice_release_supported,
                        };
                        match composer.handle_key(key, host) {
                            PromptAction::Unhandled => {
                                selected = Some((selected.unwrap_or(2) + 1) % 3);
                            }
                            PromptAction::None if !composer.footer_notice.is_empty() => {
                                hint = std::mem::take(&mut composer.footer_notice);
                            }
                            _ => {}
                        }
                    }
                    KeyCode::Enter if key.modifiers.is_empty() => match selected {
                        Some(2) => break,
                        Some(1) => {
                            composer.set_text("");
                            composer.slash_stash.clear();
                        }
                        _ => {
                            let host = HostContext {
                                inflight,
                                minimal: screen == ScreenMode::Minimal,
                                voice_release: voice_release_supported,
                            };
                            match composer.handle_key(key, host) {
                                PromptAction::None => {
                                    if !composer.footer_notice.is_empty() {
                                        hint = std::mem::take(&mut composer.footer_notice);
                                    }
                                    continue;
                                }
                                PromptAction::Voice(_) | PromptAction::PasteImage => continue,
                                PromptAction::QueueSendNow(id) => {
                                    send_queued_now(
                                        id,
                                        &mut composer,
                                        &mut client,
                                        &mut turns,
                                        inflight,
                                        compacting,
                                        &mut side,
                                        &mut hint,
                                        &mut last_error,
                                    );
                                    continue;
                                }
                                PromptAction::Slash(command) => {
                                    selected = None;
                                    if command.trim() == "/tasks" {
                                        tasks = Some(subagents::TasksModal::default());
                                        hint.clear();
                                        continue;
                                    }
                                    let dispatch_result = dispatch_composer_command(
                                        &command,
                                        &mut client,
                                        &mut owner,
                                        &mut turns,
                                        &mut inflight,
                                        &mut compacting,
                                        &mut overlay,
                                        &mut ui_overlay,
                                        &mut hint,
                                        &mut last_error,
                                        &mut effective,
                                        &mut extra_env,
                                        &mut patch,
                                        &mut apply_failed,
                                        &mut previous_ready,
                                        &mut selection_ready,
                                        &mut resumed,
                                        &mut previous_session,
                                        &mut terminal,
                                        &mut guard,
                                        screen,
                                        &mut committed,
                                        &mut history,
                                        &launch,
                                        &mode,
                                        &mut prefs,
                                        &meter,
                                        policy,
                                        &mut nav,
                                        &mut live_theme_kind,
                                        &mut live_theme,
                                        &mut status_runtime,
                                        &mut composer,
                                        &mut voice,
                                        &mut memory_session_on,
                                        &mut memory_injected,
                                        &mut side,
                                    );
                                    if let Err(error) = dispatch_result {
                                        if let Some(rest) =
                                            error.to_string().strip_prefix("CODSH_SCREEN_RELAUNCH:")
                                        {
                                            let mut parts = rest.splitn(2, ':');
                                            let session_id = parts.next().unwrap_or("");
                                            let target = screen_mode::ScreenMode::parse(
                                                parts.next().unwrap_or("minimal"),
                                            )
                                            .unwrap_or(screen_mode::ScreenMode::Minimal);
                                            drop(terminal);
                                            drop(guard);
                                            restore_terminal();
                                            return Err(relaunch_exec(session_id, target));
                                        }
                                        return Err(error);
                                    }
                                    screen = if guard.alt {
                                        ScreenMode::Fullscreen
                                    } else {
                                        ScreenMode::Minimal
                                    };
                                    nav.mouse_captured = screen == ScreenMode::Fullscreen;
                                    if screen != ScreenMode::Fullscreen {
                                        nav.focus = Focus::Prompt;
                                    }
                                    live_theme_kind = effective.appearance.resolved_kind(screen);
                                    live_theme = effective.appearance.resolved_theme(screen);
                                    continue;
                                }
                                PromptAction::Submit(text) => {
                                    selected = None;
                                    if !text.trim().is_empty() {
                                        submit_composer_prompt(
                                            &text,
                                            &mut client,
                                            &mut owner,
                                            &mut turns,
                                            &mut inflight,
                                            &mut last_error,
                                            &mut effective,
                                            &mut extra_env,
                                            &mut patch,
                                            &mut apply_failed,
                                            &mut previous_ready,
                                            &mut selection_ready,
                                            &mut resumed,
                                            &mut previous_session,
                                            &launch,
                                            &mode,
                                            &mut composer,
                                            &mut memory_session_on,
                                            &mut memory_injected,
                                        );
                                    }
                                    if inflight {
                                        composer.accept_pending_submit();
                                    } else {
                                        composer.restore_pending_submit();
                                    }
                                    continue;
                                }
                                PromptAction::External { preserve } => {
                                    selected = None;
                                    let kept = composer.text().to_string();
                                    match run_external_prompt_edit(
                                        &mut terminal,
                                        &mut guard,
                                        screen,
                                        &composer,
                                        preserve,
                                    ) {
                                        Ok(Some(saved)) => {
                                            composer.set_text(&saved);
                                            hint = if saved.is_empty() {
                                                "external editor cleared the draft".into()
                                            } else {
                                                "external editor updated the draft".into()
                                            };
                                            last_error.clear();
                                        }
                                        Ok(None) => {}
                                        Err(error) => {
                                            composer.set_text(&kept);
                                            last_error = error;
                                        }
                                    }
                                    continue;
                                }
                                PromptAction::Unhandled => continue,
                            }
                        }
                    },
                    _ => {
                        let host = HostContext {
                            inflight,
                            minimal: screen == ScreenMode::Minimal,
                            voice_release: voice_release_supported,
                        };
                        match composer.handle_key(key, host) {
                            PromptAction::None => {
                                if !composer.footer_notice.is_empty() {
                                    hint = std::mem::take(&mut composer.footer_notice);
                                }
                            }
                            PromptAction::Voice(gesture) => {
                                apply_voice_gesture(
                                    gesture,
                                    &mut voice,
                                    &mut composer,
                                    &mut hint,
                                    &mut last_error,
                                );
                            }
                            PromptAction::PasteImage => {
                                attach_clipboard_image(&mut composer, &mut hint, &mut last_error);
                            }
                            PromptAction::QueueSendNow(id) => {
                                send_queued_now(
                                    id,
                                    &mut composer,
                                    &mut client,
                                    &mut turns,
                                    inflight,
                                    compacting,
                                    &mut side,
                                    &mut hint,
                                    &mut last_error,
                                );
                            }
                            PromptAction::Unhandled => {
                                selected = None;
                                if inflight && !turns.last().is_some_and(|turn| turn.cancelling) {
                                    hint = "Press Ctrl+C to cancel the turn".into();
                                    last_esc = None;
                                } else if !inflight
                                    && composer.is_empty()
                                    && !turns.is_empty()
                                    && last_esc.is_some_and(|at| {
                                        at.elapsed() <= Duration::from_millis(800)
                                    })
                                {
                                    last_esc = None;
                                    if let Some(session_id) =
                                        client.as_ref().and_then(|active| active.session_id.clone())
                                    {
                                        match session_fork::list_points(
                                            &effective.dsh_home,
                                            &session_id,
                                        ) {
                                            Ok(points) if points.is_empty() => {
                                                hint = "no turns to rewind yet".into();
                                            }
                                            Ok(mut points) => {
                                                points.reverse();
                                                overlay = Overlay::RewindPick { points, cursor: 0 };
                                                hint.clear();
                                            }
                                            Err(error) => last_error = error.message,
                                        }
                                    }
                                } else {
                                    last_esc = Some(Instant::now());
                                }
                            }
                            PromptAction::Slash(command) => {
                                selected = None;
                                if command.trim() == "/tasks" {
                                    tasks = Some(subagents::TasksModal::default());
                                    hint.clear();
                                    continue;
                                }
                                let dispatch_result = dispatch_composer_command(
                                    &command,
                                    &mut client,
                                    &mut owner,
                                    &mut turns,
                                    &mut inflight,
                                    &mut compacting,
                                    &mut overlay,
                                    &mut ui_overlay,
                                    &mut hint,
                                    &mut last_error,
                                    &mut effective,
                                    &mut extra_env,
                                    &mut patch,
                                    &mut apply_failed,
                                    &mut previous_ready,
                                    &mut selection_ready,
                                    &mut resumed,
                                    &mut previous_session,
                                    &mut terminal,
                                    &mut guard,
                                    screen,
                                    &mut committed,
                                    &mut history,
                                    &launch,
                                    &mode,
                                    &mut prefs,
                                    &meter,
                                    policy,
                                    &mut nav,
                                    &mut live_theme_kind,
                                    &mut live_theme,
                                    &mut status_runtime,
                                    &mut composer,
                                    &mut voice,
                                    &mut memory_session_on,
                                    &mut memory_injected,
                                    &mut side,
                                );
                                if let Err(error) = dispatch_result {
                                    if let Some(rest) =
                                        error.to_string().strip_prefix("CODSH_SCREEN_RELAUNCH:")
                                    {
                                        let mut parts = rest.splitn(2, ':');
                                        let session_id = parts.next().unwrap_or("");
                                        let target = screen_mode::ScreenMode::parse(
                                            parts.next().unwrap_or("minimal"),
                                        )
                                        .unwrap_or(screen_mode::ScreenMode::Minimal);
                                        drop(terminal);
                                        drop(guard);
                                        restore_terminal();
                                        return Err(relaunch_exec(session_id, target));
                                    }
                                    return Err(error);
                                }
                                screen = if guard.alt {
                                    ScreenMode::Fullscreen
                                } else {
                                    ScreenMode::Minimal
                                };
                                live_theme_kind = effective.appearance.resolved_kind(screen);
                                live_theme = effective.appearance.resolved_theme(screen);
                            }
                            PromptAction::Submit(text) => {
                                selected = None;
                                if text.trim().is_empty() {
                                    continue;
                                }
                                submit_composer_prompt(
                                    &text,
                                    &mut client,
                                    &mut owner,
                                    &mut turns,
                                    &mut inflight,
                                    &mut last_error,
                                    &mut effective,
                                    &mut extra_env,
                                    &mut patch,
                                    &mut apply_failed,
                                    &mut previous_ready,
                                    &mut selection_ready,
                                    &mut resumed,
                                    &mut previous_session,
                                    &launch,
                                    &mode,
                                    &mut composer,
                                    &mut memory_session_on,
                                    &mut memory_injected,
                                );
                                if inflight {
                                    composer.accept_pending_submit();
                                } else {
                                    composer.restore_pending_submit();
                                }
                            }
                            PromptAction::External { preserve } => {
                                selected = None;
                                let kept = composer.text().to_string();
                                match run_external_prompt_edit(
                                    &mut terminal,
                                    &mut guard,
                                    screen,
                                    &composer,
                                    preserve,
                                ) {
                                    Ok(Some(saved)) => {
                                        composer.set_text(&saved);
                                        hint = if saved.is_empty() {
                                            "external editor cleared the draft".into()
                                        } else {
                                            "external editor updated the draft".into()
                                        };
                                        last_error.clear();
                                    }
                                    Ok(None) => {}
                                    Err(error) => {
                                        composer.set_text(&kept);
                                        last_error = error;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Event::Paste(text) => {
                selected = None;
                if let NavOverlay::Search(search) = &mut nav.overlay
                    && search.composing
                {
                    search.query.push_str(&text.replace(['\n', '\r'], ""));
                    nav.refresh_search();
                    hint = nav.overlay_text();
                } else if text.trim().is_empty() {
                    // Cmd+V on an image-only clipboard reaches the app as an
                    // empty bracketed paste. The reference reads the clipboard
                    // image then; this client implements that on macOS only.
                    match images::empty_paste_route(std::env::consts::OS) {
                        images::EmptyPaste::ReadClipboard => {
                            attach_clipboard_image(&mut composer, &mut hint, &mut last_error);
                        }
                        images::EmptyPaste::Unavailable(notice) => hint = notice.to_string(),
                        images::EmptyPaste::Ignore => {}
                    }
                } else {
                    composer.paste(&text);
                    if !composer.footer_notice.is_empty() {
                        hint = std::mem::take(&mut composer.footer_notice);
                        last_error.clear();
                    }
                }
            }
            Event::Mouse(mouse) => {
                if matches!(mouse.kind, MouseEventKind::Moved) && ui_overlay.is_none() {
                    composer.hover_image(mouse, nav_layout.prompt);
                }
                if !ui_overlay.is_none() {
                    let area = terminal
                        .size()
                        .map(|size| ratatui::layout::Rect {
                            x: 0,
                            y: 0,
                            width: size.width,
                            height: size.height,
                        })
                        .unwrap_or_default();
                    let action = settings_ui::handle_mouse(
                        &mut ui_overlay,
                        mouse,
                        area,
                        &effective.appearance,
                    );
                    apply_overlay_action(
                        action,
                        &mut effective,
                        &mut live_theme_kind,
                        &mut live_theme,
                        screen,
                        &mut hint,
                        &mut last_error,
                        &mut status_runtime,
                        &mut prefs,
                        &mut ui_overlay,
                    );
                } else if screen == ScreenMode::Fullscreen && matches!(overlay, Overlay::None) {
                    match nav.handle_mouse(mouse, nav_layout, true) {
                        NavCommand::CopyBlock => {
                            if let Some(text) = nav.copy_target() {
                                hint = format!("Copied {} bytes.", text.len());
                                let _ = write!(io::stdout(), "{}", navigation::osc52(&text));
                                let _ = io::stdout().flush();
                            }
                        }
                        NavCommand::Consume | NavCommand::ToggleMouse => {}
                        NavCommand::TypePrompt => {
                            nav.focus = Focus::Prompt;
                        }
                        NavCommand::None => {}
                    }
                }
                let _ = MouseEventKind::Moved;
            }
            Event::Resize(width, height) => {
                terminal.autoresize()?;
                if screen == ScreenMode::Minimal {
                    resize_purge_rerender(&mut terminal, &history)?;
                } else {
                    let chrome_height = welcome::session_chrome_height(&nav);
                    let notice_height = welcome::session_notice_height(&notice);
                    let input_height = welcome::session_input_height(&composer.draft, width);
                    nav.sync_entries(
                        nav_entries(&turns),
                        width.saturating_sub(navigation::TRANSCRIPT_GUTTER).max(20),
                        welcome::session_transcript_height(
                            height,
                            chrome_height,
                            notice_height,
                            input_height,
                        )
                        .max(3),
                    );
                }
            }
            _ => {}
        }
    }
    status_runtime.shutdown();
    drop_connection(&mut client, &mut owner);
    subagents::cleanup(&effective.dsh_home);
    Ok(())
}

/// Move subagent lifecycle lines onto the board and keep every other event.
/// A background child that settles, or a refused spawn, becomes the hint.
fn absorb_subagent_events(
    board: &mut subagents::Board,
    events: Vec<AcpEvent>,
    hint: &mut String,
) -> Vec<AcpEvent> {
    let mut rest = Vec::with_capacity(events.len());
    for event in events {
        match event {
            AcpEvent::Subagent { event } => {
                if let Some(subagents::Notice(text)) = board.apply(&event) {
                    // Restored loops fire at once; their notices would hide
                    // the restore hint before it was ever drawn.
                    let restoring = board.schedules.restore_hint_fresh()
                        && (hint.starts_with("Restored ") || hint.starts_with("Saved loops"));
                    if !restoring {
                        *hint = text;
                    }
                }
            }
            AcpEvent::Schedule { event } => {
                if let Some(text) = board.schedules.apply(&event) {
                    *hint = text;
                }
            }
            other => rest.push(other),
        }
    }
    rest
}

/// A turn dsh opened on its own: a finished background command (or child)
/// woke the idle agent. It closes when the agent goes idle again.
#[derive(Debug)]
struct Wake {
    /// dsh reported idle at this moment; the turn closes once the last
    /// updates of the turn (stdout, a separate pipe) had time to arrive.
    idle_at: Option<Instant>,
    /// Opened before its notice arrived; the notice renames it.
    generic: bool,
}

const WAKE_SETTLE: Duration = Duration::from_millis(150);

fn background_turn(user: String) -> Turn {
    Turn {
        user,
        thought: String::new(),
        answer: String::new(),
        error: None,
        message_id: None,
        tools: Vec::new(),
        permission: None,
        done: false,
        cancelling: false,
        cancelled: false,
        interrupted: false,
        compacted: false,
        compaction: None,
        timestamp: Some(clock_stamp()),
        quiet_cancel: false,
    }
}

fn turn_is_empty(turn: &Turn) -> bool {
    turn.message_id.is_none()
        && turn.tools.is_empty()
        && turn.answer.is_empty()
        && turn.thought.is_empty()
}

/// A message dsh gave the model on its own (a finished command, a goal
/// round) opens its own transcript turn: mid-turn after the current one,
/// renaming a generic wake turn that has nothing yet, or as a wake turn on
/// an idle agent. During compaction it is only a hint.
fn open_notice_turn(
    turns: &mut Vec<Turn>,
    inflight: &mut bool,
    wake: &mut Option<Wake>,
    hint: &mut String,
    compacting: bool,
    line: String,
) {
    if compacting {
        *hint = line;
    } else if !*inflight {
        turns.push(background_turn(line));
        *inflight = true;
        *wake = Some(Wake {
            idle_at: None,
            generic: false,
        });
    } else if let Some(open) = wake.as_mut().filter(|open| open.generic)
        && let Some(turn) = turns.last_mut().filter(|turn| turn_is_empty(turn))
    {
        turn.user = line;
        open.generic = false;
    } else {
        // dsh took the message into the running turn at a step boundary;
        // what follows answers it.
        if let Some(previous) = turns.last_mut() {
            previous.done = true;
            previous.permission = None;
        }
        turns.push(background_turn(line));
        if let Some(open) = wake.as_mut() {
            open.generic = false;
        }
    }
}

/// Apply ACP events and background-command lines in arrival order. A
/// completion notice that reaches the model opens its own transcript turn:
/// mid-turn like a claimed steer, or, on an idle agent, a wake turn that
/// holds the prompt busy until dsh goes idle again.
#[allow(clippy::too_many_arguments)]
fn apply_event_stream(
    turns: &mut Vec<Turn>,
    inflight: &mut bool,
    meter: &mut Meter,
    board: &mut subagents::Board,
    wake: &mut Option<Wake>,
    hint: &mut String,
    events: Vec<AcpEvent>,
    compacting: bool,
    inspect_auto_compact: &mut bool,
) -> Option<String> {
    let events = absorb_subagent_events(board, events, hint);
    let mut disconnect = None;
    let mut batch = Vec::new();
    let flush = |batch: &mut Vec<AcpEvent>,
                 turns: &mut Vec<Turn>,
                 inflight: &mut bool,
                 meter: &mut Meter,
                 inspect: &mut bool,
                 disconnect: &mut Option<String>| {
        if batch.is_empty() {
            return;
        }
        if let Some(detail) = apply_events(
            turns,
            inflight,
            meter,
            std::mem::take(batch),
            compacting,
            inspect,
        ) {
            *disconnect = Some(detail);
        }
    };
    for event in events {
        let event = match event {
            AcpEvent::Job { event } => event,
            AcpEvent::Goal { event } => {
                flush(
                    &mut batch,
                    turns,
                    inflight,
                    meter,
                    inspect_auto_compact,
                    &mut disconnect,
                );
                let live = board.session.clone();
                match board.goal.apply(&event) {
                    Some(goal::Signal::Round { line, session })
                        if live.as_deref() == Some(session.as_str()) =>
                    {
                        open_notice_turn(turns, inflight, wake, hint, compacting, line);
                    }
                    Some(goal::Signal::Notice { text, session })
                        if !text.is_empty() && live.as_deref() == Some(session.as_str()) =>
                    {
                        *hint = text;
                    }
                    _ => {}
                }
                continue;
            }
            other => {
                batch.push(other);
                continue;
            }
        };
        flush(
            &mut batch,
            turns,
            inflight,
            meter,
            inspect_auto_compact,
            &mut disconnect,
        );
        let live = board.session.clone();
        let ours = |session: &str| live.as_deref() == Some(session);
        match board.jobs.apply(&event) {
            None => {}
            Some(background::Signal::Hint(text)) => *hint = text,
            Some(background::Signal::Running { session }) if ours(&session) => {
                if let Some(open) = wake.as_mut() {
                    open.idle_at = None;
                } else if !*inflight && !compacting {
                    // An idle agent started a run the user did not send.
                    turns.push(background_turn(background::notice_line("")));
                    *inflight = true;
                    *wake = Some(Wake {
                        idle_at: None,
                        generic: true,
                    });
                }
            }
            Some(background::Signal::Idle { session }) if ours(&session) => {
                if let Some(open) = wake.as_mut() {
                    open.idle_at = Some(Instant::now());
                }
            }
            Some(background::Signal::Notice { session, summary }) if ours(&session) => {
                let line = background::notice_line(&summary);
                open_notice_turn(turns, inflight, wake, hint, compacting, line);
            }
            Some(_) => {}
        }
    }
    flush(
        &mut batch,
        turns,
        inflight,
        meter,
        inspect_auto_compact,
        &mut disconnect,
    );
    if !*inflight {
        // A prompt response or a disconnect ended the busy state.
        *wake = None;
    }
    disconnect
}

/// Close a wake turn once dsh is idle and the turn's last updates are in.
/// A Ctrl+C during the wake marks it cancelled like a prompt turn.
fn settle_wake(
    turns: &mut [Turn],
    inflight: &mut bool,
    wake: &mut Option<Wake>,
    last_event: Instant,
) -> bool {
    let Some(idle_at) = wake.as_ref().and_then(|open| open.idle_at) else {
        return false;
    };
    if idle_at.elapsed() < WAKE_SETTLE || last_event.elapsed() < WAKE_SETTLE {
        return false;
    }
    if let Some(turn) = turns.last_mut() {
        turn.done = true;
        turn.permission = None;
        if turn.cancelling {
            turn.cancelled = true;
            for tool in &mut turn.tools {
                if tool.status == "pending" || tool.status == "in_progress" {
                    tool.status = "cancelled".into();
                }
            }
        }
        turn.cancelling = false;
    }
    *inflight = false;
    *wake = None;
    true
}

/// The last turn has a shell command dsh is still running in the foreground.
fn foreground_command_running(turns: &[Turn]) -> bool {
    turns.last().is_some_and(|turn| {
        !turn.done
            && turn.tools.iter().any(|tool| {
                (tool.status == "pending" || tool.status == "in_progress")
                    && (tool.kind == "execute" || content::is_shell_tool(&tool.title))
            })
    })
}

/// A restored history that started background commands: say they are gone.
fn restored_background_hint(turns: &[Turn]) -> Option<&'static str> {
    turns
        .iter()
        .flat_map(|turn| turn.tools.iter())
        .any(|tool| background::mentions_background(&tool.result))
        .then_some(background::RESTORED_HINT)
}

/// The tool block of each known child reads as its lifecycle line. dsh sends
/// the plain tool title; the board's line replaces it on every frame, so a
/// late dsh update or a reload after /compact cannot bring back a stale one.
fn decorate_subagent_blocks(turns: &mut [Turn], board: &subagents::Board) {
    if board.entries.is_empty() && board.workflows.is_empty() {
        return;
    }
    for turn in turns.iter_mut().rev() {
        for tool in &mut turn.tools {
            let title = if let Some(entry) = board.get(&tool.id) {
                entry.block_title()
            } else if let Some(run) = board.workflow(&tool.id) {
                run.block_title()
            } else {
                continue;
            };
            if tool.title != title {
                tool.title = title;
            }
        }
    }
}

/// Load or refresh the open child transcript. A running child is re-read at
/// most once a second; a settled one is read once more and then kept.
fn refresh_child_view(
    modal: &mut subagents::TasksModal,
    board: &subagents::Board,
    effective: &config::EffectiveConfig,
) {
    let Some(view) = modal.view.as_mut() else {
        return;
    };
    let live = board.get(&view.id).is_some_and(|entry| entry.status.live());
    let due = if live {
        view.loaded
            .is_none_or(|at| at.elapsed() >= Duration::from_secs(1))
    } else {
        !view.settled
    };
    if !due {
        return;
    }
    view.loaded = Some(Instant::now());
    view.settled = !live;
    match session_history::load_turns(&effective.dsh_home, &view.child) {
        Ok(restored) => {
            let turns: Vec<Turn> = restored.into_iter().map(turn_from_restored).collect();
            let at_bottom = view.offset + 1 >= view.lines.len();
            view.lines = render_transcript("", &turns, false)
                .lines()
                .map(str::to_string)
                .collect();
            if at_bottom {
                view.offset = view.lines.len();
            }
            view.error.clear();
        }
        Err(error) => view.error = error.message,
    }
}

/// Keys for the tasks modal. Returns true when it closes.
fn handle_tasks_key(
    key: crossterm::event::KeyEvent,
    modal: &mut subagents::TasksModal,
    board: &mut subagents::Board,
    dsh_home: &Path,
    client: Option<&AcpClient>,
    side: &mut Intervene,
) -> bool {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    if let Some(view) = modal.view.as_mut() {
        match key.code {
            KeyCode::Char('c') if ctrl => {
                let live = board.get(&view.id).is_some_and(|entry| entry.status.live());
                view.notice = if !live {
                    "this subagent already finished".into()
                } else {
                    match subagents::request_cancel(dsh_home, &view.id) {
                        Ok(()) => "cancel requested for this subagent only".into(),
                        Err(error) => format!("cancel failed: {error}"),
                    }
                };
            }
            KeyCode::Esc | KeyCode::Char('q') => {
                modal.view = None;
            }
            KeyCode::Up => view.offset = view.offset.saturating_sub(1),
            KeyCode::Down => view.offset = view.offset.saturating_add(1),
            KeyCode::PageUp => view.offset = view.offset.saturating_sub(10),
            KeyCode::PageDown => view.offset = view.offset.saturating_add(10),
            KeyCode::Home => view.offset = 0,
            KeyCode::End => view.offset = view.lines.len(),
            _ => {}
        }
        return false;
    }
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => return true,
        KeyCode::Char('g') if ctrl => return true,
        KeyCode::Up => modal.cursor = modal.cursor.saturating_sub(1),
        KeyCode::Down => {
            modal.cursor = modal.cursor.saturating_add(1);
            modal.clamp(board);
        }
        KeyCode::Char('h') if !ctrl => {
            board.hide_completed = !board.hide_completed;
            modal.clamp(board);
        }
        KeyCode::Char('x') | KeyCode::Char('k') if !ctrl => {
            if let Some(task) = modal.selected_loop(board) {
                // Same effect as scheduler_delete; a fire already running
                // finishes and still reports.
                modal.notice = match client {
                    Some(active) if active.control_ready() => {
                        side.next_control += 1;
                        let id = format!("d{}", side.next_control);
                        match active.send_schedule_delete(&id, &task.id) {
                            Ok(()) => format!("deleting loop {}…", task.id),
                            Err(error) => format!("delete failed: {error}"),
                        }
                    }
                    Some(active) => format!("delete failed: {}", active.control_unavailable()),
                    None => "delete failed: dsh is not connected".into(),
                };
                return false;
            }
            if let Some(job) = modal.selected_job(board) {
                modal.notice = if job.status != background::Status::Running {
                    format!("{} already {}", job.id, job.status.as_str())
                } else if board.session.as_deref() != Some(job.session.as_str()) {
                    format!("{} belongs to another session", job.id)
                } else {
                    match client {
                        Some(active) if active.control_ready() => {
                            side.next_control += 1;
                            let id = format!("k{}", side.next_control);
                            match active.send_job_kill(&id, &job.id) {
                                Ok(()) => format!("stopping {}…", job.id),
                                Err(error) => format!("stop failed: {error}"),
                            }
                        }
                        Some(active) => format!("stop failed: {}", active.control_unavailable()),
                        None => "stop failed: dsh is not connected".into(),
                    }
                };
                return false;
            }
            modal.notice = match modal.selected(board) {
                None => "no subagent selected".into(),
                Some(entry) if !entry.status.live() => {
                    format!("\"{}\" already {}", entry.label, entry.status.as_str())
                }
                Some(entry) => match subagents::request_cancel(dsh_home, &entry.id) {
                    Ok(()) => format!("cancel requested for \"{}\"", entry.label),
                    Err(error) => format!("cancel failed: {error}"),
                },
            };
        }
        KeyCode::Enter => open_child(modal, board),
        KeyCode::Char('f') if ctrl => open_child(modal, board),
        _ => {}
    }
    false
}

fn open_child(modal: &mut subagents::TasksModal, board: &subagents::Board) {
    if let Some(task) = modal.selected_loop(board) {
        // A loop has no transcript of its own; each fire is a subagent row.
        modal.notice = format!(
            "loop {} fires as background subagents (\"loop: …\" rows above); x deletes it",
            task.id
        );
        return;
    }
    if let Some(job) = modal.selected_job(board) {
        // A command has no transcript; its row shows the output tail.
        modal.notice = format!(
            "{} is a command; the row shows its latest output (job_output reads all of it)",
            job.id
        );
        return;
    }
    match modal.selected(board) {
        Some(entry) => match &entry.child {
            Some(child) => {
                modal.view = Some(subagents::ChildView {
                    id: entry.id.clone(),
                    child: child.clone(),
                    ..Default::default()
                });
                modal.notice.clear();
            }
            None => modal.notice = format!("\"{}\" has not started yet", entry.label),
        },
        None => modal.notice = "no subagent selected".into(),
    }
}

/// Where saved workflows are looked up for this session (ticket 184): the
/// project catalog needs folder trust, as in the dsh workflow tool.
fn workflow_scope(effective: &config::EffectiveConfig) -> workflow::Scope {
    workflow::Scope {
        cwd: effective.cwd.clone(),
        grok_home: Some(effective.grok_home.clone()),
        trusted: effective.workspace_trusted,
    }
}

fn sync_workflow_scope(composer: &mut PromptComposer, effective: &config::EffectiveConfig) {
    composer.workflow_scope = Some(workflow_scope(effective));
}

/// `/<name> [args]` naming a saved workflow that no host command, skill or
/// custom command owns.
fn saved_workflow_slash(
    text: &str,
    composer: &PromptComposer,
    effective: &config::EffectiveConfig,
) -> Option<(String, String)> {
    let rest = text.trim().strip_prefix('/')?;
    let (name, args) = rest
        .split_once(char::is_whitespace)
        .map_or((rest, ""), |(name, args)| (name, args.trim()));
    if name.is_empty()
        || composer.slash_taken(name)
        || assets::skill_invocation(&effective.assets, text.trim()).is_some()
        || assets::command_invocation(&effective.assets, text.trim()).is_some()
    {
        return None;
    }
    // A name that is defined but not runnable (invalid file, ambiguous) still
    // goes to the run manager, whose reply says why it cannot start.
    let catalog = workflow_catalog::scan(&workflow_scope(effective));
    let file = format!("{name}.rhai");
    let known = catalog.entries.iter().any(|entry| entry.meta.name == name)
        || catalog.duplicates.contains_key(name)
        || catalog
            .skipped
            .iter()
            .any(|bad| bad.path.file_name().and_then(|n| n.to_str()) == Some(file.as_str()));
    known.then(|| (name.to_string(), args.to_string()))
}

/// Hand `/workflow ...` (or a saved workflow's `/<name>`) to the run manager
/// inside dsh; its reply arrives as `WorkflowResult`.
fn send_workflow_request(
    client: Option<&AcpClient>,
    launch: Option<&str>,
    args: &str,
    side: &mut Intervene,
    hint: &mut String,
    last_error: &mut String,
) {
    let Some(active) = client else {
        *last_error = "/workflow needs a live dsh session; send a prompt first".into();
        return;
    };
    if !active.control_ready() {
        *last_error = format!("/workflow unavailable: {}", active.control_unavailable());
        return;
    }
    side.next_control += 1;
    let id = format!("w{}", side.next_control);
    let sent = match launch {
        Some(name) => active.send_workflow_launch(&id, name, args),
        None => active.send_workflow(&id, args),
    };
    match sent {
        Ok(()) => {
            side.workflow_request = Some(id);
            *hint = "asking the workflow run manager…".into();
            last_error.clear();
        }
        Err(error) => *last_error = format!("/workflow unavailable: {error}"),
    }
}

fn dispatch_composer_command(
    text: &str,
    client: &mut Option<AcpClient>,
    owner: &mut Option<SessionOwner>,
    turns: &mut Vec<Turn>,
    inflight: &mut bool,
    compacting: &mut bool,
    overlay: &mut Overlay,
    ui_overlay: &mut UiOverlay,
    hint: &mut String,
    last_error: &mut String,
    effective: &mut config::EffectiveConfig,
    extra_env: &mut Vec<(String, String)>,
    patch: &mut Option<PathBuf>,
    apply_failed: &mut bool,
    previous_ready: &mut bool,
    selection_ready: &mut bool,
    resumed: &mut bool,
    previous_session: &mut Option<String>,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    guard: &mut TerminalGuard,
    mut screen: ScreenMode,
    committed: &mut usize,
    history: &mut String,
    launch: &Launch,
    mode: &LaunchMode,
    prefs: &mut session_fork::UiPrefs,
    meter: &Meter,
    policy: SwitchPolicy,
    nav: &mut NavState,
    live_theme_kind: &mut theme::ThemeKind,
    live_theme: &mut theme::Theme,
    status_runtime: &mut status_line::StatusLineRuntime,
    composer: &mut PromptComposer,
    voice: &mut voice::VoiceSession,
    memory_session_on: &mut Option<bool>,
    memory_injected: &mut bool,
    side: &mut Intervene,
) -> io::Result<()> {
    let _ = guard;
    // `/loop [interval] <prompt>` (ticket 177): the model turns the request
    // into a scheduler_create call. The transcript shows what was typed.
    let loop_args = loop_command_args(text);
    if let Some(args) = loop_args {
        if args.is_empty() {
            composer.restore_slash_draft();
            *hint = scheduler::LOOP_USAGE.into();
            last_error.clear();
            return Ok(());
        }
        if !config::subagent_policy(effective).enabled {
            composer.restore_slash_draft();
            *last_error = "/loop needs subagents: every fire runs as a background subagent, and subagents are disabled for this session".into();
            return Ok(());
        }
    }
    if text.trim() == "/queue" {
        composer.restore_slash_draft();
        *hint = composer.queue_listing();
        last_error.clear();
        return Ok(());
    }
    if text.trim() == "/btw" || text.trim().starts_with("/btw ") {
        // Typing `/` after text parks that text behind slash completion. For
        // `/btw` the parked text is the front of the side question, not a
        // draft to put back: nothing of this message goes to the main turn.
        let question = btw_question(
            &composer.slash_stash,
            text.trim().trim_start_matches("/btw"),
        );
        // On a refusal the parked text goes back to the prompt untouched.
        if composer.parked_has_images() {
            composer.restore_slash_draft();
            *last_error = "/btw side questions are text only; remove the image first".into();
            return Ok(());
        }
        if question.is_empty() {
            composer.restore_slash_draft();
            *last_error = "usage: /btw <question>".into();
            return Ok(());
        }
        let Some(active) = client.as_ref() else {
            composer.restore_slash_draft();
            *last_error = "/btw needs a live dsh session; send a prompt first".into();
            return Ok(());
        };
        if !active.control_ready() {
            composer.restore_slash_draft();
            *last_error = format!("/btw unavailable: {}", active.control_unavailable());
            return Ok(());
        }
        side.next_btw += 1;
        let id = format!("b{}", side.next_btw);
        match active.send_btw(&id, &question) {
            Ok(()) => {
                composer.discard_parked_draft();
                // A newer question replaces the panel; the old answer is dropped.
                if let Some(old) = side.btw.take()
                    && old.state == BtwState::Loading
                {
                    active.cancel_btw(&old.id);
                }
                side.btw = Some(BtwPanel {
                    id,
                    question,
                    state: BtwState::Loading,
                });
                hint.clear();
                last_error.clear();
            }
            Err(error) => {
                composer.restore_slash_draft();
                *last_error = format!("/btw unavailable: {error}");
            }
        }
        return Ok(());
    }
    let trimmed_goal = text.trim();
    if trimmed_goal == "/goal" || trimmed_goal.starts_with("/goal ") {
        composer.restore_slash_draft();
        let command = goal::parse(&trimmed_goal["/goal".len()..]);
        let Some(active) = client.as_ref() else {
            *last_error = "/goal needs a live dsh session; send a prompt first".into();
            return Ok(());
        };
        if !active.control_ready() {
            *last_error = format!("/goal unavailable: {}", active.control_unavailable());
            return Ok(());
        }
        match active.send_goal(&goal::next_id(), &command) {
            Ok(()) => last_error.clear(),
            Err(error) => *last_error = format!("/goal unavailable: {error}"),
        }
        return Ok(());
    }
    let trimmed_plan = text.trim();
    if trimmed_plan == "/plan" || trimmed_plan.starts_with("/plan ") {
        composer.restore_slash_draft();
        match plan_command(
            trimmed_plan.trim_start_matches("/plan"),
            side,
            client.as_ref(),
            effective,
        ) {
            Ok(message) => {
                *hint = message;
                last_error.clear();
            }
            Err(error) => *last_error = error,
        }
        return Ok(());
    }
    if matches!(trimmed_plan, "/view-plan" | "/show-plan" | "/plan-view") {
        composer.restore_slash_draft();
        match view_plan_text(side, client.as_ref(), effective) {
            Ok(text) if screen == ScreenMode::Minimal => {
                let block = format!("{text}\n");
                history.push_str(&block);
                let _ = with_synchronized_output(terminal, |terminal| {
                    emit_to_scrollback(terminal, &block)
                });
                last_error.clear();
            }
            Ok(text) => {
                let (path, body) = text.split_once('\n').unwrap_or(("", &text));
                if side.ask.open() {
                    *last_error = "answer the open question first".into();
                } else {
                    side.ask.review = Some(interaction::PlanReview::viewer(
                        body,
                        path.trim_matches(|c: char| c == '─' || c == ' '),
                    ));
                    last_error.clear();
                }
            }
            Err(error) => *hint = error,
        }
        return Ok(());
    }
    if text.trim() == "/voice" || text.trim().starts_with("/voice ") {
        composer.restore_slash_draft();
        apply_voice_command(text.trim(), voice, composer, hint, last_error);
        return Ok(());
    }
    if text.trim() == "/reload-assets" {
        // Same restore as /minimal: the placeholder is not the image bytes.
        composer.restore_slash_draft();
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| effective.grok_home.clone());
        config::refresh_assets(effective, &home);
        composer.asset_commands = assets::menu_entries(&effective.assets);
        sync_workflow_scope(composer, effective);
        *hint = format!(
            "Rescanned assets: {} rules, {} skills, {} commands, {} agents. {}",
            effective.assets.rules.len(),
            effective.assets.skills.len(),
            effective.assets.commands.len(),
            effective.assets.agents.len(),
            if effective.assets.project_active {
                "Project assets active."
            } else {
                "Project assets inactive until this folder is trusted."
            }
        );
        last_error.clear();
        return Ok(());
    }
    if text.trim() == "/workflows" || text.trim().starts_with("/workflows ") {
        // Ticket 184: the saved-workflow catalog (or one workflow's details),
        // read here without running anything; launches still go through dsh.
        composer.restore_slash_draft();
        sync_workflow_scope(composer, effective);
        let catalog = workflow_catalog::scan(&workflow_scope(effective));
        let name = text.trim().trim_start_matches("/workflows").trim();
        *hint = if name.is_empty() {
            workflow_catalog::overview(&catalog, &|name| composer.slash_taken(name))
        } else {
            workflow_catalog::detail(&catalog, name, &|name| composer.slash_taken(name))
        };
        composer.refresh_workflow_commands();
        last_error.clear();
        return Ok(());
    }
    if text.trim() == "/workflow" || text.trim().starts_with("/workflow ") {
        // Ticket 183: the run manager inside dsh owns the runs; the reply
        // (overview, launch, pause, resume, stop, save) comes back as
        // `WorkflowResult`.
        composer.restore_slash_draft();
        send_workflow_request(
            client.as_ref(),
            None,
            text.trim().trim_start_matches("/workflow").trim(),
            side,
            hint,
            last_error,
        );
        return Ok(());
    }
    if text.trim() == "/worktree" || text.trim().starts_with("/worktree ") {
        composer.restore_slash_draft();
        let cwd = std::env::current_dir().unwrap_or_else(|_| effective.cwd.clone());
        let pool = worktree::pool(&effective.grok_home);
        match worktree::slash(&pool, &cwd, text.trim()) {
            Ok(output) => {
                *hint = output;
                last_error.clear();
            }
            Err(error) => *last_error = error,
        }
        return Ok(());
    }
    if text.trim() == "/revoke-approvals" {
        composer.restore_slash_draft();
        match revoke_remembered_grants(effective) {
            Ok(message) => {
                *hint = message;
                last_error.clear();
            }
            Err(error) => *last_error = error,
        }
        return Ok(());
    }
    if let Some(mode_command) = permission_slash(text.trim()) {
        composer.restore_slash_draft();
        match apply_session_permission_mode(effective, client.as_ref(), mode_command) {
            Ok(message) => {
                let applied = runtime_apply(effective);
                if applied.apply_failed {
                    *last_error = applied.error;
                } else {
                    *extra_env = applied.extra_env;
                    *patch = applied.patch;
                    *hint = message;
                    last_error.clear();
                }
            }
            Err(error) => *last_error = error,
        }
        return Ok(());
    }
    if let Some(command) = appearance::slash(text) {
        composer.restore_slash_draft();
        match command {
            appearance::AppearanceSlash::Settings => {
                *ui_overlay =
                    UiOverlay::Settings(SettingsState::open(&effective.appearance, screen));
                hint.clear();
            }
            appearance::AppearanceSlash::Theme(args) => {
                if screen == ScreenMode::Minimal {
                    *hint = appearance::minimal_theme_refuse().into();
                } else if args.is_empty() {
                    *ui_overlay = UiOverlay::Theme(ThemeState::open(&effective.appearance));
                    hint.clear();
                    apply_overlay_action(
                        OverlayAction::PreviewTheme(if let UiOverlay::Theme(state) = &ui_overlay {
                            state.current()
                        } else {
                            *live_theme_kind
                        }),
                        effective,
                        live_theme_kind,
                        live_theme,
                        screen,
                        hint,
                        last_error,
                        status_runtime,
                        prefs,
                        ui_overlay,
                    );
                } else {
                    match appearance::apply_setting(&mut effective.appearance, "ui.theme", &args) {
                        Ok(encoded) => match persist_appearance(effective, "ui.theme", &encoded) {
                            Ok(()) => {
                                *live_theme_kind = effective.appearance.resolved_kind(screen);
                                *live_theme = effective.appearance.resolved_theme(screen);
                                apply_cursor_color(live_theme);
                                *hint = format!(
                                    "theme = {}",
                                    effective.appearance.theme.display_name()
                                );
                                last_error.clear();
                            }
                            Err(error) => *last_error = error,
                        },
                        Err(error) => *last_error = error,
                    }
                }
            }
            appearance::AppearanceSlash::ToggleCompact => {
                let next = !effective.appearance.compact_mode;
                match appearance::apply_setting(
                    &mut effective.appearance,
                    "ui.compact_mode",
                    if next { "true" } else { "false" },
                ) {
                    Ok(encoded) => {
                        match persist_appearance(effective, "ui.compact_mode", &encoded) {
                            Ok(()) => {
                                *hint = format!("compact_mode {}", if next { "on" } else { "off" });
                                last_error.clear();
                            }
                            Err(error) => *last_error = error,
                        }
                    }
                    Err(error) => *last_error = error,
                }
            }
            appearance::AppearanceSlash::ToggleTimestamps => {
                let next = !effective.appearance.show_timestamps;
                match appearance::apply_setting(
                    &mut effective.appearance,
                    "ui.show_timestamps",
                    if next { "true" } else { "false" },
                ) {
                    Ok(encoded) => {
                        match persist_appearance(effective, "ui.show_timestamps", &encoded) {
                            Ok(()) => {
                                *hint = format!("timestamps {}", if next { "on" } else { "off" });
                                last_error.clear();
                            }
                            Err(error) => *last_error = error,
                        }
                    }
                    Err(error) => *last_error = error,
                }
            }
            appearance::AppearanceSlash::Help => {
                *hint = settings_ui::help_text().into();
            }
            appearance::AppearanceSlash::Unavailable(message) => {
                *hint = message;
            }
        }
        return Ok(());
    }
    if let Some(action) = screen_mode::slash_action(text) {
        composer.restore_slash_draft();
        match action {
            SlashAction::Switch(target) if target == screen => {
                *hint = format!("Already in {} mode.", screen.as_str());
            }
            SlashAction::Switch(target) => {
                if policy == SwitchPolicy::Exec && composer.queue_count() > 0 {
                    // The exec relaunch resumes the session only; the rows
                    // queued here would be lost.
                    *hint = format!(
                        "{} queued row(s) would be lost by the relaunch; send or clear the queue first",
                        composer.queue_count()
                    );
                    return Ok(());
                }
                if policy == SwitchPolicy::Exec {
                    let session_id = client
                        .as_ref()
                        .and_then(|active| active.session_id.clone())
                        .or_else(|| previous_session.clone());
                    let Some(session_id) = session_id else {
                        *hint = screen_mode::exec_failure_message(None, target, "no session");
                        return Ok(());
                    };
                    // The exec relaunch resumes the session, not the draft.
                    drop_connection(client, owner);
                    return Err(io::Error::other(format!(
                        "CODSH_SCREEN_RELAUNCH:{session_id}:{target}",
                        target = target.as_str()
                    )));
                }
                guard.apply(terminal, target)?;
                if target == ScreenMode::Minimal {
                    commit_completed_turns(
                        terminal,
                        turns,
                        committed,
                        history,
                        Some(target.switch_marker()),
                    )?;
                    hint.clear();
                } else {
                    *hint = target.switch_marker().into();
                }
                screen = target;
                nav.mouse_captured = target == ScreenMode::Fullscreen;
                if target != ScreenMode::Fullscreen {
                    nav.overlay = NavOverlay::None;
                    nav.focus = Focus::Prompt;
                }
                *live_theme_kind = effective.appearance.resolved_kind(screen);
                *live_theme = effective.appearance.resolved_theme(screen);
                apply_cursor_color(live_theme);
                last_error.clear();
            }
            SlashAction::Navigate(command) => match command {
                NavSlash::Find(query) => {
                    if screen != ScreenMode::Fullscreen {
                        *hint = navigation::FIND_MINIMAL.into();
                    } else {
                        nav.open_search(query);
                        *hint = nav.overlay_text();
                    }
                }
                NavSlash::Jump => {
                    if screen != ScreenMode::Fullscreen {
                        *hint = navigation::JUMP_MINIMAL.into();
                    } else {
                        nav.open_jump();
                        *hint = nav.overlay_text();
                    }
                }
                NavSlash::VimMode => {
                    nav.toggle_vim();
                    if let Err(error) =
                        navigation::save_vim_mode(&effective.grok_home, nav.prefs.vim_mode)
                    {
                        *last_error = error.to_string();
                    }
                    *hint = format!(
                        "Vim scrollback navigation {} (ui.simple_mode unchanged).",
                        if nav.prefs.vim_mode { "on" } else { "off" }
                    );
                }
                NavSlash::ToggleMouse => {
                    if !nav.prefs.mouse_reporting_toggle {
                        *hint = navigation::MOUSE_TOGGLE_HINT.into();
                    } else {
                        nav.toggle_mouse();
                        *hint = format!(
                            "Mouse capture {}.",
                            if nav.mouse_captured {
                                "on"
                            } else {
                                "off (native selection)"
                            }
                        );
                    }
                }
            },
            refuse @ SlashAction::Refuse(_) => {
                if let Some(message) = screen_mode::mode_command_message(screen, refuse) {
                    *hint = message;
                }
            }
            SlashAction::Expand => {
                if let Some(message) =
                    screen_mode::mode_command_message(screen, SlashAction::Expand)
                {
                    *hint = message;
                } else {
                    let views = turn_views(turns);
                    match content::expand_last_folded(&mut nav.display, &views) {
                        Ok(body) => {
                            last_error.clear();
                            hint.clear();
                            history.push_str(&body);
                            history.push('\n');
                            let _ = with_synchronized_output(terminal, |terminal| {
                                emit_to_scrollback(terminal, &format!("{body}\n"))
                            });
                        }
                        Err(error) => *hint = error,
                    }
                }
            }
            SlashAction::Dashboard(refusal) => {
                if screen == ScreenMode::Minimal {
                    *hint = refusal.into();
                } else {
                    match open_dashboard_overlay(overlay, effective, client.as_ref()) {
                        Ok(()) => {
                            hint.clear();
                            last_error.clear();
                        }
                        Err(error) => *last_error = error,
                    }
                }
            }
            SlashAction::Transcript => {
                let views = turn_views(turns);
                if views.is_empty() {
                    *hint = "No active session to view".into();
                } else {
                    let _ = terminal.clear();
                    guard.suspend()?;
                    let result = content::open_transcript_pager(&views, &effective.grok_home);
                    guard.resume(terminal, screen)?;
                    let _ = terminal.clear();
                    match result {
                        Ok(message) => {
                            *hint = message;
                            last_error.clear();
                        }
                        Err(error) => *last_error = error,
                    }
                }
            }
        }
        return Ok(());
    }
    let parked_draft = composer.voice_draft();
    let trimmed = text.trim();
    if let Some(action) = session_catalog_slash(trimmed) {
        composer.clear_slash_line(&parked_draft);
        return apply_session_catalog_slash(
            action,
            client,
            owner,
            turns,
            inflight,
            overlay,
            hint,
            last_error,
            effective,
            extra_env,
            patch,
            apply_failed,
            selection_ready,
            resumed,
            previous_session,
            terminal,
            screen,
            committed,
            history,
            composer,
            launch,
            memory_session_on,
            memory_injected,
        );
    }
    if let Some(action) = memory_slash(trimmed) {
        if effective.memory.force_off() && matches!(action, MemorySlash::Browse) {
            *last_error =
                "memory is hidden for this process (--no-memory or GROK_MEMORY=0); notes were not deleted"
                    .into();
            composer.clear_slash_line(&parked_draft);
            return Ok(());
        }
        match action {
            MemorySlash::Browse => {
                match open_memory_browser(overlay, effective, *memory_session_on, *memory_injected)
                {
                    Ok(()) => {
                        hint.clear();
                        last_error.clear();
                    }
                    Err(error) => *last_error = error,
                }
            }
            MemorySlash::Remember(text) => {
                let scope = memory::Scope::Workspace;
                match text {
                    Some(note) => {
                        match open_remember_confirmation(
                            effective,
                            *memory_session_on,
                            *memory_injected,
                            &note,
                            scope,
                        ) {
                            Ok(browser) => {
                                *hint = browser.notice.clone();
                                *overlay = Overlay::Memory(browser);
                                last_error.clear();
                            }
                            Err(error) => {
                                *last_error = error;
                                composer.clear_slash_line(&parked_draft);
                                return Ok(());
                            }
                        }
                    }
                    None => {
                        *overlay = Overlay::Remember {
                            draft: String::new(),
                            scope,
                        };
                        hint.clear();
                        last_error.clear();
                    }
                }
            }
        }
        composer.clear_slash_line(&parked_draft);
        return Ok(());
    }
    if let Some(action) = mcp::parse_slash(trimmed) {
        composer.clear_slash_line(&parked_draft);
        let action = match action {
            Ok(action) => action,
            Err(error) => {
                *last_error = error;
                return Ok(());
            }
        };
        if action == mcp::Slash::List {
            *hint = mcp_report((*client).as_ref());
            last_error.clear();
            return Ok(());
        }
        if *inflight {
            *last_error =
                "MCP servers restart with the session; wait for the running turn to finish".into();
            return Ok(());
        }
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_default();
        let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        let input = mcp::DiscoverInput {
            grok_home: &effective.grok_home,
            config_path: &effective.config_path,
            home: &home,
            cwd: &effective.cwd,
            trusted: effective.workspace_trusted,
            env: &env,
        };
        let verb = match &action {
            mcp::Slash::Enable(name) | mcp::Slash::Disable(name) => {
                let outcome =
                    mcp::run_set_enabled(&input, name, matches!(action, mcp::Slash::Enable(_)));
                if outcome.code != 0 {
                    *last_error = outcome.stderr.trim().replace('\n', " ");
                    return Ok(());
                }
                outcome.stdout.trim().to_string()
            }
            mcp::Slash::Restart(Some(name)) => {
                if mcp::discover(&input).get(name).is_none() {
                    *last_error = format!("No MCP server named '{name}'.");
                    return Ok(());
                }
                format!(
                    "Restarted MCP servers (dsh restarts every server with the session) for '{name}'."
                )
            }
            _ => "Reloaded MCP config and restarted MCP servers.".to_string(),
        };
        // dsh mounts MCP servers when a session is created or resumed, so the
        // same session is resumed in a fresh dsh with the rewritten plan.
        *effective = load_runtime_config(launch);
        let applied = runtime_apply(effective);
        *extra_env = applied.extra_env;
        if applied.apply_failed {
            *last_error = applied.error;
            *apply_failed = true;
            return Ok(());
        }
        *patch = applied.patch;
        *apply_failed = false;
        drop_connection(client, owner);
        let mut live = LiveSession {
            client,
            owner,
            turns,
            resumed,
            previous_session,
            selection_ready,
            last_error,
        };
        match open_live_session(
            &LaunchMode::New,
            extra_env,
            (*patch).as_ref(),
            effective,
            &mut live,
        ) {
            Ok(()) => {
                *hint = format!("{verb}\n{}", mcp_report((*client).as_ref()));
            }
            Err(error) => *last_error = error,
        }
        return Ok(());
    }
    if trimmed == "/plugins" || trimmed == "/marketplace" {
        *overlay = Overlay::Plugins(plugin::new_overlay(if trimmed == "/marketplace" {
            plugin::PluginTab::Marketplace
        } else {
            plugin::PluginTab::Plugins
        }));
        composer.clear_slash_line(&parked_draft);
        last_error.clear();
        hint.clear();
        return Ok(());
    }
    if session_fork::is_conversation_slash(trimmed) {
        if *inflight {
            *last_error = session_fork::running_turn_error();
            composer.clear_slash_line(&parked_draft);
            return Ok(());
        }
        if (*client).is_none() {
            *last_error = "not connected".into();
            return Ok(());
        }
        if trimmed.starts_with("/fork") {
            match session_fork::parse_fork_slash(trimmed) {
                Err(error) => {
                    *last_error = error;
                    composer.clear_slash_line(&parked_draft);
                }
                Ok(fork) => {
                    if let Some(active) = (*client).as_mut() {
                        match commit_fork(
                            active,
                            owner,
                            turns,
                            inflight,
                            &effective.dsh_home,
                            &effective.cwd,
                            prefs,
                            fork.directive.as_deref(),
                            launch,
                            effective,
                            resumed,
                            previous_session,
                            memory_session_on,
                            memory_injected,
                        ) {
                            Ok(message) => {
                                *hint = message;
                                last_error.clear();
                                composer.clear_slash_line(&parked_draft);
                                if let Err(error) = reset_native_history_after_switch(
                                    terminal, screen, committed, history,
                                ) {
                                    *last_error = error.to_string();
                                }
                            }
                            Err(error) => *last_error = error,
                        }
                    }
                }
            }
            return Ok(());
        }
        let rest = trimmed
            .trim_start_matches("/rewind")
            .trim_start_matches("/undo")
            .trim();
        let Some(session_id) = (*client)
            .as_ref()
            .and_then(|active| active.session_id.clone())
        else {
            *last_error = "ACP session is not ready".into();
            return Ok(());
        };
        match session_fork::list_points(&effective.dsh_home, &session_id) {
            Ok(points) if points.is_empty() => {
                *hint = "no turns to rewind yet".into();
                composer.clear_slash_line(&parked_draft);
            }
            Ok(points) => {
                if rest.is_empty() {
                    let mut newest = points;
                    newest.reverse();
                    *overlay = Overlay::RewindPick {
                        points: newest,
                        cursor: 0,
                    };
                    composer.clear_slash_line(&parked_draft);
                    hint.clear();
                } else if let Ok(turn) = rest.parse::<u32>() {
                    if let Some(point) = points.into_iter().find(|point| point.turn == turn) {
                        if prefs.confirm_before_rewind {
                            *overlay = Overlay::RewindConfirm { point };
                            composer.clear_slash_line(&parked_draft);
                        } else if let Some(active) = (*client).as_mut() {
                            match commit_rewind(
                                active,
                                owner,
                                turns,
                                &effective.dsh_home,
                                &effective.cwd,
                                &point,
                                resumed,
                                previous_session,
                                memory_session_on,
                                memory_injected,
                            ) {
                                Ok(message) => {
                                    *hint = message;
                                    last_error.clear();
                                    composer.clear_slash_line(&parked_draft);
                                    if let Err(error) = reset_native_history_after_switch(
                                        terminal, screen, committed, history,
                                    ) {
                                        *last_error = error.to_string();
                                    }
                                }
                                Err(error) => *last_error = error,
                            }
                        }
                    } else {
                        *last_error = "turn must be between 1 and the latest rewind point".into();
                    }
                } else {
                    *last_error = "turn must be a positive integer".into();
                }
            }
            Err(error) => *last_error = error.message,
        }
        return Ok(());
    }
    let slash = models::parse_slash(trimmed);
    if slash.is_none()
        && let Some((name, args)) = saved_workflow_slash(trimmed, composer, effective)
    {
        // `/<name> [args]` for a saved workflow no command or skill owns
        // (reference: advertised workflow names launch like `/workflow`).
        composer.clear_slash_line(&parked_draft);
        send_workflow_request(client.as_ref(), Some(&name), &args, side, hint, last_error);
        return Ok(());
    }
    if *inflight && slash.is_none() {
        // A custom command, skill, or passthrough starts a model turn. It
        // waits in the queue as a command row instead of being dropped.
        composer.enqueue_command(trimmed);
        *hint = std::mem::take(&mut composer.footer_notice);
        composer.clear_slash_line(&parked_draft);
        return Ok(());
    }
    if let Some(models::Command::Feedback { rest }) = slash.clone() {
        let session_id = feedback_session_id((*client).as_ref());
        if let Some(message) = feedback_ui::immediate_message(&rest) {
            let policy = privacy::PrivacyPolicy::from_config(effective);
            let slash_log = privacy_cmd::debug_log_path(&effective.dsh_home);
            let command = privacy_cmd::FeedbackCommand::Save {
                session: session_id,
                title: message.chars().take(80).collect(),
                details: message,
                area: None,
                kind: privacy::FeedbackType::Bug,
                task_category: None,
                failure_mode: None,
                send: true,
            };
            match privacy_cmd::run(&command, &effective.dsh_home, &policy, slash_log.as_deref()) {
                Ok(message) => {
                    *hint = message;
                    last_error.clear();
                }
                Err(error) => *last_error = error.to_string(),
            }
        } else if rest.trim().is_empty() {
            *overlay = Overlay::Feedback(feedback_ui::FeedbackForm::open());
            hint.clear();
            last_error.clear();
        } else {
            let mut argv = vec!["feedback".into()];
            argv.extend(rest.split_whitespace().map(str::to_string));
            if !argv.iter().any(|arg| arg == "--session") {
                argv.push("--session".into());
                argv.push(session_id);
            }
            match privacy_cmd::parse_feedback(&argv[1..]) {
                Ok(command) => {
                    let policy = privacy::PrivacyPolicy::from_config(effective);
                    let slash_log = privacy_cmd::debug_log_path(&effective.dsh_home);
                    match privacy_cmd::run(
                        &command,
                        &effective.dsh_home,
                        &policy,
                        slash_log.as_deref(),
                    ) {
                        Ok(message) => {
                            *hint = message;
                            last_error.clear();
                        }
                        Err(error) => *last_error = error.to_string(),
                    }
                }
                Err(error) => *last_error = error.to_string(),
            }
        }
        composer.clear_slash_line(&parked_draft);
        return Ok(());
    }
    if matches!(
        slash,
        Some(models::Command::Login | models::Command::Logout)
    ) {
        match handle_slash_command(
            slash.clone().unwrap(),
            effective,
            (*client).as_mut(),
            *inflight,
        ) {
            Ok(message) => {
                *hint = message;
                last_error.clear();
                let was_ready = *previous_ready;
                let previous_env = extra_env.clone();
                let previous_patch_body = patch
                    .as_deref()
                    .and_then(|path| std::fs::read_to_string(path).ok());
                *effective = load_runtime_config(launch);
                let applied = runtime_apply(effective);
                let replace = slash_reload_replaces_client(
                    &previous_env,
                    was_ready,
                    previous_patch_body.as_deref(),
                    &applied,
                    effective.ready,
                );
                *extra_env = applied.extra_env;
                if applied.apply_failed {
                    *last_error = applied.error;
                    *apply_failed = true;
                } else {
                    *patch = applied.patch;
                    *apply_failed = false;
                    if replace {
                        drop_connection(client, owner);
                    }
                }
                *previous_ready = effective.ready;
                if (*client).is_none() && !can_execute(effective, *apply_failed) {
                    if last_error.is_empty() {
                        *last_error = effective.first_run_message();
                    }
                } else if (*client).is_none() && can_execute(effective, *apply_failed) {
                    let mut live = LiveSession {
                        client,
                        owner,
                        turns,
                        resumed,
                        previous_session,
                        selection_ready,
                        last_error,
                    };
                    if let Err(error) =
                        open_live_session(mode, extra_env, (*patch).as_ref(), effective, &mut live)
                    {
                        *last_error = error;
                    }
                }
            }
            Err(error) => *last_error = error,
        }
        composer.clear_slash_line(&parked_draft);
        return Ok(());
    }
    if !*inflight {
        replace_if_plugin_runtime_changed(client, owner, effective, extra_env);
    }
    if (*client).is_none() {
        *effective = load_runtime_config(launch);
        let applied = runtime_apply(effective);
        *extra_env = applied.extra_env;
        *previous_ready = effective.ready;
        if applied.apply_failed {
            *last_error = applied.error;
            composer.clear_slash_line(&parked_draft);
            return Ok(());
        }
        *patch = applied.patch;
        *apply_failed = false;
        if !can_execute(effective, *apply_failed) {
            *last_error = effective.first_run_message();
            composer.clear_slash_line(&parked_draft);
            return Ok(());
        }
        let mut live = LiveSession {
            client,
            owner,
            turns,
            resumed,
            previous_session,
            selection_ready,
            last_error,
        };
        if let Err(error) =
            open_live_session(mode, extra_env, (*patch).as_ref(), effective, &mut live)
        {
            *last_error = error;
            composer.clear_slash_line(&parked_draft);
            return Ok(());
        }
    }
    if text.trim().is_empty() {
        composer.clear_slash_line(&parked_draft);
        return Ok(());
    }
    config::refresh_assets(
        effective,
        &std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| effective.grok_home.clone()),
    );
    composer.asset_commands = assets::menu_entries(&effective.assets);
    sync_workflow_scope(composer, effective);
    if let Some(command) = slash {
        match command {
            models::Command::Context => {
                let routing = live_routing((*client).as_ref(), effective);
                let breakdown = client
                    .as_ref()
                    .and_then(|active| active.session_id.as_ref())
                    .and_then(|session_id| {
                        session_history::load_session(&effective.dsh_home, session_id)
                            .ok()
                            .and_then(|session| session.breakdown)
                    })
                    .map(|item| models::ContextBreakdown {
                        system: item.system,
                        tools: item.tools,
                        messages: item.messages,
                    });
                *hint = models::context_report(
                    meter.used,
                    routing.as_ref().and_then(|item| item.advertised_context),
                    meter.size,
                    breakdown.as_ref(),
                );
                last_error.clear();
                composer.clear_slash_line(&parked_draft);
                return Ok(());
            }
            models::Command::Compact { instruction } => {
                if *inflight && !*compacting {
                    // Compaction needs an idle agent; it runs when this turn ends.
                    composer.enqueue_command(trimmed);
                    *hint = std::mem::take(&mut composer.footer_notice);
                    composer.clear_slash_line(&parked_draft);
                    return Ok(());
                }
                if *inflight {
                    *last_error = "Compaction is unavailable because this process has an active compaction, or the agent is not idle.".into();
                    composer.clear_slash_line(&parked_draft);
                    return Ok(());
                }
                let prompt = match instruction {
                    Some(text) => format!("/compact {text}"),
                    None => "/compact".into(),
                };
                if let Some(active) = (*client).as_mut() {
                    match active.submit_prompt(&prompt) {
                        Ok(_) => {
                            *hint = "✂ compacting history…".into();
                            *inflight = true;
                            *compacting = true;
                            last_error.clear();
                        }
                        Err(error) => *last_error = error.message,
                    }
                } else {
                    *last_error = UNAVAILABLE.trim().to_string();
                }
                composer.clear_slash_line(&parked_draft);
                return Ok(());
            }
            other => {
                match handle_slash_command(other, effective, (*client).as_mut(), *inflight) {
                    Ok(message) => {
                        if message.starts_with("Selected ") {
                            *selection_ready = true;
                            sync_image_route(composer, effective);
                        }
                        *hint = message;
                        last_error.clear();
                    }
                    Err(error) => *last_error = error,
                }
                composer.clear_slash_line(&parked_draft);
                return Ok(());
            }
        }
    }
    if *inflight {
        composer.clear_slash_line(&parked_draft);
        return Ok(());
    }
    if !turn_allowed(*selection_ready) {
        if last_error.is_empty() {
            *last_error = "configured model was not applied; no silent provider fallback".into();
        }
        composer.clear_slash_line(&parked_draft);
        return Ok(());
    }
    if (*owner).as_ref().is_some_and(|held| !held.still_held()) {
        *last_error = format!(
            "Write owner refused: session {} is no longer owned by this client.",
            owner
                .as_ref()
                .map(|held| held.session_id.as_str())
                .unwrap_or("unknown")
        );
        drop_connection(client, owner);
        composer.clear_slash_line(&parked_draft);
        return Ok(());
    }
    let loop_instruction = loop_args.map(scheduler::loop_instruction);
    if let Some(active) = (*client).as_mut() {
        match active.submit_prompt(&model_prompt(
            launch,
            effective,
            loop_instruction.as_deref().unwrap_or(text),
            *memory_session_on,
            !*memory_injected && turns.is_empty(),
        )) {
            Ok(_) => {
                if let Some(args) = loop_args {
                    *hint = format!(
                        "⟳ loop {} (provisional: the model's scheduler_create call sets the schedule)",
                        scheduler::loop_preview(args)
                    );
                }
                turns.push(Turn {
                    user: text.to_string(),
                    thought: String::new(),
                    answer: String::new(),
                    error: None,
                    message_id: None,
                    tools: Vec::new(),
                    permission: None,
                    done: false,
                    cancelling: false,
                    cancelled: false,
                    interrupted: false,
                    compacted: false,
                    compaction: None,
                    timestamp: Some(clock_stamp()),
                    quiet_cancel: false,
                });
                composer.discard_parked_draft();
                *inflight = true;
                *memory_injected = true;
                last_error.clear();
                if let Some(session_id) = active.session_id.clone() {
                    let _ = session_catalog::note_turn(&effective.dsh_home, &session_id, true);
                }
            }
            Err(error) => {
                *last_error = error.message;
                composer.clear_slash_line(&parked_draft);
            }
        }
        return Ok(());
    }
    composer.clear_slash_line(&parked_draft);
    Ok(())
}

/// The arguments of a `/loop` line (empty for a bare `/loop`), or None.
fn loop_command_args(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    let rest = trimmed.strip_prefix("/loop")?;
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim())
}

fn model_prompt(
    launch: &Launch,
    effective: &config::EffectiveConfig,
    text: &str,
    memory_session_on: Option<bool>,
    first_turn: bool,
) -> String {
    // --verbatim freezes the user content. Rules and slash bodies are not
    // pasted into it. dsh still owns the system message, and permission
    // policy still runs on the tool channel. First-turn memory is context,
    // not prompt text: blocks_with_model_prompt sends it as its own block.
    if launch.verbatim {
        return text.to_string();
    }
    let base = model_prompt_inner(launch, effective, text);
    match first_turn_memory(effective, text, memory_session_on, first_turn) {
        Some(block) => format!("{block}{base}"),
        None => base,
    }
}

/// The first-turn memory block, or None. A later turn, --no-memory,
/// GROK_MEMORY=0, a /memory session toggle, or an empty store gives None.
fn first_turn_memory(
    effective: &config::EffectiveConfig,
    text: &str,
    memory_session_on: Option<bool>,
    first_turn: bool,
) -> Option<String> {
    if !first_turn {
        return None;
    }
    let enabled = if effective.memory.force_off() {
        false
    } else {
        memory_session_on.unwrap_or_else(|| effective.memory.enabled())
    };
    if !enabled {
        return None;
    }
    let store = memory::open_store(&effective.grok_home, &effective.cwd).ok()?;
    // Curated global and workspace notes are the bounded index. A keyword in
    // the first prompt also pulls matching session logs.
    let block = if memory::has_search_terms(text) {
        memory::injection_block_for(&store, true, text)
    } else {
        memory::injection_block(&store, true)
    }
    .ok()?;
    (!block.is_empty()).then_some(block)
}

/// The rules `--verbatim` still applies: file rules, `--rules`, and agent
/// definitions, or only `--system-prompt-override`. They lead as their own
/// block so the user's bytes stay exact; a slash body is not expanded.
fn verbatim_rules(launch: &Launch, effective: &config::EffectiveConfig) -> String {
    let replaced = launch.system_prompt_override.is_some();
    let rules = if replaced {
        launch.system_prompt_override.as_deref().unwrap_or("")
    } else {
        launch.session_rules.as_deref().unwrap_or("")
    };
    assets::context_block(&effective.assets, rules, replaced)
}

fn model_prompt_inner(launch: &Launch, effective: &config::EffectiveConfig, text: &str) -> String {
    let override_text = launch.system_prompt_override.as_deref().unwrap_or("");
    let rules = if launch.system_prompt_override.is_some() {
        override_text
    } else {
        launch.session_rules.as_deref().unwrap_or("")
    };
    if rules.is_empty() && launch.system_prompt_override.is_none() {
        return assets::prompt_for_model(&effective.assets, text);
    }
    assets::prompt_with_session(
        &effective.assets,
        text,
        rules,
        launch.system_prompt_override.is_some(),
    )
}

/// Rules, agents, session rules, and an explicit skill body wrap the user's
/// text once. Attachment resource links and later text blocks (a pasted-image
/// fallback, a file body) stay as admitted. First-turn memory joins that first
/// text block. `--verbatim` leaves every admitted block exact and leads with
/// the rules and first-turn memory as their own block.
fn blocks_with_model_prompt(
    launch: &Launch,
    effective: &config::EffectiveConfig,
    blocks: Vec<serde_json::Value>,
    memory_session_on: Option<bool>,
    first_turn: bool,
) -> Vec<serde_json::Value> {
    let mut first_text = true;
    let mut wrapped_user = false;
    let mut lead = String::new();
    let mut out = Vec::with_capacity(blocks.len() + 1);
    for mut block in blocks {
        let text = match block.get("text").and_then(|value| value.as_str()) {
            Some(text) if block.get("type").and_then(|value| value.as_str()) == Some("text") => {
                text.to_string()
            }
            _ => {
                out.push(block);
                continue;
            }
        };
        let memory_pending = first_turn && first_text;
        if launch.verbatim {
            if first_text {
                if memory_pending
                    && let Some(memory) =
                        first_turn_memory(effective, &text, memory_session_on, true)
                {
                    lead.push_str(&memory);
                }
                lead.push_str(&verbatim_rules(launch, effective));
            }
        } else if !wrapped_user {
            let wrapped = model_prompt(launch, effective, &text, memory_session_on, memory_pending);
            if wrapped != text {
                block["text"] = serde_json::Value::String(wrapped);
            }
            wrapped_user = true;
        }
        first_text = false;
        out.push(block);
    }
    if !lead.is_empty() {
        out.insert(0, serde_json::json!({ "type": "text", "text": lead }));
    }
    out
}

fn submit_composer_prompt(
    text: &str,
    client: &mut Option<AcpClient>,
    owner: &mut Option<SessionOwner>,
    turns: &mut Vec<Turn>,
    inflight: &mut bool,
    last_error: &mut String,
    effective: &mut config::EffectiveConfig,
    extra_env: &mut Vec<(String, String)>,
    patch: &mut Option<PathBuf>,
    apply_failed: &mut bool,
    previous_ready: &mut bool,
    selection_ready: &mut bool,
    resumed: &mut bool,
    previous_session: &mut Option<String>,
    launch: &Launch,
    mode: &LaunchMode,
    composer: &mut PromptComposer,
    memory_session_on: &mut Option<bool>,
    memory_injected: &mut bool,
) {
    if *inflight {
        return;
    }
    replace_if_plugin_runtime_changed(client, owner, effective, extra_env);
    if client.is_none() {
        *effective = load_runtime_config(launch);
        let applied = runtime_apply(effective);
        *extra_env = applied.extra_env;
        *previous_ready = effective.ready;
        if applied.apply_failed {
            *last_error = applied.error;
            return;
        }
        *patch = applied.patch;
        *apply_failed = false;
        if !can_execute(effective, *apply_failed) {
            *last_error = effective.first_run_message();
            return;
        }
        let mut live = LiveSession {
            client,
            owner,
            turns,
            resumed,
            previous_session,
            selection_ready,
            last_error,
        };
        if let Err(error) = open_live_session(mode, extra_env, patch.as_ref(), effective, &mut live)
        {
            *last_error = error;
            return;
        }
    }
    if !turn_allowed(*selection_ready) {
        if last_error.is_empty() {
            *last_error = "configured model was not applied; no silent provider fallback".into();
        }
        return;
    }
    if owner.as_ref().is_some_and(|held| !held.still_held()) {
        *last_error = format!(
            "Write owner refused: session {} is no longer owned by this client.",
            owner
                .as_ref()
                .map(|held| held.session_id.as_str())
                .unwrap_or("unknown")
        );
        drop_connection(client, owner);
        return;
    }
    config::refresh_assets(
        effective,
        &std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| effective.grok_home.clone()),
    );
    composer.asset_commands = assets::menu_entries(&effective.assets);
    sync_workflow_scope(composer, effective);
    if let Some(active) = client.as_mut() {
        let prepared = composer.take_prepared_submit();
        let transcript = prepared
            .as_ref()
            .map(|item| item.text.clone())
            .unwrap_or_else(|| text.to_string());
        let blocks = prepared
            .map(|item| item.blocks)
            .unwrap_or_else(|| vec![serde_json::json!({ "type": "text", "text": text })]);
        let blocks = blocks_with_model_prompt(
            launch,
            effective,
            blocks,
            *memory_session_on,
            !*memory_injected && turns.is_empty(),
        );
        match active.submit_prompt_blocks(&blocks) {
            Ok(_) => {
                turns.push(Turn {
                    user: transcript.clone(),
                    thought: String::new(),
                    answer: String::new(),
                    error: None,
                    message_id: None,
                    tools: Vec::new(),
                    permission: None,
                    done: false,
                    cancelling: false,
                    cancelled: false,
                    interrupted: false,
                    compacted: false,
                    compaction: None,
                    timestamp: Some(clock_stamp()),
                    quiet_cancel: false,
                });
                composer.record_history(&transcript);
                *inflight = true;
                *memory_injected = true;
                last_error.clear();
                if let Some(session_id) = active.session_id.clone() {
                    let _ = session_catalog::note_turn(&effective.dsh_home, &session_id, true);
                }
            }
            Err(error) => *last_error = error.message,
        }
    }
}

fn run_external_prompt_edit(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    guard: &mut TerminalGuard,
    screen: ScreenMode,
    composer: &PromptComposer,
    preserve: bool,
) -> Result<Option<String>, String> {
    // A file or image chip must stay atomic. Flattening it into the editor
    // would send a path instead of the admitted bytes.
    if composer.chips && preserve {
        return Err(
            "external editor refused: pasted, file-reference, or image chips must stay in the composer"
                .into(),
        );
    }
    let visual = std::env::var("VISUAL").ok();
    let editor = std::env::var("EDITOR").ok();
    let argv = prompt_edit::resolve_editor(visual.as_deref(), editor.as_deref())?;
    let grok_home =
        PathBuf::from(std::env::var_os("GROK_HOME").unwrap_or_else(|| PathBuf::from(".").into()));
    let draft = if preserve {
        composer.text().to_string()
    } else {
        String::new()
    };
    let path =
        prompt_edit::write_editor_temp(&grok_home, &draft).map_err(|error| error.to_string())?;
    guard.suspend().map_err(|error| error.to_string())?;
    let mut extra = Vec::new();
    for key in ["PATH", "HOME", "TERM", "TMPDIR"] {
        if let Some(value) = std::env::var_os(key) {
            extra.push((key.to_string(), value.to_string_lossy().into_owned()));
        }
    }
    let result = prompt_edit::run_external_editor(&argv, &path, &extra);
    let resume = guard.resume(terminal, screen);
    resume.map_err(|error| error.to_string())?;
    match result {
        Ok(text) => Ok(Some(text)),
        Err(error) => Err(format!("{error}; original draft kept")),
    }
}

/// `codsh --rust mcp ...`. Returns the exit code.
fn run_mcp(invocation: &mcp::McpInvocation, loaded: &config::EffectiveConfig) -> io::Result<i32> {
    if let mcp::McpCommand::Help(topic) = &invocation.command {
        println!("{}", mcp::help(topic));
        return Ok(0);
    }
    let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    let home = PathBuf::from(
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .unwrap_or_default(),
    );
    let input = mcp::DiscoverInput {
        grok_home: &loaded.grok_home,
        config_path: &loaded.config_path,
        home: &home,
        cwd: &loaded.cwd,
        trusted: loaded.workspace_trusted,
        env: &env,
    };
    let (label, outcome) = match &invocation.command {
        mcp::McpCommand::Help(_) => unreachable!("handled above"),
        mcp::McpCommand::List { json } => ("list", mcp::run_list(&mcp::discover(&input), *json)),
        mcp::McpCommand::Add(args) => ("add", mcp::run_add(&input, args)),
        mcp::McpCommand::Remove { name, scope } => {
            ("remove", mcp::run_remove(&input, name, *scope))
        }
        mcp::McpCommand::Enable { name } => ("enable", mcp::run_set_enabled(&input, name, true)),
        mcp::McpCommand::Disable { name } => ("disable", mcp::run_set_enabled(&input, name, false)),
        mcp::McpCommand::Doctor { json, name } => (
            "doctor",
            mcp_proxy::run_doctor(&input, *json, name.as_deref()),
        ),
    };
    if invocation.debug || invocation.debug_file.is_some() {
        let trace = format!(
            "mcp {label} config={} trusted={} exit={}\n",
            loaded.config_path.display(),
            loaded.workspace_trusted,
            outcome.code
        );
        eprint!("{trace}");
        if let Some(path) = &invocation.debug_file {
            std::fs::write(path, trace)?;
        }
    }
    print!("{}", outcome.stdout);
    eprint!("{}", outcome.stderr);
    Ok(outcome.code)
}

fn main() {
    // dsh starts this executable as the launcher for each stdio MCP server.
    // It must not touch the terminal, config, or sandbox setup.
    {
        let raw: Vec<String> = std::env::args().skip(1).collect();
        if raw.first().map(String::as_str) == Some(mcp::PROXY_SUBCOMMAND) {
            std::process::exit(mcp_proxy::run_proxy(&raw[1..]));
        }
        // The dsh workflow tool starts this executable as its Rhai engine.
        if raw.first().map(String::as_str) == Some(workflow::SUBCOMMAND) {
            std::process::exit(workflow::run_engine());
        }
    }
    let old_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        old_hook(info);
    }));
    if let Err(error) = run() {
        let message = error.to_string();
        if let Some(usage) = message.strip_prefix("usage: ") {
            eprintln!("error: {usage}");
            std::process::exit(2);
        }
        eprintln!("codsh: Rust startup failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_turn(user: &str) -> Turn {
        Turn {
            user: user.into(),
            thought: String::new(),
            answer: String::new(),
            error: None,
            message_id: None,
            tools: Vec::new(),
            permission: None,
            done: false,
            cancelling: false,
            cancelled: false,
            interrupted: false,
            compacted: false,
            compaction: None,
            timestamp: None,
            quiet_cancel: false,
        }
    }

    fn intervene_composer() -> (PromptComposer, PathBuf) {
        let home = std::env::temp_dir().join(format!(
            "codsh-intervene-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        (PromptComposer::load(&home, &[]), home)
    }

    fn queue_row(composer: &mut PromptComposer, text: &str) -> u64 {
        let busy = HostContext {
            inflight: true,
            minimal: false,
            voice_release: true,
        };
        for ch in text.chars() {
            composer.handle_key(
                crossterm::event::KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
                busy,
            );
        }
        composer.handle_key(
            crossterm::event::KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            busy,
        );
        composer.take_last_enqueued().expect("queued")
    }

    #[test]
    fn send_now_chord_follows_the_terminal_family() {
        use crossterm::event::KeyEvent;
        let ctrl = |code| KeyEvent::new(code, KeyModifiers::CONTROL);
        let other = term_family(Some("xterm-kitty"));
        assert_eq!(other, TermFamily::Other);
        assert!(is_send_now_chord(&ctrl(KeyCode::Enter), other));
        assert!(is_send_now_chord(&ctrl(KeyCode::Char('i')), other));
        assert!(
            !is_send_now_chord(&ctrl(KeyCode::Char('o')), other),
            "Ctrl+O is not send-now outside Apple Terminal"
        );
        assert!(!is_send_now_chord(&ctrl(KeyCode::Char('l')), other));
        assert!(!is_send_now_chord(
            &KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            other
        ));
        let apple = term_family(Some("Apple_Terminal"));
        assert_eq!(apple, TermFamily::AppleTerminal);
        assert!(is_send_now_chord(&ctrl(KeyCode::Char('o')), apple));
        assert!(is_send_now_chord(&ctrl(KeyCode::Enter), apple));
        assert!(is_send_now_chord(&ctrl(KeyCode::Char('i')), apple));
        for name in ["vscode", "cursor", "zed"] {
            let family = term_family(Some(name));
            assert_eq!(family, TermFamily::VsCode, "{name}");
            assert!(is_send_now_chord(&ctrl(KeyCode::Char('l')), family));
            assert!(!is_send_now_chord(&ctrl(KeyCode::Enter), family));
            assert!(!is_send_now_chord(&ctrl(KeyCode::Char('o')), family));
        }
    }

    fn question_event(id: &str, review: Option<&str>) -> control::ControlEvent {
        control::ControlEvent::Question {
            id: id.into(),
            session_id: "s1".into(),
            questions: serde_json::json!([{
                "id": "color",
                "question": "Which color?",
                "options": [{"label": "red"}, {"label": "blue"}]
            }]),
            review: review.map(|plan| control::Review {
                plan: plan.into(),
                plan_file: "/tmp/plan.md".into(),
            }),
        }
    }

    fn press(code: KeyCode) -> crossterm::event::KeyEvent {
        crossterm::event::KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn questions_open_one_at_a_time_and_close_by_id() {
        let (mut composer, _home) = intervene_composer();
        let mut side = Intervene::default();
        let mut hint = String::new();
        let events = vec![question_event("q1", None), question_event("q2", None)];
        assert!(
            apply_interaction_events(&events, &mut side, &mut composer, None, &mut hint, false)
                .is_none()
        );
        assert_eq!(side.ask.card.as_ref().unwrap().id, "q1");
        assert_eq!(side.ask.waiting.len(), 1);
        let closed = vec![control::ControlEvent::QuestionClosed {
            id: "q1".into(),
            reason: "timeout".into(),
        }];
        apply_interaction_events(&closed, &mut side, &mut composer, None, &mut hint, false);
        assert!(hint.contains("timed out"), "{hint}");
        assert_eq!(side.ask.card.as_ref().unwrap().id, "q2");
        // A dropped control channel drops the card rather than leaving it
        // waiting for an answer nobody can deliver.
        let gone = vec![control::ControlEvent::Closed("gone".into())];
        apply_interaction_events(&gone, &mut side, &mut composer, None, &mut hint, false);
        assert!(!side.ask.open());
    }

    #[test]
    fn minimal_prints_the_plan_and_answers_need_a_session() {
        let (mut composer, home) = intervene_composer();
        let mut side = Intervene::default();
        let mut hint = String::new();
        let events = vec![question_event("r1", Some("# Ship\n\n1. build"))];
        let printed =
            apply_interaction_events(&events, &mut side, &mut composer, None, &mut hint, true)
                .expect("minimal commits the plan to scrollback");
        assert!(printed.contains("# Ship"), "{printed}");
        assert!(side.ask.review.as_ref().unwrap().committed);
        // `a` without a live session reports that nothing was delivered.
        let (used, _) = handle_interaction_key(
            press(KeyCode::Char('a')),
            &mut side,
            &mut composer,
            None,
            &mut hint,
            true,
            &home,
        );
        assert!(used);
        assert!(hint.contains("not delivered"), "{hint}");
        assert!(side.ask.review.is_none());
    }

    #[test]
    fn plan_state_todos_and_ctrl_c_pass_through() {
        let (mut composer, home) = intervene_composer();
        let mut side = Intervene::default();
        let mut hint = String::new();
        let events = vec![
            control::ControlEvent::PlanState {
                session_id: "s1".into(),
                active: true,
                pending: None,
                plan_file: "/tmp/p.md".into(),
            },
            control::ControlEvent::Todos {
                session_id: "s1".into(),
                todos: Some(serde_json::json!([{"content": "a", "status": "pending"}])),
            },
            question_event("q9", None),
        ];
        apply_interaction_events(&events, &mut side, &mut composer, None, &mut hint, false);
        assert_eq!(side.ask.plan.flag(), Some("plan"));
        assert_eq!(side.ask.todos.as_ref().unwrap().len(), 1);
        let ctrl_c = crossterm::event::KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        let (used, _) = handle_interaction_key(
            ctrl_c,
            &mut side,
            &mut composer,
            None,
            &mut hint,
            false,
            &home,
        );
        assert!(!used, "Ctrl+C still cancels the turn");
        assert!(side.ask.card.is_some());
    }

    #[test]
    fn a_claimed_steer_leaves_the_queue_and_opens_its_own_turn() {
        let (mut composer, home) = intervene_composer();
        let id = queue_row(&mut composer, "go left");
        let wire = composer.queue_items()[0].wire_id();
        composer.queue_item_mut(id).unwrap().steering = true;
        let mut turns = vec![live_turn("first")];
        turns[0].message_id = Some("m1".into());
        let mut side = Intervene::default();
        let mut hint = String::new();
        apply_control_events(
            vec![control::ControlEvent::SteerClaimed(wire.clone())],
            &mut composer,
            &mut turns,
            true,
            &mut side,
            &mut hint,
            false,
        );
        assert_eq!(composer.queue_count(), 0, "claimed rows are not sent again");
        assert_eq!(turns.len(), 2);
        assert!(turns[0].done);
        assert_eq!(turns[1].user, "go left");
        assert!(!turns[1].done);
        // A duplicate claim for the same id changes nothing.
        apply_control_events(
            vec![control::ControlEvent::SteerClaimed(wire)],
            &mut composer,
            &mut turns,
            true,
            &mut side,
            &mut hint,
            false,
        );
        assert_eq!(turns.len(), 2);
        // Old-message chunks still reach the first turn; new ones the steer turn.
        assert!(message_turn(&mut turns, "m1").is_some_and(|turn| turn.user == "first"));
        assert!(message_turn(&mut turns, "m2").is_some_and(|turn| turn.user == "go left"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_returned_steer_is_queued_again_and_arms_the_drain_when_idle() {
        let (mut composer, home) = intervene_composer();
        let id = queue_row(&mut composer, "later");
        let wire = composer.queue_items()[0].wire_id();
        composer.queue_item_mut(id).unwrap().steering = true;
        assert_eq!(
            composer.next_release(false),
            prompt_queue::Release::Steering,
            "an outstanding steer holds the drain"
        );
        let mut turns = vec![live_turn("first")];
        let mut side = Intervene::default();
        let mut hint = String::new();
        apply_control_events(
            vec![control::ControlEvent::SteerReturned(wire)],
            &mut composer,
            &mut turns,
            false,
            &mut side,
            &mut hint,
            false,
        );
        assert!(side.drain_armed);
        assert_eq!(turns.len(), 1);
        assert!(matches!(
            composer.next_release(false),
            prompt_queue::Release::Item(item) if item.prompt.text == "later"
        ));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_closed_channel_returns_steering_rows_and_fails_a_pending_side_question() {
        let (mut composer, home) = intervene_composer();
        let id = queue_row(&mut composer, "row");
        composer.queue_item_mut(id).unwrap().steering = true;
        let mut side = Intervene {
            btw: Some(BtwPanel {
                id: "b1".into(),
                question: "q".into(),
                state: BtwState::Loading,
            }),
            ..Intervene::default()
        };
        let mut turns = Vec::new();
        let mut hint = String::new();
        apply_control_events(
            vec![control::ControlEvent::Closed("gone".into())],
            &mut composer,
            &mut turns,
            false,
            &mut side,
            &mut hint,
            false,
        );
        assert!(!composer.queue_items()[0].steering);
        assert_eq!(
            side.btw.as_ref().map(|panel| panel.state.clone()),
            Some(BtwState::Failed("gone".into()))
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn workflow_replies_show_only_for_the_newest_request() {
        let (mut composer, _home) = intervene_composer();
        let mut turns = Vec::new();
        let mut hint = String::new();
        let mut side = Intervene {
            workflow_request: Some("w2".into()),
            ..Intervene::default()
        };
        let mut apply = |events, side: &mut Intervene, hint: &mut String| {
            apply_control_events(events, &mut composer, &mut turns, true, side, hint, false);
        };
        apply(
            vec![control::ControlEvent::WorkflowResult {
                id: "w1".into(),
                outcome: Ok("stale".into()),
            }],
            &mut side,
            &mut hint,
        );
        assert_eq!(hint, "");
        assert_eq!(side.workflow_request.as_deref(), Some("w2"));
        apply(
            vec![control::ControlEvent::WorkflowResult {
                id: "w2".into(),
                outcome: Ok("Paused triage. /workflow resume triage to continue.".into()),
            }],
            &mut side,
            &mut hint,
        );
        assert_eq!(hint, "Paused triage. /workflow resume triage to continue.");
        assert!(side.workflow_request.is_none());
        side.workflow_request = Some("w3".into());
        apply(
            vec![control::ControlEvent::WorkflowResult {
                id: "w3".into(),
                outcome: Err("workflows are not available".into()),
            }],
            &mut side,
            &mut hint,
        );
        assert_eq!(hint, "/workflow failed: workflows are not available");
        side.workflow_request = Some("w4".into());
        apply(
            vec![control::ControlEvent::Closed("dsh exited".into())],
            &mut side,
            &mut hint,
        );
        assert_eq!(hint, "/workflow failed: dsh exited");
        assert!(side.workflow_request.is_none());
    }

    #[test]
    fn late_or_foreign_side_answers_are_dropped() {
        let (mut composer, home) = intervene_composer();
        let mut turns = Vec::new();
        let mut hint = String::new();
        let mut side = Intervene {
            btw: Some(BtwPanel {
                id: "b2".into(),
                question: "why".into(),
                state: BtwState::Loading,
            }),
            ..Intervene::default()
        };
        apply_control_events(
            vec![control::ControlEvent::BtwAnswer {
                id: "b1".into(),
                text: "stale".into(),
            }],
            &mut composer,
            &mut turns,
            true,
            &mut side,
            &mut hint,
            false,
        );
        assert_eq!(side.btw.as_ref().unwrap().state, BtwState::Loading);
        apply_control_events(
            vec![control::ControlEvent::BtwAnswer {
                id: "b2".into(),
                text: "because".into(),
            }],
            &mut composer,
            &mut turns,
            true,
            &mut side,
            &mut hint,
            false,
        );
        let panel = side.btw.clone().unwrap();
        assert_eq!(panel.state, BtwState::Answer("because".into()));
        assert!(btw_panel_text(&panel).contains("because"));
        assert!(
            turns.is_empty(),
            "a side answer never touches the transcript"
        );
        // Dismissed: the answer for b3 arrives with no panel and is dropped.
        side.btw = None;
        apply_control_events(
            vec![control::ControlEvent::BtwAnswer {
                id: "b3".into(),
                text: "late".into(),
            }],
            &mut composer,
            &mut turns,
            true,
            &mut side,
            &mut hint,
            false,
        );
        assert!(side.btw.is_none());
        // Minimal mode: a finished answer goes to native scrollback.
        side.btw = Some(BtwPanel {
            id: "b4".into(),
            question: "what".into(),
            state: BtwState::Loading,
        });
        let printed = apply_control_events(
            vec![control::ControlEvent::BtwAnswer {
                id: "b4".into(),
                text: "that".into(),
            }],
            &mut composer,
            &mut turns,
            true,
            &mut side,
            &mut hint,
            true,
        );
        assert_eq!(printed.as_deref(), Some("btw › what\nthat\n"));
        assert!(side.btw.is_none());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn btw_question_joins_the_parked_prefix() {
        assert_eq!(btw_question("fix X.", " what is Y?"), "fix X. what is Y?");
        assert_eq!(btw_question("", "why"), "why");
        assert_eq!(btw_question("  ", "  "), "");
    }

    #[test]
    fn a_send_now_cancel_hides_the_cancelled_marker() {
        let mut turn = live_turn("x");
        turn.done = true;
        turn.cancelled = true;
        turn.quiet_cancel = true;
        assert!(!turn_views(std::slice::from_ref(&turn))[0].cancelled);
        turn.quiet_cancel = false;
        assert!(turn_views(std::slice::from_ref(&turn))[0].cancelled);
    }

    #[test]
    fn tool_updates_find_their_turn_after_a_steer_split() {
        let mut turns = vec![live_turn("first"), live_turn("steer")];
        turns[0].tools.push(ToolRow {
            id: "t1".into(),
            title: "read".into(),
            kind: String::new(),
            status: "in_progress".into(),
            diff: String::new(),
            result: String::new(),
            raw_input: Value::Null,
        });
        assert!(tool_turn(&mut turns, "t1").is_some_and(|turn| turn.user == "first"));
        assert!(tool_turn(&mut turns, "t2").is_some_and(|turn| turn.user == "steer"));
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parse_inspect_json_and_model() {
        let launch = parse_launch(&args(&["inspect", "--json", "--model", "gateway"])).unwrap();
        assert!(matches!(
            launch.mode,
            LaunchMode::Inspect {
                json: true,
                help: false,
                ..
            }
        ));
        assert_eq!(launch.model.as_deref(), Some("gateway"));
        assert_eq!(launch.effort.as_deref(), None);
    }

    #[test]
    fn parse_sandbox_profile() {
        let launch = parse_launch(&args(&["--sandbox", "workspace"])).unwrap();
        assert_eq!(launch.sandbox.as_deref(), Some("workspace"));
        let inline = parse_launch(&args(&["--sandbox=read-only"])).unwrap();
        assert_eq!(inline.sandbox.as_deref(), Some("read-only"));
        let missing = parse_launch(&args(&["--sandbox"])).unwrap_err();
        assert!(missing.to_string().contains("missing --sandbox"));
    }

    #[test]
    fn parse_effort_flags() {
        let launch = parse_launch(&args(&["--model", "think", "--effort", "high"])).unwrap();
        assert_eq!(launch.model.as_deref(), Some("think"));
        assert_eq!(launch.effort.as_deref(), Some("high"));
        let alias = parse_launch(&args(&["--reasoning-effort=low"])).unwrap();
        assert_eq!(alias.effort.as_deref(), Some("low"));
    }

    #[test]
    fn restored_turn_copies_interrupted_and_compaction_into_nav() {
        let restored = turn_from_restored(session_history::RestoredTurn {
            user: "TOKEN_CRASH_EDIT".into(),
            thought: String::new(),
            answer: String::new(),
            tools: vec![session_history::RestoredTool {
                id: "t1".into(),
                title: "tool".into(),
                status: "pending".into(),
                diff: String::new(),
                result: String::new(),
            }],
            error: None,
            cancelled: false,
            interrupted: true,
            compacted: false,
            compaction: None,
        });
        let entries = nav_entries(std::slice::from_ref(&restored));
        assert!(entries[0].interrupted);
        assert!(entries[0].done);
        assert_eq!(entries[0].tool_meta[0].1, "unknown");
        assert!(entries[0].compaction.is_none());

        let compacted = turn_from_restored(session_history::RestoredTurn {
            user: "compaction summary".into(),
            thought: String::new(),
            answer: "summary".into(),
            tools: Vec::new(),
            error: None,
            cancelled: false,
            interrupted: false,
            compacted: true,
            compaction: Some(session_history::RestoredCompaction {
                items: Some(4),
                tokens: Some(210),
                provider: "cli-mock".into(),
                model: "cli-mock".into(),
                error: None,
            }),
        });
        let entries = nav_entries(std::slice::from_ref(&compacted));
        let sentence = entries[0].compaction.as_deref().unwrap_or("");
        assert!(sentence.contains("purpose=compaction"), "{sentence}");
        assert!(sentence.contains("cli-mock"), "{sentence}");
        assert!(!entries[0].interrupted);
    }

    #[test]
    fn feedback_slash_is_not_a_model_turn() {
        let command = models::parse_slash("/feedback save --title Fold --details Lost").unwrap();
        assert!(matches!(command, models::Command::Feedback { .. }));
        assert!(models::parse_slash("/feedbacks").is_none());
    }

    #[test]
    fn parse_inspect_help() {
        let launch = parse_launch(&args(&["inspect", "--help"])).unwrap();
        assert!(matches!(
            launch.mode,
            LaunchMode::Inspect { help: true, .. }
        ));
    }

    #[test]
    fn parse_login_logout_setup_flags() {
        let login = parse_launch(&args(&["login", "--help"])).unwrap();
        assert!(matches!(login.mode, LaunchMode::Login { help: true, .. }));
        let device = parse_launch(&args(&["login", "--device-code"])).unwrap();
        match device.mode {
            LaunchMode::Login { flags, .. } => assert!(flags.device_auth && !flags.oauth),
            other => panic!("{other:?}"),
        }
        let conflict = parse_launch(&args(&["login", "--oauth", "--device-auth"])).unwrap_err();
        assert!(conflict.to_string().contains("conflicts"));
        let logout = parse_launch(&args(&["logout", "--help"])).unwrap();
        assert!(matches!(logout.mode, LaunchMode::Logout { help: true, .. }));
        let setup = parse_launch(&args(&["setup", "--json"])).unwrap();
        match setup.mode {
            LaunchMode::Setup { flags, help } => {
                assert!(flags.json);
                assert!(!help);
            }
            other => panic!("{other:?}"),
        }
        let leader = parse_launch(&args(&["login", "--leader-socket", "x"])).unwrap_err();
        assert!(leader.to_string().contains("dsh owns execution"));
    }

    #[test]
    fn parse_leader_socket_is_refused() {
        let error = parse_launch(&args(&["inspect", "--leader-socket", "x"])).unwrap_err();
        assert!(error.to_string().contains("dsh owns execution"));
        let completions = parse_launch(&args(&[
            "completions",
            "--leader-socket",
            "/tmp/unused.sock",
            "bash",
        ]))
        .unwrap_err();
        let message = completions.to_string();
        assert!(message.contains("completions --leader-socket"));
        assert!(message.contains("dsh owns execution"));
        let equals =
            parse_launch(&args(&["completions", "--leader-socket=/tmp/unused.sock"])).unwrap_err();
        assert!(equals.to_string().contains("dsh owns execution"));
        let missing = parse_launch(&args(&["completions", "--leader-socket"])).unwrap_err();
        assert!(missing.to_string().contains("--leader-socket <PATH>"));
        let help = completions_help();
        assert!(help.contains("--leader-socket <PATH>"));
        assert!(help.contains("dsh owns execution"));
    }

    #[test]
    fn parse_sessions_and_resume_title() {
        let help = parse_launch(&args(&["sessions"])).unwrap();
        assert!(matches!(
            help.mode,
            LaunchMode::Sessions(session_catalog::SessionsCommand::Help)
        ));
        let list = parse_launch(&args(&["sessions", "list", "--limit", "5"])).unwrap();
        match list.mode {
            LaunchMode::Sessions(session_catalog::SessionsCommand::List { limit }) => {
                assert_eq!(limit, 5);
            }
            other => panic!("{other:?}"),
        }
        let search = parse_launch(&args(&["sessions", "search", "rate", "limit"])).unwrap();
        match search.mode {
            LaunchMode::Sessions(session_catalog::SessionsCommand::Search { query, limit }) => {
                assert_eq!(query, "rate limit");
                assert_eq!(limit, 20);
            }
            other => panic!("{other:?}"),
        }
        let missing = parse_launch(&args(&["sessions", "search"])).unwrap_err();
        assert!(missing.to_string().contains("missing search query"));
        let dashboard = parse_launch(&args(&["dashboard"])).unwrap();
        assert!(matches!(dashboard.mode, LaunchMode::Dashboard));
    }

    #[test]
    fn parse_plain_prompt_sources_and_bounds() {
        let single =
            parse_launch(&args(&["-p", "hello", "--cwd", "/tmp", "--max-turns", "2"])).unwrap();
        assert_eq!(single.cwd.as_deref(), Some(std::path::Path::new("/tmp")));
        match single.mode {
            LaunchMode::Plain {
                prompt: PlainPrompt::Text(text),
                max_turns,
                tools,
                resume,
            } => {
                assert_eq!(text, "hello");
                assert_eq!(max_turns, Some(2));
                assert!(tools.is_none());
                assert!(resume.is_none());
            }
            other => panic!("{other:?}"),
        }
        let file = parse_launch(&args(&[
            "--prompt-file",
            "prompt.txt",
            "--tools",
            "read_file,Bash",
            "--disallowed-tools",
            "edit",
            "--continue",
        ]))
        .unwrap();
        match file.mode {
            LaunchMode::Plain {
                prompt: PlainPrompt::File(path),
                tools: Some(PlainTools::Filter { allow, deny }),
                resume: Some(PlainResume::Continue),
                ..
            } => {
                assert_eq!(path, std::path::PathBuf::from("prompt.txt"));
                assert_eq!(
                    allow
                        .as_deref()
                        .map(|names| { names.iter().map(String::as_str).collect::<Vec<_>>() }),
                    Some(vec!["read_file", "Bash"])
                );
                assert_eq!(
                    deny.as_deref()
                        .map(|names| names.iter().map(String::as_str).collect::<Vec<_>>()),
                    Some(vec!["edit"])
                );
            }
            other => panic!("{other:?}"),
        }
        let verbatim = parse_launch(&args(&["-p", "keep  spaces", "--verbatim"])).unwrap();
        assert!(verbatim.verbatim);
        assert!(matches!(
            verbatim.mode,
            LaunchMode::Plain {
                prompt: PlainPrompt::Text(text),
                ..
            } if text == "keep  spaces"
        ));
        let continued = parse_launch(&args(&["-c", "-p", "again"])).unwrap();
        assert!(matches!(
            continued.mode,
            LaunchMode::Plain {
                resume: Some(PlainResume::Continue),
                ..
            }
        ));
        let resumed = parse_launch(&args(&["-p", "again", "-r", "title"])).unwrap();
        assert!(matches!(
            resumed.mode,
            LaunchMode::Plain {
                resume: Some(PlainResume::Id(id)),
                ..
            } if id == "title"
        ));
        let bare_continue = parse_launch(&args(&["-c"])).unwrap();
        assert!(matches!(bare_continue.mode, LaunchMode::Continue));
        let missing_resume = parse_launch(&args(&["-r"])).unwrap_err();
        assert!(missing_resume.to_string().contains("missing session id"));
        let scoped = parse_launch(&args(&[
            "-p",
            "hello",
            "--disallowed-tools",
            "Agent(explore),edit",
        ]))
        .unwrap();
        assert_eq!(scoped.subagents.denied_types, vec!["explore".to_string()]);
        let duplicate = parse_launch(&args(&["-p", "one", "-p", "two"])).unwrap_err();
        assert!(duplicate.to_string().contains("conflicting prompt"));
        let unknown = parse_launch(&args(&["--not-a-real-option"])).unwrap_err();
        assert!(unknown.to_string().starts_with("usage: "));
        assert!(unknown.to_string().contains("unexpected argument"));
        let missing_allow = parse_launch(&args(&["--allowedTools"])).unwrap_err();
        assert!(missing_allow.to_string().contains("'--allow <RULE>'"));
        let bad_format = parse_launch(&args(&["--output-format", "not-a-format"])).unwrap_err();
        assert!(bad_format.to_string().contains("invalid value"));
        let plain_format =
            parse_launch(&args(&["-p", "hello", "--output-format", "plain"])).unwrap();
        assert!(matches!(plain_format.mode, LaunchMode::Plain { .. }));
        assert_eq!(plain_format.output_format, headless::OutputFormat::Plain);
        let json_format = parse_launch(&args(&["-p", "hello", "--output-format", "json"])).unwrap();
        assert_eq!(json_format.output_format, headless::OutputFormat::Json);
        let messages = parse_launch(&args(&[
            "-p",
            "hello",
            "--output-format",
            "streaming-messages-json",
            "--include-partial-messages",
        ]))
        .unwrap();
        assert_eq!(
            messages.output_format,
            headless::OutputFormat::StreamingMessagesJson
        );
        assert!(messages.include_partial_messages);
        let ignored_partial = parse_launch(&args(&[
            "-p",
            "hello",
            "--output-format",
            "json",
            "--include-partial-messages",
        ]))
        .unwrap();
        assert!(!ignored_partial.include_partial_messages);
        assert!(
            ignored_partial
                .warnings
                .iter()
                .any(|warning| warning.contains("include-partial-messages"))
        );
        let shells = parse_launch(&args(&["completions", "zsh"])).unwrap();
        assert!(matches!(
            shells.mode,
            LaunchMode::Completions { help: false, .. }
        ));
        let shell_help = parse_launch(&args(&["completions", "--help"])).unwrap();
        assert!(matches!(
            shell_help.mode,
            LaunchMode::Completions { help: true, .. }
        ));
        let json = parse_launch(&args(&[
            "--prompt-json",
            "{\"type\":\"text\",\"text\":\"hi\"}",
        ]))
        .unwrap();
        assert!(matches!(
            json.mode,
            LaunchMode::Plain {
                prompt: PlainPrompt::Json(_),
                ..
            }
        ));
        let zero = parse_launch(&args(&["-p", "hello", "--max-turns", "0"])).unwrap_err();
        assert!(zero.to_string().contains("positive integer"));
        let positional = parse_launch(&args(&["fix the bug"])).unwrap_err();
        assert!(positional.to_string().contains("positional prompt"));
        let deferred = parse_launch(&args(&["-p", "hello", "--json-schema", "{}"])).unwrap_err();
        assert!(deferred.to_string().contains("later ticket"));
        let subagents = parse_launch(&args(&["-p", "hello", "--no-subagents"])).unwrap();
        assert!(subagents.subagents.disabled);
        let interactive = parse_launch(&args(&["--no-subagents"])).unwrap();
        assert!(interactive.subagents.disabled);
        assert!(
            interactive.warnings.is_empty(),
            "{:?}",
            interactive.warnings
        );
    }

    #[test]
    fn verbatim_keeps_user_text_and_normal_prompt_still_expands() {
        let root = tempfile::tempdir().unwrap();
        let grok = root.path().join("grok");
        std::fs::create_dir_all(grok.join("commands")).unwrap();
        std::fs::create_dir_all(grok.join("rules")).unwrap();
        std::fs::write(
            grok.join("commands").join("ship-note.md"),
            "---\ndescription: note\n---\nSHIP_NOTE_BODY\n",
        )
        .unwrap();
        std::fs::write(grok.join("rules").join("home.md"), "HOME_RULE\n").unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut input = config::LoadInput {
            home: home.clone(),
            dsh_home: root.path().join("dsh"),
            cwd: root.path().join("empty"),
            grok_home: Some(grok),
            ..config::LoadInput::default()
        };
        std::fs::create_dir_all(&input.cwd).unwrap();
        input.env.insert("HOME".into(), home.display().to_string());
        let mut effective = config::load_from(input);
        config::refresh_assets(&mut effective, &home);
        let slash = "/ship-note  keep\nline";
        let normal = parse_launch(&args(&["-p", slash])).unwrap();
        let wrapped = model_prompt(&normal, &effective, slash, None, true);
        assert!(wrapped.contains("SHIP_NOTE_BODY"), "{wrapped}");
        assert!(wrapped.contains("<human_rules>"), "{wrapped}");
        assert_ne!(wrapped, slash);
        let frozen = parse_launch(&args(&["-p", slash, "--verbatim"])).unwrap();
        assert_eq!(model_prompt(&frozen, &effective, slash, None, true), slash);
        let spaced = "  keep\nline";
        assert_eq!(
            model_prompt(&frozen, &effective, spaced, None, true),
            spaced
        );
        let text = |value: &str| serde_json::json!({ "type": "text", "text": value });
        // Rules still reach the model: they lead as their own block and the
        // user's block keeps its exact bytes. The slash body is not expanded.
        let blocks = blocks_with_model_prompt(&frozen, &effective, vec![text(slash)], None, true);
        assert_eq!(blocks.len(), 2, "{blocks:?}");
        let context = blocks[0]["text"].as_str().unwrap_or_default();
        assert!(context.contains("HOME_RULE"), "{context}");
        assert!(!context.contains("SHIP_NOTE_BODY"), "{context}");
        assert!(!context.contains(slash), "{context}");
        assert_eq!(blocks[1]["text"], slash);
        let rules = parse_launch(&args(&[
            "-p",
            slash,
            "--verbatim",
            "--rules",
            "SESSION_RULE_SENTINEL",
        ]))
        .unwrap();
        assert_eq!(model_prompt(&rules, &effective, slash, None, true), slash);
        let ruled = blocks_with_model_prompt(&rules, &effective, vec![text(slash)], None, false);
        assert_eq!(ruled.len(), 2, "{ruled:?}");
        let context = ruled[0]["text"].as_str().unwrap_or_default();
        assert!(context.contains("SESSION_RULE_SENTINEL"), "{context}");
        assert!(context.contains("HOME_RULE"), "{context}");
        assert!(!context.contains("SHIP_NOTE_BODY"), "{context}");
        assert_eq!(ruled[1]["text"], slash);
        let replaced = parse_launch(&args(&[
            "-p",
            slash,
            "--verbatim",
            "--system-prompt-override",
            "ONLY_THIS_OVERRIDE",
        ]))
        .unwrap();
        let only = blocks_with_model_prompt(&replaced, &effective, vec![text(slash)], None, true);
        assert_eq!(only.len(), 2, "{only:?}");
        let context = only[0]["text"].as_str().unwrap_or_default();
        assert!(context.contains("ONLY_THIS_OVERRIDE"), "{context}");
        assert!(!context.contains("HOME_RULE"), "{context}");
        assert_eq!(only[1]["text"], slash);
    }

    #[test]
    fn relative_prompt_file_stays_inside_cwd_and_other_inputs_stay_beside_the_invocation() {
        // Upstream apply_cwd changes the process directory and then reads
        // --prompt-file, so a relative file is inside --cwd. The debug file,
        // sandbox report, and trust folder are anchored to the invocation.
        let mut launch = parse_launch(&args(&[
            "--prompt-file",
            "prompt.txt",
            "--cwd",
            "../b",
            "--sandbox-report",
            "report.json",
            "--trust-folder",
            "trusted",
        ]))
        .unwrap();
        let base = std::path::Path::new("/invoked/here");
        anchor_input_paths(&mut launch, base);
        assert!(matches!(
            &launch.mode,
            LaunchMode::Plain {
                prompt: PlainPrompt::File(path),
                ..
            } if path == std::path::Path::new("prompt.txt")
        ));
        assert_eq!(launch.cwd.as_deref(), Some(base.join("../b").as_path()));
        assert_eq!(
            launch.sandbox_report.as_deref(),
            Some(base.join("report.json").as_path())
        );
        assert_eq!(
            launch.trust_folder.as_deref(),
            Some(base.join("trusted").as_path())
        );
        let mut logged = parse_launch(&args(&[
            "--cwd",
            "../b",
            "inspect",
            "--debug-file",
            "debug.log",
        ]))
        .unwrap();
        anchor_input_paths(&mut logged, base);
        assert!(matches!(
            &logged.mode,
            LaunchMode::Inspect { debug_file: Some(path), .. } if path == &base.join("debug.log")
        ));
        let absolute =
            parse_launch(&args(&["--prompt-file", "/abs/p.txt", "--cwd", "/x"])).unwrap();
        let mut kept = absolute;
        anchor_input_paths(&mut kept, base);
        assert!(matches!(
            &kept.mode,
            LaunchMode::Plain { prompt: PlainPrompt::File(path), .. } if path == std::path::Path::new("/abs/p.txt")
        ));
    }

    #[test]
    fn inherited_plain_env_reaches_only_plain_turns() {
        let inherited = [
            ("CODSH_PLAIN_TOOLS".to_string(), "deny:edit".to_string()),
            ("CODSH_PLAIN_MAX_TURNS".to_string(), "1".to_string()),
        ];
        let plain = parse_launch(&args(&["-p", "hello"])).unwrap();
        let env = plain_env(&plain.mode, &inherited);
        assert!(
            env.contains(&("CODSH_PLAIN_TOOLS".into(), "deny:edit".into())),
            "{env:?}"
        );
        assert!(
            env.contains(&("CODSH_PLAIN_MAX_TURNS".into(), "1".into())),
            "{env:?}"
        );
        let flagged = parse_launch(&args(&[
            "-p",
            "hello",
            "--disallowed-tools",
            "bash",
            "--max-turns",
            "3",
        ]))
        .unwrap();
        let env = plain_env(&flagged.mode, &inherited);
        assert!(
            env.contains(&("CODSH_PLAIN_TOOLS".into(), "deny:bash".into())),
            "{env:?}"
        );
        assert!(
            env.contains(&("CODSH_PLAIN_MAX_TURNS".into(), "3".into())),
            "{env:?}"
        );
        assert_eq!(env.len(), 2, "{env:?}");
        let interactive = parse_launch(&args(&["--continue"])).unwrap();
        assert!(plain_env(&interactive.mode, &inherited).is_empty());
        // The ACP child never copies the inherited keys itself.
        assert!(!acp::INHERITED_ENV.contains(&"CODSH_PLAIN_TOOLS"));
        assert!(!acp::INHERITED_ENV.contains(&"CODSH_PLAIN_MAX_TURNS"));
    }

    #[test]
    fn loop_lines_and_the_scheduler_switch() {
        assert_eq!(loop_command_args("/loop"), Some(""));
        assert_eq!(
            loop_command_args("  /loop   30m check  "),
            Some("30m check")
        );
        assert_eq!(loop_command_args("/loopy x"), None);
        assert_eq!(loop_command_args("loop x"), None);
        assert_eq!(loop_command_args("/btw /loop x"), None);
        // Only the client sets the switch; a parent's value never reaches dsh.
        assert!(!acp::INHERITED_ENV.contains(&"CODSH_SCHEDULER"));
        assert!(acp::INHERITED_ENV.contains(&"CODSH_TEST_SCHEDULER_TIME_SCALE"));
        assert!(acp::INHERITED_ENV.contains(&"CODSH_TEST_SCHEDULER_EPOCH"));
        assert!(acp::INHERITED_ENV.contains(&"CODSH_TEST_SCHEDULER_OFFSET_MS"));
    }

    #[test]
    fn typed_agent_filters_deny_types_and_cannot_be_allowed() {
        for (entry, types, names) in [
            ("Agent(explore, plan)", vec!["explore", "plan"], vec![]),
            ("agent(explore)", vec!["explore"], vec![]),
            ("AGENT(plan)", vec!["plan"], vec![]),
            ("Agent(explore),edit", vec!["explore"], vec!["edit"]),
            ("read,Agent(a,b),edit", vec!["a", "b"], vec!["read", "edit"]),
        ] {
            let launch =
                parse_launch(&args(&["-p", "hello", "--disallowed-tools", entry])).unwrap();
            assert_eq!(launch.subagents.denied_types, types, "{entry}");
            match &launch.mode {
                LaunchMode::Plain {
                    tools: Some(PlainTools::Filter { deny, .. }),
                    ..
                } => assert_eq!(deny.clone().unwrap_or_default(), names, "{entry}"),
                other => panic!("{entry}: {other:?}"),
            }
            let error = parse_launch(&args(&["-p", "hello", "--tools", entry])).unwrap_err();
            let text = error.to_string();
            assert!(text.contains("cannot allow"), "{entry}: {text}");
            assert!(!text.starts_with("usage: "), "{entry}: {text}");
        }
        for entry in ["Agent()", "Agent( , )"] {
            let text = parse_launch(&args(&["-p", "hello", "--disallowed-tools", entry]))
                .unwrap_err()
                .to_string();
            assert!(text.contains("name at least one subagent type"), "{text}");
        }
        let open = parse_launch(&args(&[
            "-p",
            "hello",
            "--disallowed-tools",
            "Agent(explore",
        ]))
        .unwrap_err()
        .to_string();
        assert!(open.contains("cannot parse"), "{open}");
        // Interactive runs ignore the headless flag, types included.
        let interactive = parse_launch(&args(&["--disallowed-tools", "Agent(explore)"])).unwrap();
        assert!(interactive.subagents.denied_types.is_empty());
        assert!(scoped_agent_filter("Agent(explore"));
        assert!(scoped_agent_filter("agent()"));
        assert!(scoped_agent_filter("AGENT(plan)"));
        assert!(!scoped_agent_filter("Agent"));
        assert!(!scoped_agent_filter("agent"));
        assert!(!scoped_agent_filter("plan)"));
        let plain = parse_launch(&args(&["-p", "hello", "--disallowed-tools", "Agent"])).unwrap();
        assert!(matches!(plain.mode, LaunchMode::Plain { .. }));
    }

    #[test]
    fn integrated_sandbox_memory_web_and_cwd_flags_are_not_refused() {
        let plain = parse_launch(&args(&[
            "-p",
            "hello",
            "--sandbox",
            "workspace",
            "--no-memory",
            "--disable-web-search",
            "--cwd",
            "/tmp",
        ]))
        .unwrap();
        assert!(matches!(plain.mode, LaunchMode::Plain { .. }));
        assert_eq!(plain.sandbox.as_deref(), Some("workspace"));
        assert!(plain.no_memory);
        assert!(plain.disable_web_search);
        assert_eq!(plain.cwd.as_deref(), Some(std::path::Path::new("/tmp")));
        assert!(plain.warnings.is_empty(), "{:?}", plain.warnings);
        let interactive = parse_launch(&args(&["--disable-web-search", "--cwd", "/tmp"])).unwrap();
        assert!(matches!(interactive.mode, LaunchMode::New));
        assert!(interactive.disable_web_search);
        assert_eq!(
            interactive.cwd.as_deref(),
            Some(std::path::Path::new("/tmp"))
        );
        // The guide: headless-only flags print a warning in the TUI and are ignored.
        let ignored = parse_launch(&args(&[
            "--max-turns",
            "2",
            "--tools",
            "read",
            "--disallowed-tools",
            "edit",
            "--version",
        ]))
        .unwrap();
        assert!(matches!(ignored.mode, LaunchMode::Version));
        for flag in ["--max-turns", "--tools", "--disallowed-tools"] {
            assert!(
                ignored
                    .warnings
                    .iter()
                    .any(|warning| warning.contains(flag) && warning.contains("ignored")),
                "{flag}: {:?}",
                ignored.warnings
            );
        }
        let short_model = parse_launch(&args(&["-m", "gateway", "-p", "hello"])).unwrap();
        assert_eq!(short_model.model.as_deref(), Some("gateway"));
        assert!(matches!(
            parse_launch(&args(&["-v"])).unwrap().mode,
            LaunchMode::Version
        ));
        let quiet_verbatim = parse_launch(&args(&["--verbatim"])).unwrap();
        assert!(!quiet_verbatim.verbatim);
        assert!(
            quiet_verbatim
                .warnings
                .iter()
                .any(|warning| warning.contains("--verbatim"))
        );
        let later = parse_launch(&args(&["-p", "hello", "--experimental-memory"])).unwrap_err();
        assert!(later.to_string().contains("later ticket"), "{later}");
    }

    #[test]
    fn every_completed_flag_is_accepted_by_the_parser() {
        let script = completion_script("bash");
        let flags = script
            .lines()
            .find_map(|line| line.trim().strip_prefix("local flags=\""))
            .and_then(|rest| rest.strip_suffix('"'))
            .expect("bash flags list");
        let valued = script
            .lines()
            .find(|line| line.trim_start().starts_with("--resume|-r|"))
            .expect("bash value flags")
            .trim()
            .trim_end_matches(')');
        let valued: Vec<&str> = valued.split('|').collect();
        for flag in flags.split_whitespace() {
            let mut argv = vec![flag];
            if valued.contains(&flag) {
                argv.push(if flag == "--max-turns" {
                    "2"
                } else {
                    "workspace"
                });
            }
            if !matches!(flag, "-p" | "--single" | "--prompt-file" | "--prompt-json") {
                argv.extend(["-p", "hello"]);
            }
            if let Err(error) = parse_launch(&args(&argv)) {
                assert!(
                    !error.to_string().contains("unexpected argument"),
                    "{flag}: {error}"
                );
            }
        }
    }

    #[test]
    fn disable_web_search_turns_off_search_and_fetch_for_the_process() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut input = config::LoadInput {
            home: home.clone(),
            dsh_home: root.path().join("dsh"),
            cwd: root.path().to_path_buf(),
            grok_home: Some(root.path().join("grok")),
            ..config::LoadInput::default()
        };
        input.env.insert("GROK_WEB_FETCH".into(), "1".into());
        let enabled = config::load_from(input.clone());
        assert!(enabled.web.fetch.enabled);
        input.cli_disable_web_search = true;
        let disabled = config::load_from(input);
        assert!(!disabled.web.search.enabled);
        assert!(!disabled.web.fetch.enabled);
        assert_eq!(disabled.web.search.enabled_source, "--disable-web-search");
        assert_eq!(disabled.web.fetch.enabled_source, "--disable-web-search");
        let env = config::web_env(&disabled);
        assert!(env.contains(&("CODSH_WEB_SEARCH".into(), "0".into())));
        assert!(env.contains(&("CODSH_WEB_FETCH".into(), "0".into())));
        assert!(env.contains(&("CODSH_DISABLE_WEB_TOOLS".into(), "1".into())));
    }

    #[test]
    fn verbatim_sends_first_turn_memory_as_its_own_block() {
        let root = tempfile::tempdir().unwrap();
        let grok = root.path().join("grok");
        std::fs::create_dir_all(grok.join("memory")).unwrap();
        std::fs::write(
            grok.join("memory").join("MEMORY.md"),
            "MEMORY_SENTINEL note\n",
        )
        .unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut input = config::LoadInput {
            home: home.clone(),
            dsh_home: root.path().join("dsh"),
            cwd: root.path().join("empty"),
            grok_home: Some(grok),
            ..config::LoadInput::default()
        };
        std::fs::create_dir_all(&input.cwd).unwrap();
        input.env.insert("HOME".into(), home.display().to_string());
        input.env.insert("GROK_MEMORY".into(), "1".into());
        let effective = config::load_from(input);
        let text = |value: &str| serde_json::json!({ "type": "text", "text": value });
        let spaced = "  keep\nline";
        let frozen = parse_launch(&args(&["-p", spaced, "--verbatim"])).unwrap();
        let first = blocks_with_model_prompt(&frozen, &effective, vec![text(spaced)], None, true);
        assert_eq!(first.len(), 2, "{first:?}");
        let context = first[0]["text"].as_str().unwrap_or_default();
        assert!(context.contains("MEMORY_SENTINEL"), "{context}");
        assert!(!context.contains(spaced), "{context}");
        assert_eq!(first[1]["text"], spaced);
        let resumed =
            blocks_with_model_prompt(&frozen, &effective, vec![text(spaced)], None, false);
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0]["text"], spaced);
        let session_off =
            blocks_with_model_prompt(&frozen, &effective, vec![text(spaced)], Some(false), true);
        assert_eq!(session_off.len(), 1);
        // Without --verbatim the note still leads the first text block, once.
        let normal = parse_launch(&args(&["-p", "one"])).unwrap();
        let two = blocks_with_model_prompt(
            &normal,
            &effective,
            vec![text("one"), text("two")],
            None,
            true,
        );
        assert_eq!(two.len(), 2);
        let seen = two
            .iter()
            .filter(|block| {
                block["text"]
                    .as_str()
                    .is_some_and(|value| value.contains("MEMORY_SENTINEL"))
            })
            .count();
        assert_eq!(seen, 1, "{two:?}");
        assert!(two[0]["text"].as_str().unwrap_or_default().ends_with("one"));
        assert_eq!(two[1]["text"], "two");
    }

    #[test]
    fn parse_continue_with_model() {
        let launch = parse_launch(&args(&["--model", "gateway", "--continue"])).unwrap();
        assert!(matches!(launch.mode, LaunchMode::Continue));
        assert_eq!(launch.model.as_deref(), Some("gateway"));
    }

    #[test]
    fn refuses_turns_until_advertised_selection_applies() {
        assert!(!turn_allowed(false));
        assert!(turn_allowed(true));
    }

    #[test]
    fn rules_wrap_the_user_text_once_and_leave_image_blocks_alone() {
        let dir = tempfile::TempDir::new().unwrap();
        let grok = dir.path().join(".grok");
        std::fs::create_dir_all(grok.join("rules")).unwrap();
        std::fs::write(grok.join("rules").join("home.md"), "HOME_RULE_SENTINEL\n").unwrap();
        std::fs::write(grok.join("config.toml"), "[memory]\nenabled = true\n").unwrap();
        let mut env = std::collections::BTreeMap::new();
        env.insert("HOME".into(), dir.path().display().to_string());
        let effective = config::load_from(config::LoadInput {
            home: dir.path().to_path_buf(),
            dsh_home: dir.path().join("dsh"),
            cwd: dir.path().to_path_buf(),
            grok_home: Some(grok),
            env,
            cli_model: None,
            cli_effort: None,
            cli_trust: false,
            cli_revoke_trust: false,
            cli_trust_path: None,
            interactive: true,
            cli_permission_mode: None,
            cli_always_approve: false,
            cli_auto: false,
            cli_allow: Vec::new(),
            cli_deny: Vec::new(),
            cli_no_memory: false,
            cli_sandbox: None,
            cli_disable_web_search: false,
            cli_subagents: Default::default(),
            cli_interaction: Default::default(),
        });
        assert!(effective.memory.enabled(), "{:?}", effective.memory);
        let store = memory::open_store(&effective.grok_home, &effective.cwd).unwrap();
        memory::save_note(&store, memory::Scope::Global, "MEMORY_NOTE_SENTINEL").unwrap();
        let launch = parse_launch(&args(&["--rules", "SESSION_RULE_SENTINEL"])).unwrap();
        let image = images::prepare_image(1, images::sniff_image(&images::tiny_png()).unwrap());
        let saved = images::save_original(dir.path(), &image).unwrap();
        let mut stored = image;
        stored.saved_path = Some(saved);
        let built =
            images::prompt_blocks_with_images("look", &[], std::slice::from_ref(&stored), false)
                .unwrap();
        let file = attachments::PreparedAttachment {
            mention: "@note.txt".into(),
            status: attachments::AttachStatus::Ready,
            bytes: None,
            text: Some("FILE_BODY_SENTINEL".into()),
            size: 18,
            modified: None,
            preview: "FILE_BODY_SENTINEL".into(),
            detail: String::new(),
        };
        let with_file =
            images::prompt_blocks_with_images("look", std::slice::from_ref(&file), &[], true)
                .unwrap();
        let wrapped = blocks_with_model_prompt(&launch, &effective, built, None, true);
        let texts: Vec<&str> = wrapped
            .iter()
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .collect();
        assert_eq!(texts.len(), 2, "{texts:?}");
        assert!(
            texts[0].contains("HOME_RULE_SENTINEL")
                && texts[0].contains("SESSION_RULE_SENTINEL")
                && texts[0].contains("MEMORY_NOTE_SENTINEL")
                && texts[0].contains("look"),
            "{}",
            texts[0]
        );
        assert!(
            texts[1].starts_with("\n<pasted-image ") && texts[1].ends_with("</pasted-image>\n"),
            "{}",
            texts[1]
        );
        for marker in [
            "HOME_RULE_SENTINEL",
            "SESSION_RULE_SENTINEL",
            "MEMORY_NOTE_SENTINEL",
            "<human_rules>",
            "<local-memory>",
        ] {
            assert!(!texts[1].contains(marker), "{marker} leaked: {}", texts[1]);
        }
        let later =
            images::prompt_blocks_with_images("next", &[], std::slice::from_ref(&stored), false)
                .unwrap();
        let again = blocks_with_model_prompt(&launch, &effective, later, None, false);
        let second: Vec<&str> = again
            .iter()
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .collect();
        assert_eq!(
            second[0].matches("HOME_RULE_SENTINEL").count(),
            1,
            "{}",
            second[0]
        );
        assert!(!second[0].contains("<local-memory>"), "{}", second[0]);
        assert!(second[1].starts_with("\n<pasted-image "), "{}", second[1]);
        assert!(!second[1].contains("HOME_RULE_SENTINEL"), "{}", second[1]);
        let files = blocks_with_model_prompt(&launch, &effective, with_file, None, true);
        let file_text = files
            .iter()
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .find(|text| text.contains("FILE_BODY_SENTINEL"))
            .expect("attachment body");
        assert!(
            file_text.starts_with("\nAttached file "),
            "rules wrapped the attachment body: {file_text}"
        );
    }

    #[test]
    fn retained_apply_keeps_the_previous_patch_when_settings_write_fails() {
        let dir = tempfile::TempDir::new().unwrap();
        let grok = dir.path().join(".grok");
        std::fs::create_dir_all(&grok).unwrap();
        std::fs::write(
            grok.join("config.toml"),
            r#"
[models]
default = "chat"

[model.chat]
name = "Local chat"
model = "shared-name"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
"#,
        )
        .unwrap();
        let mut env = std::collections::BTreeMap::new();
        env.insert("XAI_API_KEY".into(), "ROUTE_TOKEN".into());
        env.insert("HOME".into(), dir.path().display().to_string());
        let effective = config::load_from(config::LoadInput {
            home: dir.path().to_path_buf(),
            dsh_home: dir.path().join("dsh"),
            cwd: dir.path().to_path_buf(),
            grok_home: Some(grok),
            env: env.clone(),
            cli_model: None,
            cli_effort: None,
            cli_trust: false,
            cli_revoke_trust: false,
            cli_trust_path: None,
            interactive: false,
            cli_permission_mode: None,
            cli_always_approve: false,
            cli_auto: false,
            cli_allow: Vec::new(),
            cli_deny: Vec::new(),
            cli_no_memory: false,
            cli_sandbox: None,
            cli_disable_web_search: false,
            cli_subagents: Default::default(),
            cli_interaction: Default::default(),
        });
        assert!(effective.ready, "{:?}", effective.errors);
        let previous = dir.path().join("previous.yml");
        std::fs::write(&previous, "provider: chat\n").unwrap();
        let mut extra_env = vec![("XAI_API_KEY".into(), "ROUTE_TOKEN".into())];
        let mut patch = Some(previous.clone());
        let mut apply_failed = false;
        let mut last_error = String::new();
        let mut hint = String::new();
        assert!(prepare_retained_apply(
            &effective,
            &mut extra_env,
            &mut patch,
            &mut apply_failed,
            &mut last_error,
            &mut hint,
        ));
        let written = std::fs::read_to_string(patch.as_ref().unwrap()).unwrap();
        assert!(written.contains("provider: chat"), "{written}");
        assert!(written.contains("model: shared-name"), "{written}");
        assert!(written.contains("llm-deepseek"), "{written}");
        assert!(
            written.contains("disabled: true"),
            "the configured chat provider must disable the default deepseek adapter: {written}"
        );
        assert!(
            extra_env
                .iter()
                .any(|(key, _)| key == "CODSH_PERMISSION_POLICY")
        );
        std::fs::write(&effective.settings_yaml, "llm-pi-ai:\n  providers: {}\n").unwrap();
        assert!(
            !prepare_retained_apply(
                &effective,
                &mut extra_env,
                &mut patch,
                &mut apply_failed,
                &mut last_error,
                &mut hint,
            ),
            "a refused settings write must not start a replacement session"
        );
        assert!(apply_failed);
        assert!(
            std::fs::read_to_string(patch.as_ref().unwrap())
                .unwrap()
                .contains("model: shared-name"),
            "the previous patch stays until a replacement is allowed"
        );
        assert!(last_error.contains("refusing to overwrite"));
    }

    fn memory_effective(dir: &Path, enabled: bool) -> config::EffectiveConfig {
        let grok = dir.join(".grok");
        std::fs::create_dir_all(&grok).unwrap();
        std::fs::write(
            grok.join("config.toml"),
            format!(
                r#"
[models]
default = "chat"

[model.chat]
name = "Local chat"
model = "shared-name"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"

[memory]
enabled = {enabled}
"#
            ),
        )
        .unwrap();
        let mut env = std::collections::BTreeMap::new();
        env.insert("XAI_API_KEY".into(), "ROUTE_TOKEN".into());
        env.insert("HOME".into(), dir.display().to_string());
        let effective = config::load_from(config::LoadInput {
            home: dir.to_path_buf(),
            dsh_home: dir.join("dsh"),
            cwd: dir.to_path_buf(),
            grok_home: Some(grok),
            env,
            cli_model: None,
            cli_effort: None,
            cli_trust: false,
            cli_revoke_trust: false,
            cli_trust_path: None,
            interactive: false,
            cli_permission_mode: None,
            cli_always_approve: false,
            cli_auto: false,
            cli_allow: Vec::new(),
            cli_deny: Vec::new(),
            cli_no_memory: false,
            cli_sandbox: None,
            cli_disable_web_search: false,
            cli_subagents: Default::default(),
            cli_interaction: Default::default(),
        });
        assert!(effective.ready, "{:?}", effective.errors);
        effective
    }

    // Regression for ticket 53 / issue 185: an empty `/remember` (no inline
    // text, confirmed via the two-step draft prompt) used to open the
    // confirmation modal with `memory_session_enabled(effective, None)`,
    // ignoring the live `t` toggle and silently re-deriving config.toml's
    // value. Saving or cancelling then wrote that wrong value back as the
    // session's memory switch.
    #[test]
    fn empty_remember_keeps_the_session_toggle_off_when_config_is_on() {
        let dir = tempfile::TempDir::new().unwrap();
        let effective = memory_effective(dir.path(), true);
        // `t` already turned memory off for this session (config stays on).
        let memory_session_on = Some(false);
        let browser = open_remember_confirmation(
            &effective,
            memory_session_on,
            false,
            "",
            memory::Scope::Workspace,
        )
        .unwrap();
        assert!(
            !browser.session_enabled,
            "the confirmation modal must keep the session's `t off`, not config.toml's `enabled = true`"
        );
        // Cancelling (`n`) does not touch session_enabled; the caller then
        // commits `Some(browser.session_enabled)` as the new session switch,
        // which must still read off.
        assert_eq!(Some(browser.session_enabled), Some(false));
    }

    #[test]
    fn empty_remember_keeps_the_session_toggle_on_when_config_is_off() {
        let dir = tempfile::TempDir::new().unwrap();
        let effective = memory_effective(dir.path(), false);
        // `t` already turned memory on for this session (config stays off).
        let memory_session_on = Some(true);
        let browser = open_remember_confirmation(
            &effective,
            memory_session_on,
            false,
            "",
            memory::Scope::Workspace,
        )
        .unwrap();
        assert!(
            browser.session_enabled,
            "the confirmation modal must keep the session's `t on`, not config.toml's `enabled = false`"
        );
        assert_eq!(Some(browser.session_enabled), Some(true));
    }

    #[test]
    fn slash_reload_keeps_client_on_apply_failure_and_replaces_on_patch_change() {
        let failed = RuntimeApply {
            extra_env: vec![("XAI_API_KEY".into(), "same".into())],
            patch: None,
            apply_failed: true,
            error: "refusing to overwrite".into(),
        };
        assert!(
            !slash_reload_replaces_client(
                &[("XAI_API_KEY".into(), "same".into())],
                true,
                Some("old-patch"),
                &failed,
                true,
            ),
            "a settings write error must not drop the live client"
        );
        let dir = tempfile::TempDir::new().unwrap();
        let patch = dir.path().join("rust-effective.yml");
        std::fs::write(&patch, "new-patch\n").unwrap();
        let changed = RuntimeApply {
            extra_env: vec![("XAI_API_KEY".into(), "same".into())],
            patch: Some(patch),
            apply_failed: false,
            error: String::new(),
        };
        assert!(
            slash_reload_replaces_client(
                &[("XAI_API_KEY".into(), "same".into())],
                true,
                Some("old-patch"),
                &changed,
                true,
            ),
            "an unchanged credential env still replaces dsh when the settings patch changes"
        );
        assert!(!slash_reload_replaces_client(
            &[("XAI_API_KEY".into(), "same".into())],
            true,
            Some("new-patch\n"),
            &changed,
            true,
        ));
    }

    #[test]
    fn parse_trust_and_revoke_flags() {
        let launch = parse_launch(&args(&["--trust", "--revoke-trust"])).unwrap();
        assert!(launch.trust);
        assert!(launch.revoke_trust);
        let folder =
            parse_launch(&args(&["--trust-folder", "/tmp/repo", "inspect", "--json"])).unwrap();
        assert!(folder.trust);
        assert_eq!(
            folder.trust_folder.as_deref(),
            Some(std::path::Path::new("/tmp/repo"))
        );
        assert!(matches!(
            folder.mode,
            LaunchMode::Inspect { json: true, .. }
        ));
    }

    #[test]
    fn parse_no_memory_and_memory_clear() {
        let launch = parse_launch(&args(&["--no-memory", "--continue"])).unwrap();
        assert!(launch.no_memory);
        assert!(matches!(launch.mode, LaunchMode::Continue));
        let memory = parse_launch(&args(&["memory", "clear", "--global", "--yes"])).unwrap();
        assert!(matches!(
            memory.mode,
            LaunchMode::Memory(ref args) if args == &vec!["clear".to_string(), "--global".to_string(), "--yes".to_string()]
        ));
    }

    #[test]
    fn parse_session_scoped_screen_flags() {
        let launch = parse_launch(&args(&["--minimal", "--continue"])).unwrap();
        assert!(matches!(launch.mode, LaunchMode::Continue));
        assert_eq!(launch.screen, Some(ScreenMode::Minimal));
        let launch = parse_launch(&args(&[
            "--resume",
            "abc",
            "--fullscreen",
            "--model",
            "think",
        ]))
        .unwrap();
        assert!(matches!(launch.mode, LaunchMode::Resume(_)));
        assert_eq!(launch.screen, Some(ScreenMode::Fullscreen));
        assert_eq!(launch.model.as_deref(), Some("think"));
        let alias = parse_launch(&args(&["--full", "inspect", "--json"])).unwrap();
        assert_eq!(alias.screen, Some(ScreenMode::Fullscreen));
        assert!(matches!(alias.mode, LaunchMode::Inspect { json: true, .. }));
        let error = parse_launch(&args(&["--minimal", "--fullscreen"])).unwrap_err();
        assert!(
            error.to_string().contains("conflicting screen flags"),
            "{error}"
        );
        // The refusal text is mode-neutral: these flags are refused in the TUI too.
        for flag in ["--no-alt-screen", "--no-auto-update", "--agent"] {
            let error = parse_launch(&args(&[flag])).unwrap_err().to_string();
            assert!(error.starts_with(flag), "{error}");
            assert!(!error.contains("plain command"), "{error}");
            assert!(error.contains("later ticket"), "{error}");
        }
        let rules =
            parse_launch(&args(&["--rules", "SESSION_RULE_SENTINEL", "--minimal"])).unwrap();
        assert_eq!(
            rules.session_rules.as_deref(),
            Some("SESSION_RULE_SENTINEL")
        );
        assert!(rules.system_prompt_override.is_none());
        let alias = parse_launch(&args(&["--append-system-prompt=also"])).unwrap();
        assert_eq!(alias.session_rules.as_deref(), Some("also"));
        let replaced = parse_launch(&args(&["--system-prompt-override", "ONLY_THIS"])).unwrap();
        assert_eq!(
            replaced.system_prompt_override.as_deref(),
            Some("ONLY_THIS")
        );
        let prompt_alias = parse_launch(&args(&["--system-prompt=verbatim"])).unwrap();
        assert_eq!(
            prompt_alias.system_prompt_override.as_deref(),
            Some("verbatim")
        );
        let missing = parse_launch(&args(&["--rules"])).unwrap_err();
        assert!(
            missing
                .to_string()
                .contains("a value is required for '--rules")
        );
    }

    #[test]
    fn parse_plugin_help_is_a_supported_public_command() {
        let launch = parse_launch(&args(&["plugin", "--help"])).expect("plugin help");
        assert!(matches!(
            launch.mode,
            LaunchMode::Plugin(plugin::PluginCommand::Help)
        ));
        let install =
            parse_launch(&args(&["plugin", "install", "./p", "--trust"])).expect("install");
        assert!(matches!(
            install.mode,
            LaunchMode::Plugin(plugin::PluginCommand::Install { trust: true, .. })
        ));
        assert!(!install.trust);
        let mp = parse_launch(&args(&["plugin", "marketplace", "--help"])).expect("mp help");
        assert!(matches!(
            mp.mode,
            LaunchMode::Plugin(plugin::PluginCommand::MarketplaceHelp)
        ));
    }

    #[test]
    fn parse_export_share_delete_and_disk_usage() {
        let export = parse_launch(&args(&[
            "export",
            "11111111-1111-4111-8111-111111111111",
            "out.md",
        ]))
        .expect("export");
        match export.mode {
            LaunchMode::Export(request) => {
                assert_eq!(request.session_id, "11111111-1111-4111-8111-111111111111");
                assert!(matches!(
                    request.target,
                    session_data::ExportTarget::File(_)
                ));
            }
            other => panic!("expected export, got {other:?}"),
        }
        let share = parse_launch(&args(&[
            "share",
            "--url",
            "http://127.0.0.1:9/share",
            "11111111-1111-4111-8111-111111111111",
        ]))
        .expect("share");
        match share.mode {
            LaunchMode::Share(request) => {
                assert_eq!(request.url.as_deref(), Some("http://127.0.0.1:9/share"));
            }
            other => panic!("expected share, got {other:?}"),
        }
        let missing = parse_launch(&args(&["share", "11111111-1111-4111-8111-111111111111"]))
            .expect("share without url still parses");
        assert!(matches!(
            missing.mode,
            LaunchMode::Share(session_data::ShareRequest { url: None, .. })
        ));
        let delete = parse_launch(&args(&[
            "sessions",
            "delete",
            "11111111-1111-4111-8111-111111111111",
            "--yes",
        ]))
        .expect("delete");
        assert!(matches!(
            delete.mode,
            LaunchMode::Sessions(session_catalog::SessionsCommand::Delete(request))
                if request.confirmed && request.session_id == "11111111-1111-4111-8111-111111111111"
        ));
        let cancelled = parse_launch(&args(&[
            "sessions",
            "delete",
            "11111111-1111-4111-8111-111111111111",
        ]))
        .expect("unconfirmed delete still parses");
        assert!(matches!(
            cancelled.mode,
            LaunchMode::Sessions(session_catalog::SessionsCommand::Delete(request))
                if !request.confirmed
        ));
        let disk = parse_launch(&args(&["disk-usage", "--json"])).expect("disk");
        assert!(matches!(disk.mode, LaunchMode::DiskUsage { json: true }));
        let alias = parse_launch(&args(&["du"])).expect("du");
        assert!(matches!(alias.mode, LaunchMode::DiskUsage { json: false }));
    }

    #[test]
    fn parse_fork_session_and_restore_code() {
        let resume = parse_launch(&args(&[
            "--resume",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "--fork-session",
        ]))
        .expect("launch");
        assert!(resume.fork_session);
        assert!(matches!(resume.mode, LaunchMode::Resume(_)));
        let err = parse_launch(&args(&["--restore-code"])).expect_err("restore");
        assert!(err.to_string().contains("does not restore files"));
        let needs_resume = parse_launch(&args(&["--fork-session"])).expect_err("fork");
        assert!(needs_resume.to_string().contains("--resume"));
    }

    #[test]
    fn esc_while_recording_reaches_the_composer_before_cancel() {
        let home = tempfile::TempDir::new().unwrap();
        let mut composer = PromptComposer::load(home.path(), &[]);
        composer.set_text("KEEP");
        let host = HostContext {
            inflight: false,
            minimal: false,
            voice_release: true,
        };
        composer.handle_key(
            crossterm::event::KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE),
            host,
        );
        assert_eq!(composer.text(), "/");
        assert_eq!(composer.slash_stash, "KEEP");
        assert_eq!(composer.overlay, prompt_edit::Overlay::Slash);
        let mut config = voice::VoiceConfig::disabled();
        config.enabled = true;
        config.api_base = Some("http://127.0.0.1:9/v1".into());
        let fixture = home.path().join("clip.bin");
        std::fs::write(&fixture, b"RIFFnot-sent").unwrap();
        let mut voice =
            voice::VoiceSession::new(config).with_fixture(fixture, "Mic|0\npermission=granted\n");
        voice
            .start(&composer.voice_draft(), voice::CaptureMode::Toggle)
            .unwrap();
        assert!(voice.recording());
        let mut hint = String::new();
        let mut last_error = String::new();
        // The packed PTY order: recording is active, "/" opened slash
        // completion, and one Esc must both leave the recording and restore KEEP.
        handle_recording_esc(
            crossterm::event::KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            host,
            &mut voice,
            &mut composer,
            &mut hint,
            &mut last_error,
        );
        assert!(!voice.recording(), "Esc must leave the recording");
        assert_eq!(composer.text(), "KEEP");
        assert_eq!(composer.overlay, prompt_edit::Overlay::None);
        assert!(composer.slash_stash.is_empty());
        assert!(composer.voice_draft() == "KEEP");
        assert!(hint.contains("completion cancelled") || hint.contains("voice cancelled"));
        let late = voice.poll().unwrap();
        assert!(
            late.is_none(),
            "a cancelled recording must not insert audio"
        );
    }

    #[test]
    fn worktree_flags_parse_like_the_reference() {
        let bare = parse_launch(&args(&["-w"])).unwrap();
        assert_eq!(bare.worktree.name.as_deref(), Some(""));
        assert!(matches!(bare.mode, LaunchMode::New));
        let named = parse_launch(&args(&["--worktree", "fix-bug", "--minimal"])).unwrap();
        assert_eq!(named.worktree.name.as_deref(), Some("fix-bug"));
        let inline = parse_launch(&args(&["--worktree=x", "--ref", "main"])).unwrap();
        assert_eq!(inline.worktree.name.as_deref(), Some("x"));
        assert_eq!(inline.worktree.reference.as_deref(), Some("main"));
        let aliased = parse_launch(&args(&["-w", "--worktree-ref=v1"])).unwrap();
        assert_eq!(aliased.worktree.reference.as_deref(), Some("v1"));
        // A bare -w before -r keeps the id for --resume.
        let resume = parse_launch(&args(&["-w", "-r", "abc"])).unwrap();
        assert_eq!(resume.worktree.name.as_deref(), Some(""));
        assert!(matches!(resume.mode, LaunchMode::Resume(ref id) if id == "abc"));
        let plain = parse_launch(&args(&["-w", "-p", "hi"])).unwrap();
        assert!(matches!(plain.mode, LaunchMode::Plain { .. }));
        let lonely = parse_launch(&args(&["--ref", "main"]))
            .unwrap_err()
            .to_string();
        assert!(lonely.contains("requires '--worktree"), "{lonely}");
        let twice = parse_launch(&args(&["-w", "a", "-w"]))
            .unwrap_err()
            .to_string();
        assert!(twice.contains("cannot be used multiple times"), "{twice}");
        let command = parse_launch(&args(&["-w", "inspect"]))
            .unwrap_err()
            .to_string();
        assert!(
            command.contains("cannot be combined with that command"),
            "{command}"
        );
        let sub = parse_launch(&args(&["worktree", "rm", "-f", "x", "--dry-run"])).unwrap();
        assert!(
            matches!(sub.mode, LaunchMode::Worktree(ref words) if words == &["rm", "-f", "x", "--dry-run"])
        );
        let list = parse_launch(&args(&["worktree"])).unwrap();
        assert!(matches!(list.mode, LaunchMode::Worktree(ref words) if words.is_empty()));
    }

    #[test]
    fn fork_slash_accepts_no_worktree_and_refuses_worktree() {
        assert_eq!(
            session_fork::parse_fork_slash("/fork --no-worktree")
                .unwrap()
                .directive,
            None
        );
        assert!(
            session_fork::parse_fork_slash("/fork --worktree")
                .unwrap_err()
                .contains("codsh --rust -w -r")
        );
        assert!(session_fork::is_conversation_slash("/rewind"));
        assert_eq!(
            session_fork::running_turn_error(),
            "a turn is running — interrupt it before rewinding"
        );
    }

    #[test]
    fn parse_permission_flags() {
        let launch = parse_launch(&args(&[
            "--always-approve",
            "--deny",
            "Bash(rm -rf *)",
            "--allow",
            "Bash(git *)",
        ]))
        .unwrap();
        assert!(launch.always_approve);
        assert_eq!(launch.deny, vec!["Bash(rm -rf *)"]);
        assert_eq!(launch.allow, vec!["Bash(git *)"]);
        let auto = parse_launch(&args(&["--permission-mode", "auto"])).unwrap();
        assert_eq!(auto.permission_mode.as_deref(), Some("auto"));
        let yolo = parse_launch(&args(&["--yolo"])).unwrap();
        assert!(yolo.always_approve);
        let invalid = parse_launch(&args(&["--permission-mode", "explode"])).unwrap_err();
        assert!(invalid.to_string().contains("invalid permission mode"));
    }

    #[test]
    fn parse_agent_stdio_and_rejects_unknown_agent_commands() {
        let launch = parse_launch(&args(&["agent", "stdio"])).unwrap();
        assert!(matches!(launch.mode, LaunchMode::Agent { help: false }));
        let help = parse_launch(&args(&["agent", "--help"])).unwrap();
        assert!(matches!(help.mode, LaunchMode::Agent { help: true }));
        let error = parse_launch(&args(&["agent", "bogus"])).unwrap_err();
        assert!(error.to_string().contains("agent stdio"));
        let headless = parse_launch(&args(&["agent", "headless"])).unwrap_err();
        assert!(headless.to_string().contains("grok.com relay"));
    }

    #[test]
    fn parse_shared_agent_and_leader_commands() {
        let serve = parse_launch(&args(&[
            "agent",
            "serve",
            "--bind",
            "127.0.0.1:0",
            "--secret",
            "s",
        ]))
        .unwrap();
        match serve.mode {
            LaunchMode::AgentShared(shared_server::AgentCommand::Serve(options)) => {
                assert_eq!(options.bind, "127.0.0.1:0");
                assert_eq!(options.secret.as_deref(), Some("s"));
            }
            other => panic!("{other:?}"),
        }
        let proxy = parse_launch(&args(&["--model", "m", "agent", "--leader", "stdio"])).unwrap();
        assert_eq!(proxy.model.as_deref(), Some("m"));
        assert!(matches!(
            proxy.mode,
            LaunchMode::AgentShared(shared_server::AgentCommand::Stdio {
                leader: Some(true),
                socket: None
            })
        ));
        assert_eq!(leader_client_policy_flags(&proxy), vec!["-m/--model"]);
        let leader = parse_launch(&args(&[
            "agent",
            "leader",
            "--leader-socket=/tmp/l.sock",
            "--no-exit-on-disconnect",
        ]))
        .unwrap();
        assert!(matches!(
            leader.mode,
            LaunchMode::AgentShared(shared_server::AgentCommand::Leader(_))
        ));
        let list = parse_launch(&args(&["leader", "list", "--json"])).unwrap();
        assert!(matches!(
            list.mode,
            LaunchMode::Leader(shared_server::LeaderCommand::List { json: true, .. })
        ));
        let serve_help = parse_launch(&args(&["agent", "serve", "--help"])).unwrap();
        assert!(matches!(
            serve_help.mode,
            LaunchMode::AgentShared(shared_server::AgentCommand::Help("serve"))
        ));
        // Outside `agent` and `leader` the shared flags stay refused.
        for flags in [
            vec!["--leader"],
            vec!["--bind", "127.0.0.1:1"],
            vec!["--no-exit-on-disconnect", "agent", "stdio"],
        ] {
            let error = parse_launch(&args(&flags)).unwrap_err();
            assert!(
                error.to_string().contains("dsh owns execution"),
                "{flags:?}"
            );
        }
    }

    fn catalog_session(home: &Path, id: &str, cwd: &Path) {
        let project = session_catalog::project_key_for_test(&cwd.to_string_lossy());
        let dir = home
            .join("sessions")
            .join(project)
            .join(session_catalog::encode_segment_for_test(id));
        std::fs::create_dir_all(&dir).unwrap();
        let body = format!(
            "{}\n",
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": id,
                "createdAt": 1,
                "cwd": cwd,
                "isSeeded": false,
                "delegationDepth": 0,
            })
        );
        let encoded = zstd::encode_all(body.as_bytes(), 0).expect("zstd session log");
        std::fs::write(dir.join("session.v3.jsonl.zstd"), encoded).unwrap();
    }

    /// A same-directory resume the agent refuses must not close the live ACP
    /// session. The public switch path is the one the picker and dashboard use.
    #[test]
    fn switch_session_refused_resume_does_not_close_the_live_session() {
        let home = tempfile::TempDir::new().unwrap();
        let cwd = home.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let store = tempfile::NamedTempFile::new().unwrap();
        let store_path = store.path().to_string_lossy().into_owned();
        let held = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        catalog_session(home.path(), held, &cwd);
        let trace = home.path().join("rpc-trace.json");
        let dsh_bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../node_modules/.bin/dsh");
        let saved = std::env::var_os("DSH_BIN");
        unsafe {
            std::env::set_var("DSH_BIN", &dsh_bin);
        }
        let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut client = AcpClient::spawn_fake_for_test(
                "echo",
                vec![
                    ("FAKE_ACP_STORE".into(), store_path.clone()),
                    ("FAKE_ACP_HELD_SESSION".into(), held.into()),
                    (
                        "FAKE_ACP_TRACE".into(),
                        trace.to_string_lossy().into_owned(),
                    ),
                ],
            );
            client
                .initialize(Duration::from_secs(2))
                .expect("initialize");
            let live = client
                .new_session(&cwd, Duration::from_secs(2))
                .expect("live session");
            catalog_session(home.path(), &live, &cwd);
            // The target exists and is closed in the agent store. The agent still
            // refuses this id, which must be observed before session/close.
            let canonical = cwd.canonicalize().unwrap_or_else(|_| cwd.clone());
            let mut shared: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(&store_path)
                    .unwrap_or_else(|_| "{\"sessions\":{}}".into()),
            )
            .unwrap_or_else(|_| serde_json::json!({"sessions": {}}));
            shared["sessions"][held] = serde_json::json!({
                "sessionId": held,
                "cwd": canonical,
                "closed": true,
                "owned": false,
                "prompts": []
            });
            std::fs::write(&store_path, format!("{shared}\n")).unwrap();
            let mut owner =
                Some(SessionOwner::acquire(home.path(), &live).expect("live write owner"));
            let error = match switch_session(&mut client, &mut owner, home.path(), &cwd, held) {
                Ok(_) => panic!("held same-directory resume was accepted"),
                Err(error) => error,
            };
            let trace_body = std::fs::read_to_string(&trace).unwrap_or_default();
            assert!(
                error.contains("already active") || error.contains("already owned"),
                "{error}; rpc={trace_body}"
            );
            assert_eq!(
                client.session_id.as_deref(),
                Some(live.as_str()),
                "a refused resume must leave the live ACP session open"
            );
            assert!(
                owner.as_ref().is_some_and(
                    |held_owner| held_owner.session_id == live && held_owner.still_held()
                ),
                "the original write owner stays"
            );
            let store_body = std::fs::read_to_string(&store_path).unwrap_or_default();
            let trace: serde_json::Value =
                serde_json::from_str(&store_body).unwrap_or_else(|_| serde_json::json!({}));
            let methods: Vec<String> = trace
                .get("methods")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.get("method").and_then(|method| method.as_str()))
                .map(str::to_string)
                .collect();
            let resume_at = methods
                .iter()
                .position(|method| method == "session/resume")
                .expect("session/resume was sent");
            assert!(
                !methods.iter().any(|method| method == "session/close"),
                "refused resume closed the live session first: {methods:?} {store_body}"
            );
            assert!(
                methods[..resume_at]
                    .iter()
                    .all(|method| method != "session/close"),
                "close arrived before the refused resume: {methods:?}"
            );
            let follow = client.submit_prompt("TOKEN_STILL_LIVE").unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut stopped = false;
            while Instant::now() < deadline {
                for event in client.pump(Duration::from_millis(30)) {
                    if let AcpEvent::PromptFinished {
                        request_id: id,
                        stop_reason,
                        ..
                    } = event
                        && id == follow
                        && stop_reason == "end_turn"
                    {
                        stopped = true;
                    }
                }
                if stopped {
                    break;
                }
            }
            assert!(stopped, "the live session still accepts a prompt");
        }));
        unsafe {
            match saved {
                Some(value) => std::env::set_var("DSH_BIN", value),
                None => std::env::remove_var("DSH_BIN"),
            }
        }
        if let Err(payload) = checked {
            std::panic::resume_unwind(payload);
        }
    }

    #[test]
    fn switch_session_closes_the_previous_id_only_after_resume_succeeds() {
        let home = tempfile::TempDir::new().unwrap();
        let cwd = home.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let store = tempfile::NamedTempFile::new().unwrap();
        let store_path = store.path().to_string_lossy().into_owned();
        let trace = home.path().join("rpc-trace.json");
        let target = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        catalog_session(home.path(), target, &cwd);
        let dsh_bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../node_modules/.bin/dsh");
        let saved = std::env::var_os("DSH_BIN");
        unsafe {
            std::env::set_var("DSH_BIN", &dsh_bin);
        }
        let switched = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut client = AcpClient::spawn_fake_for_test(
                "echo",
                vec![
                    ("FAKE_ACP_STORE".into(), store_path.clone()),
                    (
                        "FAKE_ACP_TRACE".into(),
                        trace.to_string_lossy().into_owned(),
                    ),
                ],
            );
            client
                .initialize(Duration::from_secs(2))
                .expect("initialize");
            let live = client
                .new_session(&cwd, Duration::from_secs(2))
                .expect("live session");
            catalog_session(home.path(), &live, &cwd);
            let canonical = cwd.canonicalize().unwrap_or_else(|_| cwd.clone());
            let mut shared: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(&store_path)
                    .unwrap_or_else(|_| "{\"sessions\":{}}".into()),
            )
            .unwrap_or_else(|_| serde_json::json!({"sessions": {}}));
            shared["sessions"][target] = serde_json::json!({
                "sessionId": target,
                "cwd": canonical,
                "closed": true,
                "owned": false,
                "prompts": []
            });
            std::fs::write(&store_path, format!("{shared}\n")).unwrap();
            let mut owner =
                Some(SessionOwner::acquire(home.path(), &live).expect("live write owner"));
            switch_session(&mut client, &mut owner, home.path(), &cwd, target)
                .unwrap_or_else(|error| panic!("same-directory resume failed: {error}"));
            assert_eq!(client.session_id.as_deref(), Some(target));
            assert!(
                owner
                    .as_ref()
                    .is_some_and(|next| next.session_id == target && next.still_held()),
                "the target write owner is held"
            );
            let trace_body = std::fs::read_to_string(&trace).unwrap_or_default();
            let methods: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(&trace_body)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|entry| {
                    entry
                        .get("method")
                        .and_then(|method| method.as_str())
                        .map(str::to_string)
                })
                .collect();
            let resume_at = methods
                .iter()
                .rposition(|method| method == "session/resume")
                .expect("session/resume");
            let close_at = methods
                .iter()
                .rposition(|method| method == "session/close")
                .expect("session/close after resume");
            assert!(
                resume_at < close_at,
                "close must follow a successful resume: {methods:?}"
            );
            let follow = client.submit_prompt("TOKEN_ON_TARGET").unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut stopped = false;
            while Instant::now() < deadline {
                for event in client.pump(Duration::from_millis(30)) {
                    if let AcpEvent::PromptFinished {
                        request_id,
                        stop_reason,
                        ..
                    } = event
                        && request_id == follow
                        && stop_reason == "end_turn"
                    {
                        stopped = true;
                    }
                }
                if stopped {
                    break;
                }
            }
            assert!(stopped, "the resumed session accepts a prompt");
        }));
        unsafe {
            match saved {
                Some(value) => std::env::set_var("DSH_BIN", value),
                None => std::env::remove_var("DSH_BIN"),
            }
        }
        if let Err(payload) = switched {
            std::panic::resume_unwind(payload);
        }
    }
}
