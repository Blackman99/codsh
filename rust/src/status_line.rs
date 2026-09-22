use crate::appearance::{StatusLineConfig, StatusLineItem, StatusLineKind};
use crate::models::Routing;
use serde_json::{Value as JsonValue, json};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
#[allow(dead_code)]
pub const EVENT_DEBOUNCE: Duration = Duration::from_millis(300);
#[allow(dead_code)]
pub const MIN_REFRESH_INTERVAL_MS: Duration = Duration::from_millis(100);
pub const MAX_STATUS_LINE_LINES: usize = 5;
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 64 * 1024;
pub const REFRESH_FAILURES_TO_PAINT: u32 = 3;
const CONTEXT_WARN_PCT: u8 = 80;
const MIN_DISPLAYED_COST_USD: f64 = 0.005;

#[derive(Clone, Debug, PartialEq)]
pub struct StatusSnapshot {
    pub cwd: PathBuf,
    pub session_id: Option<String>,
    pub session_name: Option<String>,
    pub model_id: Option<String>,
    pub model_display: Option<String>,
    pub effort: Option<String>,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub used_percentage: Option<u8>,
    pub auto_compact_threshold_percent: Option<u8>,
    pub cost_usd: Option<f64>,
    pub turn_started: Option<Instant>,
    pub version: String,
}

impl StatusSnapshot {
    pub fn from_session(
        cwd: &Path,
        session_id: Option<&str>,
        routing: Option<&Routing>,
        used: Option<u64>,
        size: Option<u64>,
        cost: Option<&str>,
        compact_threshold: Option<u8>,
        turn_started: Option<Instant>,
    ) -> Self {
        let window = routing.and_then(|item| item.advertised_context).or(size);
        let tokens = used;
        let pct = match (tokens, window) {
            (Some(used), Some(size)) if size > 0 => Some(
                ((used as f64 / size as f64) * 100.0)
                    .round()
                    .clamp(0.0, 100.0) as u8,
            ),
            _ => None,
        };
        Self {
            cwd: cwd.to_path_buf(),
            session_id: session_id.map(str::to_string),
            session_name: None,
            model_id: routing.map(|item| item.model.clone()),
            model_display: routing.map(|item| {
                if item.provider.is_empty() {
                    item.model.clone()
                } else {
                    format!("{} {}", item.provider, item.model)
                }
            }),
            effort: routing.and_then(|item| item.effort.clone()),
            context_tokens: tokens,
            context_window: window,
            used_percentage: pct,
            auto_compact_threshold_percent: compact_threshold,
            cost_usd: cost.and_then(parse_cost),
            turn_started,
            version: env!("CARGO_PKG_VERSION").into(),
        }
    }

    pub fn payload(&self, trigger: &str, cols: u16, lines: u16) -> JsonValue {
        let mut body = json!({
            "cwd": self.cwd.display().to_string(),
            "schema_version": 1,
            "version": self.version,
            "trigger": trigger,
            "workspace": {
                "current_dir": self.cwd.display().to_string(),
            },
        });
        if let Some(id) = &self.session_id {
            body["session_id"] = json!(id);
        }
        if let Some(name) = &self.session_name {
            body["session_name"] = json!(name);
        }
        if self.model_id.is_some() || self.model_display.is_some() {
            body["model"] = json!({
                "id": self.model_id,
                "display_name": self.model_display,
            });
        }
        if self.effort.is_some() {
            body["effort"] = json!({ "level": self.effort });
        }
        let mut window = json!({});
        if let Some(size) = self.context_window {
            window["context_window_size"] = json!(size);
        }
        if let Some(tokens) = self.context_tokens {
            window["context_tokens"] = json!(tokens);
        }
        if let Some(pct) = self.used_percentage {
            window["used_percentage"] = json!(pct);
            window["remaining_percentage"] = json!(100u8.saturating_sub(pct));
        }
        if let Some(threshold) = self.auto_compact_threshold_percent {
            window["auto_compact_threshold_percent"] = json!(threshold);
        }
        if window.as_object().is_some_and(|map| !map.is_empty()) {
            body["context_window"] = window;
        }
        if let Some(usd) = self.cost_usd {
            body["cost"] = json!({ "total_cost_usd": usd });
        }
        let _ = (cols, lines);
        body
    }
}

