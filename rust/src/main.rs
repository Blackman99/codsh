mod theme;
mod welcome;

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

fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag] if flag == "--version" || flag == "-V" => {
            println!(
                "codsh-rust {} (launch preview; upstream a28ee2b; reference 1.0.34)",
                env!("CARGO_PKG_VERSION")
            );
            return Ok(());
        }
        [flag] if flag == "--help" || flag == "-h" => {
            println!(
                "codsh --rust\n\nOffline Rust launch preview. No executing agent, model, auth, telemetry, or session store.\nHome: ~/.codsh-rust/dsh; Profile: rust. Legacy codsh is unchanged.\nCtrl+Q/Ctrl+D: quit; Ctrl+C: clear draft, then quit; Enter: report availability.\nOptions: --help, --version. Other options are not yet supported."
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
    // Profile errors deliberately propagate through terminal teardown.
    profile()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut draft = TextArea::new();
    let mut notice = "Offline launch preview.\nNo account or uploads.";
    let mut selected = None;
    while !stopping.load(Ordering::Relaxed) {
        terminal.draw(|frame| {
            welcome::render(frame, &draft, notice, selected);
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
                        _ => notice = UNAVAILABLE,
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
