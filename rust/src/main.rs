mod acp;
mod theme;
mod welcome;

use acp::{AcpClient, AcpEvent};
use crossterm::cursor::{Hide, Show};
use crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEventKind, KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::{Terminal, backend::CrosstermBackend};
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use xai_ratatui_textarea::TextArea;

const UNAVAILABLE: &str = "Execution unavailable: dsh\nNot connected. Draft kept.";

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let guard = Self;
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            EnableBracketedPaste,
            Hide
        )?;
        Ok(guard)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(
            io::stdout(),
            DisableBracketedPaste,
            Show,
            LeaveAlternateScreen
        );
        let _ = terminal::disable_raw_mode();
        let _ = io::stdout().flush();
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

struct Turn {
    user: String,
    thought: String,
    answer: String,
    error: Option<String>,
    message_id: Option<String>,
    done: bool,
}

fn connect() -> Result<AcpClient, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let dsh_home = PathBuf::from(
        std::env::var_os("DSH_HOME").ok_or("missing isolated DSH_HOME; use codsh --rust")?,
    );
    let spec = acp::dsh_spawn_spec(cwd.clone(), &dsh_home).map_err(|error| error.message)?;
    let mut client = AcpClient::spawn(spec).map_err(|error| error.to_string())?;
    client
        .initialize(Duration::from_secs(20))
        .map_err(|error| error.message)?;
    client
        .new_session(&cwd, Duration::from_secs(20))
        .map_err(|error| error.message)?;
    Ok(client)
}

fn status_line(client: Option<&AcpClient>, inflight: bool, last_error: &str) -> String {
    if !last_error.is_empty() && client.is_none() {
        return format!("{UNAVAILABLE}\n{last_error}");
    }
    match client {
        Some(client) if inflight => format!(
            "Connected to dsh ACP session {}.\nStreaming turn…",
            client.session_id.as_deref().unwrap_or("unknown")
        ),
        Some(client) => format!(
            "Connected to dsh ACP session {}.\nEnter submits a prompt through dsh.",
            client.session_id.as_deref().unwrap_or("unknown")
        ),
        None => UNAVAILABLE.to_string(),
    }
}

fn render_transcript(status: &str, turns: &[Turn]) -> String {
    let mut out = status.to_string();
    for turn in turns {
        out.push_str("\n\n> ");
        out.push_str(&turn.user.replace('\n', " "));
        if !turn.thought.is_empty() {
            out.push_str("\n[thought] ");
            out.push_str(&turn.thought);
        }
        if !turn.answer.is_empty() {
            out.push('\n');
            out.push_str(&turn.answer);
        }
        if let Some(error) = &turn.error {
            out.push_str("\n[error] ");
            out.push_str(error);
        } else if turn.done && turn.answer.is_empty() && turn.thought.is_empty() {
            out.push_str("\n[empty answer]");
        } else if !turn.done {
            out.push('…');
        }
    }
    out
}

fn apply_events(turns: &mut [Turn], inflight: &mut bool, events: Vec<AcpEvent>) -> Option<String> {
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
            AcpEvent::PromptFinished { .. } => {
                if let Some(turn) = turns.last_mut() {
                    turn.done = true;
                }
                *inflight = false;
            }
            AcpEvent::RpcError { message, .. } => {
                if let Some(turn) = turns.last_mut()
                    && *inflight
                {
                    turn.error = Some(message);
                    turn.done = true;
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
                }
                disconnect = Some(detail);
                *inflight = false;
            }
            AcpEvent::PermissionCancelled { .. } => {
                if let Some(turn) = turns.last_mut() {
                    turn.error = Some("permission request cancelled".into());
                    turn.done = true;
                }
                *inflight = false;
            }
        }
    }
    disconnect
}

fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag] if flag == "--version" || flag == "-V" => {
            println!(
                "codsh-rust {} (dsh ACP; upstream a28ee2b; reference 1.0.34)",
                env!("CARGO_PKG_VERSION")
            );
            return Ok(());
        }
        [flag] if flag == "--help" || flag == "-h" => {
            println!(
                "codsh --rust\n\nIsolated Rust client. Real dsh executes turns over ACP/JSON-RPC stdio.\nHome: ~/.codsh-rust/dsh; Profile: rust. Legacy codsh is unchanged.\nCtrl+Q/Ctrl+D: quit; Ctrl+C: clear draft, then quit; Enter: submit prompt.\nOptions: --help, --version. Other options are not yet supported."
            );
            return Ok(());
        }
        [] => {}
        _ => {
            return Err(io::Error::other(
                "unsupported preview arguments; use codsh --rust --help",
            ));
        }
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(io::Error::other(
            "Rust preview requires an interactive terminal",
        ));
    }
    let stopping = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    for signal in [
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
        signal_hook::consts::SIGINT,
    ] {
        signal_hook::flag::register(signal, Arc::clone(&stopping))?;
    }
    let _guard = TerminalGuard::enter()?;
    profile()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut draft = TextArea::new();
    terminal.draw(|frame| {
        welcome::render(frame, &draft, "Connecting to dsh ACP…", None);
    })?;
    let mut selected = None;
    let mut turns: Vec<Turn> = Vec::new();
    let mut inflight = false;
    let mut last_error = String::new();
    let mut client = match connect() {
        Ok(client) => Some(client),
        Err(error) => {
            last_error = error;
            None
        }
    };
    while !stopping.load(Ordering::Relaxed) {
        let disconnect = client.as_mut().and_then(|active| {
            apply_events(&mut turns, &mut inflight, active.pump(Duration::ZERO))
        });
        if let Some(detail) = disconnect {
            last_error = detail;
            client = None;
        }
        let notice =
            render_transcript(&status_line(client.as_ref(), inflight, &last_error), &turns);
        terminal.draw(|frame| {
            welcome::render(frame, &draft, &notice, selected);
        })?;
        if !event::poll(Duration::from_millis(80))? {
            continue;
        }
        match event::read()? {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if key.modifiers.contains(KeyModifiers::CONTROL) {
                    match key.code {
                        KeyCode::Char('q' | 'd') => break,
                        KeyCode::Char('c') => {
                            if draft.is_empty() {
                                break;
                            }
                            draft.set_text("");
                            selected = None;
                            continue;
                        }
                        _ => {}
                    }
                }
                match key.code {
                    KeyCode::Esc => selected = None,
                    KeyCode::Tab => selected = Some((selected.unwrap_or(2) + 1) % 3),
                    KeyCode::Enter if key.modifiers.is_empty() => match selected {
                        Some(2) => break,
                        Some(1) => draft.set_text(""),
                        _ => {
                            if inflight {
                                continue;
                            }
                            let text = draft.text();
                            if text.trim().is_empty() {
                                continue;
                            }
                            if client.is_none() {
                                match connect() {
                                    Ok(next) => client = Some(next),
                                    Err(error) => {
                                        last_error = error;
                                        continue;
                                    }
                                }
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
                                            done: false,
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
                        draft.input(key);
                    }
                }
            }
            Event::Paste(text) => {
                selected = None;
                draft.insert_str(&text);
            }
            Event::Resize(_, _) => {}
            _ => {}
        }
    }
    if let Some(active) = client.as_mut() {
        active.shutdown();
    }
    Ok(())
}

fn main() {
    let old_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        drop(TerminalGuard);
        old_hook(info);
    }));
    if let Err(error) = run() {
        eprintln!("codsh: Rust startup failed: {error}");
        std::process::exit(1);
    }
}