fn parse_cost(value: &str) -> Option<f64> {
    let trimmed = value.trim().trim_start_matches('$');
    trimmed.parse().ok()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusLineView {
    pub text: String,
    pub warn: bool,
}

impl StatusLineView {
    pub fn empty() -> Self {
        Self {
            text: String::new(),
            warn: false,
        }
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}

pub fn compose_builtin(config: &StatusLineConfig, snap: &StatusSnapshot) -> StatusLineView {
    if config.kind != StatusLineKind::Builtin {
        return StatusLineView::empty();
    }
    let elapsed = snap.turn_started.map(|started| started.elapsed());
    let mut warn = false;
    let mut parts = Vec::new();
    for item in &config.items {
        if let Some((text, item_warn)) = builtin_item(*item, snap, elapsed) {
            parts.push(text);
            warn |= item_warn;
        }
    }
    StatusLineView {
        text: pad(&parts.join(" │ "), config.padding),
        warn,
    }
}

fn builtin_item(
    item: StatusLineItem,
    snap: &StatusSnapshot,
    elapsed: Option<Duration>,
) -> Option<(String, bool)> {
    match item {
        StatusLineItem::Cwd => {
            let name = snap
                .cwd
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())?;
            Some((fit(name, 40), false))
        }
        StatusLineItem::Model => {
            let name = snap
                .model_display
                .as_deref()
                .filter(|name| !name.is_empty())?;
            Some((fit(name, 30), false))
        }
        StatusLineItem::Context => {
            let pct = snap.used_percentage?;
            let warn_at = snap
                .auto_compact_threshold_percent
                .unwrap_or(CONTEXT_WARN_PCT);
            Some((format!("{pct}% ctx"), pct >= warn_at))
        }
        StatusLineItem::Cost => snap
            .cost_usd
            .filter(|usd| *usd >= MIN_DISPLAYED_COST_USD)
            .map(|usd| (format!("${usd:.2}"), false)),
        StatusLineItem::TurnTimer => {
            let secs = elapsed?.as_secs();
            if secs == 0 {
                return None;
            }
            Some((format_elapsed(secs), false))
        }
        StatusLineItem::SessionName => {
            let name = snap
                .session_name
                .as_deref()
                .filter(|name| !name.is_empty())?;
            Some((fit(name, 40), false))
        }
    }
}

fn format_elapsed(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m{:02}s", secs / 60, secs % 60)
    }
}

fn fit(text: &str, cols: usize) -> String {
    let mut width = 0usize;
    let mut out = String::new();
    for ch in text.chars().filter(|ch| !ch.is_control()) {
        let next = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if width + next > cols {
            if cols == 0 {
                break;
            }
            while width >= cols {
                if let Some(popped) = out.pop() {
                    width = width.saturating_sub(
                        unicode_width::UnicodeWidthChar::width(popped).unwrap_or(0),
                    );
                } else {
                    break;
                }
            }
            if cols >= 1 && width < cols {
                out.push('…');
            }
            break;
        }
        width += next;
        out.push(ch);
    }
    out
}

fn pad(text: &str, padding: u8) -> String {
    if padding == 0 {
        return text.to_string();
    }
    format!(
        "{}{text}{}",
        " ".repeat(padding as usize),
        " ".repeat(padding as usize)
    )
}

