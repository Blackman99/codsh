//! Clipboard delivery with honest reporting (ticket 155).
//!
//! A copy tries every enabled leg (native tool, tmux buffer, OSC 52) and
//! always writes a backup file. The message only says "Copied!" when a leg
//! whose destination is trusted succeeded; an OSC 52 write nobody can
//! confirm, or no route at all, names the backup file instead.

use crate::terminal_env::{
    DisplayServer, EnvMap, HostOs, Multiplexer, Osc52Support, TermEnv, non_empty, which,
};
use base64::Engine;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// OSC 52 payloads larger than this are skipped; many terminals and tmux
/// silently truncate or drop huge sequences.
pub const MAX_OSC52_BYTES: usize = 1024 * 1024;
const TOOL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct CopyContext {
    pub env: EnvMap,
    pub term: TermEnv,
    pub grok_home: PathBuf,
}

impl CopyContext {
    pub fn detect(grok_home: &Path) -> Self {
        Self {
            env: crate::terminal_env::current_env(),
            term: TermEnv::detect(),
            grok_home: grok_home.to_path_buf(),
        }
    }

    #[cfg(test)]
    pub fn from_env(env: EnvMap, host_os: HostOs, container: bool, grok_home: &Path) -> Self {
        let term = TermEnv::from_env(&env, host_os, container);
        Self {
            env,
            term,
            grok_home: grok_home.to_path_buf(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeTool {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub label: String,
}

/// Routes resolved before a copy; used by the copy itself and by `doctor`.
#[derive(Debug, Clone)]
pub struct Plan {
    pub native: Option<NativeTool>,
    /// Whether a native success lands on the user's own clipboard.
    pub native_trusted: bool,
    pub native_note: String,
    pub tmux: Option<PathBuf>,
    pub tmux_note: String,
    pub osc52: bool,
    pub osc52_tmux_wrap: bool,
    pub osc52_note: String,
    pub osc52_support: Osc52Support,
    pub backup: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// A trusted leg reported success.
    Confirmed,
    /// Only tmux's paste buffer is known to hold the text.
    TmuxBuffer,
    /// OSC 52 was emitted but nobody can confirm the terminal accepted it.
    Unverified,
    /// Nothing reached a clipboard.
    Unreachable,
}

impl Delivery {
    pub fn label(self) -> &'static str {
        match self {
            Delivery::Confirmed => "confirmed",
            Delivery::TmuxBuffer => "tmux_buffer",
            Delivery::Unverified => "unverified",
            Delivery::Unreachable => "unreachable",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CopyReport {
    pub delivery: Delivery,
    pub destination: String,
    pub backup: Result<PathBuf, String>,
    pub message: String,
}

impl CopyReport {
    pub fn delivered(&self) -> bool {
        matches!(self.delivery, Delivery::Confirmed | Delivery::TmuxBuffer)
    }
}

/// `$GROK_COPY_FILE` (with `~` expansion) or `$GROK_HOME/last-copy.txt`.
pub fn backup_path(env: &EnvMap, grok_home: &Path) -> PathBuf {
    match non_empty(env, "GROK_COPY_FILE") {
        Some(value) => expand_tilde(value, env),
        None => grok_home.join("last-copy.txt"),
    }
}

pub fn expand_tilde(value: &str, env: &EnvMap) -> PathBuf {
    let home = crate::terminal_env::user_home(env);
    match (value, home) {
        ("~", Some(home)) => home,
        (_, Some(home)) if value.starts_with("~/") => home.join(&value[2..]),
        _ => PathBuf::from(value),
    }
}

fn native_tool(ctx: &CopyContext) -> Result<NativeTool, String> {
    let env = &ctx.env;
    let tool = |name: &str, args: &[&str], label: &str| {
        which(env, name).map(|program| NativeTool {
            program,
            args: args.iter().map(|arg| arg.to_string()).collect(),
            label: label.to_string(),
        })
    };
    match ctx.term.host_os {
        HostOs::Macos => {
            tool("pbcopy", &[], "pbcopy").ok_or_else(|| "pbcopy is not on PATH".into())
        }
        HostOs::Windows => tool("clip.exe", &[], "clip.exe")
            .or_else(|| tool("clip", &[], "clip"))
            .ok_or_else(|| "clip.exe is not on PATH".into()),
        HostOs::Linux | HostOs::Other => match ctx.term.display {
            DisplayServer::Wayland => tool("wl-copy", &[], "wl-copy")
                .ok_or_else(|| "Wayland session but wl-copy (wl-clipboard) is not on PATH".into()),
            DisplayServer::X11 => tool("xclip", &["-selection", "clipboard", "-in"], "xclip")
                .or_else(|| tool("xsel", &["--clipboard", "--input"], "xsel"))
                .ok_or_else(|| "X11 session but neither xclip nor xsel is on PATH".into()),
            _ => Err("no graphical session (WAYLAND_DISPLAY/DISPLAY unset)".into()),
        },
    }
}

pub fn plan(ctx: &CopyContext) -> Plan {
    let term = &ctx.term;
    let (native, mut native_note) = match native_tool(ctx) {
        Ok(tool) => {
            let note = format!("{} ({})", tool.label, tool.program.display());
            (Some(tool), note)
        }
        Err(reason) => (None, reason),
    };
    let native_trusted = native.is_some() && !term.remote && !term.container_without_display();
    if native.is_some() && !native_trusted {
        native_note.push_str(if term.remote {
            " — writes the remote host's clipboard, not yours"
        } else {
            " — writes the container's clipboard, not yours"
        });
    }
    let tmux_backed = term.tmux_backed(&ctx.env);
    let (tmux, tmux_note) = if tmux_backed {
        match which(&ctx.env, "tmux") {
            Some(path) => (Some(path), "tmux load-buffer -".to_string()),
            None => (
                None,
                "inside tmux but the tmux binary is not on PATH".to_string(),
            ),
        }
    } else {
        (None, "not inside tmux".to_string())
    };
    let wanted = matches!(term.host_os, HostOs::Linux | HostOs::Other)
        || tmux_backed
        || term.remote
        || term.container_without_display()
        || term.osc52_sink;
    let (osc52, osc52_note) = if term.osc52_disabled {
        (false, "disabled by GROK_CLIPBOARD_NO_OSC52".to_string())
    } else if !wanted {
        (
            false,
            "not used for a local macOS/Windows session (native clipboard covers it)".to_string(),
        )
    } else if term.osc52_sink {
        (
            true,
            "codsh wrap sink detected (GROK_OSC52_SINK)".to_string(),
        )
    } else {
        (
            true,
            format!(
                "terminal {} OSC 52 support: {}",
                term.brand.label(),
                term.brand.osc52().label()
            ),
        )
    };
    Plan {
        native,
        native_trusted,
        native_note,
        tmux,
        tmux_note,
        osc52,
        osc52_tmux_wrap: tmux_backed,
        osc52_note,
        osc52_support: term.osc52_support(),
        backup: backup_path(&ctx.env, &ctx.grok_home),
    }
}

/// What a copy would most likely achieve, without writing anything.
pub fn expected_delivery(ctx: &CopyContext, plan: &Plan) -> Delivery {
    if plan.native_trusted {
        return Delivery::Confirmed;
    }
    if plan.osc52 && osc52_trusted(ctx) {
        return Delivery::Confirmed;
    }
    if plan.tmux.is_some() {
        return Delivery::TmuxBuffer;
    }
    if plan.osc52 && plan.osc52_support != Osc52Support::Unsupported {
        return Delivery::Unverified;
    }
    Delivery::Unreachable
}

/// OSC 52 counts as delivered only when the terminal that receives it is
/// known to support clipboard writes and no multiplexer sits in between.
fn osc52_trusted(ctx: &CopyContext) -> bool {
    !ctx.term.osc52_sink
        && ctx.term.multiplexer == Multiplexer::None
        && ctx.term.brand.osc52() == Osc52Support::Supported
}

pub fn osc52_sequence(text: &str) -> String {
    format!(
        "\x1b]52;c;{}\x07",
        base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
    )
}

fn run_tool(program: &Path, args: &[String], env: &EnvMap, input: &[u8]) -> Result<(), String> {
    let spawn = || {
        Command::new(program)
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    // A freshly written helper can briefly report ETXTBSY (errno 26) while
    // another thread's fork still holds its write handle; retry a few times.
    let mut attempt = 0;
    let mut child = loop {
        match spawn() {
            Ok(child) => break child,
            Err(error) if error.raw_os_error() == Some(26) && attempt < 5 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(format!("{}: {error}", program.display())),
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input)
            .map_err(|error| format!("{}: {error}", program.display()))?;
    }
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("{} exited {status}", program.display())),
            Ok(None) if started.elapsed() > TOOL_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} timed out", program.display()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(format!("{}: {error}", program.display())),
        }
    }
}

fn write_backup(path: &Path, text: &str) -> Result<PathBuf, String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    file.write_all(text.as_bytes())
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path.to_path_buf())
}

/// Copy `text`, writing any OSC 52 bytes to `out` (the terminal).
pub fn copy(text: &str, ctx: &CopyContext, out: &mut dyn Write) -> CopyReport {
    let plan = plan(ctx);
    let mut failures = Vec::new();
    let mut native_ok = false;
    match &plan.native {
        Some(tool) => match run_tool(&tool.program, &tool.args, &ctx.env, text.as_bytes()) {
            Ok(()) => native_ok = true,
            Err(error) => failures.push(format!("native: {error}")),
        },
        None => failures.push(format!("native: {}", plan.native_note)),
    }
    let mut tmux_ok = false;
    if let Some(tmux) = &plan.tmux {
        match run_tool(
            tmux,
            &["load-buffer".into(), "-".into()],
            &ctx.env,
            text.as_bytes(),
        ) {
            Ok(()) => tmux_ok = true,
            Err(error) => failures.push(format!("tmux: {error}")),
        }
    }
    let mut osc52_sent = false;
    if plan.osc52 {
        if text.len() > MAX_OSC52_BYTES {
            failures.push(format!(
                "OSC 52: {} bytes exceeds the {} byte limit",
                text.len(),
                MAX_OSC52_BYTES
            ));
        } else {
            let sequence = osc52_sequence(text);
            let mut bytes = sequence.clone();
            if plan.osc52_tmux_wrap {
                // Plain OSC 52 works with `set-clipboard on`; the passthrough
                // copy works with `allow-passthrough on`. Both set the same text.
                bytes.push_str(&crate::terminal_env::tmux_passthrough(&sequence));
            }
            match out.write_all(bytes.as_bytes()).and_then(|()| out.flush()) {
                Ok(()) => osc52_sent = true,
                Err(error) => failures.push(format!("OSC 52: {error}")),
            }
        }
    } else {
        failures.push(format!("OSC 52: {}", plan.osc52_note));
    }
    let backup = write_backup(&plan.backup, text);
    let bytes = text.len();
    let (delivery, destination) = if native_ok && plan.native_trusted {
        let label = plan
            .native
            .as_ref()
            .map(|tool| tool.label.as_str())
            .unwrap_or("");
        (Delivery::Confirmed, format!("system clipboard ({label})"))
    } else if osc52_sent && osc52_trusted(ctx) {
        (
            Delivery::Confirmed,
            format!("{} via OSC 52", ctx.term.brand.label()),
        )
    } else if tmux_ok {
        (Delivery::TmuxBuffer, "tmux paste buffer".into())
    } else if osc52_sent && plan.osc52_support != Osc52Support::Unsupported {
        (Delivery::Unverified, "OSC 52".into())
    } else {
        if osc52_sent {
            failures.push(format!(
                "OSC 52: {} does not support clipboard writes",
                ctx.term.brand.label()
            ));
        }
        if native_ok {
            failures.push(format!("native: {}", plan.native_note));
        }
        (Delivery::Unreachable, String::new())
    };
    let message = message_for(ctx, delivery, &destination, bytes, &backup, &failures);
    CopyReport {
        delivery,
        destination,
        backup,
        message,
    }
}

fn message_for(
    ctx: &CopyContext,
    delivery: Delivery,
    destination: &str,
    bytes: usize,
    backup: &Result<PathBuf, String>,
    failures: &[String],
) -> String {
    let saved = match backup {
        Ok(path) => format!("saved to {}", path.display()),
        Err(error) => format!("backup file failed: {error}"),
    };
    match delivery {
        Delivery::Confirmed => format!("Copied! {bytes} bytes → {destination}"),
        Delivery::TmuxBuffer => format!(
            "Copied {bytes} bytes to the tmux paste buffer only (system clipboard not confirmed); {saved}"
        ),
        Delivery::Unverified => {
            let why = if ctx.term.osc52_sink {
                "codsh wrap forwards it to the local clipboard, but this side cannot confirm it"
                    .to_string()
            } else if ctx.term.multiplexer != Multiplexer::None {
                format!("{} may drop it (run /doctor)", ctx.term.multiplexer.label())
            } else {
                format!(
                    "terminal {} cannot confirm delivery",
                    ctx.term.brand.label()
                )
            };
            format!("Sent {bytes} bytes via OSC 52, unconfirmed ({why}); {saved}")
        }
        Delivery::Unreachable => {
            let reason = failures
                .first()
                .cloned()
                .unwrap_or_else(|| "no clipboard route".into());
            match backup {
                Ok(path) => format!(
                    "Clipboard unreachable ({reason}); {bytes} bytes saved to {} instead",
                    path.display()
                ),
                Err(error) => format!(
                    "Clipboard unreachable ({reason}) and the backup file failed ({error}); nothing was copied"
                ),
            }
        }
    }
}

/// Copy using the live environment and the real terminal on stdout.
pub fn copy_live(text: &str, grok_home: &Path) -> CopyReport {
    use std::io::IsTerminal;
    let ctx = CopyContext::detect(grok_home);
    if std::io::stdout().is_terminal() {
        let mut stdout = std::io::stdout();
        copy(text, &ctx, &mut stdout)
    } else {
        // OSC 52 bytes in a pipe or file would corrupt it and reach no terminal.
        copy(text, &ctx, &mut NotATerminal)
    }
}

struct NotATerminal;

impl Write for NotATerminal {
    fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::other("stdout is not a terminal"))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Machine-readable route facts for `doctor --json`.
pub fn plan_json(ctx: &CopyContext, plan: &Plan) -> Value {
    json!({
        "native": {
            "tool": plan.native.as_ref().map(|tool| tool.label.clone()),
            "trusted": plan.native_trusted,
            "note": plan.native_note,
        },
        "tmux": { "enabled": plan.tmux.is_some(), "note": plan.tmux_note },
        "osc52": {
            "enabled": plan.osc52,
            "tmuxPassthrough": plan.osc52 && plan.osc52_tmux_wrap,
            "terminalSupport": plan.osc52_support.label(),
            "note": plan.osc52_note,
        },
        "backupFile": plan.backup.display().to_string(),
        "expectedDelivery": expected_delivery(ctx, plan).label(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_tool(dir: &Path, name: &str, sink: &Path, exit: i32) {
        let script = format!(
            "#!/bin/sh\ncat > '{}'\nprintf '%s ' \"$@\" > '{}.args'\nexit {exit}\n",
            sink.display(),
            sink.display()
        );
        let path = dir.join(name);
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn ctx(dir: &Path, pairs: &[(&str, &str)], os: HostOs) -> CopyContext {
        let mut env: EnvMap = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        env.entry("PATH".into())
            .or_insert_with(|| format!("{}:/usr/bin:/bin", dir.join("bin").display()));
        CopyContext::from_env(env, os, false, &dir.join("grok"))
    }

    #[test]
    fn x11_native_success_is_confirmed_and_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        let sink = dir.path().join("clip.out");
        fake_tool(&dir.path().join("bin"), "xclip", &sink, 0);
        let context = ctx(dir.path(), &[("DISPLAY", ":0")], HostOs::Linux);
        let mut out = Vec::new();
        let report = copy("héllo", &context, &mut out);
        assert_eq!(report.delivery, Delivery::Confirmed, "{}", report.message);
        assert!(report.message.starts_with("Copied!"));
        assert_eq!(std::fs::read_to_string(&sink).unwrap(), "héllo");
        let args = std::fs::read_to_string(dir.path().join("clip.out.args")).unwrap();
        assert!(args.contains("-selection clipboard"));
        // Linux still emits OSC 52 as a second leg.
        assert!(String::from_utf8(out).unwrap().starts_with("\x1b]52;c;"));
        let backup = dir.path().join("grok/last-copy.txt");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "héllo");
        let mode = std::fs::metadata(&backup).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn failing_native_tool_is_not_success() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        fake_tool(&dir.path().join("bin"), "wl-copy", &dir.path().join("w"), 1);
        let context = ctx(
            dir.path(),
            &[
                ("WAYLAND_DISPLAY", "wayland-0"),
                ("GROK_CLIPBOARD_NO_OSC52", "1"),
            ],
            HostOs::Linux,
        );
        let mut out = Vec::new();
        let report = copy("x", &context, &mut out);
        assert_eq!(report.delivery, Delivery::Unreachable);
        assert!(out.is_empty(), "kill switch must suppress OSC 52");
        assert!(report.message.contains("Clipboard unreachable"));
        assert!(report.message.contains("last-copy.txt"));
        assert!(!report.message.contains("Copied!"));
    }

    #[test]
    fn unknown_terminal_osc52_is_unverified() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        let context = ctx(dir.path(), &[("TERM", "xterm-256color")], HostOs::Linux);
        let mut out = Vec::new();
        let report = copy("abc", &context, &mut out);
        assert_eq!(report.delivery, Delivery::Unverified);
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b]52;c;YWJj\x07");
        assert!(report.message.contains("unconfirmed"));
        assert!(report.message.contains("last-copy.txt"));
    }

    #[test]
    fn supported_terminal_osc52_is_confirmed_but_vte_is_not() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        let kitty = ctx(dir.path(), &[("TERM", "xterm-kitty")], HostOs::Linux);
        let report = copy("k", &kitty, &mut Vec::new());
        assert_eq!(report.delivery, Delivery::Confirmed);
        assert!(report.message.contains("Kitty via OSC 52"));
        let vte = ctx(dir.path(), &[("VTE_VERSION", "7402")], HostOs::Linux);
        let report = copy("v", &vte, &mut Vec::new());
        assert_eq!(report.delivery, Delivery::Unreachable, "{}", report.message);
    }

