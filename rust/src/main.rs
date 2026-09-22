mod acp;
mod appearance;
mod config;
mod models;
mod screen_mode;
mod session_fork;
mod session_history;
mod session_owner;
mod settings_ui;
mod status_line;
mod theme;
mod trust;
mod welcome;

use acp::{AcpClient, AcpEvent, PendingPermission};
use crossterm::cursor::{Hide, Show};
use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode, KeyEventKind, KeyModifiers, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::{TerminalOptions, Viewport, backend::CrosstermBackend};
use screen_mode::{
    GROK_SCREEN_MODE_ENV, MINIMAL_OVERLAY_HEIGHT, SCREEN_MODE_SWITCH_ENV, ScreenMode, SlashAction,
    SwitchPolicy,
};
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
use xai_ratatui_textarea::TextArea;

const UNAVAILABLE: &str = "Execution unavailable: dsh\nNot connected. Draft kept.";

struct TerminalGuard {
    alt: bool,
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
                Hide
            )?;
        } else {
            execute!(io::stdout(), EnableBracketedPaste, EnableMouseCapture, Show)?;
        }
        Ok(Self { alt })
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
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(
            io::stdout(),
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
    status: String,
    diff: String,
    result: String,
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
    New,
    Continue,
    Resume(String),
}

struct Connection {
    client: AcpClient,
    owner: SessionOwner,
    resumed: bool,
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
}

fn take_flag_value(
    args: &[String],
    index: &mut usize,
    flag: &str,
    missing: &str,
) -> io::Result<Option<String>> {
    let arg = &args[*index];
    if arg == flag {
        *index += 1;
        let value = args.get(*index).ok_or_else(|| io::Error::other(missing))?;
        if value.starts_with('-') {
            return Err(io::Error::other(missing));
        }
        return Ok(Some(value.clone()));
    }
    if let Some(value) = arg.strip_prefix(&format!("{flag}=")) {
        if value.is_empty() {
            return Err(io::Error::other(missing));
        }
        return Ok(Some(value.to_string()));
    }
    Ok(None)
}

fn parse_launch(args: &[String]) -> io::Result<Launch> {
    if args.iter().any(|flag| flag == "--restore-code") {
        return Err(io::Error::other(session_fork::restore_code_error()));
    }
    let mut model = None;
    let mut effort = None;
    let mut trust = false;
    let mut revoke_trust = false;
    let mut trust_folder = None;
    let mut screen = None;
    let mut rest = Vec::new();
    let mut fork_session = false;
    let mut child_id = None;
    let mut index = 0;
    while index < args.len() {
        if let Some(value) = take_flag_value(
            args,
            &mut index,
            "--model",
            "missing --model value; use codsh --rust --help",
        )? {
            model = Some(value);
        } else if let Some(value) = take_flag_value(
            args,
            &mut index,
            "--effort",
            "missing --effort value; use codsh --rust --help",
        )? {
            effort = Some(value);
        } else if let Some(value) = take_flag_value(
            args,
            &mut index,
            "--reasoning-effort",
            "missing --reasoning-effort value; use codsh --rust --help",
        )? {
            effort = Some(value);
        } else if let Some(value) = take_flag_value(
            args,
            &mut index,
            "--session-id",
            "missing session id; --session-id requires --fork-session",
        )? {
            child_id = Some(value);
        } else if let Some(value) = take_flag_value(
            args,
            &mut index,
            "-s",
            "missing session id; --session-id requires --fork-session",
        )? {
            child_id = Some(value);
        } else {
            let arg = &args[index];
            if arg == "--trust" || arg == "--trust-folder" {
                trust = true;
                if arg == "--trust-folder"
                    && let Some(value) = args.get(index + 1)
                    && !value.starts_with('-')
                    && value != "inspect"
                    && value != "--continue"
                    && value != "--resume"
                    && value != "--fork-session"
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
            } else {
                rest.push(arg.clone());
            }
        }
        index += 1;
    }
    if child_id.is_some() && !fork_session {
        return Err(io::Error::other(
            "--session-id is only valid together with --fork-session",
        ));
    }
    let rest_flags: Vec<&str> = rest.iter().map(String::as_str).collect();
    let mode = match rest_flags.as_slice() {
        [] => LaunchMode::New,
        ["--help" | "-h"] => LaunchMode::Help,
        ["--version" | "-V"] => LaunchMode::Version,
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
        _ => {
            return Err(io::Error::other(
                "unsupported preview arguments; use codsh --rust --help",
            ));
        }
    };
    if fork_session
        && !matches!(
            mode,
            LaunchMode::Resume(_) | LaunchMode::Continue | LaunchMode::Help | LaunchMode::Version
        )
    {
        return Err(io::Error::other(
            "--fork-session requires --resume or --continue",
        ));
    }
    if matches!(mode, LaunchMode::Help | LaunchMode::Version) {
        fork_session = false;
        child_id = None;
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
    })
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
                status: tool.status,
                diff: tool.diff,
                result: tool.result,
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

fn drop_connection(client: &mut Option<AcpClient>, owner: &mut Option<SessionOwner>) {
    if let Some(active) = client.as_mut() {
        active.shutdown();
    }
    *client = None;
    *owner = None;
}