pub fn sanitize_output(raw: &str, max_lines: usize) -> String {
    raw.replace('\r', "")
        .split('\n')
        .take(max_lines)
        .map(|line| {
            let cut: String = line.chars().take(1024).collect();
            strip_unsafe_ansi(&cut)
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

fn strip_unsafe_ansi(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b
            && i + 1 < bytes.len()
            && bytes[i + 1] == b'['
            && let Some(end) = bytes[i + 2..].iter().position(|b| *b >= b'@' && *b <= b'~')
        {
            let final_byte = bytes[i + 2 + end];
            if final_byte == b'm' {
                out.push_str(&line[i..i + 3 + end]);
            }
            i += 3 + end;
            continue;
        }
        if bytes[i].is_ascii_control() && bytes[i] != b'\t' {
            i += 1;
            continue;
        }
        let ch = line[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[derive(Debug)]
pub enum CommandOutcome {
    Output(String),
    Failed { text: String, refresh: bool },
}

pub fn run_command(
    command: &str,
    payload: &JsonValue,
    cwd: &Path,
    cols: u16,
    lines: u16,
    timeout: Duration,
) -> CommandOutcome {
    match run_command_inner(command, payload, cwd, cols, lines, timeout) {
        Ok(text) => CommandOutcome::Output(sanitize_output(&text, MAX_STATUS_LINE_LINES)),
        Err(error) => CommandOutcome::Failed {
            text: format!("[status line: {error}]"),
            refresh: false,
        },
    }
}

fn run_command_inner(
    command: &str,
    payload: &JsonValue,
    cwd: &Path,
    cols: u16,
    lines: u16,
    timeout: Duration,
) -> Result<String, String> {
    let mut json = serde_json::to_string(payload)
        .map_err(|error| format!("could not encode Grok's payload: {error}"))?;
    json.push('\n');
    let expanded = expand_home(command);
    let workdir = if cwd.is_dir() {
        cwd.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };
    let mut child = spawn(&expanded, &workdir, cols, lines)
        .map_err(|error| format!("could not start the script: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(json.as_bytes());
        drop(stdin);
    }
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout.take() {
            let mut tmp = vec![0; 4096];
            loop {
                match out.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        let remaining = MAX_COMMAND_OUTPUT_BYTES
                            .saturating_add(1)
                            .saturating_sub(buf.len());
                        if remaining == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n.min(remaining)]);
                        if buf.len() > MAX_COMMAND_OUTPUT_BYTES {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        if let Some(mut err) = stderr.take() {
            let mut drain = Vec::new();
            let _ = err.read_to_end(&mut drain);
        }
        let _ = tx.send(buf);
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let buf = rx
                    .recv_timeout(Duration::from_millis(200))
                    .unwrap_or_default();
                if buf.len() > MAX_COMMAND_OUTPUT_BYTES {
                    return Ok(
                        String::from_utf8_lossy(&buf[..MAX_COMMAND_OUTPUT_BYTES]).into_owned()
                    );
                }
                if !status.success() && buf.is_empty() {
                    return Err(status
                        .code()
                        .map(|code| format!("exit {code}"))
                        .unwrap_or_else(|| "killed by signal".into()));
                }
                return Ok(String::from_utf8_lossy(&buf).into_owned());
            }
            Ok(None) if started.elapsed() >= timeout => {
                kill_tree(&mut child);
                return Err("timed out".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(format!("could not wait for the script: {error}")),
        }
    }
}

fn spawn(command: &str, cwd: &Path, cols: u16, lines: u16) -> io::Result<std::process::Child> {
    let mut direct = Command::new(command);
    configure(&mut direct, cwd, cols, lines);
    match direct.spawn() {
        Ok(child) => Ok(child),
        Err(error) if error.kind() == io::ErrorKind::NotFound || is_shell_script(&error) => {
            let mut shell = Command::new("sh");
            shell.args(["-c", command]);
            configure(&mut shell, cwd, cols, lines);
            shell.spawn()
        }
        Err(error) => Err(error),
    }
}

fn configure(cmd: &mut Command, cwd: &Path, cols: u16, lines: u16) {
    cmd.env_remove("BASH_ENV")
        .env_remove("ENV")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("COLUMNS", cols.to_string())
        .env("LINES", lines.to_string())
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .env("EDITOR", "true")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

fn is_shell_script(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::ENOEXEC)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn expand_home(command: &str) -> String {
    if let Some(rest) = command.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return format!("{}/{rest}", PathBuf::from(home).display());
    }
    command.to_string()
}

pub struct StatusLineRuntime {
    config: StatusLineConfig,
    last: StatusLineView,
    answered: bool,
    refresh_failures: u32,
    last_payload: Option<JsonValue>,
    rx: Option<Receiver<CommandOutcome>>,
    in_flight: bool,
    last_started: Option<Instant>,
}

impl StatusLineRuntime {
    pub fn new(config: StatusLineConfig) -> Self {
        Self {
            config,
            last: StatusLineView::empty(),
            answered: false,
            refresh_failures: 0,
            last_payload: None,
            rx: None,
            in_flight: false,
            last_started: None,
        }
    }

    #[allow(dead_code)]
    pub fn config(&self) -> &StatusLineConfig {
        &self.config
    }

    pub fn current(&self) -> StatusLineView {
        if let Some(message) = &self.config.message {
            return StatusLineView {
                text: message.clone(),
                warn: true,
            };
        }
        self.last.clone()
    }

    #[allow(dead_code)]
    pub fn reserves_row(&self) -> bool {
        self.config.kind != StatusLineKind::Disabled || self.config.message.is_some()
    }

    pub fn poll(&mut self) -> bool {
        let Some(rx) = &self.rx else {
            return false;
        };
        match rx.try_recv() {
            Ok(outcome) => {
                self.in_flight = false;
                self.apply(outcome);
                true
            }
            Err(mpsc::TryRecvError::Empty) => false,
            Err(mpsc::TryRecvError::Disconnected) => {
                self.in_flight = false;
                false
            }
        }
    }

    pub fn request_state(&mut self, snap: &StatusSnapshot, cols: u16, lines: u16) {
        match self.config.kind {
            StatusLineKind::Disabled => self.last = StatusLineView::empty(),
            StatusLineKind::Builtin => self.last = compose_builtin(&self.config, snap),
            StatusLineKind::Command => {
                let payload = snap.payload("state", cols, lines);
                self.spawn(payload, snap.cwd.clone(), cols, lines.max(1), false);
            }
        }
    }

    pub fn request_refresh(&mut self, snap: &StatusSnapshot, cols: u16, lines: u16) {
        if self.config.kind != StatusLineKind::Command {
            return;
        }
        let payload = self
            .last_payload
            .clone()
            .unwrap_or_else(|| snap.payload("refresh_interval", cols, lines));
        let mut payload = payload;
        payload["trigger"] = json!("refresh_interval");
        self.spawn(payload, snap.cwd.clone(), cols, lines.max(1), true);
    }

    pub fn due_refresh(&self, now: Instant) -> bool {
        let Some(secs) = self.config.refresh_interval else {
            return false;
        };
        if self.config.kind != StatusLineKind::Command {
            return false;
        }
        match self.last_started {
            Some(started) => now.duration_since(started) >= Duration::from_secs(secs),
            None => true,
        }
    }

    pub fn shutdown(&mut self) {
        self.rx = None;
        self.in_flight = false;
    }

    fn spawn(&mut self, payload: JsonValue, cwd: PathBuf, cols: u16, lines: u16, refresh: bool) {
        if self.in_flight {
            return;
        }
        let Some(command) = self.config.command.clone() else {
            self.last = StatusLineView {
                text: "[ui.status_line] command is required for type = \"command\"".into(),
                warn: true,
            };
            return;
        };
        self.last_payload = Some(payload.clone());
        self.last_started = Some(Instant::now());
        let (tx, rx) = mpsc::channel();
        let timeout = COMMAND_TIMEOUT;
        thread::spawn(move || {
            let mut outcome = run_command(&command, &payload, &cwd, cols, lines, timeout);
            if refresh && let CommandOutcome::Failed { refresh: flag, .. } = &mut outcome {
                *flag = true;
            }
            let _ = tx.send(outcome);
        });
        self.rx = Some(rx);
        self.in_flight = true;
    }

    fn apply(&mut self, outcome: CommandOutcome) {
        match outcome {
            CommandOutcome::Output(text) => {
                self.refresh_failures = 0;
                self.answered = true;
                self.last = StatusLineView { text, warn: false };
            }
            CommandOutcome::Failed { text, refresh, .. } => {
                if refresh && self.answered {
                    self.refresh_failures = self.refresh_failures.saturating_add(1);
                    if self.refresh_failures < REFRESH_FAILURES_TO_PAINT {
                        return;
                    }
                } else {
                    self.refresh_failures = 0;
                }
                self.last = StatusLineView { text, warn: true };
                self.answered = true;
            }
        }
    }
}

impl Drop for StatusLineRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appearance::StatusLineConfig;

    fn snap() -> StatusSnapshot {
        StatusSnapshot {
            cwd: PathBuf::from("/tmp/demo-project"),
            session_id: Some("sess-1".into()),
            session_name: Some("demo".into()),
            model_id: Some("mock-model".into()),
            model_display: Some("Local gateway mock-model".into()),
            effort: Some("high".into()),
            context_tokens: Some(12),
            context_window: Some(100),
            used_percentage: Some(12),
            auto_compact_threshold_percent: Some(80),
            cost_usd: Some(0.02),
            turn_started: None,
            version: "0.1.0".into(),
        }
    }

    #[test]
    fn builtin_row_elides_and_hides_tiny_cost() {
        let config = StatusLineConfig {
            kind: StatusLineKind::Builtin,
            items: vec![
                StatusLineItem::Cwd,
                StatusLineItem::Model,
                StatusLineItem::Context,
                StatusLineItem::Cost,
            ],
            ..Default::default()
        };
        let view = compose_builtin(&config, &snap());
        assert!(view.text.contains("demo-project"));
        assert!(view.text.contains("12% ctx"));
        assert!(view.text.contains("$0.02"));
        let mut cheap = snap();
        cheap.cost_usd = Some(0.001);
        let view = compose_builtin(&config, &cheap);
        assert!(!view.text.contains("$0.00"));
        assert!(!view.text.contains("$0.001"));
    }

    #[test]
    fn context_warns_at_threshold() {
        let config = StatusLineConfig {
            kind: StatusLineKind::Builtin,
            items: vec![StatusLineItem::Context],
            ..Default::default()
        };
        let mut hot = snap();
        hot.used_percentage = Some(81);
        assert!(compose_builtin(&config, &hot).warn);
    }

    #[test]
    fn payload_omits_unknown_fields() {
        let mut empty = snap();
        empty.model_id = None;
        empty.model_display = None;
        empty.context_tokens = None;
        empty.context_window = None;
        empty.used_percentage = None;
        empty.auto_compact_threshold_percent = None;
        empty.cost_usd = None;
        let payload = empty.payload("state", 80, 1);
        assert!(payload.get("model").is_none());
        assert!(payload.get("cost").is_none());
        assert!(payload.get("context_window").is_none());
        assert_eq!(payload["trigger"], "state");
    }

    #[test]
    fn command_timeout_kills_descendants_and_clears_rc() {
        let dir = tempfile::TempDir::new().unwrap();
        let canary = dir.path().join("rc-canary");
        let script = dir.path().join("slow.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\necho started\n(sleep 30; echo leaked) &\nexec sleep 30\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).unwrap();
        }
        let env_cmd = format!("echo rc-ran >> {}; echo from-rc", canary.display());
        let payload =
            json!({"session_id":"t","workspace":{"current_dir": dir.path().display().to_string()}});
        unsafe {
            std::env::set_var("BASH_ENV", &env_cmd);
            std::env::set_var("ENV", &env_cmd);
        }
        let started = Instant::now();
        let outcome = run_command(
            &script.display().to_string(),
            &payload,
            dir.path(),
            40,
            1,
            Duration::from_millis(400),
        );
        unsafe {
            std::env::remove_var("BASH_ENV");
            std::env::remove_var("ENV");
        }
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "timeout must not block input"
        );
        match outcome {
            CommandOutcome::Failed { text, .. } => {
                assert!(text.contains("timed out"), "{text}");
            }
            CommandOutcome::Output(text) => panic!("expected timeout, got {text}"),
        }
        thread::sleep(Duration::from_millis(200));
        assert!(!canary.exists(), "BASH_ENV must not run");
    }

    #[test]
    fn refresh_failures_keep_last_output_until_three() {
        let mut runtime = StatusLineRuntime::new(StatusLineConfig {
            kind: StatusLineKind::Command,
            command: Some("true".into()),
            ..StatusLineConfig::default()
        });
        runtime.apply(CommandOutcome::Output("ok".into()));
        runtime.apply(CommandOutcome::Failed {
            text: "[status line: timed out]".into(),
            refresh: true,
        });
        assert_eq!(runtime.current().text, "ok");
        runtime.apply(CommandOutcome::Failed {
            text: "[status line: timed out]".into(),
            refresh: true,
        });
        assert_eq!(runtime.current().text, "ok");
        runtime.apply(CommandOutcome::Failed {
            text: "[status line: timed out]".into(),
            refresh: true,
        });
        assert!(runtime.current().text.contains("timed out"));
    }

    #[test]
    fn empty_success_hides_the_row() {
        let mut runtime = StatusLineRuntime::new(StatusLineConfig {
            kind: StatusLineKind::Command,
            command: Some("true".into()),
            ..StatusLineConfig::default()
        });
        runtime.apply(CommandOutcome::Output(String::new()));
        assert!(runtime.current().is_empty());
    }

    #[test]
    fn sanitize_keeps_colors_and_drops_cursor_motion() {
        let raw = "\x1b[32mgreen\x1b[0m\x1b[2J\x1b[Hsecret\r\noverwrite";
        let out = sanitize_output(raw, 5);
        assert!(out.contains("\x1b[32mgreen\x1b[0m"));
        assert!(!out.contains("\x1b[2J"));
        assert!(!out.contains('\r'));
    }
}