    #[test]
    fn tmux_leg_and_passthrough() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        let sink = dir.path().join("tmux.out");
        fake_tool(&dir.path().join("bin"), "tmux", &sink, 0);
        let context = ctx(
            dir.path(),
            &[("TMUX", "/tmp/t,1,0"), ("TERM", "tmux-256color")],
            HostOs::Linux,
        );
        let mut out = Vec::new();
        let report = copy("buf", &context, &mut out);
        assert_eq!(report.delivery, Delivery::TmuxBuffer, "{}", report.message);
        assert_eq!(std::fs::read_to_string(&sink).unwrap(), "buf");
        assert!(
            std::fs::read_to_string(dir.path().join("tmux.out.args"))
                .unwrap()
                .contains("load-buffer -")
        );
        let written = String::from_utf8(out).unwrap();
        assert!(written.contains("\x1b]52;c;YnVm\x07"));
        assert!(written.contains("\x1bPtmux;\x1b\x1b]52;c;YnVm\x07\x1b\\"));
        assert!(report.message.contains("tmux paste buffer only"));
    }

    #[test]
    fn remote_native_is_not_trusted_and_macos_local_skips_osc52() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        fake_tool(&dir.path().join("bin"), "pbcopy", &dir.path().join("pb"), 0);
        let local = ctx(
            dir.path(),
            &[("TERM_PROGRAM", "Apple_Terminal")],
            HostOs::Macos,
        );
        let mut out = Vec::new();
        let report = copy("m", &local, &mut out);
        assert_eq!(report.delivery, Delivery::Confirmed);
        assert!(out.is_empty());
        let remote = ctx(
            dir.path(),
            &[
                ("TERM_PROGRAM", "Apple_Terminal"),
                ("SSH_TTY", "/dev/ttys1"),
            ],
            HostOs::Macos,
        );
        let mut out = Vec::new();
        let report = copy("m", &remote, &mut out);
        assert_ne!(report.delivery, Delivery::Confirmed, "{}", report.message);
        assert!(!out.is_empty(), "SSH enables the OSC 52 leg on macOS");
    }

    #[test]
    fn copy_file_override_and_tilde() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        let home = dir.path().join("home");
        let context = ctx(
            dir.path(),
            &[
                ("HOME", home.to_str().unwrap()),
                ("GROK_COPY_FILE", "~/copies/out.txt"),
                ("GROK_CLIPBOARD_NO_OSC52", "1"),
            ],
            HostOs::Linux,
        );
        let report = copy("t", &context, &mut Vec::new());
        assert_eq!(report.backup.unwrap(), home.join("copies/out.txt"));
        assert!(report.message.contains("copies/out.txt"));
    }

    #[test]
    fn sink_is_unverified_and_huge_payload_skips_osc52() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        let context = ctx(dir.path(), &[("LC_GROK_OSC52_SINK", "1")], HostOs::Macos);
        let report = copy("s", &context, &mut Vec::new());
        assert_eq!(report.delivery, Delivery::Unverified);
        assert!(report.message.contains("codsh wrap"));
        let big = "x".repeat(MAX_OSC52_BYTES + 1);
        let linux = ctx(dir.path(), &[("TERM", "xterm-kitty")], HostOs::Linux);
        let mut out = Vec::new();
        let report = copy(&big, &linux, &mut out);
        assert!(out.is_empty());
        assert_eq!(report.delivery, Delivery::Unreachable);
    }
}