fn resolve_resume(
    client: &mut AcpClient,
    mode: &LaunchMode,
    cwd: &std::path::Path,
    dsh_home: &std::path::Path,
    previous: Option<&str>,
) -> Result<Option<String>, String> {
    match mode {
        LaunchMode::Resume(id) => Ok(Some(id.clone())),
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
    let spec = acp::dsh_spawn_spec(cwd.clone(), &dsh_home, extra_env, patch.cloned())
        .map_err(|error| error.message)?;
    let mut client = AcpClient::spawn(spec).map_err(|error| error.to_string())?;
    client
        .initialize(Duration::from_secs(20))
        .map_err(|error| error.message)?;
    let resume_id = resolve_resume(&mut client, mode, &cwd, &dsh_home, previous)?;
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
    let _ = client.close_session(Duration::from_secs(10));
    *owner = None;
    let next_owner = SessionOwner::acquire(dsh_home, session_id).map_err(|error| error.message)?;
    client
        .resume_session(session_id, cwd, Duration::from_secs(20))
        .map_err(|error| error.message)?;
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
    resumed: &mut bool,
    previous_session: &mut Option<String>,
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
    apply_fork_model(client, prefs)?;
    *resumed = true;
    *previous_session = Some(forked.session_id.clone());
    let mut report = format!(
        "forked · now on {} · {} stays in /resume",
        forked.session_id, forked.parent_session
    );
    if let Some(text) = directive.filter(|value| !value.trim().is_empty()) {
        client.submit_prompt(text).map_err(|error| error.message)?;
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
        });
        *inflight = true;
        report.push_str(" · submitted fork directive");
    }
    Ok(report)
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
    }
}

