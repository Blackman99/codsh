//! Terminal, multiplexer and host facts read from the environment (ticket 155).
//!
//! Everything here is a pure function of an environment snapshot so the
//! clipboard, doctor and notification code can be tested without touching the
//! real terminal. Nothing in this module writes to the terminal or to config.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub type EnvMap = BTreeMap<String, String>;

/// Snapshot of the current process environment.
pub fn current_env() -> EnvMap {
    std::env::vars().collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Brand {
    AppleTerminal,
    Ghostty,
    Iterm2,
    Warp,
    WezTerm,
    Kitty,
    Alacritty,
    Rio,
    Foot,
    VsCode,
    Cursor,
    Windsurf,
    Zed,
    JetBrains,
    Vte,
    WindowsTerminal,
    Unknown,
}

impl Brand {
    pub fn label(self) -> &'static str {
        match self {
            Brand::AppleTerminal => "Apple Terminal",
            Brand::Ghostty => "Ghostty",
            Brand::Iterm2 => "iTerm2",
            Brand::Warp => "Warp",
            Brand::WezTerm => "WezTerm",
            Brand::Kitty => "Kitty",
            Brand::Alacritty => "Alacritty",
            Brand::Rio => "Rio",
            Brand::Foot => "foot",
            Brand::VsCode => "VS Code",
            Brand::Cursor => "Cursor",
            Brand::Windsurf => "Windsurf",
            Brand::Zed => "Zed",
            Brand::JetBrains => "JetBrains",
            Brand::Vte => "VTE (GNOME Terminal/Tilix/...)",
            Brand::WindowsTerminal => "Windows Terminal",
            Brand::Unknown => "unknown",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Brand::AppleTerminal => "apple_terminal",
            Brand::Ghostty => "ghostty",
            Brand::Iterm2 => "iterm2",
            Brand::Warp => "warp",
            Brand::WezTerm => "wezterm",
            Brand::Kitty => "kitty",
            Brand::Alacritty => "alacritty",
            Brand::Rio => "rio",
            Brand::Foot => "foot",
            Brand::VsCode => "vscode",
            Brand::Cursor => "cursor",
            Brand::Windsurf => "windsurf",
            Brand::Zed => "zed",
            Brand::JetBrains => "jetbrains",
            Brand::Vte => "vte",
            Brand::WindowsTerminal => "windows_terminal",
            Brand::Unknown => "unknown",
        }
    }

    pub fn is_editor_terminal(self) -> bool {
        matches!(
            self,
            Brand::VsCode | Brand::Cursor | Brand::Windsurf | Brand::Zed
        )
    }

    /// Documented OSC 52 clipboard-write support. iTerm2 needs a per-profile
    /// permission, so it is reported separately rather than trusted here.
    pub fn osc52(self) -> Osc52Support {
        match self {
            Brand::Ghostty
            | Brand::Kitty
            | Brand::WezTerm
            | Brand::Alacritty
            | Brand::Foot
            | Brand::Rio
            | Brand::WindowsTerminal
            | Brand::VsCode
            | Brand::Cursor
            | Brand::Windsurf
            | Brand::Zed => Osc52Support::Supported,
            Brand::Iterm2 | Brand::Warp | Brand::Unknown => Osc52Support::Unknown,
            Brand::AppleTerminal | Brand::JetBrains | Brand::Vte => Osc52Support::Unsupported,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Osc52Support {
    Supported,
    Unknown,
    Unsupported,
}

impl Osc52Support {
    pub fn label(self) -> &'static str {
        match self {
            Osc52Support::Supported => "supported",
            Osc52Support::Unknown => "unknown",
            Osc52Support::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Multiplexer {
    None,
    Tmux,
    Byobu,
    Screen,
    Zellij,
}

impl Multiplexer {
    pub fn label(self) -> &'static str {
        match self {
            Multiplexer::None => "none",
            Multiplexer::Tmux => "tmux",
            Multiplexer::Byobu => "byobu",
            Multiplexer::Screen => "screen",
            Multiplexer::Zellij => "zellij",
        }
    }

    /// tmux (or byobu's tmux backend) sits between us and the terminal.
    pub fn tmux_backed(self, env: &EnvMap) -> bool {
        match self {
            Multiplexer::Tmux => true,
            Multiplexer::Byobu => non_empty(env, "TMUX").is_some(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    Linux,
    Macos,
    Windows,
    Other,
}

impl HostOs {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            HostOs::Macos
        } else if cfg!(target_os = "windows") {
            HostOs::Windows
        } else if cfg!(target_os = "linux") {
            HostOs::Linux
        } else {
            HostOs::Other
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            HostOs::Linux => "linux",
            HostOs::Macos => "macos",
            HostOs::Windows => "windows",
            HostOs::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayServer {
    Wayland,
    X11,
    Quartz,
    Win32,
    None,
}

impl DisplayServer {
    pub fn label(self) -> &'static str {
        match self {
            DisplayServer::Wayland => "wayland",
            DisplayServer::X11 => "x11",
            DisplayServer::Quartz => "quartz",
            DisplayServer::Win32 => "win32",
            DisplayServer::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorDepth {
    TrueColor,
    Ansi256,
    Ansi16,
    NoColor,
}

impl ColorDepth {
    pub fn label(self) -> &'static str {
        match self {
            ColorDepth::TrueColor => "truecolor",
            ColorDepth::Ansi256 => "256",
            ColorDepth::Ansi16 => "16",
            ColorDepth::NoColor => "none (NO_COLOR)",
        }
    }
}

/// Facts about where we are running. `brand_source` names the variable that
/// identified the terminal so reports never present a guess as a fact.
#[derive(Debug, Clone)]
pub struct TermEnv {
    pub host_os: HostOs,
    pub brand: Brand,
    pub brand_source: String,
    pub term: String,
    pub colorterm: String,
    pub color: ColorDepth,
    pub multiplexer: Multiplexer,
    pub remote: bool,
    pub container: bool,
    pub display: DisplayServer,
    pub osc52_sink: bool,
    pub osc52_disabled: bool,
}

pub fn non_empty<'a>(env: &'a EnvMap, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

fn truthy(env: &EnvMap, key: &str) -> bool {
    non_empty(env, key).is_some_and(|value| {
        !matches!(
            value.to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        )
    })
}

impl TermEnv {
    /// Detect from the live process environment.
    pub fn detect() -> Self {
        Self::from_env(
            &current_env(),
            HostOs::current(),
            Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists(),
        )
    }

    pub fn from_env(env: &EnvMap, host_os: HostOs, container_marker: bool) -> Self {
        let (brand, brand_source) = detect_brand(env);
        let term = env.get("TERM").cloned().unwrap_or_default();
        let colorterm = env.get("COLORTERM").cloned().unwrap_or_default();
        let color = if non_empty(env, "NO_COLOR").is_some() {
            ColorDepth::NoColor
        } else if matches!(
            colorterm.to_ascii_lowercase().as_str(),
            "truecolor" | "24bit"
        ) {
            ColorDepth::TrueColor
        } else if term.contains("256color") || term.contains("direct") {
            ColorDepth::Ansi256
        } else {
            ColorDepth::Ansi16
        };
        let byobu = [
            "BYOBU_BACKEND",
            "BYOBU_CONFIG_DIR",
            "BYOBU_TTY",
            "BYOBU_SESSION",
        ]
        .iter()
        .any(|key| non_empty(env, key).is_some());
        let multiplexer = if non_empty(env, "ZELLIJ").is_some() {
            Multiplexer::Zellij
        } else if byobu && (non_empty(env, "TMUX").is_some() || non_empty(env, "STY").is_some()) {
            Multiplexer::Byobu
        } else if non_empty(env, "TMUX").is_some() {
            Multiplexer::Tmux
        } else if non_empty(env, "STY").is_some() {
            Multiplexer::Screen
        } else {
            Multiplexer::None
        };
        let remote = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]
            .iter()
            .any(|key| non_empty(env, key).is_some());
        let container = container_marker || non_empty(env, "container").is_some();
        let display = match host_os {
            HostOs::Macos => DisplayServer::Quartz,
            HostOs::Windows => DisplayServer::Win32,
            _ if non_empty(env, "WAYLAND_DISPLAY").is_some() => DisplayServer::Wayland,
            _ if non_empty(env, "DISPLAY").is_some() => DisplayServer::X11,
            _ => DisplayServer::None,
        };
        // Presence of either marker advertises the wrap sink (LC_* survives SSH).
        let osc52_sink = non_empty(env, "GROK_OSC52_SINK").is_some()
            || non_empty(env, "LC_GROK_OSC52_SINK").is_some();
        let osc52_disabled = truthy(env, "GROK_CLIPBOARD_NO_OSC52");
        TermEnv {
            host_os,
            brand,
            brand_source,
            term,
            colorterm,
            color,
            multiplexer,
            remote,
            container,
            display,
            osc52_sink,
            osc52_disabled,
        }
    }

    pub fn tmux_backed(&self, env: &EnvMap) -> bool {
        self.multiplexer.tmux_backed(env)
    }

    /// OSC 52 support of whatever will finally receive the sequence.
    pub fn osc52_support(&self) -> Osc52Support {
        if self.osc52_sink {
            Osc52Support::Supported
        } else {
            self.brand.osc52()
        }
    }

    /// Container without its own display: the native clipboard, if any,
    /// belongs to the container, not the user.
    pub fn container_without_display(&self) -> bool {
        self.container && self.display == DisplayServer::None
    }
}

fn detect_brand(env: &EnvMap) -> (Brand, String) {
    let term = env.get("TERM").map(String::as_str).unwrap_or("");
    let program = non_empty(env, "TERM_PROGRAM").unwrap_or("");
    let found = |brand: Brand, source: &str| (brand, source.to_string());
    if program.eq_ignore_ascii_case("vscode") {
        if non_empty(env, "CURSOR_TRACE_ID").is_some() {
            return found(Brand::Cursor, "TERM_PROGRAM=vscode + CURSOR_TRACE_ID");
        }
        if env.keys().any(|key| key.starts_with("WINDSURF_")) {
            return found(Brand::Windsurf, "TERM_PROGRAM=vscode + WINDSURF_*");
        }
        return found(Brand::VsCode, "TERM_PROGRAM=vscode");
    }
    match program.to_ascii_lowercase().as_str() {
        "apple_terminal" => return found(Brand::AppleTerminal, "TERM_PROGRAM"),
        "iterm.app" => return found(Brand::Iterm2, "TERM_PROGRAM"),
        "wezterm" => return found(Brand::WezTerm, "TERM_PROGRAM"),
        "ghostty" => return found(Brand::Ghostty, "TERM_PROGRAM"),
        "warpterminal" => return found(Brand::Warp, "TERM_PROGRAM"),
        "zed" => return found(Brand::Zed, "TERM_PROGRAM"),
        "rio" => return found(Brand::Rio, "TERM_PROGRAM"),
        _ => {}
    }
    if non_empty(env, "ITERM_SESSION_ID").is_some() {
        return found(Brand::Iterm2, "ITERM_SESSION_ID");
    }
    if non_empty(env, "LC_TERMINAL").is_some_and(|value| value == "iTerm2") {
        return found(Brand::Iterm2, "LC_TERMINAL");
    }
    if non_empty(env, "KITTY_WINDOW_ID").is_some() || term == "xterm-kitty" {
        return found(Brand::Kitty, "KITTY_WINDOW_ID/TERM");
    }
    if non_empty(env, "GHOSTTY_RESOURCES_DIR").is_some() || term == "xterm-ghostty" {
        return found(Brand::Ghostty, "GHOSTTY_RESOURCES_DIR/TERM");
    }
    if non_empty(env, "WEZTERM_PANE").is_some() || non_empty(env, "WEZTERM_EXECUTABLE").is_some() {
        return found(Brand::WezTerm, "WEZTERM_PANE");
    }
    if non_empty(env, "ALACRITTY_WINDOW_ID").is_some()
        || non_empty(env, "ALACRITTY_SOCKET").is_some()
        || term == "alacritty"
    {
        return found(Brand::Alacritty, "ALACRITTY_WINDOW_ID/TERM");
    }
    if term.starts_with("foot") {
        return found(Brand::Foot, "TERM");
    }
    if non_empty(env, "ZED_TERM").is_some() {
        return found(Brand::Zed, "ZED_TERM");
    }
    if non_empty(env, "TERMINAL_EMULATOR").is_some_and(|value| value.contains("JetBrains")) {
        return found(Brand::JetBrains, "TERMINAL_EMULATOR");
    }
    if non_empty(env, "WT_SESSION").is_some() {
        return found(Brand::WindowsTerminal, "WT_SESSION");
    }
    if non_empty(env, "VTE_VERSION").is_some() {
        return found(Brand::Vte, "VTE_VERSION");
    }
    (
        Brand::Unknown,
        "no terminal marker in the environment".into(),
    )
}

/// The user's real home: the launcher isolates HOME and passes the real one
/// as CODSH_HOST_HOME.
pub fn user_home(env: &EnvMap) -> Option<PathBuf> {
    non_empty(env, "CODSH_HOST_HOME")
        .or_else(|| non_empty(env, "HOME"))
        .map(PathBuf::from)
}

/// First executable named `name` on the PATH from `env`.
pub fn which(env: &EnvMap, name: &str) -> Option<PathBuf> {
    let path = env.get("PATH")?;
    for dir in std::env::split_paths(path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Wrap an escape sequence in tmux's DCS passthrough (`allow-passthrough on`).
pub fn tmux_passthrough(sequence: &str) -> String {
    format!("\x1bPtmux;{}\x1b\\", sequence.replace('\x1b', "\x1b\x1b"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> EnvMap {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn brands_come_from_named_markers() {
        let cases = [
            (vec![("TERM_PROGRAM", "iTerm.app")], Brand::Iterm2),
            (
                vec![("TERM_PROGRAM", "Apple_Terminal")],
                Brand::AppleTerminal,
            ),
            (vec![("TERM_PROGRAM", "ghostty")], Brand::Ghostty),
            (vec![("TERM", "xterm-kitty")], Brand::Kitty),
            (vec![("KITTY_WINDOW_ID", "1")], Brand::Kitty),
            (vec![("WEZTERM_PANE", "0")], Brand::WezTerm),
            (vec![("TERM", "alacritty")], Brand::Alacritty),
            (vec![("TERM", "foot")], Brand::Foot),
            (vec![("TERM_PROGRAM", "vscode")], Brand::VsCode),
            (
                vec![("TERM_PROGRAM", "vscode"), ("CURSOR_TRACE_ID", "x")],
                Brand::Cursor,
            ),
            (
                vec![("TERMINAL_EMULATOR", "JetBrains-JediTerm")],
                Brand::JetBrains,
            ),
            (vec![("VTE_VERSION", "7402")], Brand::Vte),
            (vec![("WT_SESSION", "abc")], Brand::WindowsTerminal),
            (vec![("LC_TERMINAL", "iTerm2")], Brand::Iterm2),
            (vec![("TERM", "xterm-256color")], Brand::Unknown),
        ];
        for (pairs, brand) in cases {
            let detected = TermEnv::from_env(&env(&pairs), HostOs::Linux, false);
            assert_eq!(detected.brand, brand, "{pairs:?}");
        }
    }

    #[test]
    fn tmux_program_does_not_hide_the_outer_brand() {
        let detected = TermEnv::from_env(
            &env(&[
                ("TERM_PROGRAM", "tmux"),
                ("TMUX", "/tmp/tmux-1/default,1,0"),
                ("ITERM_SESSION_ID", "w0t0p0"),
            ]),
            HostOs::Macos,
            false,
        );
        assert_eq!(detected.brand, Brand::Iterm2);
        assert_eq!(detected.multiplexer, Multiplexer::Tmux);
    }

    #[test]
    fn multiplexer_remote_container_and_color() {
        let detected = TermEnv::from_env(
            &env(&[
                ("TMUX", "/tmp/t,1,0"),
                ("BYOBU_CONFIG_DIR", "/h/.byobu"),
                ("SSH_CONNECTION", "1 2 3 4"),
                ("COLORTERM", "truecolor"),
            ]),
            HostOs::Linux,
            true,
        );
        assert_eq!(detected.multiplexer, Multiplexer::Byobu);
        assert!(detected.remote);
        assert!(detected.container_without_display());
        assert_eq!(detected.color, ColorDepth::TrueColor);
        let screen = TermEnv::from_env(&env(&[("STY", "1.pts")]), HostOs::Linux, false);
        assert_eq!(screen.multiplexer, Multiplexer::Screen);
        let zellij = TermEnv::from_env(&env(&[("ZELLIJ", "0")]), HostOs::Linux, false);
        assert_eq!(zellij.multiplexer, Multiplexer::Zellij);
        let wayland = TermEnv::from_env(
            &env(&[("WAYLAND_DISPLAY", "wayland-0"), ("DISPLAY", ":0")]),
            HostOs::Linux,
            false,
        );
        assert_eq!(wayland.display, DisplayServer::Wayland);
    }

    #[test]
    fn sink_and_kill_switch() {
        let detected = TermEnv::from_env(
            &env(&[
                ("LC_GROK_OSC52_SINK", "1"),
                ("GROK_CLIPBOARD_NO_OSC52", "1"),
            ]),
            HostOs::Linux,
            false,
        );
        assert!(detected.osc52_sink);
        assert!(detected.osc52_disabled);
        assert_eq!(detected.osc52_support(), Osc52Support::Supported);
        let off = TermEnv::from_env(
            &env(&[("GROK_CLIPBOARD_NO_OSC52", "0")]),
            HostOs::Linux,
            false,
        );
        assert!(!off.osc52_disabled);
    }

    #[test]
    fn passthrough_doubles_escapes() {
        assert_eq!(
            tmux_passthrough("\x1b]9;hi\x07"),
            "\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\"
        );
    }
}