struct Meter {
    used: Option<u64>,
    size: Option<u64>,
    cost: Option<String>,
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
    let header = format!("mode={}", screen.as_str());
    if !last_error.is_empty() && client.is_none() {
        return format!("{header}\n{UNAVAILABLE}\n{last_error}");
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
    body
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

fn compact_summary_preview(text: &str) -> String {
    let body = text
        .split("<compacted-summary>")
        .nth(1)
        .and_then(|rest| rest.split("</compacted-summary>").next())
        .unwrap_or(text);
    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("\n")
}

fn compact_tool_result(text: &str) -> String {
    if let Some(body) = text
        .split("<content>\n")
        .nth(1)
        .and_then(|rest| rest.split("\n</content>").next())
    {
        return body.lines().take(12).collect::<Vec<_>>().join("\n");
    }
    text.lines().take(12).collect::<Vec<_>>().join("\n")
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
    let mut out = status.to_string();
    for turn in turns {
        out.push_str("\n\n> ");
        if show_timestamps && let Some(stamp) = &turn.timestamp {
            out.push_str(stamp);
            out.push(' ');
        }
        out.push_str(&turn.user.replace('\n', " "));
        if turn.compacted {
            if let Some(info) = &turn.compaction {
                out.push('\n');
                out.push_str(&models::compaction_line(
                    info.items,
                    info.tokens,
                    Some(&info.provider),
                    Some(&info.model),
                    info.error.as_deref(),
                ));
            } else {
                out.push_str("\n✂ compacted history into a summary · purpose=compaction");
            }
        }
        if !turn.thought.is_empty() {
            out.push_str("\n[thought] ");
            out.push_str(&turn.thought);
        }
        for tool in &turn.tools {
            out.push_str("\n[tool ");
            out.push_str(&tool.title);
            out.push(' ');
            out.push_str(&tool.id);
            out.push(' ');
            out.push_str(&tool.status);
            out.push(']');
            if !tool.diff.is_empty() {
                out.push('\n');
                out.push_str(&tool.diff);
            }
            if !tool.result.is_empty() {
                out.push('\n');
                out.push_str(&compact_tool_result(&tool.result));
            }
        }
        if !turn.answer.is_empty() && turn.compacted {
            let preview = compact_summary_preview(&turn.answer);
            if !preview.is_empty() {
                out.push('\n');
                out.push_str(&preview);
            }
        } else if !turn.answer.is_empty() {
            out.push('\n');
            out.push_str(turn.answer.lines().next().unwrap_or(""));
        }
        if let Some(permission) = &turn.permission {
            out.push_str("\nAllow ");
            let name = turn
                .tools
                .iter()
                .find(|tool| tool.id == permission.tool_call_id)
                .map(|tool| tool.title.as_str())
                .unwrap_or("tool");
            out.push_str(name);
            out.push(' ');
            out.push_str(&permission.tool_call_id);
            out.push_str("? y=allow once  n=reject");
        }
        if turn.interrupted {
            out.push_str("\n[interrupted]");
        } else if turn.cancelled {
            out.push_str("\n[cancelled]");
        } else if let Some(error) = &turn.error {
            out.push_str("\n[error] ");
            out.push_str(error);
        } else if turn.done
            && turn.answer.is_empty()
            && turn.thought.is_empty()
            && turn.tools.is_empty()
        {
            out.push_str("\n[empty answer]");
        } else if !turn.done {
            out.push('…');
        }
    }
    out
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
                if let Some(turn) = turns.last_mut()
                    && turn.message_id.as_ref().is_none_or(|id| id == &message_id)
                {
                    turn.message_id = Some(message_id);
                    turn.thought.push_str(&text);
                }
            }
            AcpEvent::Answer {
                message_id, text, ..
            } => {
                if let Some(turn) = turns.last_mut()
                    && turn.message_id.as_ref().is_none_or(|id| id == &message_id)
                {
                    turn.message_id = Some(message_id);
                    turn.answer.push_str(&text);
                }
            }
            AcpEvent::ToolCall {
                tool_call_id,
                title,
                status,
                diff,
                ..
            } => {
                if let Some(turn) = turns.last_mut() {
                    if let Some(tool) = turn.tools.iter_mut().find(|tool| tool.id == tool_call_id) {
                        tool.title = title;
                        tool.status = status;
                        if !diff.is_empty() {
                            tool.diff = diff;
                        }
                    } else {
                        turn.tools.push(ToolRow {
                            id: tool_call_id,
                            title,
                            status,
                            diff,
                            result: String::new(),
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
                if let Some(turn) = turns.last_mut() {
                    if let Some(tool) = turn.tools.iter_mut().find(|tool| tool.id == tool_call_id) {
                        tool.status = status.clone();
                        if !content.is_empty() {
                            tool.result = content;
                        }
                    } else {
                        turn.tools.push(ToolRow {
                            id: tool_call_id.clone(),
                            title: "tool".into(),
                            status: status.clone(),
                            diff: String::new(),
                            result: content,
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
            AcpEvent::Usage { used, size, cost } => {
                meter.used = used;
                meter.size = size;
                meter.cost = cost;
            }
            AcpEvent::ConfigOptions { .. } => {}
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
    draft: &TextArea,
    notice: &str,
    selected: Option<usize>,
    theme: &theme::Theme,
    compact: bool,
    ui_overlay: &mut UiOverlay,
) -> io::Result<()> {
    terminal.draw(|frame| {
        if screen == ScreenMode::Minimal {
            welcome::render_minimal(frame, draft, notice, selected, theme);
        } else {
            welcome::render(frame, draft, notice, selected, theme, compact);
        }
        settings_ui::render(frame, ui_overlay, theme, screen);
    })?;
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

fn inspect_help() -> &'static str {
    "Show the configuration this directory resolves\n\nUsage: codsh --rust inspect [OPTIONS]\n\nOptions:\n      --json                  Emit machine-readable JSON output\n      --debug                 Enable debug logging\n      --debug-file <FILE>     Write debug logs to FILE\n  -h, --help                  Print help\n\nReports CLI, environment, overlay, config.toml, workspace, managed, and requirements origins.\nLocked requirements cannot be bypassed. Folder trust and project-asset activity are included.\nLeader sockets are unused; dsh owns execution."
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
    };
    if input.dsh_home.as_os_str().is_empty() {
        input.dsh_home = input.home.join("dsh");
    }
    config::load_from(input)
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
        }
    }
    if let Some(option) = client.and_then(|client| client.config_option("reasoning_effort")) {
        routing.effort = option.current.clone().filter(|value| !value.is_empty());
    }
    Some(routing)
}

fn apply_live_selection(
    client: &mut AcpClient,
    effective: &config::EffectiveConfig,
) -> Result<(), String> {
    if config::is_test_execution_seam() {
        return Ok(());
    }
    let Some(choice) = effective
        .catalog()
        .into_iter()
        .find(|choice| Some(choice.id.as_str()) == effective.default_model.as_deref())
    else {
        return Ok(());
    };
    if !choice.usable {
        return Err(choice
            .unavailable
            .clone()
            .unwrap_or_else(|| format!("model {} is unavailable", choice.id)));
    }
    let model_option = client.config_option("model").cloned();
    let Some(option) = model_option else {
        return Err(format!(
            "dsh did not advertise model options; configured {} was not applied. No silent provider fallback.",
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
    if let Some(effort) = &effective.default_effort {
        let effort_option = client.config_option("reasoning_effort").cloned();
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
                    "dsh did not advertise effort {effort} for {}; option unavailable.",
                    choice.id
                ));
            }
            None if choice.reasoning => {
                return Err(format!(
                    "dsh did not advertise reasoning effort for {}; option unavailable.",
                    choice.id
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
        models::Command::Context | models::Command::Compact { .. } => Err(
            "internal slash routing: /context and /compact are handled by the live session".into(),
        ),
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
    Ok(format!(
        "Selected {} / {} api={} effort={} ({when}).",
        choice.provider,
        choice.model,
        choice.api,
        effort.unwrap_or("unavailable")
    ))
}

fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let launch = parse_launch(&args)?;
    let mode = launch.mode.clone();
    match &mode {
        LaunchMode::Version => {
            println!(
                "codsh-rust {} (dsh ACP; upstream a28ee2b; reference 1.0.34)",
                env!("CARGO_PKG_VERSION")
            );
            return Ok(());
        }
        LaunchMode::Help => {
            println!(
                "codsh --rust\n\nIsolated Rust client. Real dsh executes turns over ACP/JSON-RPC stdio.\nHome: ~/.codsh-rust/dsh; Profile: rust. Legacy codsh is unchanged.\nUser config: $GROK_HOME/config.toml (default ~/.codsh-rust/.grok/config.toml), mapped into isolated dsh settings.yaml.\nManaged defaults: $GROK_HOME/managed_config.toml. Locked requirements: $GROK_HOME/requirements.toml (cannot be bypassed by later CLI, environment, overlay, workspace, or user values).\n`codsh --rust inspect` / `inspect --json` shows effective values, origins, folder trust, appearance/theme/status-line, and whether project assets are active. Invalid config.toml is left unchanged and reports its path. Unknown security fields and invalid policies are diagnosed with valid values, sources, and limits.\nWorkspace trust: untrusted folders prompt before applying project config, Hooks, plugins, or instructions; `--trust` / `--trust-folder [path]` saves a grant, `--revoke-trust` withdraws it. A read-only $GROK_HOME reports save failure without pretending the grant is durable. Untrusted Hooks/plugins/project capabilities do not execute.\nFirst-run missing credentials stay local: no grok.com login, no default official telemetry, no import of ~/.dsh or ~/.grok credentials.\nFile read/edit/write run through dsh tools; y allows once, n rejects with no write. Trust prompt: y=allow, n=deny.\nCtrl+Q/Ctrl+D: quit. Ctrl+C: clear a draft; empty draft cancels a running turn via dsh, or quits when idle before any turn.\nEsc never cancels a turn or a pending approval; it dismisses selection and reminds you to use Ctrl+C.\nEnter: submit prompt. /settings (/config) edits appearance, default screen mode, timestamps, compact mode, and status line. /theme (/t) previews fullscreen themes; Escape restores the previous theme without saving. /compact-mode and /timestamps toggle persisted [ui] keys. Minimal mode uses the terminal palette and refuses /theme. Status-line scripts run with a 10s timeout, cleared BASH_ENV/ENV, and process-group cleanup on exit. Locked requirements show their source and cannot be edited.\n/minimal and /fullscreen switch render mode in process without restarting dsh; --minimal/--fullscreen and GROK_SCREEN_MODE are session-scoped and do not rewrite [ui] screen_mode. /model (/m) and /effort select advertised catalog options; unsupported backends/efforts are refused, never treated as equivalent or silently swapped. /context shows dsh occupancy, advertised model limits, and heuristic buckets without fabricating zeros. /compact [instruction] runs dsh compaction (not a second history); optional instructions go only to the summarizer request (purpose=compaction). Automatic compaction uses session.auto_compact_threshold_percent / GROK_AUTO_COMPACT_THRESHOLD_PERCENT mapped to dsh thresholdRatio. GROK_COMPACTION_WALL_CLOCK_SECS bounds the operation; 0 disables that budget. Runtime changes apply to the next turn and persist under $GROK_HOME/model-selection.toml. --continue resumes the last session in this directory; --resume <id> loads that dsh session. --fork-session with --resume/--continue copies conversation into a new session id. /rewind and /undo fork conversation-only history through dsh; files are not restored. /fork copies the current history into a new session. Idle empty Esc Esc opens rewind. A second client is refused while this process holds write ownership. Interrupted tools show [interrupted]/unknown and are not replayed.\nOptions: --help, --version, --continue, --resume <id>, --fork-session, --session-id <id>, --minimal, --fullscreen, --model <id>, --effort/--reasoning-effort <level>, --trust, --trust-folder [path], --revoke-trust, inspect. --restore-code is refused."
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
        _ => {}
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
    let mut draft = TextArea::new();
    let connecting = format!("mode={}\nConnecting to dsh ACP…", screen.as_str());
    paint(
        &mut terminal,
        screen,
        &draft,
        &connecting,
        None,
        &theme::Theme::offline(),
        false,
        &mut UiOverlay::None,
    )?;
    let mut selected = None;
    let mut turns: Vec<Turn> = Vec::new();
    let mut inflight = false;
    let mut compacting = false;
    let mut compact_cancelled = false;
    let mut last_compaction_count = 0usize;
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
    let mut composer_stash = String::new();
    let mut effective = load_runtime_config(&launch);
    let mut prefs = session_fork::load_prefs(&effective.grok_home);
    let mut extra_env = {
        let mut extra = config::credential_env(&effective, &std::env::vars().collect());
        extra.extend(config::compact_env(&effective));
        extra
    };
    let mut live_theme_kind = effective.appearance.resolved_kind(screen);
    let mut live_theme = effective.appearance.resolved_theme(screen);
    apply_cursor_color(&live_theme);
    let mut status_runtime =
        status_line::StatusLineRuntime::new(effective.appearance.status_line.clone());
    let mut turn_started: Option<Instant> = None;
    let mut last_status_key = String::new();
    let mut apply_failed = false;
    let mut patch = match config::apply_to_dsh(&effective, &std::env::vars().collect()) {
        Ok(path) => path,
        Err(error) => {
            last_error = error.to_string();
            apply_failed = true;
            None
        }
    };
    let can_execute = !apply_failed
        && !effective.trust_prompt
        && (effective.ready || config::is_test_execution_seam());
    if !can_execute && last_error.is_empty() {
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
    let mut client = if can_execute {
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
                match apply_live_selection(&mut client, &effective) {
                    Ok(()) => selection_ready = true,
                    Err(error) => {
                        last_error = error;
                        selection_ready = false;
                    }
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
        inspect_auto_compact = false;
        let disconnect = client.as_mut().and_then(|active| {
            apply_events(
                &mut turns,
                &mut inflight,
                &mut meter,
                active.pump(Duration::ZERO),
                compacting,
                &mut inspect_auto_compact,
            )
        });
        if was_compacting && !inflight {
            compacting = false;
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
                            last_error = hint.clone();
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
        }
        let awaiting = turns.last().is_some_and(|turn| turn.permission.is_some());
        let cancelling = turns.last().is_some_and(|turn| turn.cancelling);
        let shown_hint = if matches!(overlay, Overlay::None) {
            hint.clone()
        } else {
            overlay_hint(&overlay, &prefs)
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
        let show_timestamps = view.show_timestamps;
        let notice = if screen == ScreenMode::Minimal {
            overlay_notice(view, &turns)
        } else {
            render_transcript(&status_line(view), &turns, show_timestamps)
        };
        paint(
            &mut terminal,
            screen,
            &draft,
            &notice,
            selected,
            &live_theme,
            effective.appearance.compact_mode,
            &mut ui_overlay,
        )?;
        if !event::poll(Duration::from_millis(80))? {
            continue;
        }
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && matches!(key.code, KeyCode::Char('q' | 'd'))
                {
                    if let (Some(turn), Some(active)) = (turns.last_mut(), client.as_mut())
                        && let Some(permission) = turn.permission.take()
                    {
                        let _ = active.cancel_permission(&permission.request_id);
                    }
                    break;
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
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && matches!(key.code, KeyCode::Char('c'))
                {
                    if !draft.is_empty() || !composer_stash.is_empty() {
                        draft.set_text("");
                        composer_stash.clear();
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
                    extra_env = {
                        let mut extra =
                            config::credential_env(&effective, &std::env::vars().collect());
                        extra.extend(config::compact_env(&effective));
                        extra
                    };
                    match config::apply_to_dsh(&effective, &std::env::vars().collect()) {
                        Ok(path) => {
                            patch = path;
                            apply_failed = false;
                        }
                        Err(error) => {
                            last_error = error.to_string();
                            apply_failed = true;
                        }
                    }
                    if !apply_failed
                        && !effective.trust_prompt
                        && (effective.ready || config::is_test_execution_seam())
                    {
                        match connect(
                            &mode,
                            previous_session.as_deref(),
                            &extra_env,
                            patch.as_ref(),
                            false,
                            None,
                        ) {
                            Ok((connection, restored)) => {
                                resumed = connection.resumed;
                                previous_session = connection.client.session_id.clone();
                                owner = Some(connection.owner);
                                if turns.is_empty() {
                                    turns = restored;
                                }
                                let mut connected = connection.client;
                                match apply_live_selection(&mut connected, &effective) {
                                    Ok(()) => {
                                        selection_ready = true;
                                        last_error.clear();
                                    }
                                    Err(error) => {
                                        last_error = error;
                                        selection_ready = false;
                                    }
                                }
                                client = Some(connected);
                            }
                            Err(error) => last_error = error,
                        }
                    } else if last_error.is_empty() {
                        last_error = effective.first_run_message();
                        if last_error.is_empty() {
                            last_error = effective.trust_message.clone();
                        }
                    }
                    continue;
                }

                if key.modifiers.is_empty() {
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
                                    ) {
                                        Ok(message) => {
                                            overlay = Overlay::None;
                                            hint = message;
                                            last_error.clear();
                                            draft.set_text("");
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
                                    ) {
                                        Ok(message) => {
                                            overlay = Overlay::None;
                                            hint = message;
                                            last_error.clear();
                                            draft.set_text("");
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
                                    ) {
                                        Ok(message) => {
                                            overlay = Overlay::None;
                                            hint = message;
                                            last_error.clear();
                                            draft.set_text("");
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
                        Overlay::None => {}
                    }
                }

                if let (Some(turn), Some(active)) = (turns.last_mut(), client.as_mut())
                    && let Some(permission) = turn.permission.clone()
                    && key.modifiers.is_empty()
                    && draft.is_empty()
                {
                    let option = match key.code {
                        KeyCode::Char('y') | KeyCode::Enter => Some("allow-once"),
                        KeyCode::Char('n') => Some("reject-once"),
                        _ => None,
                    };
                    if let Some(option_id) = option {
                        match active.answer_permission(&permission.request_id, option_id) {
                            Ok(()) => {
                                turn.permission = None;
                                last_error.clear();
                            }
                            Err(error) => last_error = error.message,
                        }
                        continue;
                    }
                }
                match key.code {
                    KeyCode::Esc => {
                        selected = None;
                        if inflight && !turns.last().is_some_and(|turn| turn.cancelling) {
                            hint = "Press Ctrl+C to cancel the turn".into();
                            last_esc = None;
                        } else if !inflight
                            && draft.is_empty()
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
                    KeyCode::Tab => selected = Some((selected.unwrap_or(2) + 1) % 3),
                    KeyCode::Enter if key.modifiers.is_empty() => match selected {
                        Some(2) => break,
                        Some(1) => {
                            draft.set_text("");
                            composer_stash.clear();
                        }
                        _ => {
                            let text = draft.text();
                            if let Some(command) = appearance::slash(text) {
                                let restored = std::mem::take(&mut composer_stash);
                                draft.set_text(&restored);
                                selected = None;
                                match command {
                                    appearance::AppearanceSlash::Settings => {
                                        ui_overlay = UiOverlay::Settings(SettingsState::open(
                                            &effective.appearance,
                                            screen,
                                        ));
                                        hint.clear();
                                    }
                                    appearance::AppearanceSlash::Theme(args) => {
                                        if screen == ScreenMode::Minimal {
                                            hint = appearance::minimal_theme_refuse().into();
                                        } else if args.is_empty() {
                                            ui_overlay = UiOverlay::Theme(ThemeState::open(
                                                &effective.appearance,
                                            ));
                                            hint.clear();
                                            apply_overlay_action(
                                                OverlayAction::PreviewTheme(
                                                    if let UiOverlay::Theme(state) = &ui_overlay {
                                                        state.current()
                                                    } else {
                                                        live_theme_kind
                                                    },
                                                ),
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
                                        } else {
                                            match appearance::apply_setting(
                                                &mut effective.appearance,
                                                "ui.theme",
                                                &args,
                                            ) {
                                                Ok(encoded) => {
                                                    match persist_appearance(
                                                        &effective, "ui.theme", &encoded,
                                                    ) {
                                                        Ok(()) => {
                                                            live_theme_kind = effective
                                                                .appearance
                                                                .resolved_kind(screen);
                                                            live_theme = effective
                                                                .appearance
                                                                .resolved_theme(screen);
                                                            apply_cursor_color(&live_theme);
                                                            hint = format!(
                                                                "theme = {}",
                                                                effective
                                                                    .appearance
                                                                    .theme
                                                                    .display_name()
                                                            );
                                                            last_error.clear();
                                                        }
                                                        Err(error) => last_error = error,
                                                    }
                                                }
                                                Err(error) => last_error = error,
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
                                                match persist_appearance(
                                                    &effective,
                                                    "ui.compact_mode",
                                                    &encoded,
                                                ) {
                                                    Ok(()) => {
                                                        hint = format!(
                                                            "compact_mode {}",
                                                            if next { "on" } else { "off" }
                                                        );
                                                        last_error.clear();
                                                    }
                                                    Err(error) => last_error = error,
                                                }
                                            }
                                            Err(error) => last_error = error,
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
                                                match persist_appearance(
                                                    &effective,
                                                    "ui.show_timestamps",
                                                    &encoded,
                                                ) {
                                                    Ok(()) => {
                                                        hint = format!(
                                                            "timestamps {}",
                                                            if next { "on" } else { "off" }
                                                        );
                                                        last_error.clear();
                                                    }
                                                    Err(error) => last_error = error,
                                                }
                                            }
                                            Err(error) => last_error = error,
                                        }
                                    }
                                    appearance::AppearanceSlash::Help => {
                                        hint = settings_ui::help_text().into();
                                    }
                                    appearance::AppearanceSlash::Unavailable(message) => {
                                        hint = message;
                                    }
                                }
                                continue;
                            }
                            if let Some(action) = screen_mode::slash_action(text) {
                                let restored = std::mem::take(&mut composer_stash);
                                draft.set_text(&restored);
                                selected = None;
                                match action {
                                    SlashAction::Switch(target) if target == screen => {
                                        hint = format!("Already in {} mode.", screen.as_str());
                                    }
                                    SlashAction::Switch(target) => {
                                        if policy == SwitchPolicy::Exec {
                                            let session_id = client
                                                .as_ref()
                                                .and_then(|active| active.session_id.clone())
                                                .or_else(|| previous_session.clone());
                                            let Some(session_id) = session_id else {
                                                hint = screen_mode::exec_failure_message(
                                                    None,
                                                    target,
                                                    "no session",
                                                );
                                                continue;
                                            };
                                            drop_connection(&mut client, &mut owner);
                                            drop(terminal);
                                            drop(guard);
                                            restore_terminal();
                                            return Err(relaunch_exec(&session_id, target));
                                        }
                                        guard.apply(&mut terminal, target)?;
                                        if target == ScreenMode::Minimal {
                                            commit_completed_turns(
                                                &mut terminal,
                                                &turns,
                                                &mut committed,
                                                &mut history,
                                                Some(target.switch_marker()),
                                            )?;
                                            hint.clear();
                                        } else {
                                            hint = target.switch_marker().into();
                                        }
                                        screen = target;
                                        live_theme_kind =
                                            effective.appearance.resolved_kind(screen);
                                        live_theme = effective.appearance.resolved_theme(screen);
                                        apply_cursor_color(&live_theme);
                                        last_error.clear();
                                    }
                                    refuse @ SlashAction::Refuse(_) => {
                                        if let Some(message) =
                                            screen_mode::mode_command_message(screen, refuse)
                                        {
                                            hint = message;
                                        }
                                    }
                                }
                                continue;
                            }
                            composer_stash.clear();
                            let trimmed = text.trim();
                            if session_fork::is_conversation_slash(trimmed) {
                                if inflight {
                                    last_error = session_fork::running_turn_error();
                                    draft.set_text("");
                                    continue;
                                }
                                if client.is_none() {
                                    last_error = "not connected".into();
                                    continue;
                                }
                                if trimmed.starts_with("/fork") {
                                    match session_fork::parse_fork_slash(trimmed) {
                                        Err(error) => {
                                            last_error = error;
                                            draft.set_text("");
                                        }
                                        Ok(fork) => {
                                            if let Some(active) = client.as_mut() {
                                                match commit_fork(
                                                    active,
                                                    &mut owner,
                                                    &mut turns,
                                                    &mut inflight,
                                                    &effective.dsh_home,
                                                    &effective.cwd,
                                                    &prefs,
                                                    fork.directive.as_deref(),
                                                    &mut resumed,
                                                    &mut previous_session,
                                                ) {
                                                    Ok(message) => {
                                                        hint = message;
                                                        last_error.clear();
                                                        draft.set_text("");
                                                        if let Err(error) =
                                                            reset_native_history_after_switch(
                                                                &mut terminal,
                                                                screen,
                                                                &mut committed,
                                                                &mut history,
                                                            )
                                                        {
                                                            last_error = error.to_string();
                                                        }
                                                    }
                                                    Err(error) => last_error = error,
                                                }
                                            }
                                        }
                                    }
                                    continue;
                                }
                                let rest = trimmed
                                    .trim_start_matches("/rewind")
                                    .trim_start_matches("/undo")
                                    .trim();
                                let Some(session_id) =
                                    client.as_ref().and_then(|active| active.session_id.clone())
                                else {
                                    last_error = "ACP session is not ready".into();
                                    continue;
                                };
                                match session_fork::list_points(&effective.dsh_home, &session_id) {
                                    Ok(points) if points.is_empty() => {
                                        hint = "no turns to rewind yet".into();
                                        draft.set_text("");
                                    }
                                    Ok(points) => {
                                        if rest.is_empty() {
                                            let mut newest = points;
                                            newest.reverse();
                                            overlay = Overlay::RewindPick {
                                                points: newest,
                                                cursor: 0,
                                            };
                                            draft.set_text("");
                                            hint.clear();
                                        } else if let Ok(turn) = rest.parse::<u32>() {
                                            if let Some(point) =
                                                points.into_iter().find(|point| point.turn == turn)
                                            {
                                                if prefs.confirm_before_rewind {
                                                    overlay = Overlay::RewindConfirm { point };
                                                    draft.set_text("");
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
                                                    ) {
                                                        Ok(message) => {
                                                            hint = message;
                                                            last_error.clear();
                                                            draft.set_text("");
                                                            if let Err(error) =
                                                                reset_native_history_after_switch(
                                                                    &mut terminal,
                                                                    screen,
                                                                    &mut committed,
                                                                    &mut history,
                                                                )
                                                            {
                                                                last_error = error.to_string();
                                                            }
                                                        }
                                                        Err(error) => last_error = error,
                                                    }
                                                }
                                            } else {
                                                last_error = "turn must be between 1 and the latest rewind point"
                                                    .into();
                                            }
                                        } else {
                                            last_error = "turn must be a positive integer".into();
                                        }
                                    }
                                    Err(error) => last_error = error.message,
                                }
                                continue;
                            }
                            let slash = models::parse_slash(trimmed);
                            if inflight && slash.is_none() {
                                continue;
                            }
                            if client.is_none() {
                                effective = load_runtime_config(&launch);
                                extra_env = {
                                    let mut extra = config::credential_env(
                                        &effective,
                                        &std::env::vars().collect(),
                                    );
                                    extra.extend(config::compact_env(&effective));
                                    extra
                                };
                                match config::apply_to_dsh(&effective, &std::env::vars().collect())
                                {
                                    Ok(path) => patch = path,
                                    Err(error) => {
                                        last_error = error.to_string();
                                        continue;
                                    }
                                }
                                if effective.trust_prompt
                                    || (!effective.ready && !config::is_test_execution_seam())
                                {
                                    last_error = effective.first_run_message();
                                    continue;
                                }
                                match connect(
                                    &mode,
                                    previous_session.as_deref(),
                                    &extra_env,
                                    patch.as_ref(),
                                    false,
                                    None,
                                ) {
                                    Ok((connection, restored)) => {
                                        resumed = connection.resumed;
                                        previous_session = connection.client.session_id.clone();
                                        owner = Some(connection.owner);
                                        if turns.is_empty() {
                                            turns = restored;
                                        }
                                        let mut connected = connection.client;
                                        match apply_live_selection(&mut connected, &effective) {
                                            Ok(()) => {
                                                selection_ready = true;
                                                last_error.clear();
                                            }
                                            Err(error) => {
                                                last_error = error;
                                                selection_ready = false;
                                            }
                                        }
                                        client = Some(connected);
                                    }
                                    Err(error) => {
                                        last_error = error;
                                        continue;
                                    }
                                }
                            }
                            if text.trim().is_empty() {
                                continue;
                            }
                            if let Some(command) = slash {
                                match command {
                                    models::Command::Context => {
                                        let routing = live_routing(client.as_ref(), &effective);
                                        let breakdown = client
                                            .as_ref()
                                            .and_then(|active| active.session_id.as_ref())
                                            .and_then(|session_id| {
                                                session_history::load_session(
                                                    &effective.dsh_home,
                                                    session_id,
                                                )
                                                .ok()
                                                .and_then(|session| session.breakdown)
                                            })
                                            .map(|item| models::ContextBreakdown {
                                                system: item.system,
                                                tools: item.tools,
                                                messages: item.messages,
                                            });
                                        hint = models::context_report(
                                            meter.used,
                                            routing
                                                .as_ref()
                                                .and_then(|item| item.advertised_context),
                                            meter.size,
                                            breakdown.as_ref(),
                                        );
                                        last_error.clear();
                                        draft.set_text("");
                                        continue;
                                    }
                                    models::Command::Compact { instruction } => {
                                        if inflight {
                                            last_error = "Compaction is unavailable because this process has an active compaction, or the agent is not idle.".into();
                                            draft.set_text("");
                                            continue;
                                        }
                                        let prompt = match instruction {
                                            Some(text) => format!("/compact {text}"),
                                            None => "/compact".into(),
                                        };
                                        if let Some(active) = client.as_mut() {
                                            match active.submit_prompt(&prompt) {
                                                Ok(_) => {
                                                    hint = "✂ compacting history…".into();
                                                    inflight = true;
                                                    compacting = true;
                                                    last_error.clear();
                                                }
                                                Err(error) => last_error = error.message,
                                            }
                                        } else {
                                            last_error = UNAVAILABLE.trim().to_string();
                                        }
                                        draft.set_text("");
                                        continue;
                                    }
                                    other => {
                                        match handle_slash_command(
                                            other,
                                            &mut effective,
                                            client.as_mut(),
                                            inflight,
                                        ) {
                                            Ok(message) => {
                                                if message.starts_with("Selected ") {
                                                    selection_ready = true;
                                                }
                                                hint = message;
                                                last_error.clear();
                                            }
                                            Err(error) => last_error = error,
                                        }
                                        draft.set_text("");
                                        continue;
                                    }
                                }
                            }
                            if inflight {
                                continue;
                            }
                            if !turn_allowed(selection_ready) {
                                if last_error.is_empty() {
                                    last_error = "configured model was not applied; no silent provider fallback".into();
                                }
                                continue;
                            }
                            if owner.as_ref().is_some_and(|held| !held.still_held()) {
                                last_error = format!(
                                    "Write owner refused: session {} is no longer owned by this client.",
                                    owner
                                        .as_ref()
                                        .map(|held| held.session_id.as_str())
                                        .unwrap_or("unknown")
                                );
                                drop_connection(&mut client, &mut owner);
                                continue;
                            }
                            if let Some(active) = client.as_mut() {
                                match active.submit_prompt(text) {
                                    Ok(_) => {
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
                                        });
                                        draft.set_text("");
                                        inflight = true;
                                        last_error.clear();
                                    }
                                    Err(error) => last_error = error.message,
                                }
                            }
                        }
                    },
                    _ => {
                        selected = None;
                        if key.modifiers.is_empty()
                            && key.code == KeyCode::Char('/')
                            && !draft.is_empty()
                            && !draft.text().starts_with('/')
                        {
                            composer_stash = draft.text().to_string();
                            draft.set_text("/");
                        } else {
                            draft.input(key);
                        }
                    }
                }
            }
            Event::Paste(text) => {
                selected = None;
                draft.insert_str(&text);
            }
            Event::Mouse(mouse) => {
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
                }
                let _ = MouseEventKind::Moved;
            }
            Event::Resize(_, _) => {
                terminal.autoresize()?;
                if screen == ScreenMode::Minimal {
                    resize_purge_rerender(&mut terminal, &history)?;
                }
            }
            _ => {}
        }
    }
    status_runtime.shutdown();
    drop_connection(&mut client, &mut owner);
    Ok(())
}

fn main() {
    let old_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        old_hook(info);
    }));
    if let Err(error) = run() {
        eprintln!("codsh: Rust startup failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parse_effort_flags() {
        let launch = parse_launch(&args(&["--model", "think", "--effort", "high"])).unwrap();
        assert_eq!(launch.model.as_deref(), Some("think"));
        assert_eq!(launch.effort.as_deref(), Some("high"));
        let alias = parse_launch(&args(&["--reasoning-effort=low"])).unwrap();
        assert_eq!(alias.effort.as_deref(), Some("low"));
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
    fn parse_leader_socket_is_refused() {
        let error = parse_launch(&args(&["inspect", "--leader-socket", "x"])).unwrap_err();
        assert!(error.to_string().contains("dsh owns execution"));
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
        let error = parse_launch(&args(&["--no-alt-screen"])).unwrap_err();
        assert!(
            error.to_string().contains("unsupported preview arguments"),
            "{error}"
        );
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
                .contains("omit --worktree")
        );
        assert!(session_fork::is_conversation_slash("/rewind"));
        assert_eq!(
            session_fork::running_turn_error(),
            "a turn is running — interrupt it before rewinding"
        );
    }
}
